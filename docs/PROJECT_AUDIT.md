# PROJECT_AUDIT

Three repositories were audited. Two are frozen inputs; the third is this
platform, audited again as the build progressed.

- **Part A** -- `Agentic/ticket-system` ("ShopWave CRM"), frozen
- **Part B** -- `taskmanager/team-task-manager` ("TaskFlow"), frozen
- **Part C** -- `main/BigCRM`, as built

Every finding below was verified by reading the code end-to-end and, where marked
**VERIFIED**, by executing it. Counts: **21 Critical, 27 High, 28 Medium,
24 Low, plus 8 test defects and 14 documentation discrepancies.**

---

# Part A -- `Agentic/ticket-system` (ShopWave CRM)

Python 3.11 - FastAPI - SQLite (stdlib `sqlite3`) - server-rendered HTML -
pytest - no build step, no ORM, no JS framework.

## A.1 Architecture as found

| Area | Reality |
|---|---|
| Backend | Single FastAPI app; `crm/api.py` (JSON API), `crm/web.py` (HTML pages) |
| Database | 20 tables, SQLite WAL, hand-rolled migration runner |
| Auth | PBKDF2-SHA256 200k, opaque DB-backed session tokens, HttpOnly cookie |
| Multi-tenancy | `org_id` resolved from the session -- the strongest part of the design |
| Frontend | HTML built as Python f-strings; one inline `onsubmit` handler |
| Tests | 21 pytest tests, all passing |
| Dependencies | 6 entries, **all unpinned, no lockfile** |
| Deploy | None. No Dockerfile, no CI |
| Dead weight | 2.3 GB of TinyLlama + LoRA weights, gitignored and unused |

## A.2 Verified findings

### A-01 - Stored XSS via skipped enum validation on update - **Critical - VERIFIED**

`create_contact` validates `status` and `lifecycle_stage`. `update_contact`
validates nothing but duplicate email. `crm/web.py:280` then renders
`lifecycle_stage` **without `html.escape`**.

```
PATCH /api/contacts/{id} {"lifecycle_stage":"<script>alert(1)</script>"}
 -> HTTP 200, stored verbatim
GET /contacts
 -> <span class='badge'><script>alert(1)</script></span>
```

### A-02 - Stored XSS via task `due_date` - **Critical - VERIFIED**

`TaskIn.due_date` is `Optional[str]` with no format validation. `web.py:256` and
`web.py:480` interpolate it unescaped while escaping every sibling field.

```
POST /api/tasks {"due_date":"<img src=x onerror=alert(1)>"} -> raw tag in /tasks
```

### A-03 - Cross-tenant PII leak - **Critical - VERIFIED**

`records.py:301` -- `company_detail`'s contact query has no `org_id` predicate
while every sibling query in the same function does. Instrumented the SQL to
confirm only `company_id` is bound.

### A-04 - Cross-tenant FK accepted - **Critical - VERIFIED**

`create_contact` writes `company_id`/`owner_id` unchecked; the FK proves existence,
not same-org membership. Org A attached a contact to Org B's company (`HTTP 201`)
and Org B's page then rendered Org A's contact name.

`crm/api.py:3-4` claims *"Tenant escape is impossible by construction."* Both
A-03 and A-04 disprove it.

### A-05 - Privilege escalation in `change_role` - **Critical - VERIFIED**

No role-hierarchy check. Only the *last* owner is protected.

```
ADMIN PATCH /api/members/self {role:"owner"} -> 200, admin became owner
ADMIN PATCH /api/members/owner {role:"viewer"} -> 200, owner demoted
```

### A-06 - Account takeover via invitation - **Critical - VERIFIED**

`accept_invite` adds an *existing* user without checking their password
(`authsvc.py:163-164`). The token is reachable because `api.py:238` returns it in
the response body **and** `emailing.py:21` prints it to stdout.

```
alice@victim.io (owner of her own company)
mallory@evil.io (admin of a different org) invites her as role=owner
accept with name="NOT ALICE", password="Attacker123"
 -> alice joined Mallory's org AS OWNER
```

### A-07 - No transactions - **High**

`register` issues three independent INSERTs (users, organizations,
organization_members), each on its own connection with its own commit. A crash
leaves a half-registered tenant. Same for `accept_invite`, `create_contact`,
`update_contact`.

### A-08 - Blocking SQLite on the event loop - **High**

Every route is `async def` but calls synchronous `sqlite3`. One slow query stalls
the server. Compounded by a module-level `threading.Lock()` that serialises all
database work process-wide.

### A-09 - `with conn` never closes the connection - **High - VERIFIED**

Python's context manager commits/rolls back; it does not `close()`. Each query
opens a new connection and relies on CPython refcounting.

```
db.fetchone('SELECT 1') = 585 µs
same query on one reused connection = 2 µs -> ~263× overhead
```

### A-10 - Session absolute TTL never enforced - **High - VERIFIED**

`SESSION_TTL_DAYS = 30` exists, but `read_session` checks only the idle timeout.
The absolute expiry lives solely in `cleanup_expired()`, which has **zero
callers**. A session touched hourly is valid forever.

### A-11 - `read_session` fails **open** - **High**

`except ValueError: idle = 0`. A malformed `last_seen` makes a session look brand
new indefinitely. Should fail closed.

### A-12 - Infinite redirect loop - **High - VERIFIED**

`web.py:220` requires `org_id` and 303s to `/login`; `_signin_and_land` sends
org-less users to `/settings`; `/settings` requires `org_id`.

```
GET / -> 303 /login -> 303 /settings -> 303 /login (forever)
```

### A-13 - Login timing oracle - **High**

`if not user or not verify_password(...)` -- for an unknown email PBKDF2 (200k
iterations) **never runs**. The message is identical; the timing is not.

### A-14 - Password change did not revoke sessions - **High**

`reset_password` revoked all sessions (line 101); `change_password` did not.

### A-15 - Unbounded PII in `audit_logs` - **High - VERIFIED**

Every `update_contact` stores the **entire row** as JSON -- `email`, `phone`,
`address`, `birthday`, `linkedin_url`, `description` and more. No redaction, no
retention, and nothing purges it (A-10).

### A-16 - Enum bypass breaks integrity and feeds XSS - **High - VERIFIED**

`ContactIn`/`CompanyIn` omit ~12 columns that `create_*` reads, so POST cannot set
them but PATCH can -- and PATCH skips the enum checks POST enforces.

### A-17 - Email normalisation asymmetry - **High - VERIFIED**

The duplicate check lowercases; the INSERT stores the raw value. Case and
whitespace variants persist as distinct rows.

### A-18 - Check-then-act races - **High**

`_clean_tags` and `register` both SELECT-then-INSERT against a UNIQUE constraint ->
concurrent requests get an `IntegrityError` -> 500 instead of a clean 400/409.

### A-19 - Missing permission checks - **Medium - VERIFIED**

`GET /api/search` and `GET /api/dashboard` call `_member` but never `_need(...)`.
Every sibling list route does. Currently unexploitable only because all five
roles happen to hold `contacts.read`.

### A-20 - Pagination envelope lies - **Medium - VERIFIED**

`_paginate()` clamps to `page≥1`, `page_size≤100`; the route echoes the **raw**
query values. `?page=0&page_size=9999` -> `{"page":0,"page_size":9999}`.

### A-21 - Silent no-op role change - **Medium - VERIFIED**

UPDATE on a nonexistent user matches 0 rows -> `{"ok": true}`.

### A-22 - Orphan notes - **Medium - VERIFIED**

`add_note` checks `entity_type` but never that `entity_id` exists or is in-org.

### A-23 - Session leak on switch-org - **Medium - VERIFIED**

Mints a new session, never revokes the old one. 1 -> 2 rows, never pruned.

### A-24 - `.env.example` gitignored - **Medium - VERIFIED**

A bare `.env.example` line follows the earlier `.env.*` rule, so the file is
untracked. The README's `cp .env.example .env` fails on a clean clone.

### A-25 - Contradictory `models/` ignore rules - **Medium - VERIFIED**

`models/*` + `!models/.gitkeep`, then `models/` -- the later rule wins, so even the
negation is dead.

### A-26 - DDL is not PostgreSQL-compatible - **Medium - VERIFIED**

`contacts` (line 93) FK-references `companies`, created at line **122**.
`docs/DATABASE.md` claims "Postgres-compatible". **Reproduced during the BigCRM
build: PostgreSQL returns `42P01 relation "o" does not exist`.**

### A-27 - `EMAIL_PROVIDER` has no implementation - **Medium - VERIFIED**

`get_provider()` raises `ValueError` for anything but `console`.
`docs/SECURITY.md` claims a provider interface exists. There is no SMTP code.

### A-28 - Tokens printed to stdout - **Medium - VERIFIED**

`print()` emits every reset, invite and verification token.

### A-29 - `owner` ≡ `admin` - **Medium - VERIFIED**

`owner-only = []`, `admin-only = []`. The last-owner guard protects a distinction
that does not exist.

### A-30 - Invite API accepts `role=owner` - **Medium - VERIFIED**

The API validates against all five roles; the HTML dropdown offers four. An admin
can mint an owner invitation.

### A-31 - Only 25 contacts visible, no pager - **Medium**

The UI renders the default page size, shows `total`, offers no pagination, and
exposes none of the API's `status`/`stage`/`owner_id`/`tag` filters.

### A-32 - Task assignment unreachable from the UI - **Medium**

`/tasks/new` has no assignee field, so the notify-on-assign feature can never fire
from a browser. No way to un-complete or change status.

### A-33 - Unvalidated web-form strings - **Medium**

`/settings/org` name and `/tasks` title have no max length; only the API path is
Pydantic-validated.

### A-34 - Empty note bodies via the form - **Medium**

`NoteIn` enforces `min_length=1`; the form path does not.

### A-35 - `HTTPException(303)` used for redirects - **Medium**

Works only because the error handler happens to forward `exc.headers`.

### A-36 - Dead configuration - **Low - VERIFIED**

`SECRET_KEY`, `APP_URL`, `LOG_LEVEL` -- **zero references in any `.py` file.**
Sessions are opaque DB tokens, so `SECRET_KEY` is vestigial. Both
`PROJECT_AUDIT.md §6` and `docs/SECURITY.md` list "SECRET_KEY defaults to
insecure value" as a live risk. **That risk is fictional.**

### A-37 - Dead imports - **Low - VERIFIED**

`api.py:7 import time` (unused); `web.py:12 from crm.api import _member, _session`
(both unused).

### A-38 - Dead code and phantom permissions - **Low - VERIFIED**

`cleanup_expired()` (0 callers) - `models.Page`, `models.ErrorBody` (unused) -
`contacts.archive`, `companies.archive`, `contacts.assign`, `companies.assign`
(declared, **never checked**) - **~30 permissions for `leads`/`deals`/`pipelines`,
which have no table, no route and no model.**

### A-39 - Dead parameter and expression - **Low**

`web.py:167` -- `ids["user_id"] and form.get("email","")`; `_signin_and_land`'s
`email` argument is never used in the body.

### A-40 - Dead `except` clause - **Low**

`web.py:605` catches `ValueError` from a function that only raises `AuthError`.

### A-41 - Layer violation - **Low**

`web.py:531`, `web.py:615` issue raw `db.fetchall` from the view layer.

### A-42 - `team_members` is a dead table - **Low - VERIFIED**

Read by `orgsvc.teams()` but **never written**. Teams is create+list only.

### A-43 - What is genuinely good

Recorded because an audit that lists only defects misrepresents the codebase.
Tenant scoping via session is well executed and cross-org access correctly
returns 404 (not 403) to avoid existence leaks. **SQL injection is fully closed**
-- every dynamic identifier is allowlisted. PBKDF2 with `hmac.compare_digest` is
sound. Single-use hashed tokens with server-side expiry. Enumeration-safe forgot.
Server-generated audit with actor/IP/UA.

### A-44 - Test defects

- `test_web.py:37` -- `assert "Add a note" in ... or True` -- **vacuously true**
- `test_auth.py:59-62` -- `other = [...]; assert other` -- **tautological**
- `test_records.py:55` -- variable assigned, never used
- `test_rbac.py:1` -- docstring claims coverage of "metrics"; **no metrics test exists**
- `tests/__init__.py` -- temp DB never deleted; all 21 tests **share one database**,
 making them order-dependent

Zero coverage: teams, switch-org, change-password, revoke-one, the successful
email-verify path, `update_org`, `remove_member`, last-owner protection, the enum
gap, XSS, the cross-tenant leak, CSRF, pagination clamping, the sort allowlist.

### A-45 - Documentation discrepancies - **14**

`PROJECT_AUDIT.md` describes a **deleted system**: references `app/api.py`,
`dashboard/app.py`, `app/db.py`, `app/config.py`, `app/tools/registry.py`,
`app/agents/prompts.py`, `training/requirements-train.txt`,
`scripts/download_model.py` -- none exist. Claims "87 tests" (now 21), a resolver
pipeline, refund tools, a queue/worker/DLQ, PII masking, retention purge, a
customer portal -- all deleted. Claims "0.929 eval" while
`models/tinyllama-1.1b-chat/eval_results.json` shows **0.738** with
`logps/chosen (-370.13)` *worse* than `logps/rejected (-296.07)` -- a degraded
DPO run. Also: `api.py:3-4` "tenant escape is impossible" (false),
`DATABASE.md` "Postgres-compatible" (false), `SECURITY.md` ×3 (provider interface,
SECRET_KEY risk, 30-day expiry), `DEPLOYMENT.md` quickstart (fails on clean clone).

### A.46 - Other assets

`models/shopwave-lora/adapter_config.json` hardcodes
`/home/harryoscorn/Projects/Agentic/ticket-system/...` -- **`BigCRM/` is missing
from the path**, so the adapter cannot resolve its base model. 2.3 GB of
unloadable weights on disk.

---

# Part B -- `taskmanager/team-task-manager` (TaskFlow)

Node 26 - Express 4.22 - Mongoose 8.24 - MongoDB - React 18 - Vite 8 -
hand-rolled test scripts - Railway.

## B.1 Architecture as found

Projects with per-project `owner`/`admin`/`member` roles, a Kanban board, task
assignment, and an admin warning system with a recipient inbox. 22 API routes,
6 React screens, 5 test scripts (124 assertions). `npm audit --omit=dev` -> 0.

**No multi-tenancy at all.** No organization concept exists.

## B.2 Verified findings

### B-01 - Live credentials in a plaintext `.env` - **Critical - VERIFIED**

```
MONGO_URI="mongodb://<username>:<password>@cluster0-shard-00-00.<cluster-host>:27017,..."
JWT_SECRET=<96-hex-character-signing-secret-redacted>
```

A real MongoDB Atlas username/password plus a real 96-char JWT signing secret.
> The literal values quoted in earlier revisions of this document were copied from
> the frozen repo and have been redacted. Reproducing a live credential inside a
> second repository is the same defect the audit is reporting, and it widens the
> exposure from one compromised host to two.
`.env` is correctly gitignored (never committed), but the credential is **live**
and readable by anyone with filesystem access. **Must be rotated.**

### B-02 - Un-expediting destroys the original priority - **High - VERIFIED**

```js
const previousPriority = task.priority; // captured
task.priority = task.expedited ? 'urgent' : (previousPriority === 'urgent' ? 'medium' : previousPriority);
```

The original is overwritten in the same document, so it is unrecoverable.

```
created priority=high -> expedite -> urgent -> un-expedite -> MEDIUM
```

The JSDoc claims "restores the priority". `test/README.md` lists *"Un-expediting
restores the previous priority"* as a guarded regression. **Both false** -- and
`test/test.js:218` asserts only `!== 'urgent'`, so `'medium'` passes. The test that
claims to guard the behaviour cannot detect the bug.

### B-03 - Stale user after a 401 renders an authenticated shell - **High**

The 401 interceptor clears only `token`. `AuthContext` sets `user` to null but
never removes `'user'` from localStorage. On reload `readStoredUser()` returns the
stale user, `loading` is `false`, and `ProtectedRoute` renders the shell **with no
token**. Self-heals only after error toasts fire.

### B-04 - CORS allows every origin when unconfigured - **High - VERIFIED**

```js
if (!allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
```

Empty allowlist => allow all. The comment claims the opposite: *"Without
CLIENT_ORIGIN we serve same-origin only."* The live `.env` does not set it.

```
Origin: https://evil.example -> Access-Control-Allow-Origin: https://evil.example
```

Limited impact -- the token lives in `localStorage`, not a cookie -- but this is a
real misconfiguration plus a comment that actively misleads.

### B-05 - `NODE_ENV` gated three security behaviours - **High**

CSP enablement (`index.js:34`), SPA static serving (`:113`), and stack-trace
leakage (`error.js:46`). `.env.example` says `development`; `railway.toml` does
not set it. Miss that one Railway variable -> blank page, **no CSP**, stack traces
in every 500.

### B-06 - 7-day unrevocable JWT - **High**

Signed `{id}` with `expiresIn:'7d'`, no `jti`, no version. **No logout endpoint
and no denylist** -- `handleLogout` clears localStorage only. A leaked token is
exploitable for a week with no kill switch.

### B-07 - No pagination anywhere - **High - VERIFIED**

`grep -rn "limit(\|skip(\|page\|cursor" server/` -> zero hits. `Dashboard` fetches
every visible task then `.slice(0,5)`. `Layout`'s badge fetches all warnings.
`GET /api/tasks` without `project` loads **all** project ids into an `$in`.

### B-08 - Three non-atomic multi-document writes - **High**

Delete-project cascade, member removal + task unassign, delete-task cascade. No
sessions or transactions; a mid-sequence failure leaves exactly the state the
comment at line 229 exists to prevent.

### B-09 - `isOverdue()` reused for projects - **Medium - VERIFIED**

Guards on `task.status !== 'done'`, but project statuses are
`active|completed|archived`. A **completed** project with a past due date renders
red "overdue".

### B-10 - Inconsistent link guards - **Medium**

`MyWarnings.jsx:96` guards `w.project &&`; line 110 guards only `w.task` while
interpolating `w.project?._id` -> `/projects/undefined`.

### B-11 - Dead payload field - **Medium**

`TaskModal` always sends `project` on PUT; the route neither validates nor reads it.

### B-12 - Refetch storms - **Medium**

Status change -> local set **then** a 4-request `fetchData()`. Warnings refetched
on every route change. Dashboard refetches what Layout already fetched.

### B-13 - Stale sidebar badge - **Medium**

Issuing a warning does a local insert with no refetch, so the badge goes stale.

### B-14 - `canEdit` and `TaskModal.locked` disagree - **Medium**

The Edit button shows for `isAdmin || creator === owner`, but `locked` disables
every field for a non-admin -- a creator who is not the owner clicks Edit and finds
a fully-disabled form.

### B-15 - Unguarded `localStorage` in render - **Medium**

`ThemeContext:9`, `AuthContext:17` call `localStorage.getItem` without try/catch
(private mode throws). `readStoredUser` and `theme-init.js` *are* guarded.

### B.16 - Latent `members` validator trap - **Medium**

`members` requires `length > 0`; remove-member filters then saves. Currently
unreachable (the owner cannot be removed) but a latent 400 from an unexpected place.

### B.17 - Redundant / deprecated patterns - **Low**

`.select('-password')` on a schema with `select: false`. Two `pre('save')` hooks
use the deprecated `next()` callback form. Two idioms for the same validator.

### B.18 - No audit log - **Medium**

Every mutation is unrecorded. For a CRM holding customer PII this is the single
largest compliance gap in the task manager.

### B.19 - What is genuinely good

**IDOR discipline** -- every lookup is membership-scoped; cross-project expedite
and warning-delete are blocked by scoping the query. **Timing-equalised login**
(`DUMMY_HASH`) -- precisely what Part A gets wrong. **Explicit member-edit
rejection** (403 listing the offending fields) rather than a silent 200.
**Validation layering** -- schema + express-validator + `runValidators` +
`assertObjectId`, with ~15 assertions proving 400-not-500. Real CSP with a
pre-paint `theme-init.js` written as an external file specifically so
`script-src 'self'` does not break it. A `Modal` that ref-holds `onClose` to avoid
stealing focus mid-typing. `syncIndexes()` instead of `dropIndexes()`.

### B.20 - Unpinned/unverified dependency ranges - **Low**

Declared ranges such as `express ^4.22.3`, `vite ^8.3.3`,
`react-router-dom ^7.18.4`. Installed versions confirmed present in
`node_modules`, but ranges are unpinned and there is no CI.

### B.21 - Working-tree state

`skills(fullstack).md` is deleted and uncommitted -- the project's own full-stack
verification checklist, including the phase-gated build sequence and the
master go/no-go audit. Losing it removes the build standard.

---

# Part C -- `main/BigCRM`, as built

## C.1 Stack and rationale

TypeScript - Express 5 - **PostgreSQL 17** - PGlite for dev/test (real PostgreSQL
in WASM, not a mock) - Zod - scrypt/Argon2id - hand-rolled assertion suites on
`node:test`.

## C.2 What was verified by execution

> **Historical snapshot.** This is the suite as it stood at the time of the audit,
> preserved because the findings below were written against it. The current
> figures are 549 server assertions across 10 suites -- see
> `docs/PROJECT_STATUS.md` §1. `unit/mongodb.test.ts` was removed on 2026-10-11
> when the MongoDB integration was dropped.

```bash
npm test
```
```
PASS unit/rbac.test.ts 26 assertions
PASS integration/auth.test.ts 26 assertions
PASS security/scenarios.test.ts 137 assertions
PASS unit/mongodb.test.ts 24 assertions [since removed]
TOTAL: 213 assertions passed, 0 failed across 4 suites
```

| Check | Result |
|---|---|
| Schema applies to real PostgreSQL 17.5 | 39 tables, 89 FKs, 128 indexes, 53 CHECKs |
| Migration re-run idempotent | 0 applied on second run |
| `audit_logs` UPDATE blocked by trigger | `audit_logs is append-only (attempted UPDATE)` |
| `audit_logs` DELETE blocked by trigger | `audit_logs is append-only (attempted DELETE)` |
| Forward FK rejected by PostgreSQL | `42P01` -- confirms A-26 |
| All 14 RULE 222 security scenarios | 137 assertions, all passing |

## C.3 Defects found **in this codebase** during the build

Five of these were found by the tests, not by review -- the reason the suite
exists.

| ID | Severity | Finding | How found |
|---|---|---|---|
| BIG-01 | **Critical** | `TenantScope` exposed the raw driver, so an unscoped query returned another tenant's row | **Scenario 1** |
| BIG-02 | **Critical** | `inviteMember` returned `__token` -- the invitation token in the response body, exactly `LEG-05`/`LEG-04` | **Scenario 11** |
| BIG-03 | **Critical** | `verifyPassword` mis-indexed the hash string; **every correct password returned false** | direct probe |
| BIG-04 | High | `revokeSessions` filtered `user_id IN (sessionIds)` -> silently revoked nothing; `changePassword` reported `{"revoked":0}` | instrumented probe |
| BIG-05 | High | Placeholder index collision -> `08P01` bind mismatch | probe |
| BIG-06 | High | The RBAC owner-only invariant **failed on first run** -- the matrix and the declared set had drifted | `assertOwnerOnlyInvariant()` |
| BIG-07 | High | `assignableRoles` ignored `users.invite`, so a sales rep ranked above "viewer" could "assign" one | rbac suite |
| BIG-08 | High | Composite FK declared before its backing UNIQUE constraint -> `42830` | migration run |

Full detail, fixes and regression tests: `SECURITY_FINDINGS.md`.

## C.4 Open findings in BigCRM

| ID | Severity | Finding |
|---|---|---|
| BIG-10 | Medium | MFA TOTP is implemented and tested but `users` has no secret column -- the flow cannot persist |
| BIG-11 | Medium | MFA secret needs KMS envelope encryption; not implemented |
| BIG-12 | Medium | Retention settings exist; no scheduler invokes a purge |
| BIG-20 | Medium | Security headers unverified over a real socket -- no route layer |
| BIG-21 | Medium | Only the PGlite driver has run; the `pg` pool path is untested |
| BIG-19 | Low | Metrics collected but no `/metrics` route mounted |

## C.5 Not verified at all

`npm run typecheck` - client build (no client sources) - Terraform apply (no
binary, no credentials) - container build and scan (no Docker) - DAST (no deployed
instance) - load testing - backup restore drill - S3/KMS/WAF/VPC controls - an
external penetration test.

**BigCRM is not production-ready.** The security core is real and tested; the
delivery surface is not built. See `PROJECT_STATUS.md` §5.

---

## Summary of counts

| Severity | Part A | Part B | Part C |
|---|---:|---:|---:|
| Critical | 6 | 1 | 3 |
| High | 12 | 7 | 5 |
| Medium | 18 | 7 | 5 |
| Low | 9 | 3 | 2 |
| **Subtotal** | **45** | **18** | **15** |
| Test defects | 5 | 1 | -- |
| Doc discrepancies | 14 | -- | -- |
| **Total** | **64** | **19** | **15** |