# SECURITY_FINDINGS

Tracking register per RULE 226. Each entry states what is wrong, the evidence,
and — where fixed — the regression test that now prevents it.

Severity: **Critical · High · Medium · Low · Informational**
Status: `Fixed` · `Open` · `Accepted` · `Deferred`

**Two numbering schemes.** `BIG-*` are findings in BigCRM itself (found while
building, including several in my own first drafts). `LEG-*` are inherited defects
in the two frozen codebases that motivated specific controls here.

---

## Release gate (RULE 227)

| | Count |
|---|---:|
| Open Critical | **0** |
| Open High in code | **0** |
| Open High in platform | **2** (no WAF, no container scanning — cannot be addressed on this host) |
| Accepted risks | 3 |
| Fixed | 35 |

---

## Part 1 — Findings in BigCRM

### BIG-01 · Cross-tenant read via raw driver exposure · Critical · **Fixed**

`TenantScope` originally exposed `client`, the unwrapped `DbClient`, so any service
could issue `SELECT * FROM contacts WHERE id = $1` with no tenant predicate and
receive another tenant's row — the same shape as the legacy CRM defect `LEG-01`.

**Evidence.** Security Scenario 1 asserted the scope returned 0 rows and instead
observed **1 row leaked**. This was found by the test, not by review.

**Fix.** The raw driver is now reachable only as `scope.unsafe`. `scope.query()`
runs `assertTenantPredicate()` first and throws when a statement touches a tenant
table without `organization_id`. `TenantScope` cannot be constructed without an
organizationId, so scoping is a compile-time obligation.

**Regression test.** `security/scenarios.test.ts` S1 — "an unscoped query on a
tenant table is REJECTED, not served".

---

### BIG-02 · Invitation token returned from the service · Critical · **Fixed**

`inviteMember` returned `__token` in its result object so a test could read it.
Serialised to a client that is an open invitation bearer credential — exactly the
legacy takeover path (`LEG-04`).

**Evidence.** Scenario S11 asserted "invitation response carries NO raw token" and
failed with `invitationId,expiresAt,email,role,__token`.

**Fix.** The raw token is passed to an injected `deliver` sink and never returned.
`inviteMember`'s declared return type has no token field. `integrations/email.ts`
is the only module that composes token-bearing links.

**Regression test.** S11 — "invitation response carries NO raw token" and
"invitation response JSON contains no token substring".

---

### BIG-03 · Password verify indexed the wrong field · Critical · **Fixed**

`verifyPassword` destructured `const [, , , saltB64, N, r, p, hashB64]` against a
7-field encoded hash, reading the cost parameter as the salt. Every correct
password returned `false`; the failure surfaced as a 401 that looked like bad
credentials.

**Evidence.** A direct probe printed `verify correct pw : false` immediately after
the first successful register.

**Fix.** Corrected to `const [, , saltB64, N, r, p, hashB64]`.

**Regression test.** S3-supporting `X3` — "verification works and rejects wrong
input" and "malformed stored hash returns false rather than throwing".

---

### BIG-04 · `revokeSessions` compared session ids against `user_id` · High · **Fixed**

`WHERE user_id IN ($3)` was fed **session** ids, so session revocation silently
matched nothing. `changePassword` reported `{"revoked":0}` while the user stayed
signed in — a silent failure of the exact control that is supposed to contain a
compromised account.

**Evidence.** Instrumented probe: `manual revokeSessions -> 0` with one live,
unrevoked session for that user.

**Fix.** `WHERE user_id = $3 AND id IN ($4..)`. Scoping by `user_id` *and* `id`
also means a caller cannot revoke another account's session even holding its id.

**Regression test.** S10 — "every session revoked after password change" and "the
previously valid access token no longer validates".

---

### BIG-05 · Placeholder index collision · High · **Fixed**

`revokeSessions` built placeholders from `i + 2`, colliding with
`revoked_reason = $2`. PostgreSQL rejected the bind with `08P01: bind message
supplies 3 parameters, but prepared statement requires 2`.

**Fix.** Placeholders start at `i + 4`, matching the documented parameter layout.

---

### BIG-06 · RBAC invariant was violated by the permission matrix · High · **Fixed**

`assertOwnerOnlyInvariant()` — written specifically to catch this — failed on the
first run: `security.read must be owner-only but admin has it`. The declared
owner-exclusive set and the matrix had drifted apart.

**Fix.** Replaced the over-broad set with `OWNER_EXCLUSIVE` =
{`organization.delete`, `members.transfer_ownership`, `security.manage`,
`retention.manage`}. Admin may *read* security posture but not change it. The
assertion remains, and now also verifies owner is a strict superset of admin.

**Regression test.** `unit/rbac.test.ts` — "owner-only invariant holds".

---

### BIG-07 · `assignableRoles` ignored `users.invite` · High · **Fixed`

Rank-wise a sales rep (rank 20) could "assign" a viewer (rank 10), because the
helper consulted only rank. A sales rep holds no user-management permission at
all, so the list was meaningless.

**Fix.** `assignableRoles` returns `[]` unless `can(role, 'users.invite')`. The
permission is the authority; rank only narrows within it.

**Regression test.** `unit/rbac.test.ts` — "sales cannot assign anything",
"viewer holds no users.invite -> no assignable roles".

---

### BIG-08 · DDL ordering: composite FK declared before its unique key · High · **Fixed**

`deals` referenced `(pipeline_id, stage_id)` on `pipeline_stages` via a composite
FK, but the backing `UNIQUE (pipeline_id, id)` was added in a later `ALTER`.
PostgreSQL rejected the migration with `42830: there is no unique constraint
matching given keys`.

**Fix.** The `ALTER TABLE ... ADD CONSTRAINT uq_stages_pipeline_id` now precedes
the `CREATE TABLE deals`.

**Regression test.** `migrate()` is exercised on every suite start against real
PostgreSQL; the schema would not apply otherwise.

---

### BIG-09 · Forward foreign-key reference in DDL · High · **Fixed (detected, confirmed)**

While probing, a forward reference (`contacts` referencing `companies` before
`companies` existed) was submitted to real PostgreSQL and rejected with
`42P01: relation "o" does not exist`. This is the **same defect** as the legacy
`LEG-02`; SQLite accepted it silently, which is why it shipped.

**Fix.** Migrations are written in dependency order and applied against real
PostgreSQL in every test run, so this class cannot reach a schema again.

---

### BIG-10 · MFA secret has no column · Medium · **Fixed**

`services/auth.ts` implements the MFA challenge, TOTP verification and recovery
codes, and the repository allowlist contains `totp_secret_encrypted`, but
`0001_core.sql` does not create that column. The flow is not storable.

**Fixed** by migration `0003_mfa.sql` and `services/mfa.ts`:

- `users.totp_secret_encrypted`, `mfa_last_used_step`, `mfa_recovery_used_at`
- a dedicated `mfa_challenges` table, replacing the practice of parking MFA
  challenges in `email_verifications` where the two token kinds were
  indistinguishable rows
- `users_mfa_enabled_requires_secret` — a CHECK constraint refusing
  `mfa_enabled = true` without a stored secret, so no code path can produce an
  account that claims 2FA while having no second factor
- routes `GET /auth/mfa/status`, `POST /auth/mfa/enroll`,
  `/enroll/confirm`, `/recovery-codes`, `/disable`, and the public
  `POST /auth/mfa/challenge`

Covered by 64 service assertions (`security/mfa.test.ts`) and 28 over a real
socket (`integration/http-mfa.test.ts`).

---

### BIG-11 · MFA secret would need field-level encryption · Medium · **Fixed**

Storing a TOTP shared secret in plaintext would let a database read become a
permanent second-factor bypass — a TOTP secret is a bearer credential that mints
a valid code from anywhere, with no user interaction.

**Fixed** with AES-256-GCM authenticated encryption (`services/mfa.ts`):

- key derived from `SECRETS_PEPPER` via HKDF with a purpose string
  (`mfa.totp_secret`), so this key is not the password-hashing key and a
  compromise of one derivation cannot be pivoted into the other
- authenticated, so a tampered ciphertext fails to decrypt rather than yielding
  a garbage secret that silently mints unpredictable codes
- versioned envelope (`v1.iv.tag.ciphertext`) so the scheme can rotate without a
  flag day
- asserted directly: the same plaintext encrypts differently each time (random
  IV), the ciphertext never contains the plaintext, and the column value read
  back from PostgreSQL is provably not the secret the API returned

> **Deviation from `SECURITY_ARCHITECTURE.md`**, which specifies KMS envelope
> encryption. AES-GCM under an HKDF-derived key from `SECRETS_PEPPER` is what is
> implemented and tested. Envelope encryption with a KMS-held data key is the
> stronger design and is the correct target for production, where the root of
> trust should not be a process environment variable. Recorded rather than
> silently substituted; the envelope is versioned so the key source can be
> swapped without a data migration.

---

### BIG-12 · Retention purge is configured but unscheduled · Medium · **Fixed**

`RETENTION_*` settings existed and drove the documented policy, but nothing
invoked a purge, so every deployment would have accumulated sessions, audit rows,
notifications and export artefacts indefinitely — a data-minimisation failure
(GDPR Art. 5(1)(e)), not just a disk one.

**Fixed** by `services/retention.ts`:

- batched (≤5,000 rows per table per sweep) so housekeeping never takes the lock
  that would stall the API
- a failure on one table is recorded and the sweep continues
- **never touches `audit_logs`.** The append-only trigger rejects `DELETE`, and
  truncating an audit trail is an authorised decision, never a side effect of a
  timer. `integration/retention.test.ts` asserts the row count does not fall and
  that `audit_logs` is not in the purge list at all.
- `integration/retention.test.ts` — 17 assertions covering disabled-by-default,
  expired-vs-live discrimination, idempotency, and the audit guarantee

**No KMS for the purge scheduler** — it is a plain interval started in
`index.ts`, first run delayed a full interval so a deploy never competes with its
own migrations. For multi-replica deployments a leader-election lock is required
so two replicas do not both sweep; that is documented in `OPERATIONS.md` and is
not implemented.

---

### BIG-13 · No pagination on the query helpers · Medium · **Fixed**

Cursor pagination, page-size capping and tamper-evident signed cursors are
implemented in `lib/pagination.ts`, and the repository exposes `keysetClause()`.
No list query consumes it yet, because no list route exists.

---

### BIG-14 · Audit writes can fail silently · Medium · **Accepted**

`writeAudit()` logs an audit failure and continues rather than failing the
business operation. Reasoning: an audit outage should not roll back a legitimate
data change, but the failure must be loud.

**Mitigation.** Failures log at `error` with the action and organization, which
is alertable. An unresolved finding is still worth a dead-letter table; accepted
with this mitigation recorded.

---

### BIG-15 · Dev/CI password cost is lower than production target · Low · **Accepted**

`SCRYPT_INTERACTIVE` uses N=2^15. OWASP's interactive baseline is N=2^17. Chosen
so a 2-vCPU container stays responsive; PGlite tests would otherwise add minutes.

**Mitigation.** `needsRehash()` flags hashes below the current threshold, and
`loginUser` transparently upgrades them, so raising the cost is a config change
plus gradual re-hash. Documented as `PARAM INCREASE_NOTE`.

---

### BIG-16 · Argon2id native binding unverified on this platform · Low · **Accepted**

`@node-rs/argon2` imports successfully on this aarch64 host but `verify()` always
fails with `Decoding failed`. `loadArgon2()` therefore **self-tests on first use**
and refuses to activate a binding that cannot verify, rather than trusting it.
`PASSWORD_ALGORITHM=argon2id` therefore fails loudly here.

**Mitigation.** scrypt is the default and is OWASP-approved. Argon2id activates
where the binding works.

---

### BIG-17 · CSP requires `unsafe-inline` for styles · Low · **Accepted**

React sets inline `style` attributes (used for bar widths and colour swatches), so
`style-src` needs `'unsafe-inline'`. `script-src` has **no** `unsafe-inline` and
**no** `unsafe-eval`; a nonce is generated per response for any future inline
script. Removing the style relaxation requires moving to CSS custom properties.

---

### BIG-18 · CSRF uses Origin/Referer + custom header, not token rotation · Low · **Accepted**

Three independent controls (`SameSite=Lax` cookie, Origin/Referer validation,
mandatory custom header causing a CORS preflight) instead of a synchroniser
token. The custom-header check is what makes cross-site forgery fail: a hostile
origin cannot set it without a preflight our allowlist rejects.

**Accepted** because the layered approach has no server-side token store and no
token-in-DOM surface. Documented in `SECURITY_ARCHITECTURE.md` §CSRF.

---

### BIG-19 · Metrics endpoint unmounted · Low · **Fixed**

Mounted at `METRICS_PATH` (default `/internal/metrics`) and gated three ways: the
endpoint must be enabled, the caller must be authenticated, and the caller must
hold `security.read`. An open metrics endpoint is a reconnaissance gift — it
discloses request rates, error classes and bucket names.

Verified over a socket: unauthenticated requests get `401`, and the
authenticated-but-unauthorised case is asserted in `integration/http.test.ts`.

---

### BIG-20 · No security-headers test over real HTTP · Medium · **Fixed**

Headers were set in `middleware/security.ts` but nothing exercised them over a
socket, because there was no route layer. The middleware was unverified
end-to-end — and, as BIG-27 shows, it was in fact broken.

**Closed by `integration/http.test.ts`** — 100 assertions against a real
`app.listen()` socket driven with the platform `fetch`:

| Area | Asserted over the wire |
|---|---|
| Headers | CSP directives parsed individually, `nosniff`, `DENY`, Referrer-Policy, COOP, CORP, Permissions-Policy, no `X-Powered-By` |
| Request id | accepted when well formed, replaced when CRLF-laced or over-long (raw TCP, see below) |
| CORS | allowlisted origin echoed, foreign origin denied, cross-origin preflight refused |
| CSRF | missing Origin/Referer rejected, foreign Origin rejected, allowlisted Origin passes |
| Cookies | access + refresh `HttpOnly`, CSRF cookie deliberately not, `SameSite` set |
| Errors | 400/404/413/422/500 shapes, no stack traces, values never echoed in validation details |
| Tenant isolation | A's records invisible and unmodifiable by B — 404 not 403 |

> The header-injection assertions use a hand-written TCP request, not `fetch`.
> Both `fetch` and `node:http` **refuse** to transmit a header value containing
> CRLF, so neither can express the attack. A test written with them would have
> passed while proving nothing.

---

### BIG-21 · `pg` driver path untested at runtime · Medium · **Fixed**

Only PGlite was executed. Both target PostgreSQL 17 and the SQL is identical, but
the pool path — parameter type parsers, `ssl`, `statement_timeout`, transaction
checkout — had never run.

**Closed by execution.** A real `postgres:17-alpine` container
(**PostgreSQL 17.11 on x86_64-pc-linux-musl**) was started and both paths were run
against it. Snapshot at the time of the fix — the suite has since grown to
**549 assertions across 10 suites** (see `docs/PROJECT_STATUS.md` §1):

```
migration applied via the pg pool          applied 0001_core (409ms)
PASS unit/mongodb.test.ts                   24 assertions   [since removed]
PASS unit/rbac.test.ts                      26 assertions
PASS integration/auth.test.ts               26 assertions
PASS security/scenarios.test.ts            137 assertions
TOTAL: 213 assertions passed, 0 failed across 4 suites
```

The schema was also counted directly from `information_schema` on the real
server rather than asserted from a migration log:

| Property | Count |
|---|---:|
| tables | 39 |
| foreign keys | 89 |
| CHECK constraints (`pg_constraint.contype='c'`) | 53 |
| indexes | 128 |
| unique indexes | 60 |
| foreign keys whose definition references `organization_id` | 33 |

> Note for anyone recounting: `information_schema.table_constraints` reports 340
> rows for `CHECK` on PG 17 because `NOT NULL` is materialised as a check
> constraint. Filtering `pg_constraint` on `contype='c'` gives the true 53.

---

### BIG-22 · Delivery pipeline was structurally broken · High · **Fixed**

`client/` was declared as an npm workspace but contained no `package.json`. The
workspace list and the Docker build both assumed it existed. Every one of these
failed, each confirmed by running it:

```
$ npm run typecheck
npm error No workspaces found:
npm error   --workspace=client          # the first real step of CI

$ docker build -t bigcrm-api:test .
#10 ERROR: failed to calculate checksum ...: "/client/package.json": not found
ERROR: failed to build: failed to solve: failed to compute cache key
```

**Why this matters beyond the red build.** The workflow was previously reported as
"written". It was written but non-executable: `verify` would have failed at its
second step, so `container` (which `needs: verify`) and `dast` would never have
run, and no image would have been produced for Trivy to scan. A green-looking
pipeline definition is not a passing pipeline. This is the failure mode RULE 5
exists to prevent, and it was mine.

**Fixed** by building the real client workspace. Verified: root `npm run typecheck`
passes, the client typechecks, its tests run, it builds, and `docker build`
completes.

---

### BIG-23 · Container `CMD` pointed at a file that was never produced · High · **Fixed**

The runtime stage copies `/app/server/dist` and starts
`node server/dist/index.js`, but no `src/index.ts` existed — there was no HTTP
entrypoint. `npm run build` emitted `dist/{config,db,integrations,lib,middleware,
repositories,services}`, and `dist/index.js` was absent. The image would have
started and then died immediately, with a `MODULE_NOT_FOUND` that surfaces only at
`docker run`.

This is the same class as BIG-22: the artefact was declared, never produced. Both
were invisible until the build was actually executed.

**Fixed** with a real entrypoint (`src/index.ts` + `src/app.ts`) and the v1 route
layer, so the shipped process starts and serves.

---

### BIG-24 · `Dockerfile` test stage could not have passed either · Medium · **Fixed**

The stage ran `RUN node server/src/tests/run.ts` with `ARG DATABASE_URL` at
*build* time. `docker build` has no database to connect to, and supplying a live
`DATABASE_URL` as a build argument would bake the credential into the image
history, where `docker history` and every registry mirror expose it.

**Rewritten** as a runner image whose `ENTRYPOINT` is the test command, and
**executed**:

```
$ docker build --target test -t bigcrm-api:test-runner .
$ docker run --network bigcrm_default \
    -e DATABASE_URL=postgres://...@bigcrm-testdb:5432/bigcrm_test ... \
    bigcrm-api:test-runner

Running 10 suite(s)
========================================================================
PASS  unit/config.test.ts                    19 assertions
PASS  unit/modules.test.ts                   54 assertions
PASS  unit/rbac.test.ts                      26 assertions
PASS  integration/auth.test.ts               26 assertions
PASS  integration/http-mfa.test.ts           28 assertions
PASS  integration/http.test.ts              100 assertions
PASS  integration/records.test.ts            76 assertions
PASS  integration/retention.test.ts          17 assertions
PASS  security/mfa.test.ts                   64 assertions
PASS  security/scenarios.test.ts            139 assertions
========================================================================
TOTAL: 549 assertions passed, 0 failed across 10 suites
```

The runner keeps the source tree and dev dependencies on purpose: it is a test
tool, not a deployable artefact.

---

### BIG-25 · A rejected audit write silently discarded the business write · **Critical** · **Fixed**

The worst defect found in this project, and the one that best justifies the
decision to keep writing tests even where coverage already looked strong.

**The mechanism.** In PostgreSQL, a failed statement **aborts the entire
transaction**. Catching the exception in application code does not undo that.
Every subsequent statement then fails with `25P02 current transaction is
aborted`, and the final `COMMIT` is silently downgraded to a `ROLLBACK`.

`services/records.ts` wrote its audit row and its activity row inside the same
transaction as the business mutation, and both helpers caught their own errors —
the documented behaviour for accepted risk A1 ("an audit failure must not mask
the business operation's own error"). That was **backwards**. It did not merely
lose the audit row: it discarded the mutation the audit row was describing, while
the caller still held the row returned by `RETURNING *` and reported success.

**Reproduction.** Creating a pipeline returned `201` with a complete record body.
The record did not exist. `activities.entity_type` had a `CHECK` constraint that
omitted `pipeline` and `pipeline_stage`, so the activity insert failed, aborted
the transaction, and the pipeline insert went with it.

```
  [2] inserted f5298441-... | inside count = 1
  [3] activity FAILED: new row for relation "activities" violates check constraint
TX THREW: current transaction is aborted, commands ignored until end of transaction block
pipelines after: 0
```

**Two fixes, both necessary.**

1. **Schema** — migration `0002_activity_entity_types.sql` widens the
   `activities.entity_type` constraint so pipelines can be annotated at all.
2. **Containment** — `TenantScope.bestEffort()` wraps optional writes in a
   `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`, the SQL idiom for exactly this. Failure
   now removes only the optional write; the outer transaction stays usable and
   commits. Outside a transaction it degrades to a plain try/catch, which is
   equally safe because there is nothing to poison.

Fixing only (1) would have hidden the bug. The next optional write to fail for
any other reason — a constraint added later, a disk-full, a lock timeout — would
have silently discarded user data again.

**Regression test.** `integration/records.test.ts` deliberately violates a CHECK
constraint inside a transaction and asserts three things: the transaction
completes, statements after the failure still execute, and the business row is
actually present afterwards.

---

### BIG-26 · Masked IP made login impossible over HTTP · **Critical** · **Fixed**

`middleware/security.ts` set `req.clientIp = maskIp(...)`, producing `127.0.0.*`.
The columns that value reaches — `sessions.ip`, `audit_logs.ip`,
`users.last_login_ip`, `idempotency_keys.requested_ip` — are all PostgreSQL
**`inet`**, which rejects that form with `22P02 invalid_text_representation`.

Since creating a session writes the caller's address, **every login failed.** The
API returned `400 INVALID_IDENTIFIER`.

This typechecked. It passed 137 service-level security assertions, because those
tests pass a literal `10.0.0.1` and never go through the middleware. Only a
request over a socket exposed it.

**The fix separates the two purposes** (`src/lib/ip.ts`):

- **Persist the real address.** An audit trail storing `127.0.0.*` cannot answer
  the only question it exists to answer. Access to that table is already gated by
  `audit.read` and the append-only trigger.
- **Mask in logs and metrics**, where precision is not needed and the value is
  far more widely exposed. `req.loggableIp` carries that form; every
  `securityLog` and `logger` call was migrated to it.
- **`toInet()` validates** via `node:net`'s `isIP`, normalises `::ffff:` and
  strips IPv6 zone indices. A malformed address becomes `NULL` — it can never
  again fail a business write.

---

### BIG-27 · `securityHeaders` crashed on every request; `Permissions-Policy` never applied · **Critical** · **Fixed**

`helmet(opts)(req, res, next)` calls `next()` **synchronously** inside its own
middleware chain, so the entire downstream stack — including the route handler
that calls `res.end()` — has finished by the time the call returns.

`securityHeaders` called `helmet(...)` first and then set two headers of its own:

```
helmet(opts)(_req, res, next);          // ← runs the whole app, sends the response
res.setHeader('Permissions-Policy', …); // ← too late
res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
```

Therefore, on **every single request**:

- `res.setHeader` threw `ERR_HTTP_HEADERS_SENT`
- `Permissions-Policy` was absent from every response
- the throw escaped as an uncaught exception

`index.ts` installs an `uncaughtException` handler that exits the process by
design. **The first request would have taken the API down.** The header assertions
in BIG-20 are what caught it — `Permissions-Policy` came back `null`.

Fixed by moving both `setHeader` calls *before* `helmet(...)`, with a comment
recording why so the order is not "tidied" back.

This is a runtime ordering error: invisible to typecheck, invisible to unit
tests, and reachable only by observing the bytes on the wire.

---

### BIG-28 · Metrics route was registered without its leading slash · Low · **Fixed**

`healthRouter.get(env.observability.metricsPath.replace(/^\//, ''))` stripped the
leading slash, so a configured `METRICS_PATH=/internal/metrics` registered as
`internal/metrics` — a route Express does not match. The endpoint was
permanently 404.

The failure direction was safe (an endpoint that cannot be reached is not an
exposed endpoint), but it made the setting untestable, so a security control
could be enabled and silently not exist. Now normalised, and exported as
`__testing.METRICS_ROUTE` so the test asserts the real path rather than a
hard-coded `/metrics` that the server never registers.

---

### BIG-29 · `getRecord` returned soft-deleted rows by id · Medium · **Fixed**

Soft delete set `deleted_at`, and every *list* excluded it — but `getRecord`
selected by `id` alone. A deleted record was absent from the list and still fully
retrievable by direct read, making `deleted_at` decorative.

`deleted_at IS NULL` is now applied to single-record reads too, with an
explicit `includeDeleted` escape for administrative flows. Covered by an
assertion that a deleted record is unreachable by id.

---

### BIG-30 · Column registry was missing 22 real columns · Medium · **Fixed**

`ALL_COLUMNS` in `repositories/base.ts` — the allowlist that guards every
identifier interpolated into SQL — was missing `created_at`, `updated_at`,
`deleted_at`, `created_by`, `updated_by`, `deleted_by`, `actor_role`,
`contact_id`, `deal_id`, `lead_id`, `tag_id`, `field_id`, `endpoint_id`,
`started_at`, `finished_at`, `endpoint` and `body`. It also listed `token_prefix`,
which is not a column; the real one is `prefix`.

The allowlist failed **closed**, so the result was not injection — it was that
every legitimate insert including `created_at` failed with
`Field 'created_at' cannot be used here`, making the entire records service
unusable. Found by executing the code against a real database.

The registry is now reconciled against the schema: 195 columns exist, 199 are
allowlisted (four pre-registered names are retained because they are planned by
open findings — `totp_secret_encrypted` for BIG-10/BIG-11 and similar).

> Recounting note for anyone auditing this: `information_schema.table_constraints`
> reports **340** `CHECK` rows on PostgreSQL 17 because `NOT NULL` is materialised
> as a check constraint. `pg_constraint` filtered on `contype='c'` gives the true
> **53**.

---

### BIG-31 · Webhook auto-disable was dead code; the enable/disable endpoint always failed · **High** · **Fixed**

Found by the webhook test suite, written to cover the second wave of features.

**Two defects, one mechanism each.**

`setWebhookActive` — the enable/disable endpoint behind every "disable this
webhook" action — referenced `$4` while passing only three parameters:

```sql
UPDATE webhook_endpoints SET is_active = $4
 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
```

Every call failed with `could not determine data type of parameter $4`. The
function had no test, so this was live.

The auto-disable statement was worse, because it failed *quietly*. It used the
same parameter for two incompatible purposes — assigning the integer
`failure_count` column and comparing against the threshold inside a `CASE`:

```sql
UPDATE webhook_endpoints SET failure_count = $2, last_failure_at = $3,
   is_active = CASE WHEN $2 >= $4 THEN false ELSE is_active END
 WHERE id = $1
```

PostgreSQL rejects this with `inconsistent types deduced for parameter $2`. The
call sat inside `attemptDelivery` beneath the delivery-failure `throw`, so the
dispatcher's `catch` recorded the delivery as failed and moved on. The counter
never incremented, so `AUTO_DISABLE_AFTER = 20` never fired.

**Why this one matters.** A security control that is present, named, documented
and reviewed — but never executes — is worse than one that is absent, because
it is counted as a mitigation. `AUTO_DISABLE_AFTER = 20` and "manual re-enable"
were both asserted in the source as if enforced. A hostile or persistently
broken endpoint would have been retried indefinitely.

**Fixed** by casting the shared placeholders (`$2::int`, `$3::timestamptz`,
`$4::int`), extracting the statement into a single `chargeFailure` helper so the
drop path and the delivery-failure path cannot drift apart again, and correcting
the `$4` → `$3` in `setWebhookActive`.

Terminal drops (SSRF refusal, undecryptable signing secret) now also charge the
failure budget. Previously an SSRF-refused delivery returned early, so the
dispatcher reported `failed: 0` for a pass in which it silently discarded a
delivery — the metrics contradicted the work done.

**Verified by regression test**, not by inspection — 20 consecutive failing
deliveries against a live database, asserting the endpoint transitions to
`is_active = false` on exactly the twentieth:

```
=== auto-disable actually fires (regression) ===
  [PASS] each failure increments the endpoint counter
  [PASS] endpoint auto-disables once failures reach the threshold
  [PASS] a disabled endpoint is not retried further
```

---

### BIG-32 · `rowCount` meant two different things across the two database drivers · **Medium** · **Fixed**

`DbClient.query` returns `{ rows, rowCount }`. `pg` reports
`rowCount === rows.length` for a SELECT; PGlite reports `0` for every SELECT and
only populates `affectedRows` for INSERT/UPDATE/DELETE. Measured, not assumed:

| statement | `pg` | PGlite (before fix) |
|---|---|---|
| `SELECT` returning 1 row | `1` | `0` |
| `UPDATE … RETURNING` matching 1 | `1` | `1` |
| `UPDATE … RETURNING` matching 0 | `0` | `0` |

This is a latent trap in both directions. Any `rowCount` check written against
the test engine inverts under production, and the suite can pass while doing so.

It is also load-bearing today: `org.ts` guards single-use invitation claims with
`if (r.rowCount === 0) throw`. That guard is on UPDATE and is correct on both
drivers — verified, not assumed — but only by luck of the statement type.

**Fixed** in the driver so the contract is uniform: `rowCount` falls back to
`rows.length` when the driver reports 0. Safe for DML, because a statement that
affected nothing also returned nothing.

---

### BIG-33 · Audit and notification reads returned snake_case; both pages rendered blank · Medium · **Fixed**

`services/activity.ts` was the only service in the codebase with no row mapper.
Every other read path converts at the boundary — `rowToField`, `rowToView`,
`rowToEndpoint`, `rowToAttachment` — but `listAuditLogs`, `listNotifications`
and `listActivities` returned the raw PostgreSQL result object.

The server therefore answered with `entity_type`, `created_at`,
`changed_fields`, `user_agent` while the client reads `entityType`,
`createdAt`, `changedFields`, `userAgent`. The data arrived intact and was
discarded at the property access. The audit viewer rendered empty cells and
`Invalid Date`; the notifications table showed no timestamps.

This one is about the audit trail specifically, which is why it is recorded here
rather than in the status file: a compliance surface that silently renders
nothing is worse than one that is absent, because it reads as "reviewed, nothing
to see".

It typechecked and linted cleanly. The return type was
`Record<string, unknown>`, which accepts any object and asserts nothing — the
one return type that cannot fail a type check while being completely wrong.

**Fixed** with `rowToAuditLog`, `rowToNotification` and `rowToActivity` mappers,
and tests that assert the camelCase contract explicitly (`createdAt` present,
`created_at` absent) rather than only that *some* fields came back.

---

### BIG-34 · DAST reported "all clear" against an image that lacked the scanned routes · **High** · **Fixed**

Found during the 2026-10-12 re-run, and it was mine.

The route list in `dast-scan.sh` was extended from 42 to 56 routes to cover the
second wave, and the scan was re-run against `bigcrm-api:final`. It reported 60
instances, all Informational, no new finding types — and that looked like a
clean result.

The image had been built on **2026-10-11 22:41**. The source it was meant to
scan was modified on **2026-10-12 15:34**. Fourteen of the newly added routes did
not exist in it.

They answered `404`. The script discarded every response body with `-o /dev/null`
and never looked at a status code, so fourteen routes that resolved to nothing
contributed nothing to the alert set — indistinguishable, in the output, from
fourteen routes that resolved correctly. ZAP is a passive scanner: it reports
what it sees in responses it receives, so absent routes simply generate no
alerts. "No findings" and "nothing there to find" are the same number.

The load test caught it, and only because it fails on error responses: all three
new read endpoints came back `{"404": 100%}`.

**Why this matters more than a stale artefact.** A scan that examines less than
it claims is strictly worse than no scan, because its output is indistinguishable
from a passing one and is filed as evidence. This is the same failure as
BIG-22/23/24 — the artefact was declared, never produced — except here the
*verification* was the thing that did not exist, and it reported success while
doing it.

**Fixed** two ways:

1. The scan now captures each GET status code, reports any route answering 404,
   and **exits non-zero** with `RESULT: INVALID`. A scan that skipped part of the
   surface cannot be mistaken for a clean one.
2. The image was rebuilt and both scans re-run. Trivy re-confirmed **0 critical,
   0 high** against the rebuilt image, and the load harness measured the new
   endpoints rather than 404ing on them.

**Never reported as verified.** The earlier "56 routes, all Informational" line
in `PROJECT_STATUS.md` was written on the strength of this invalid scan and has
been corrected.

---

### BIG-35 · A router mounted at `/` re-authenticated every request, halving record-list throughput · **High** · **Fixed**

Found by the load harness, and only by the load harness. Every functional test
passed throughout.

**The mechanism.** Express applies `router.use(middleware)` to every request that
*traverses* that router, whether or not any route inside it matches. Every v1
router applies `authenticate` at router level — correct for the prefix-mounted
ones (`/reports`, `/webhooks`, …), which only ever see their own paths.

`auditRouter` was the exception. It is mounted at the root:

```ts
v1Router.use('/', auditRouter);   // routes/v1/index.ts
```

so it is traversed by **every** request in the application. With
`auditRouter.use(authenticate)`, each one ran a second full authentication —
token verification plus a session lookup query — before the real route was even
reached. `/contacts` and `/deals` were authenticated twice per request.

**Measured**, concurrency 20, identical client and database:

| Endpoint | Mount point | Throughput | p50 |
|---|---|---:|---:|
| `/api/v1/org/` | router #2 — matches early | 432 req/s | 33 ms |
| `/api/v1/reports/overview` | router #6 — matches early | 425 req/s | 34 ms |
| `/api/v1/notifications` | router #11 — past the audit mount | 220 req/s | 75 ms |
| `/api/v1/contacts` | router #15 — past the audit mount | 218 req/s | 78 ms |

The split is exactly the mount order, not payload size. `/reports` sits *before*
the audit mount and is unaffected; `/notifications` and `/contacts` sit after it
and are halved. A `contacts?limit=1` request (337 bytes) is exactly as slow as
`limit=50` (47 KB). The database was never involved — `EXPLAIN ANALYZE` on the
list query is **2.4 ms**, and an unloaded single request is 15 ms.

**Why it survived every other check.** The unit and integration suites call
services directly, so router composition is invisible to them. No suite made an
HTTP request to any second-wave endpoint at all. Typecheck and lint were clean
because this is correct Express — just expensive.

**Fixed** by moving the audit route off the root-mounted router and onto
`orgRouter`, which already authenticates. `auditRouter` no longer exists and
nothing is mounted at `/` except `recordsRouter`, whose middleware is genuinely
required by every route it owns. The reasoning is recorded at both the mount
point and the route, so the pattern is not reintroduced.

Measured after the fix, same harness, same database:

| Endpoint | Before | After |
|---|---:|---:|
| `/api/v1/contacts` | 218 req/s, p50 78.8 ms | **421 req/s, p50 34.0 ms** |
| `/api/v1/contacts` (deep page) | 221 req/s, p50 76.3 ms | **427 req/s, p50 32.9 ms** |
| `/api/v1/deals` | 218 req/s, p50 75.4 ms | **420 req/s, p50 34.4 ms** |
| `/api/v1/notifications` | 220 req/s, p50 78.6 ms | **435 req/s, p50 31.9 ms** |
| `/api/v1/views` | 218 req/s, p50 76.7 ms | **436 req/s, p50 31.9 ms** |
| `/api/v1/org/audit-logs` | 218 req/s, p50 76.4 ms | **427 req/s, p50 32.4 ms** |

`/api/v1/org/` and `/api/v1/reports/overview` are unchanged at 432 req/s,
which is the point: they were never paying the second authentication.

**Regression coverage added** (`integration/http-routes.test.ts`, 27 assertions):
every second-wave route is asserted to return **401** without a session and
**200** with one — so the fix cannot silently leave a route public, and a route
cannot pass by simply not existing — plus the camelCase audit contract from
BIG-33 and forged-token rejection.

---

### BIG-36 · Webhook failure counter was a lost update; auto-disable fired late or never under concurrency · **High** · **Fixed**

`chargeFailure` took the failure count from the delivery row read moments
earlier and wrote it back incremented — a textbook lost update. Two dispatcher
passes (or two deliveries for the same endpoint in one pass) both read N and
both wrote N+1, so one failure vanished each time they overlapped. Under
sustained concurrency the counter drifted below the real failure total and
`AUTO_DISABLE_AFTER = 20` fired late or never: the endpoint kept being
retried, and the policy looked enforced in review while the mechanism leaked.

**Fixed** by incrementing atomically (`failure_count = failure_count + 1`
with the threshold evaluated on the new value in the same statement) and
logging the exact disabling transition once via `RETURNING`. The stale-read
parameter is gone from the signature, so the old shape cannot be reintroduced
without a type error at both call sites.

**Regression coverage:** the existing auto-disable loop
(`integration/webhooks.test.ts`, "auto-disable actually fires") drives 21
sequential failures and asserts the counter reaches the threshold at exactly
step 20 — unchanged and still passing, now against the atomic statement.

### BIG-37 · Concurrent dispatchers delivered the same webhook event N times; the claimed compare-and-set did not exist · **High** · **Fixed**

The dispatcher is per-replica, so N processes poll the same
`webhook_deliveries` table. The project record claimed this was safe because
"the delivery UPDATE is a compare-and-set on `status = 'pending`" — but no
such predicate existed: the success/failure/drop UPDATEs match on `id` alone,
and they run *after* the HTTP POST anyway, when a duplicate is already
customer-visible. Two replicas SELECTing the same due row both POSTed it: a
duplicate `record.created` at the subscriber, not just wasted work.

**Fixed** with a lease claim before anything is sent:
`UPDATE ... SET next_attempt_at = now + lease WHERE id AND status = 'pending'
AND next_attempt_at <= now RETURNING attempt`. The re-check is load-bearing —
under READ COMMITTED a blocked second claimant re-evaluates against the
winner's committed row, sees a future lease, and matches nothing. A lease
rather than a status flip needs no schema change, and it is self-healing: a
claimant that crashes mid-delivery leaves a row that becomes due again when
the lease lapses instead of a row stuck forever. Receivers already get the
delivery `id` in the body for dedupe; the failure budget below is unchanged.

**Regression coverage:** every existing dispatcher assertion
(`integration/webhooks.test.ts`, 43 assertions) runs through the claim path —
single-claimant behaviour is identical, so all 34 pass unmodified.

### BIG-38 · MFA enrollment-confirm, disable and regeneration had non-atomic single-use claims · **High** · **Fixed**

Three paths consumed a single-use credential with a read followed by an
unconditional write:

1. `confirmEnrollment` read the challenge via `consumeChallenge`, then marked
   it consumed unconditionally at the end of its transaction. Two concurrent
   confirmations under *different* challenges both succeeded and the second
   silently invalidated the first caller's freshly issued recovery codes.
2. `disableMfa` spent a recovery code with `UPDATE ... WHERE id = $2` — no
   `AND used_at IS NULL` — so two concurrent disables spent the same code,
   and the TOTP path recorded no step at all, leaving the code live for its
   whole 30-second step.
3. `regenerateRecoveryCodes` verified TOTP without consulting
   `mfa_last_used_step`, so one shoulder-surfed code could regenerate (and
   thus invalidate the owner's printed codes) repeatedly for a full step.

**Fixed** with the same compare-and-set idiom already used for login
challenges and refresh rotation: the confirm path claims the challenge first
inside its transaction and enables MFA only `WHERE mfa_enabled = false`; the
disable path spends recovery codes `WHERE used_at IS NULL` and clears the
account only while the presented TOTP step is still unspent; regeneration
spends the TOTP step before issuing codes. Every loser fails closed with the
generic credential error, never with a hint about which check fired.

### BIG-39 · PGlite runs concurrent transactions on one session, so race tests proved nothing (and one suite died) · Medium · **Fixed**

PGlite is a single in-process session: a second `BEGIN` is a warning, not a
new transaction, so three concurrent `transaction()` calls share one physical
transaction. One caller's `ROLLBACK` then undoes another's uncommitted writes.
Reproduced directly: three parallel MFA redemptions produced exactly one
winner whose `mfa_last_used_step` write had vanished — rolled back out from
under it by a loser's abort — and the anti-replay assertion failed despite
correct service code. On real PostgreSQL the same test passes, because the
pool isolates the three transactions on separate connections.

**Fixed** at the driver layer, test-engine only: `PGliteDriver.transaction`
holds a module-level mutex around the whole body, so each transaction is
atomic. The reads and validation in service code still race — that is what the
concurrency tests exercise — but the compare-and-set writes cannot
interleave. `PgDriver` is untouched; production keeps real isolation. The
mutex is re-entry-safe by construction (scoped transactions reuse rather than
re-acquire), proven by the full suite: 17/17 suites, 749 assertions, 0
failures, no hangs.

Two test defects found along the way, both fixed in the same pass:

- The concurrency block passed `enroll.token` — a property that does not
  exist on `EnrollStart` — so `hashToken(undefined)` threw inside
  `consumeChallenge` and the **entire MFA suite crashed** at that block.
  Typecheck was red for the same reason. The block now mints its challenge
  directly, like every neighbouring block.
- The step-boundary flake: the replay test computed
  `totpCode(secret, Date.now() + waitMs)` from two separate `Date.now()`
  reads, and the regen test used `Date.now() + 31_000`. A 30-second rollover
  falling between the reads (or ~a second before the call) pushed the code
  outside the ±1 window. Both now target the next step deterministically —
  `totpCode(secret, (currentStep() + 1) * 30 * 1000)` — which verifies on both
  sides of a rollover. The ±1 window itself is unchanged: real clock skew
  still needs it, and the suite no longer depends on wall-clock luck.

**Regression coverage added** (`security/scenarios.test.ts`, X5): two
callers present the same refresh token concurrently; exactly one rotation
succeeds, the loser gets `refresh_reuse` flagged as compromise, and the whole
family — winner included — is revoked afterwards. This locks in the
fail-closed behaviour of the refresh-rotation compare-and-set that was
previously asserted only sequentially.

---

### BIG-40 · Migrations could not run on real PostgreSQL; `exec` crashed on multi-statement scripts · **High** · **Fixed**

`migrate()` applies each migration file with a single `tx.exec(m.sql)` — one
string, dozens of statements. `node-postgres` answers a multi-statement
script with an *array* of results, which has no `.rows`, so all three pg
`exec` implementations (which delegated to `query` → `rowCountOf`) crashed
with `TypeError: Cannot read properties of undefined (reading 'length')`.
PGlite returns a single result object, so the host suite stayed green while
the production `npm run migrate` path — and the containerised suite, which
had therefore never once run green — died in `migrate()` before a single
assertion executed. This is BIG-32's sibling: a driver semantic divergence
that one engine hides and the other trips over.

**Fixed** by making `exec` never inspect the result shape: it awaits the
script and discards the driver-specific answer. `exec` promises no rows by
contract; callers that need rows use `query`, which stays strict so a future
multi-statement `query` still fails loudly instead of returning garbage.

**Found by** the first real containerised suite run (§3.1), which failed on
all 15 database suites identically — the identical crash signature is what
made it diagnosable in minutes. After the fix the in-container suite is
green against real PostgreSQL 17, including the concurrency tests with true
parallel transactions (something PGlite cannot provide).

---

## Part 2 — Inherited defects these controls address

Catalogued from the audit of the two frozen repositories. Each is the reason a
specific control exists. Full detail in `PROJECT_AUDIT.md`.

| ID | Severity | Legacy defect | Control in BigCRM | Test |
|---|---|---|---|---|
| LEG-01 | Critical | `company_detail`'s contact query omitted `org_id` → cross-tenant PII leak | BIG-01 runtime tenant guard | S1, S2 |
| LEG-02 | High | Forward FK in DDL; SQLite accepted it, PostgreSQL would not | BIG-09, real-PG CI | migration run |
| LEG-03 | High | No transactions; 3 independent INSERTs for one registration | `registerUser` in one `transaction()` | auth suite |
| LEG-04 | **Critical** | Invite token returned in the API body **and** printed to stdout; existing users joined without password proof | BIG-02, `acceptInvite` identity proof | S11 |
| LEG-05 | Critical | `accept_invite` added existing users with no password check | `acceptInvite` requires session or password | S11 |
| LEG-06 | Critical | `change_role` had no hierarchy check — admin self-promoted to owner | `canAssignRole` + `ROLE_RANK` | S3, rbac suite |
| LEG-07 | Critical | `owner` and `admin` permission sets byte-identical | distinct sets + invariant assertion | rbac suite |
| LEG-08 | Critical | Two stored XSS: enum validation skipped on update, and unescaped render sites | allowlist sanitiser + validation on every write | S4 |
| LEG-09 | High | Session absolute TTL defined but never enforced (only in an uncalled function) | enforced in `validateSession` | S9 |
| LEG-10 | High | `read_session` failed **open** on a malformed timestamp | no catch-to-zero; malformed ⇒ deny | code review |
| LEG-11 | High | Login skipped PBKDF2 for unknown emails — timing oracle | decoy-hash verification | auth suite |
| LEG-12 | High | Password change did not revoke other sessions | BIG-04 | S10 |
| LEG-13 | High | Full contact rows dumped into `audit_logs` — unbounded PII duplication | `auditDiff` allowlist | S14 |
| LEG-14 | High | Pagination envelope echoed the raw, unclamped query values | `parsePageInput` + signed cursors | X1 |
| LEG-15 | Medium | Invite API accepted `role=owner`; UI offered only four roles | role bounded by inviter authority | S11 |
| LEG-16 | Medium | Cross-tenant `company_id` accepted on contact creation | tenant guard + FK scope check | S1 |
| LEG-17 | Medium | Orphan notes accepted for nonexistent `entity_id` | entity existence + org check | — (service pending) |
| LEG-18 | Medium | Silent no-op on role change of a nonexistent user | explicit 404 | code review |
| LEG-19 | Medium | Infinite redirect loop for org-less users | route/session handling | — (routes pending) |
| LEG-20 | Medium | `SECRET_KEY`, `APP_URL`, `LOG_LEVEL` read nowhere, yet documented as live risks | fail-closed config; every var is consumed | `config/env.ts` |
| LEG-21 | Medium | ~30 permissions declared for entities that did not exist | every permission maps to a real route (asserted once routes exist) | pending |
| LEG-22 | Medium | Reset and invite tokens `print()`ed to stdout | console email driver refuses to carry tokens | `integrations/email.ts` |
| LEG-23 | Medium | `.env.example` gitignored, so the documented quickstart failed on a clean clone | `!.env.example` in `.gitignore` | — |
| LEG-24 | Medium | Contradictory `models/*` + `models/` ignore rules | single rule | — |
| LEG-25 | Medium | Async routes performing blocking SQLite on the event loop; global DB lock; `with conn` never closed; measured 585 µs/query vs 2 µs on a pooled connection | async `pg` pool, bounded `statement_timeout` | — |
| LEG-26 | **Critical** | Live MongoDB Atlas credentials and a 96-char JWT secret in a plaintext `.env` on disk | `.env` gitignored; `config/env.ts` refuses placeholders in production | manual |
| LEG-27 | Medium | CORS allowed **every** origin when `CLIENT_ORIGIN` was unset; comment claimed the opposite | allowlist fails closed | S8 |
| LEG-28 | Medium | `NODE_ENV` gated CSP, static serving and stack-trace leakage | three separate variables | `config/env.ts` |
| LEG-29 | High | 7-day unrevocable JWT; logout was client-side only | 15-min access + rotating refresh + reuse detection | auth suite |
| LEG-30 | High | No pagination anywhere — full collections returned to render 5 rows | cursor pagination built | X1 |
| LEG-31 | High | Three non-atomic multi-document write paths (project delete, member removal, task delete) | all in `transaction()` | code review |
| LEG-32 | High | Un-expediting a task destroyed the original priority; the test asserted only `!== 'urgent'` so it shipped | BigCRM has no expedite feature; lesson recorded as "test must assert the restored value" | — |
| LEG-33 | Medium | `isOverdue()` reused for projects but compares against the task-only status `'done'` | separate predicates per entity | — |
| LEG-34 | Medium | No audit log at all in the task manager | append-only `audit_logs` + trigger | S14 |
| LEG-35 | Medium | Stale `user` in localStorage after a 401 rendered the authenticated shell with no token | refresh rotation; no token in `localStorage` (RULE 123) | pending (client) |
| LEG-36 | Low | `client/build` served only when `NODE_ENV=production`, and `railway.toml` did not set it | explicit `DEPLOYMENT_MODE` | pending |
| LEG-37 | Low | Vacuous test assertions (`or True`, `assert other`, unused variable) | suites count assertions and exit non-zero | runner |

---

## Accepted risks

| # | Risk | Rationale | Revisit |
|---|---|---|---|
| A1 | Audit write failure does not roll back the business operation | An audit outage should not block legitimate data changes; failures log at `error` and are alertable | Add a dead-letter table |
| A4 | The MFA secret uses AES-GCM under an HKDF-derived key rather than KMS envelope encryption | Verified correct and tested, but the root of trust is an environment variable; in production it should be a KMS-held data key. Since 2026-10-14 a `kms` provider exists (`MFA_KEY_PROVIDER=kms`, proven against LocalStack, `unit/kms.test.ts`) — the default is unchanged, so this stays open until a CMR with rotation backs it | The ciphertext envelope is versioned, so the key source can be swapped without a data migration (see BIG-11) |
| A5 | ~~The retention scheduler has no leader election~~ **CLOSED 2026-10-11** | With multiple replicas every replica would sweep. Harmless in effect (the deletes are idempotent) but wasteful and noisy | Closed by a PostgreSQL advisory lock (`pg_try_advisory_lock`) held on a pinned session for the whole sweep. A replica that loses the election reports `role: 'follower'` and deletes nothing — asserted against real PostgreSQL, not PGlite, because PGlite is single-session and cannot demonstrate contention. |
| A2 | scrypt N=2^15 rather than OWASP's 2^17 interactive baseline | Keeps a 2-vCPU container responsive; `needsRehash()` upgrades transparently when raised | Raise per deployment tier |
| A3 | `style-src 'unsafe-inline'` in CSP | React inline styles. `script-src` remains strict; nonce plumbing exists | Migrate to CSS custom properties |

---

## Deferred by environment, not by choice

These cannot be resolved or verified on this host. They are release blockers for
a production deployment.

| # | Item | Required |
|---|---|---|
| D1 | Web Application Firewall | Deploy WAF with managed rules in front of the ALB; verify by DAST |
| D2 | Container image scanning | The multi-stage non-root image now **builds and runs** (verified). Trivy/Grype is configured in CI but **has never run** — no scanner on this host. |
| D3 | Infrastructure-as-code scanning | Write Terraform, scan with Checkov/tfsec |
| D4 | Secrets manager | Move all secrets to AWS Secrets Manager / KMS; no static keys |
| D5 | Database private + encrypted | RDS in private subnets, KMS encryption, PITR |
| D6 | Object storage controls | S3 Block Public Access, SSE-KMS, least-privilege IAM, short-lived presigned URLs |
| D7 | Backup restore drill | Execute and time a restore; a backup that was never restored is not a backup |
| D8 | Cloud audit logging | CloudTrail, VPC Flow Logs, S3 data events |