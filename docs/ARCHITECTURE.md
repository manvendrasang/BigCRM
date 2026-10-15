# ARCHITECTURE

## 1. Design principles

1. **Security is a layer, not a pass at the end.** It shaped the schema (tenant
   column on every table), the API (permission per route), the data layer
   (`TenantScope`), the session model (revocable), and the deployment plan.
2. **The server is the only authority.** No client-supplied value decides
   authorization, tenancy, ownership, or role.
3. **Fail closed.** Missing configuration aborts startup. Malformed security
   data denies. Unknown roles deny.
4. **Enumerate less.** Where a value can be public, public it; where it cannot,
   the client gets nothing.
5. **Audit is a control, not a log.** Append-only at the database level.

## 2. Layering

```
routes (HTTP, not yet written)
  └─ services        business rules · transactions · audit · notifications
       └─ repositories/base.ts    TenantScope + identifier allowlists
            └─ db/driver.ts       pg Pool (prod) | PGlite (dev/test)
                 └─ PostgreSQL 17  39 tables · 89 FKs · 128 indexes
```

Dependencies point downward only. Services never import Express; repositories
never import services.

### Why a generic repository base instead of per-entity repositories

`TenantScope` makes tenant scoping a *construction requirement* rather than a
per-query convention, which is the structural fix for the legacy cross-tenant
leak. Per-entity repositories on top of it are a readability improvement, not a
security requirement, and were deferred to keep the tested surface small.

## 3. Request lifecycle

```
1. requestContext     assign/propagate X-Request-Id; capture and mask client IP
2. securityHeaders    CSP + nonce, HSTS, nosniff, COOP/CORP, referrer, permissions
3. corsPolicy         explicit allowlist; empty list denies, never allows
4. globalLimiter      per-network budget
5. body parsers       bounded size; malformed JSON becomes 400, not 500
6. csrfGuard          Origin/Referer must be an allowed origin
7. authenticate       Bearer token → verify → session row → live checks
8. requirePermission  RBAC; every denial is logged and counted
9. handler            service → repository → database
10. errorHandler      safe public error; internals to the log only
```

### Authentication (step 7) performs five checks

1. JWT signature, `iss`, `aud`, `exp`
2. Session row exists
3. Session not revoked
4. **Absolute** expiry (checked every request, not only at issue)
5. Idle expiry
6. Membership still exists in the claimed organization

Any failure returns one generic `401`, so a client cannot distinguish "expired"
from "revoked" from "no longer a member". Removing a member revokes their
sessions immediately, even mid-token-life.

## 4. Authentication design

### Two-token scheme

| Token | Lifetime | Storage | Purpose |
|---|---|---|---|
| access | 15 min | `HttpOnly; Secure; SameSite=Lax` cookie | Authorises requests |
| refresh | 7 days, rotating | Same cookie | Mints a new access token |

Refresh tokens are **single-use**. Rotation writes the new `jti` and burns the
old. Presenting an already-used token is treated as theft: the entire token
*family* is revoked and a fresh login is required. A unique index on
`refresh_jti` makes concurrent rotation a detectable race rather than a silent
split-brain.

Per RULE 123, **no token is stored in `localStorage`** — the legacy task manager
put a 7-day JWT there, which is exactly the exposure XSS needs.

### Password storage

Default `scrypt` (Node built-in, zero native dependencies); `Argon2id`
selectable and validated with a **self-test on first use** — the native binding
on this host imports fine but `verify()` always fails, so it is refused rather
than trusted.

Encoded form is self-describing:

```
bigcrm $ scrypt $ <salt-b64url> $ N $ r $ p $ <hash-b64url>
bigcrm $ argon2id $ <salt-b64url> $ <argon2-encoded>
```

Every password is mixed with `SECRETS_PEPPER` before hashing, so a
database-only compromise does not yield offline-crackable hashes.
`needsRehash()` lets cost parameters rise without invalidating stored hashes.

### Account enumeration

Unknown-account login still performs one full verification against a decoy hash,
so timing does not reveal existence. Every authentication failure returns the
same code and message.

## 5. Authorization

Three independent gates, all server-side:

1. **Permission** — `requirePermission('contacts.update')`
2. **Role hierarchy** — `ROLE_RANK`; nobody may act on a peer or superior
3. **Resource ownership** — every query carries `organization_id`

`assertOwnerOnlyInvariant()` runs in tests: owner must be a strict superset of
admin, and owner-exclusive permissions must not appear in any other role. That
assertion caught a real drift during the build (BIG-06).

### Owner is meaningfully distinct

| Permission | owner | admin |
|---|:-:|:-:|
| `organization.delete` | ✓ | — |
| `members.transfer_ownership` | ✓ | — |
| `security.manage` | ✓ | — |
| `retention.manage` | ✓ | — |
| everything admin has | ✓ | ✓ |

`owner` cannot be granted by invitation by anyone. It exists only on registration
or via explicit ownership transfer — stricter than both legacy systems.

## 6. Multi-tenancy

Enforced at three levels:

1. **Compile-time** — `TenantScope` cannot be constructed without an
   organizationId.
2. **Runtime** — `assertTenantPredicate()` throws if a statement touches a tenant
   table without `organization_id`.
3. **Schema** — `organization_id uuid NOT NULL` on every tenant table, indexed.

Reaching the raw driver requires naming the property `unsafe`, so a bypass is
visible at every call site. This design was corrected during the build after
Scenario 1 demonstrated that an earlier version leaked cross-tenant rows.

Postgres Row Level Security is a documented defence-in-depth option
(`DATABASE.md` §Row Level Security); it is not enabled, because correctness must
not depend on a session variable surviving connection pooling.

## 7. Data layer

Two drivers, one interface:

| Driver | Use | Notes |
|---|---|---|
| `PgDriver` | production | pool, bounded size, `statement_timeout`, health checks, graceful shutdown |
| `PgliteDriver` | dev + test | **real PostgreSQL 17 in WASM** |

PGlite is not a mock. Migrations, foreign keys, unique constraints, CHECK
constraints, triggers and transactions are genuinely exercised. This is what
caught the legacy SQLite-only DDL defect.

### Transactions

Every multi-statement business operation runs inside `transaction()`:

- registration: user + organization + membership + verification token
- password reset: hash update + token burn + session revocation
- member removal: membership delete + unassign across five tables
- invitation acceptance: token claim + membership insert (single-use enforced by
  `UPDATE … WHERE accepted_at IS NULL RETURNING id`)

## 8. Error handling

| Condition | Status | Public message |
|---|---|---|
| Unknown/invalid token, expired, revoked, not a member | 401 | one generic message |
| Wrong role, missing permission, ownership rejected | 403 | generic |
| Resource absent **or** in another tenant | 404 | generic — never leaks existence |
| Validation | 422 | field-level messages |
| Constraint violation | 409 | field-level |

Internals (stack traces, SQL, paths, hostnames) go to the log with the request
id. `errorHandler` translates PostgreSQL SQLSTATEs (`23505`, `23503`, `23514`,
`22P02`, `57014`) into safe, meaningful responses.

## 9. Observability

- **Logs** — structured JSON, recursive secret redaction, email masking, request
  id on every entry
- **Metrics** — requests, latency, auth failures, permission denials, **tenant
  denials**, rate-limit hits, DB latency, job outcomes, queue depth
- **Audit** — server-generated, append-only (database trigger), minimised diffs
- **Security events** — separate table with severity, feeding SIEM export

## 10. Key trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Password KDF | scrypt default, Argon2id optional | bcrypt | OWASP preference; Argon2id's native binding is unreliable on this platform |
| DB | PostgreSQL | SQLite / MongoDB | The tenant model needs constraints and real transactions; SQLite hid a fatal DDL defect |
| Tenant enforcement | `TenantScope` + runtime guard | RLS | RLS depends on a session variable surviving pooling; app-layer scoping is testable |
| Tokens | Cookie + CSRF defence-in-depth | `localStorage` | RULE 123; XSS cannot read a cookie |
| CSRF | Origin/Referer + mandatory header | Synchroniser token | No server-side token store, no token in the DOM; three layered controls |
| Idempotency | unique `(org, key, endpoint)` | best-effort | Makes retries safe by construction (RULE 104/195) |
| Migrations | Plain `.sql` | migration framework | The schema is the security boundary; it should be readable as SQL |

## 11. What is deliberately not built yet

`PROJECT_STATUS.md` §4 is the authoritative list. In brief: no HTTP route layer,
no frontend, no records/search/reports services, no storage/queue/webhook
providers, no Terraform. Each entry there names the abstraction that exists so
the gap is shaped, not open-ended.

## 12. Component map

| Component | Path | Responsibility |
|---|---|---|
| Config | `config/env.ts` | fail-closed validation, 60+ settings |
| Errors | `lib/errors.ts` | typed public errors |
| Ids | `lib/ids.ts` | UUIDs, secrets, constant-time compare |
| Time | `lib/time.ts` | ISO-8601, strict validators |
| Redaction | `lib/redact.ts` | secret/PII redaction, audit diff minimisation |
| Passwords | `lib/password.ts` | scrypt/Argon2id, strength policy, decoy hash |
| Tokens | `lib/tokens.ts` | single-use hashed tokens, recovery codes |
| JWT | `lib/jwt.ts` | access + rotating refresh, reuse detection |
| TOTP | `lib/totp.ts` | RFC 6238, replay window |
| Base32 | `lib/base32.ts` | RFC 4648 |
| Sanitize | `lib/sanitize.ts` | HTML escaping, rich-text allowlist |
| SSRF | `lib/ssrf.ts` | DNS-resolving egress guard |
| MIME | `lib/mime.ts` | magic-byte upload validation, opaque keys |
| CSV | `lib/csv.ts` | formula-injection defence, bounded parser |
| Pagination | `lib/pagination.ts` | signed cursors, hard caps |
| Logger | `lib/logger.ts` | structured logging, security events |
| Metrics | `lib/metrics.ts` | Prometheus registry |
| Driver | `db/driver.ts` | pg / PGlite, transactions |
| Migrations | `db/migrate.ts` | checksummed, transactional runner |
| Schema | `db/migrations/0001_core.sql` | 39 tables |
| Tenant | `repositories/base.ts` | `TenantScope`, allowlists, predicate guard |
| RBAC | `services/rbac.ts` | matrix, hierarchy, invariants |
| Auth | `services/auth.ts` | registration, login, sessions, reset, verify |
| Org | `services/org.ts` | org, members, invitations, teams, audit |
| Normalise | `services/normalise.ts` | canonicalisation for duplicate detection |
| Email | `integrations/email.ts` | provider abstraction |
| Middleware | `middleware/security.ts` | headers, CORS, limits, auth, RBAC, CSRF, errors |