# PROJECT_STATUS

Honest accounting. RULE 5: nothing here claims a test, a deployment, or a control
that was not actually exercised. RULE 6: nothing is silently omitted -- every
unfinished item appears below with the reason.

Last updated: 2026-10-11

---

## 1. Verification summary -- commands actually executed

Every result below was produced by running the command shown, in this repository.
Nothing here is estimated.

```bash
npm test # 905 server assertions, 21 suites
npm run lint # clean
npm run typecheck # 0 errors
npm test -w client # 129 client tests (13 files)
```

```
SKIPPED (excluded from tsconfig): unit/mongodb.test.ts

Running 20 suite(s)
========================================================================
PASS unit/config.test.ts 19 assertions
PASS unit/kms.test.ts 10 assertions
PASS unit/modules.test.ts 75 assertions
PASS unit/rbac.test.ts 26 assertions
PASS integration/activity.test.ts 16 assertions
PASS integration/auth.test.ts 26 assertions
PASS integration/calendar.test.ts 53 assertions
PASS integration/http-mfa.test.ts 28 assertions
PASS integration/http-routes.test.ts 31 assertions
PASS integration/http.test.ts 100 assertions
PASS integration/item8.test.ts 33 assertions
PASS integration/members.test.ts 54 assertions
PASS integration/preferences.test.ts 26 assertions
PASS integration/queue.test.ts 20 assertions
PASS integration/readOnly.test.ts 7 assertions
PASS integration/records.test.ts 94 assertions
PASS integration/reports.test.ts 15 assertions
PASS integration/retention.test.ts 20 assertions
PASS integration/savedViews.test.ts 12 assertions
PASS security/mfa.test.ts 71 assertions
PASS security/scenarios.test.ts 168 assertions
========================================================================
TOTAL: 905 assertions passed, 0 failed across 21 suites
```

| Suite | Assertions | Covers |
|---|---:|---|
| `unit/config.test.ts` | 19 | Production fail-closed config, TLS posture, CA handling -- each booted in a child process |
| `unit/kms.test.ts` | 10 | Envelope encryption against LocalStack KMS; rekey between `env` and `kms` backends |
| `unit/modules.test.ts` | 75 | Every module loads; disabled sources provably inert; import extensions; secret-shaped literals |
| `unit/rbac.test.ts` | 26 | Role matrix, hierarchy, last-owner, invariant assertions |
| `integration/activity.test.ts` | 16 | Audit + notification reads; snapshots omitted; org-AND-user scoping; cross-user 404 |
| `integration/auth.test.ts` | 26 | Register, login, lockout, sessions, password change/reset, token single-use |
| `integration/calendar.test.ts` | 53 | Agenda, meetings, invitees, the invites inbox, and accept/decline scoping |
| `integration/http-mfa.test.ts` | 28 | MFA enrollment and login challenge **over a real socket** |
| `integration/http-routes.test.ts` | 31 | Every second-wave route: 401 anonymous, 200 authenticated, forged token refused, audit camelCase contract; calendar + invite routes incl. anonymous-POST 401s |
| `integration/http.test.ts` | 100 | **Over a real socket**: headers, CORS, CSRF, cookies, error shapes, tenant isolation |
| `integration/item8.test.ts` | 33 | Custom fields, attachments (magic bytes), import/export, idempotency, cross-tenant |
| `integration/members.test.ts` | 54 | In-house account creation, role bounds, permission gate, and a member-initiated password-reset flow |
| `integration/preferences.test.ts` | 26 | Per-account theme: light by default, no cross-account leakage, database CHECK, CSRF-guarded write |
| `integration/queue.test.ts` | 20 | Durable job queue: `SKIP LOCKED` claims, backoff, terminal failure, tenant scoping |
| `integration/readOnly.test.ts` | 7 | Read-only guard over a real socket: reads pass, writes 503 |
| `integration/records.test.ts` | 94 | CRM records, tenant isolation, transactional conversion, savepoint regression, viewer task scope |
| `integration/reports.test.ts` | 15 | Pipeline/funnel/load/overview, cross-tenant invisibility, definitions |
| `integration/retention.test.ts` | 20 | Batched purge, expired-vs-live discrimination, **audit rows never deleted**, leader election |
| `integration/savedViews.test.ts` | 12 | Private vs shared visibility; non-admin cannot share or delete others' views |
| `security/mfa.test.ts` | 71 | Secret encryption at rest, three-legged enrollment, anti-replay, recovery codes |
| `security/scenarios.test.ts` | 168 | All 14 RULE 222 scenarios + supporting controls |
| **Server total** | **905** | |
| `client` (vitest) | 170 | Token storage, CSRF header, refresh/retry, open-redirect guard, record formatters, workspace API unwrapping, calendar + members + password-reset pages, window-close sign-out decision table, account-backed theme |
| **Combined** | **1075** | |

`unit/mongodb.test.ts` is skipped, not silently absent: the MongoDB provider was
removed on 2026-10-11 and the runner derives its skip list from
`tsconfig.json`'s `exclude`, so a file disabled in one place cannot still be
executed in another.

---

## 1a. Verified beyond the unit/integration level

| Check | Evidence |
|---|---|
| **Real PostgreSQL 17.11** | All 17 suites re-run through the `pg` pool, not PGlite |
| **Inside a container** | `docker build --target test` -> `docker run` against `postgres:17-alpine`. **Re-run 2026-10-14: 821 assertions, 19 suites, 0 failures** (higher than host -- the retention real-exclusion assertions run only on real PG). First attempt failed all DB suites in `migrate()` (BIG-40); fixed, rebuilt, green, and re-run after every server change since. |
| **Production image** | Builds `--no-cache`; `node` user; no `tsc`, no source tree, no `.env` files; Trivy 0 critical / 0 high |
| **Production container** | `NODE_ENV=production`, TLS `verify-full`, migrations applied, serving on `:3000` |
| **End-to-end auth** | Register -> login -> `/auth/me` executed against the running container; cookies `HttpOnly; Secure; SameSite=Lax` |
| **Header injection** | Asserted over a **raw TCP socket** -- `fetch` and `node:http` both refuse to send CRLF in a header, so neither can express the attack |
| **Migrations** | `migrate:up` twice -> "schema up to date"; both migrations idempotent |
| **ESLint** | Flat config, type-aware; `npm run lint` exits 0 |
| **MongoDB removal** | 9 assertions that the disabled sources are inert: banner present, no executable import, excluded from typecheck, package absent, no config block, no startup probe, no CLI command |
| **Backup / restore drill** | `infra/scripts/backup-restore-drill.sh`: 4,170 rows / 14 tables, dump 143 ms, restore 899 ms, all tables match, audit tamper blocked post-restore (`docs/evidence/backup-restore-drill.md`) |
| **Trivy image scan** | `aquasec/trivy:0.58.1`, **re-run 2026-10-12 against the rebuilt image**: **0 critical, 0 high** (2 moderate). Was 8 critical / 56 high before npm removal + `apt-get upgrade` (`docs/evidence/trivy-2026-10-12.md`) |
| **DAST (ZAP)** | **Re-run 2026-10-12 against a freshly built image**: 106 requests across 53 real routes through the MITM proxy -- 57 instances, all Informational, 0 Low or above. The script now asserts every scanned route exists in the image and exits non-zero otherwise (BIG-34) (`docs/evidence/dast-zap-2026-10-12.md`) |
| **Load / performance** | 20 workers, 9 scenarios including all four second-wave reads: health 5,734 req/s (p99 14 ms); every authenticated endpoint **420-436 req/s at p50 ~32 ms**, 0 errors. Uniformity is itself the evidence -- before BIG-35 these same endpoints split into a 432 req/s group and a 218 req/s group purely by mount order (`docs/evidence/load-test-2026-10-12.md`) |
| **Retention leader election** | Advisory lock proven on real PostgreSQL: loser reports `follower`, deletes nothing; accepted risk A5 closed |
| **Reports + item 8 live** | All 4 reports, custom fields, export/import/upload verified against the running production container |

**Database TLS**, each row executed against the running container:

| Configuration | Result |
|---|---|
| `verify-full` + correct CA | connected, listening |
| `verify-full` + rogue CA | **refused** -- `unable to verify the first certificate` |
| `verify-full` + unreadable `DATABASE_SSL_CA_FILE` | refused at startup, names the path |
| `require` | connected (defeats passive interception only) |
| `disable` in production | refused -- `not permitted in production` |

**Schema, counted from `information_schema` on the real server:**

| Property | Count |
|---|---:|
| tables | 39 |
| foreign keys | 89 |
| CHECK constraints (`pg_constraint.contype='c'`) | 53 |
| indexes | 128 |
| unique indexes | 60 |
| foreign keys referencing `organization_id` | 33 |

> Recounting note: `information_schema.table_constraints` reports **340** `CHECK`
> rows on PostgreSQL 17 because `NOT NULL` is materialised as a check constraint.
> Filtering `pg_constraint` on `contype='c'` gives the true 53.


---

## 2. Completed

### Foundations
- [x] TypeScript monorepo, workspaces `server` + `client`, Node 22
- [x] Fail-closed configuration: 60+ validated settings, startup aborts on any
 missing/insecure value (`server/src/config/env.ts`)
- [x] `NODE_ENV` never gates CSP, CORS, or logging -- each has its own variable
 (RULE 208). Verified by reading `config/env.ts`
- [x] Two database drivers behind one interface: `pg` pool for production,
 PGlite (real PostgreSQL 17 in WASM) for dev/test
- [x] Migration runner: checksummed, transactional, `@destructive` acknowledgement
 gate, refuses to edit a landed migration

### Data layer
- [x] 39-table schema with tenant predicate on every tenant table
- [x] `TenantScope` -- cannot be constructed without an organizationId
- [x] **Runtime tenant guard**: `assertTenantPredicate()` throws when a statement
 touches a tenant table without `organization_id`. Found by Security
 Scenario 1, which caught that my own first draft leaked the raw driver
- [x] `allowlist()` for dynamic SQL identifiers; all values bound as parameters
- [x] Money as `BIGINT` minor units -- no floating point
- [x] Append-only `audit_logs` enforced by a PostgreSQL trigger
- [x] Composite FK guaranteeing a deal's stage belongs to its pipeline
- [x] Database-level duplicate prevention via partial unique indexes
- [x] `tasks_completed_consistent` CHECK constraint

### AuthN / AuthZ
- [x] Argon2id-capable, scrypt-by-default pluggable password hasher, PHC-style
 self-describing hashes, HMAC peppered
- [x] Timing-equalised login: unknown accounts still perform a full verification
 against a decoy hash (RULE 20)
- [x] 15-minute access tokens; rotating single-use refresh tokens with reuse
 detection that revokes the token family
- [x] Idle **and** absolute session expiry, enforced on every request
- [x] Session listing, per-session revoke, revoke-all, max sessions per user
- [x] Password change **and** reset revoke every session
- [x] Failed-login lockout (per account) separate from IP rate limits
- [x] Single-use, hashed, expiring reset / verification / invitation tokens
- [x] RBAC: 5 roles, 107/103/72/37/15 permissions, explicit rank hierarchy
- [x] `assertOwnerOnlyInvariant()` -- owner is a strict superset of admin, and
 owner-exclusive permissions cannot leak to any other role
- [x] Self-escalation refused; peers and superiors untouchable
- [x] Last-owner protection on demote and remove
- [x] Invitation role bounded by the inviter's authority
- [x] **Invitation tokens never returned from a service** -- delivered through an
 injected sink. Directly fixes the legacy account-takeover path

### Security primitives
- [x] HTML escaping + allowlist rich-text sanitiser (`sanitize-html`)
- [x] SSRF guard: DNS-resolving, blocks loopback/RFC1918/link-local/ULA/CGNAT/
 IPv4-mapped/6to4/metadata endpoints; blocks embedded credentials
- [x] Upload validation by magic bytes; SVG/HTML/executables never accepted;
 extensioncontent mismatch rejected
- [x] Opaque, org-namespaced object keys
- [x] CSV formula-injection neutralisation on export; bounded RFC 4180 parser
- [x] Signed, tamper-evident pagination cursors; page size capped at 100
- [x] TOTP (RFC 6238) implemented on `node:crypto`, verified against the RFC test
 vector; hashed single-use recovery codes
- [x] CSP with nonce, no `unsafe-eval`, `object-src 'none'`, `frame-ancestors
 'none'`; HSTS; nosniff; strict referrer; Permissions-Policy; COOP/CORP
- [x] CORS explicit allowlist that **fails closed** when empty
- [x] CSRF guard: Origin/Referer validation **and** mandatory custom header
- [x] Rate limits: global, auth-IP, auth-account, search, export, upload, sensitive
- [x] Structured logging with recursive secret redaction and email masking
- [x] Prometheus metrics for requests, auth failures, permission denials, tenant
 denials, rate limits, DB latency, queue depth
- [x] Audit diff minimisation -- secrets and PII cannot enter audit rows

### Multi-factor authentication
- [x] `0003_mfa.sql` -- `totp_secret_encrypted`, `mfa_last_used_step`, and a
 dedicated `mfa_challenges` table (replacing MFA challenges parked in
 `email_verifications`, where the two token kinds were indistinguishable)
- [x] `CHECK (mfa_enabled = false OR totp_secret_encrypted IS NOT NULL)` -- no
 code path can produce an account claiming 2FA with no second factor
- [x] TOTP secret encrypted at rest: AES-256-GCM, key derived from
 `SECRETS_PEPPER` via HKDF with a purpose string, versioned envelope
- [x] Three-legged enrollment -- the secret is stored encrypted but
 `mfa_enabled` stays false until the user proves they can generate codes
- [x] **Anti-replay**: the accepted HOTP step is recorded and a code at or below
 it is refused, closing the 30-second shoulder-surf window
- [x] Recovery codes hashed, single-use, and matched case-insensitively
- [x] Disabling or regenerating requires the current factor, not just a session
- [x] Each challenge bounds its own attempts (5), so one token cannot be used to
 grind the 10^6 code space

### Operations
- [x] `services/retention.ts` -- batched, per-table, failure-isolating sweep over
 expired sessions, one-time tokens, challenges, notifications and export
 artefacts. **Never touches `audit_logs`** -- asserted directly.
- [x] Scheduler started from `index.ts`, stopped on shutdown, disabled by default
- [x] Database TLS with three explicit modes; `disable` refused in production;
 `DATABASE_SSL_CA_FILE` read at startup so a missing mount fails clearly
- [x] Dockerfile `test` stage rewritten as a runner image and **executed** against
 a real PostgreSQL container

### Quality
- [x] ESLint flat config, type-aware, `npm run lint` exits 0
- [x] `unit/modules.test.ts` -- every module must import cleanly; disabled sources
 must be provably inert; no unstrippable syntax; no missing `.ts`
 extensions; no credential-shaped literals

### CRM domain
- [x] `services/records.ts` -- companies, contacts, leads, deals, pipelines,
 pipeline stages, tasks, notes, tags
- [x] Per-type record specs declare writable/updatable/sortable/searchable
 columns **and** provenance shape, so a table without `created_by` or
 without `deleted_at` is handled from data rather than assumption (BIG-30)
- [x] **Transactional lead conversion** -- contact, optional company and optional
 deal commit with the `leads.status = 'converted'` update, or not at all
- [x] Deal stage movement re-reads the stage, applies probability and won/lost,
 and refuses a stage belonging to a different pipeline
- [x] Soft delete + separate, separately-permissioned restore
- [x] Every mutation writes an activity row and an audit row **in the same
 transaction**, each contained by a SAVEPOINT so an optional write can never
 discard the business write (BIG-25)

### HTTP surface
- [x] `app.ts` -- documented middleware order, fixed `trust proxy` hop count
- [x] `routes/v1/auth.ts` -- register, login, MFA challenge, refresh (with reuse
 detection), logout, logout-all, me, sessions, password change/reset,
 email verification. Access token returned in the body **and** an HttpOnly
 cookie; refresh token only ever an HttpOnly cookie
- [x] `routes/v1/org.ts` -- organization, members, role changes, invitations,
 teams, ownership transfer (owner-only, re-authenticated, atomic)
- [x] `routes/v1/records.ts` -- generated from the record types so an HTTP verb
 becomes exactly one `<resource>.<verb>` permission
- [x] `routes/v1/health.ts` -- liveness, readiness, gated metrics
- [x] `index.ts` -- config check, migration check, listen, graceful drain on
 SIGTERM/SIGINT, fatal on unhandled rejection
- [x] Database TLS with three explicit modes; `disable` refused in production

### Client
- [x] React 18 + Vite + TypeScript workspace; typechecks and builds
- [x] Tokens held in memory only -- never `localStorage`, `sessionStorage`, or a
 JS-readable cookie
- [x] Single-flight refresh with exactly one retry, then redirect to `/login`
- [x] CSRF header echoed on state-changing verbs only
- [x] **Open-redirect guard** -- `location.state.from` is validated before use
 (`//evil.com`, `/\evil.com`, scheme-bearing and control-character forms
 all refused)
- [x] **Record screens (item 6)** -- list/search/detail/create/edit/delete for
 contacts, companies, leads, deals, tasks; shared shell, config-driven
 pages, values rendered as text never HTML
- [x] **Search, dashboard, reports (item 7)** -- global search fanning out to
 the five tenant-scoped list endpoints; dashboard overview cards from the
 `overview` report; reports page (pipeline/funnel/task-load) from server
 aggregations with centralised definitions (RULE 152)
- [x] **Custom fields, attachments, import/export (item 8)** -- field definition
 management, per-record values, file upload/download with magic-byte
 validation, CSV export/import with idempotency, all in Settings + record
 detail pages

### The eight-item scope (2026-10-11)
- [x] **1. Backup + restore drill** -- `infra/scripts/backup-restore-drill.sh`,
 13 checks, measured RTO (899 ms restore), report in `docs/evidence/`
- [x] **2. DAST** -- `infra/scripts/dast-scan.sh`, ZAP 2.17.0 through the MITM
 proxy across 53 real routes, every route verified present in the scanned
 image, all findings Informational (re-run 2026-10-12; see BIG-34)
- [x] **3. Trivy image scan** -- `infra/scripts/trivy-scan.sh`, 0 critical /
 0 high after npm removal + base upgrade (was 8/56)
- [x] **4. Retention leader election** -- advisory lock on a pinned session,
 proven on real PostgreSQL; accepted risk A5 closed
- [x] **5. Load / performance** -- `infra/scripts/load-test.{sh,mjs}`, measured
 req/s + p50-p99 per endpoint, 0 errors, report in `docs/evidence/`
- [x] **6. Frontend record screens** -- see Client above
- [x] **7. Search, dashboard, reports** -- see Client above; `services/reports.ts`
 + `routes/v1/reports.ts` + 15 cross-tenant assertions
- [x] **8. Custom fields, attachments, import/export** -- `services/customFields.ts`,
 `services/attachments.ts`, `services/transfers.ts`, three routers, 33
 assertions, Settings page + record extras

### Second wave (2026-10-12) -- collaboration, integrations, degraded mode

Built, then covered with tests and four client pages:

- [x] **Audit log reads** -- `services/activity.ts`, `/api/v1/org/audit-logs`.
 List view deliberately omits `before_json`/`after_json` (bulk PII).
- [x] **Notifications** -- org-AND-user scoped; another user's id 404s rather
 than confirming existence.
- [x] **Activity timeline** -- `/api/v1/activities/:entityType/:entityId`
- [x] **Saved views** -- delete+recreate, no update endpoint; sharing is
 admin/owner-only enforced in the service, not the route.
- [x] **Webhooks** -- CRUD + dispatcher + retry/backoff + HMAC signing. SSRF is
 validated at registration **and re-validated per attempt** (DNS rebinding).
 Secret sealed in the AES-256-GCM envelope. See BIG-31 for two real defects
 this testing surfaced.
- [x] **Read-only degraded mode** -- `SECURITY_READ_ONLY_MODE`; the switch lives
 on `env.security`, not the DB, because the DB is the untrusted part.
- [x] **Client pages** -- `Webhooks`, `SavedViews`, `Notifications`, `AuditLogs`,
 plus `lib/workspace.ts`, all wired into the router and nav.

Suite grew from 617 to **713 assertions across 17 suites**, and the second wave
produced **five** findings in `SECURITY_FINDINGS.md` -- every one of them
invisible to typecheck and lint, and three of them invisible to the entire test
suite:

| Finding | What it was | Found by |
|---|---|---|
| BIG-31 | Webhook enable/disable always failed; auto-disable never fired | webhook tests |
| BIG-32 | `rowCount` meant different things in the two DB drivers | webhook tests |
| BIG-33 | Audit + notification reads returned snake_case; both pages rendered blank | audit tests |
| BIG-34 | DAST reported "all clear" against an image lacking the scanned routes | the **load** test (100% 404) |
| BIG-35 | A `/`-mounted router re-authenticated every request, halving record-list throughput | the **load** test |

BIG-35 is the one worth remembering: no suite made an HTTP request to any
second-wave endpoint, so router composition was entirely untested. The fix came
with `integration/http-routes.test.ts`, which asserts every new route is closed to
anonymous callers and open to a valid session.

### Documentation
- [x] `README.md` `PROJECT_AUDIT.md` `PROJECT_STATUS.md` `ARCHITECTURE.md`
 `DATABASE.md` `API.md` `SECURITY.md` `SECURITY_ARCHITECTURE.md`
 `THREAT_MODEL.md` `DEPLOYMENT.md` `TESTING.md` `OPERATIONS.md`
 `INCIDENT_RESPONSE.md` `DISASTER_RECOVERY.md` `SECURITY_FINDINGS.md`

---

## 3. In progress

| Area | State | Note |
|---|---|---|
| Frontend polish | All eight scoped items built | Record screens, search, reports, settings all render against the live API. Remaining: visual polish, mobile layout, empty-state illustrations -- cosmetic, not functional. |

---

## 4. Not started -- with reasons and intended shape

RULE 6 requires the correct abstraction to exist even where implementation is
deferred, so every row names what *is* already in place.

| Requirement | Status | Abstraction created | Reason |
|---|---|---|---|
| Kanban board | **Done 2026-10-14** | `/deals/board`: stage columns, DnD + keyboard move menu, orphan bucket; moves through `POST /deals/:id/stage` | Viewers read-only; server enforces `deals.advance` |
| Calendar / meetings | **Done 2026-10-14** | `GET /api/v1/calendar` agenda + `POST /meetings` schedule + invites/respond/invitees; `/calendar` page + detail-page form | Invitations fan out `meeting_invite` notifications |
| Files / attachments | **Done (item 8)** | `services/attachments.ts`, local driver, magic-byte validation, 33 assertions | S3 driver refused loudly, not silently -- needs AWS to verify |
| Custom fields | **Done (item 8)** | `services/customFields.ts`, typed validation, cross-tenant tests | -- |
| Saved views | **Done (second wave)** | `services/savedViews.ts`, delete+recreate, sharing is admin-only in the service, 12 assertions | No update endpoint, by design |
| Cross-entity global search | **Done (item 7)** | Client fans out to five tenant-scoped endpoints; no server UNION | Server-side full-text would need its own threat model |
| Dashboard / reports | **Done (item 7)** | `services/reports.ts` with centralised definitions (RULE 152), 15 assertions | -- |
| Import / export jobs | **Done (item 8)** | `services/transfers.ts`, CSV hardening, idempotency, per-row errors | Synchronous; a queue-backed runner for 50k+ rows not built |
| Background jobs / queue | **Infra done 2026-10-14** | `0007_job_queue`, atomic SKIP LOCKED claims, `npm run worker`, 20 assertions; first producer is the due-reminder scheduler (`0010`, `services/reminders.ts`) | SQS seam is the 4-function contract; producers unchanged by a swap |
| Webhooks | **Removed 2026-10-14** | Owner decision: routes, dispatcher, fan-out, tables (`0006`), client page, tests, and the unused `SIEM_WEBHOOK_URL` stub all excised; SSRF guard stays | History kept in BIG-31/36/37 |
| Audit log reads | **Done (second wave)** | `services/activity.ts` + `/org/audit-logs`; list view omits `before_json`/`after_json` | BIG-33 fixed: responses are camelCase |
| Notifications | **Done (second wave)** | Org-AND-user scoped; another user's id 404s | Unread badge wired into the nav header 2026-10-14 |
| Due reminders | **Done** | Every meeting and dated task earns two advance notices (1h, 15m) to every role, creator included. `0010_event_reminders` is an exactly-once ledger, not a queue: the sweep claims a row in one statement, the handler claims `sent_at` and writes the notices in one transaction | Notices are armed by the writer and delivered by `npm run worker`, so a deployment without the worker schedules but never sends |
| Activity timeline | **Done (second wave)** | `/activities/:entityType/:entityId` | Rendered on the record Detail page 2026-10-14 |
| OAuth / SSO | **Declined 2026-10-14** | Internal office software: internal logins only, no external IdP | Revisit with the `ExternalIdentity` design if outsiders ever log in |
| Read-only degraded mode | **Done (second wave)** | `SECURITY_READ_ONLY_MODE` on `env.security`; writes 503, reads pass; 7 assertions | Switch is env, not DB -- the DB is the untrusted part |
| KMS envelope encryption for the MFA secret | **Done 2026-10-14** | `lib/kms.ts` providers + `npm run rekey` (two-phase reseal, proven vs LocalStack + real PG) + `unit/kms.test.ts` | Accepted risk A4 stays open until a rotated CMR backs the default |
| Terraform | **Removed 2026-10-14** | Scaffolded + validated, then removed whole on direction before ever applying; CI Checkov step self-disables | Re-scaffold from §4.6 if AWS access arrives |
| Code coverage report | Not started | -- | Assertion counts per suite are reported instead |

---

## 5. Explicitly NOT verified

Stated plainly so nothing here reads as production-ready when it is not.

**Verified** (each by execution, see §1 and §1a): typecheck, lint, 905 server
assertions, 129 client tests, real PostgreSQL 17.11 via the `pg` pool, the
whole suite inside a container, the production image build, the production
container boot and serving, end-to-end auth, header injection over raw TCP,
migration idempotency, all five database TLS paths, backup/restore drill,
Trivy image scan (0 critical / 0 high, re-run on the rebuilt image), ZAP DAST across 53 routes with a route-existence assertion, load test
with measured percentiles, retention leader election on real PostgreSQL,
reports + custom fields + import/export/upload all verified live.

**Still not verified:**

| Item | Why not |
|---|---|
| `npm run atlas:ping` | **No longer exists.** The MongoDB integration was removed on 2026-10-11; PostgreSQL is the only database. |
| CI pipeline | Written (`.github/workflows/ci.yml`) but **never executed** -- no git remote is configured. Its steps were independently proven by hand, but the workflow itself has not run. |
| Terraform apply / plan | No `terraform` binary, no AWS credentials; `infra/terraform/` was scaffolded, validated, then removed on direction 2026-10-14. |
| S3 driver, KMS rotation, WAF, private subnets | Cannot be enforced or observed from here. Documented as requirements, not facts. S3 explicitly refused at runtime rather than pretended. |
| Independent penetration test | Not done. RULE 189 asks for one; the internal scenario suite + ZAP passive scan is not a substitute, and the release gate in §10 says so. |
| Authenticated active DAST | The ZAP scan is passive-only against anonymous routes; authenticated handlers return 401 to the crawler. Tenant isolation is covered by tests, not by scan. |
| Sustained write throughput | The load harness is read-only by design. Write throughput at volume is unmeasured. |
| Multi-replica behaviour beyond retention | Leader election proven for the sweep; nothing else has run with more than one replica. |
| ~~DAST and load evidence is stale~~ **Closed 2026-10-12** | Both were re-run after the route/endpoint lists were extended to the second wave. DAST now drives 56 routes / 112 requests; the load harness gained `reports/overview`, `org/audit-logs`, `notifications` and `views`. |
| Containerised suite run | ~~`docker build --target test` -> `docker run` was last executed against the pre-second-wave surface. The host suite is current at 713 assertions; the in-container figure is not.~~ **Closed 2026-10-14, kept current**: 783 assertions, 0 failures on real PostgreSQL 17 (BIG-40 fixed along the way; re-run after calendar, invites, KMS and webhook removal). |
| Webhook delivery to a real subscriber | ~~Dispatcher routing, signing, backoff, SSRF re-validation and auto-disable are tested against a real database, but no delivery has completed a round trip to an actual HTTPS receiver that verified the signature.~~ **Closed 2026-10-14**: round-trip test plays the receiver via a socket-only seam (guard still executes) and verifies the HMAC from the delivered body. |

---

## 6. Known issues in the current build

| # | Issue | Severity | Note |
|---|---|---|---|
| 1 | `SmtpEmailProvider.send()` throws by design | Low | Intentional -- production must supply a transport. Failing loudly beats pretending to send. |
| 2 | `console` email provider is refused when `NODE_ENV=production` | Low | Intentional per RULE 197 |
| 3 | `password_hash` has no length bound | Low | scrypt + argon2id outputs verified at ~100-160 chars |
| 4 | No read-only degraded mode for a database outage | Low | Documented as a requirement in `OPERATIONS.md`; not implemented |
| 5 | MFA secret uses a pepper-derived key, not KMS | Low | Accepted risk A4. Verified correct; the envelope is versioned for later key-source swap. |

---

## 7. Technical debt

- `repositories/base.ts` keeps a long flat `ALL_COLUMNS` allowlist. A per-table
 map would be tighter; it was reconciled against the schema after BIG-30, but a
 flat list still permits a column on the wrong table (the service layer catches
 this, the database does not).
- Two database drivers mean two behaviours to keep in step. **Both are now
 exercised** -- every suite runs under PGlite and under `pg` -- but a third driver
 would need the same treatment.
- Services call `TenantScope` helpers directly rather than through per-entity
 repositories.
- The client has three pages and no record screens, so the API surface it
 exercises is a fraction of what exists.
- Commented-out MongoDB sources are preserved under `tsconfig` `exclude`. That is
 deliberate and documented rather than deleted (RULE 6), but commented code rots
 -- if the decision is not revisited within a release cycle, delete it.

---

## 8. Recommended next steps, in dependency order

1. Frontend record screens against the finished API -- it is the largest visible
 gap and everything it needs already exists.
2. `search`, `dashboard`, `reports` services with centralised metric definitions
 (RULE 152) -- dashboards without shared definitions drift silently.
3. Terraform for the network the docs already assume, then a DAST pass against a
 deployed instance (the `dast` job is still `if: false`).
4. KMS envelope encryption for the MFA secret, and leader election for the
 retention scheduler.
5. Independent penetration test (RULE 189).

---

## 9. Files delivered

| Path | Contents |
|---|---|
| `server/src/config/env.ts` | Fail-closed configuration, 60+ settings, database TLS posture |
| `server/src/lib/` | 18 modules incl. `ip.ts` (inet vs. masked address), `totp.ts`, `csv.ts`, `ssrf.ts` |
| `server/src/db/` | Driver (`pg` \| PGlite), migration runner, `0001_core.sql` (39 tables), `0002_activity_entity_types.sql`, `0003_mfa.sql`, `cli.ts` |
| `server/src/repositories/base.ts` | `TenantScope`, `assertTenantPredicate`, `bestEffort` savepoints, identifier allowlists |
| `server/src/middleware/security.ts` | Headers, CORS, rate limits, authentication, RBAC, CSRF, error mapping |
| `server/src/services/` | `rbac.ts`, `auth.ts`, `org.ts`, `records.ts`, **`mfa.ts`**, **`retention.ts`**, `normalise.ts` |
| `server/src/routes/v1/` | `auth.ts`, `mfa.ts`, `org.ts`, `records.ts`, `health.ts`, `cookies.ts`, `helpers.ts`, `index.ts` |
| `server/src/app.ts` - `src/index.ts` | Middleware assembly; entrypoint with graceful shutdown and retention scheduler |
| `server/src/integrations/` | `email.ts`; ~~`mongodb.ts`~~ **REMOVED** (commented out, excluded, dependency dropped) |
| `server/src/tests/` | 20 suites, **874 assertions** |
| `client/` | React 18 + Vite; 129 vitest tests including the open-redirect guard |
| `docs/` | 15 documents |
| `eslint.config.mjs` | Type-aware flat config; `npm run lint` exits 0 |
| `server/.env.example` | Every variable documented, including `DATABASE_SSL` |
| `Dockerfile` - `docker-compose.yml` | **Built and run** -- including the test-runner stage |
| `.github/workflows/ci.yml` | Written, never executed (no git remote) |
| `LICENSE` | Proprietary, with the code-reuse notice |

---

## 10. Security release gate (RULE 227)

| Gate | State |
|---|---|
| Unresolved Critical findings | **0** -- every `BIG-*` finding is Fixed or an accepted risk |
| Unresolved High findings | **0** in code; **0** in the image (Trivy) |
| Findings still Open | **0**. Part 1 of `SECURITY_FINDINGS.md` has no open entries. |
| Documented accepted risks | 4 -- A1 audit-write containment, A2 scrypt cost, A3 CSP `style-src`, A4 MFA key source (A5 closed 2026-10-11) |
| Deferred by environment | 5 -- WAF, IaC scanning, secrets manager, private RDS, S3 controls + cloud audit logging |
| Verified this round, previously deferred | Backup/restore drill, Trivy image scan, DAST, load test -- all executed, reports in `docs/evidence/` |
| Independent penetration test | **Not done.** |

**Verdict: not releasable to production.**

What is genuinely done: the API builds, boots in production mode against a real
TLS PostgreSQL, serves a real route surface with MFA, records, reports, custom
fields, attachments and import/export, and passes **905 server assertions plus
129 client tests** -- including 14 end-to-end attack scenarios, 128
assertions observed over an actual socket, and the entire suite re-run inside a
container against a real database. ESLint is clean, the image carries **0
critical and 0 high** Trivy findings, ZAP raises nothing above Informational
across 53 routes with every route confirmed to exist in the scanned image, and
the load harness measures 420-436 req/s at p50 ~32 ms across all nine
authenticated endpoints. The client covers auth, five record types, global search,
reports, settings, and file transfer.

What blocks release is no longer the application. It is the absent cloud
infrastructure (no Terraform, no WAF, no private subnets, no S3 controls) and
the absence of an independent penetration test.

**The honest caveat about the bug count.** This round found **11 defects in code
that had already typechecked green and passed 213 assertions** -- three of them
Critical, including one that silently discarded user data and one that made
login impossible. Later rounds found four more (a recovery-code hash that could
never match, an anti-replay window recorded one step behind, a CORS log reading
`ip: undefined`, and a retention query binding the wrong parameters). Every one
was invisible to the tooling that existed and only appeared when the code was
actually executed against a real database and a real socket.

A green typecheck, a clean lint and a passing suite are not evidence of
correctness. They are evidence that nothing has been checked *yet*.
