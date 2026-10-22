# HANDOFF — BigCRM

> **Purpose.** Everything a competent engineer needs to take over this project cold: what it is, what
> was built, what is verified, what is not, what is unfinished, and what the open decision is.
>
> **Audience.** Whoever picks this up next — including "future me".
>
> **Read order if you are in a hurry:** §1 (snapshot) → §6 (recent, undocumented work) → §11 (gaps)
> → §13 (next steps).

---

## Contents

1. [Snapshot](#1-snapshot)
2. [Repository state and how to verify it](#2-repository-state-and-how-to-verify-it)
3. [What the product does](#3-what-the-product-does)
4. [Architecture](#4-architecture)
5. [Code map](#5-code-map)
6. [Recent work — four features](#6-recent-work--four-features)
6.5. [Third wave — meeting lifecycle, negative testing, first end-to-end run](#65-third-wave-2026-10-22--meeting-lifecycle-negative-testing-first-end-to-end-run)
7. [Background job system](#7-background-job-system)
8. [Testing](#8-testing)
9. [Documentation map](#9-documentation-map)
10. [Deployment and hosting](#10-deployment-and-hosting)
11. [Known gaps, risks and stale claims](#11-known-gaps-risks-and-stale-claims)
12. [Conventions and gotchas](#12-conventions-and-gotchas)
13. [Suggested next steps](#13-suggested-next-steps)
14. [Glossary](#14-glossary)

---

## 1. Snapshot

| | |
|---|---|
| **What** | Multi-tenant CRM SaaS for small offices. Employees are created in-house by an owner/admin — there is **no public sign-up**. |
| **Stack** | Node 22 + Express 5 + PostgreSQL 15+ (developed on 17.5) + React 18 + Vite 5, TypeScript throughout, npm workspaces monorepo. |
| **Repo** | `github.com:manvendrasang/BigCRM`, branch `master`, tracking `origin/master`. |
| **HEAD** | `2ac63ba` — *calendar viewing/role based tasks/notification updates* |
| **Tree** | **Dirty.** The third-wave work (meeting lifecycle, negative testing, the end-to-end test) is in the working tree, uncommitted. Everything in [§6.5](#65-third-wave-2026-10-22--meeting-lifecycle-negative-testing-first-end-to-end-run) is verified but not yet committed or pushed. |
| **Licence** | Proprietary. Copyright © 2026 Manvendra Sang. All rights reserved. Do not assume open-source terms. |
| **Status banner** | `README.md` line 1 says **"THIS REPO IS NOW FREEZED"** — see [§11.1](#111-the-repo-is-both-frozen-and-being-changed). |

**The features that make up the most recent (and least documented) work:**

1. Role-scoped task assignment.
2. Calendar events announce themselves to the whole workspace.
3. One shared event-viewing window, reachable from the calendar *and* from notifications.
4. Two system-wide "due" reminders per calendar item — one hour out, fifteen minutes out.
5. **Meetings can be amended and cancelled**, and a moved meeting re-arms its notices.
6. **A task's due date can be cleared** — absent, `null` and `''` now mean three different things.

The first four are covered in depth in [§6](#6-recent-work--four-features); the
last two, and the negative-testing and end-to-end work that found two real
defects, in [§6.5](#65-third-wave-2026-10-22--meeting-lifecycle-negative-testing-first-end-to-end-run).

---

## 2. Repository state and how to verify it

### 2.1 Git

```
$ git status --short        # (empty — clean)
$ git log --oneline -3
2ac63ba calendar viewing/role based tasks/notification updates
f31778e Add fluid motion graphics across the client for light and dark mode
dc014bb Merge branch 'master' of github.com:manvendrasang/BigCRM
```

There is **one** branch (`master`) and **no** worktrees.

### 2.2 Last verified state

Verified after the third wave, on the working tree described in [§6.5](#65-third-wave-2026-10-22--meeting-lifecycle-negative-testing-first-end-to-end-run):

| Check | Result |
|---|---|
| `npm run typecheck` (server + client + e2e) | clean |
| `npm run lint` | clean |
| `npm test` (server) | **1238 assertions, 0 failed, 27 suites** |
| `npm test --workspace=@bigcrm/client` | **173 tests, 0 failed, 15 files** |
| `npm run test:e2e` (Playwright, Chromium) | **1 test, 0 failed** |
| `npm run test:coverage -w @bigcrm/server` | 89.88 / 84.34 / 75.41 / 89.88 — above the enforced thresholds |
| `npm run test:coverage -w @bigcrm/client` | 58.06 / 66.91 / 78.02 / 58.06 — above the enforced thresholds |

> The assertion counts in `docs/TESTING.md` and `docs/PROJECT_STATUS.md` were
> stale (905). They now match the numbers above. See
> [§11.5](#115-stale-documents).

### 2.3 Bringing it up from zero

```bash
npm install
npm run bootstrap     # generates server/.env with fresh secrets
npm run migrate
npm run seed

npm run dev           # API on :3000
npm run dev:web       # client on :5173 (proxies /api to :3000)
```

**Then, in a third terminal, start the worker** — see [§7.4](#74-the-worker-is-not-optional-anymore):

```bash
npm run worker
```

Fuller instructions: `INSTALL.md`. Env var reference: `server/.env.example` (there is **no** root-level
`.env.example` — env files live under `server/`).

### 2.4 Test database

Each server test suite runs in a **fresh child process with a clean database**, so suites do not
contaminate each other and there is no ordering dependency. `server/.env.test` supplies test JWT
secrets and silent logging. Real PostgreSQL is used — **not** an in-memory emulation — so foreign
keys, CHECK constraints, triggers and transactions are genuinely exercised. A PGlite fallback exists
for dev/test convenience only and is explicitly forbidden in production by `config/env.ts`.

---

## 3. What the product does

A multi-tenant CRM. Each organisation ("workspace") owns its own users, and **tenant isolation is a
data-layer property**, not a convention — see [§4.6](#46-security-model).

| Area | Detail |
|---|---|
| **Contacts / Companies / Leads** | Standard CRM entities. Leads convert to contacts in one transactional step (`POST /leads/:id/convert`). |
| **Projects** | The UI name for the `deals` table. Value, currency, pipeline, stage, probability, close date. Each has a dedicated window with a clickable stage stepper. **The table is still called `deals`.** |
| **Tasks** | Status, priority, assignee, due date. List view **and** calendar view. |
| **Calendar** | Meetings, invitees, accept/decline responses, an agenda. |
| **Reports** | Pipeline, funnel, load, overview. CSV export. |
| **Notifications** | Unread badge in the nav; per-user, per-organisation. |
| **Attachments, notes, tags, comments** | On any record type. |
| **Saved views** | Private per user, or shared with the org. |
| **Global search** | Client fans out to five tenant-scoped endpoints; no server-side UNION. |
| **Import / export** | CSV, with idempotency keys and per-row error reporting. |
| **Audit log** | Every state change, append-only **at the database level** via a trigger that raises on UPDATE/DELETE. |

### 3.1 Roles

Five roles, ranked. The matrix lives in **`server/src/services/rbac.ts` and is the only authority** —
the client asks the server what it may do rather than deciding for itself.

`viewer` (10) < `sales` (20) < `manager` (30) < `admin` (40) < `owner` (50)

The full matrix is in `README.md` §"Roles and permissions". Two things that routinely surprise people:

- **`admin` is not a superuser.** It outranks `manager` on *rank* but holds less *authority* in a few
  specific places (e.g. it has no `tasks.assign` permission — see §6.1). Rank and permission are
  separate axes.
- **A `viewer` can update a task only if it is assigned to them, and only its status.**

### 3.2 Sessions

**A session ends when the window closes** — for every role, owner included. Refreshing keeps you
signed in; closing the window does not. Closing one of several tabs does not sign the others out.

The browser cannot distinguish "closed" from "refreshed" during unload, so the decision is made on
the *next page load* using `sessionStorage` (per-tab, survives refresh, destroyed on close) plus a
cross-tab liveness registry. Implementation: `client/src/lib/sessionWindow.ts`.

---

## 4. Architecture

### 4.1 Process model

```
┌─ npm run dev ──────────────┐   ┌─ npm run worker ───────────────┐
│  server/src/index.ts       │   │  server/src/worker.ts          │
│  1. validate config        │   │  registerHandler(...)          │
│  2. initKeyProvider()  (KMS)│  │  startWorker()      ─ queue poll│
│  3. initDriver()       (pool)│ │  startReminderSweep()          │
│  4. migrate()          ←──┼───┤  (both setInterval loops)       │
│  5. app.listen()           │   └────────────────────────────────┘
│  6. startRetentionScheduler()  ─ 6h interval, IN the API process
└────────────────────────────┘
            │
            ▼
     PostgreSQL 17  (docker compose service `db`)
```

**Three separate timers, in two processes.** This matters for hosting — see [§10](#10-deployment-and-hosting).

### 4.2 Request lifecycle

`app.ts` assembles the middleware in a deliberate order:

```
requestContext → securityHeaders → corsPolicy → /health
  → cookieParser → express.json / urlencoded / text / raw
  → globalLimiter → readOnlyGuard
  → /api/v1 (v1Router) → notFoundHandler → errorHandler
```

`globalLimiter` sits **after** CORS so a rejected preflight is not rate-limited into a confusing 429.

### 4.3 Data model

Ten migrations, applied in order, each recorded in `schema_migrations` with a **SHA-256 checksum**:
editing a landed migration makes startup fail loudly rather than silently diverging.

| Migration | Adds |
|---|---|
| `0001_core.sql` | orgs, users, sessions, all record tables, audit log + append-only trigger |
| `0002_activity_entity_types.sql` | activity entity-type widening |
| `0003_mfa.sql` | TOTP enrolment, challenges, recovery codes |
| `0004_webhooks.sql` | *(later removed)* |
| `0005_meeting_invites.sql` | calendar invites |
| `0006_drop_webhooks.sql` | drops 0004 |
| `0007_job_queue.sql` | `job_queue` — durable queue, `FOR UPDATE SKIP LOCKED` claiming |
| `0008_password_reset_requests.sql` | member-initiated password reset requests |
| `0009_user_preferences.sql` | per-account appearance |
| `0010_event_reminders.sql` | `event_reminders` — exactly-once ledger for due reminders *(new)* |

Destructive migrations must declare `destructive = true` and the runner refuses to apply them without
an explicit acknowledgement flag.

### 4.4 Database access

Two layers, both in `server/src/repositories/base.ts`:

- **`TenantScope`** — cannot be constructed without an `organizationId`. Every helper takes a scope as
  its first argument, so a tenant query without one is a **type error**, not a review comment.
- **`allowlist()`** — the *only* place a SQL fragment is assembled from a string (sort columns, filter
  keys). Throws on anything unrecognised.

`scope.query()` auto-appends `organization_id = $n`; `scope.unsafe.query()` is the raw escape hatch,
used for INSERTs and DDL-shaped statements. `assertTenantPredicate()` refuses an unscoped SELECT at
runtime as a second line of defence.

`scope.transaction(fn)` passes a **nested `TenantScope`** back into the callback — so service functions
compose inside a transaction without losing tenant safety.

`scope.bestEffort(label, fn)` wraps work in a **SAVEPOINT**. This is the load-bearing mechanism behind
"a failed optional write must not roll back the business write" — a PostgreSQL statement error aborts
the whole transaction, and catching it in JS does *not* undo that. There is a regression test for
exactly this in `records.test.ts` (search *"a rejected optional write must not roll back"*).

> **Bug class this prevents:** the legacy CRM leaked across tenants because `company_detail`'s contact
> query omitted `organization_id`. That class is unrepresentable here.

### 4.5 Storage, email, secrets

| Concern | Default | Production option |
|---|---|---|
| Attachments | `STORAGE_DRIVER=local` → `.bigcrm-storage/` | `s3` (S3 / R2 / MinIO) — presigned URLs |
| Email | `EMAIL_PROVIDER=log` (written to logs, **not sent**) | `smtp` + `SMTP_URL` |
| Field encryption (MFA secrets) | `MFA_KEY_PROVIDER=env` (HKDF under `SECRETS_PEPPER`) | `kms` + `KMS_MFA_KEY_CIPHERTEXT` (AWS SDK; LocalStack works) |
| Password hashing | `scrypt` (default) or `argon2id` | either |

### 4.6 Security model

- **Auth.** JWT in `HttpOnly` cookies (`bigcrm_at`, `bigcrm_at_refresh`) plus a **readable**
  `bigcrm_csrf` cookie used as a double-submit token. Access token TTL 15 min, refresh 7 days,
  rotation with family invalidation, idle + absolute timeouts, max sessions per user.
- **CORS.** Explicit allowlist. An empty list **never** means "allow all" — `APP_ORIGINS` is required
  in production and every origin must be `https://`.
- **Config fails closed.** `config/env.ts` throws at *import time*. In production a secret may not be
  a placeholder, may not be under 32 chars, and may not equal any other configured secret.
  `DATABASE_SSL=disable` is refused in production outright.
- **CSRF, rate limiting, security events, lockout, read-only degraded mode** (`READ_ONLY_MODE`, an
  env var on purpose — the switch cannot live inside the database it is meant to distrust).
- **The audit log is append-only at the DB level** via a trigger that `RAISE EXCEPTION`s on
  UPDATE/DELETE.

Full control list with file + proving test: `docs/SECURITY.md`. Threat model: `docs/THREAT_MODEL.md`
(STRIDE per trust boundary). Findings register: `docs/SECURITY_FINDINGS.md`.

---

## 5. Code map

### 5.1 Server

| Path | Owns |
|---|---|
| `src/index.ts` | API entrypoint: config → keys → driver → migrate → listen → retention |
| `src/worker.ts` | Worker entrypoint: **handler registration lives here, not in `queue.ts`** |
| `src/app.ts` | Express assembly, middleware order, router mount |
| `src/config/env.ts` | Configuration parsing, **fails closed** |
| `src/db/migrate.ts` | Migration runner with checksums |
| `src/db/driver.ts` | `pg.Pool` / transaction / PGlite drivers behind one `DbClient` interface |
| `src/repositories/base.ts` | `TenantScope`, `allowlist()`, `bestEffort()`, insert/count helpers |
| `src/middleware/security.ts` | Auth, RBAC, CSRF, rate limits, security events |
| `src/middleware/readOnly.ts` | Read-only degraded mode |
| `src/routes/v1/` | HTTP layer: validation, permissions, response shape |
| `src/services/` | Business logic, one module per bounded area |
| `src/lib/` | Passwords, JWT, KMS, TOTP, CSV, sanitise, SSRF, metrics, logging, redaction |
| `src/integrations/` | `email.ts`, `mongodb.ts` (**disabled** — see §11.4) |

**Services (18):** `activity` · `attachments` · `auth` · `calendar` · `customFields` · `mfa` ·
`normalise` · `org` · `queue` · `rbac` · `records` · `rekey` · `reminders` · `reports` · `retention` ·
`savedViews` · `transfers` · `userPreferences`

**Key ones:**

| Module | Owns |
|---|---|
| `rbac.ts` | The permission matrix, role rank, hierarchy rules |
| `records.ts` | CRUD for all 9 record types, tenant scoping, viewer task scope, assignment rules |
| `auth.ts` | Registration, login, sessions, tokens, MFA |
| `org.ts` | Organizations, members, invitations, teams, password resets |
| `calendar.ts` | Agenda, meetings, invites, the shared event read |
| `activity.ts` | Audit reads, notifications, the two fan-out helpers |
| `queue.ts` | Durable job queue (transport only — no business handlers) |
| `reminders.ts` | Due-reminder ledger, sweep, delivery handler *(new)* |
| `transfers.ts` | Import/export jobs |

### 5.2 Routes

All mounted under `/api/v1` by `routes/v1/index.ts`.

| File | Mount | Endpoints |
|---|---|---|
| `health.ts` | `/` | `GET /health`, `GET /ready`, metrics |
| `auth.ts` | `/auth` | register, login, refresh, logout(+all), password change/forgot/reset, verify-email(+resend), `GET /me`, sessions, preferences |
| `mfa.ts` | `/auth/mfa` | status, enroll(+confirm), recovery-codes, disable; public `POST /challenge` |
| `cookies.ts` | — | cookie issuance helpers only |
| `org.ts` | `/org` | org, audit-logs, roles, members (CRUD, role change, password reset), invitations, teams, transfer-ownership |
| `records.ts` | `/` | CRUD per record type × 9; `GET /tasks/assignees`, `GET /pipelines/:id/stages`, `POST /deals/:id/stage`, `POST /leads/:id/convert` |
| `calendar.ts` | `/calendar` | agenda, `POST /meetings`, **`GET /events/:kind/:id`**, invitees, invites, invite, respond |
| `activity.ts` | `/notifications`, `/activities` | list + unread count, mark read, read-all; per-record timeline |
| `attachments.ts` | `/attachments` | list, upload, download, delete |
| `reports.ts` | `/reports` | `GET /:name` |
| `transfers.ts` | `/transfers` | exports (+download), imports |
| `customFields.ts` | `/custom-fields` | field defs + per-record values |
| `views.ts` | `/views` | saved views |

> ⚠️ **Route ordering matters.** `GET /tasks/assignees` is registered **before** the generated `/:id`
> route, otherwise `assignees` is read as a task id. Same class of bug is possible anywhere a literal
> segment precedes an `:id`.

### 5.3 Client

| Path | Owns |
|---|---|
| `src/main.tsx` | Bootstraps window-close sign-out *before* rendering |
| `src/App.tsx` | Route table |
| `src/lib/api.ts` | HTTP client: token **in memory only**, CSRF header, refresh + retry, typed errors. `API_BASE = '/api/v1'` (**hardcoded, relative**) |
| `src/lib/auth.tsx` | Session state, sign-in, sign-out |
| `src/lib/sessionWindow.ts` | Sign out when the window closes |
| `src/lib/theme.tsx`, `src/lib/preferences.ts` | Account-backed appearance |
| `src/lib/workspace.ts` | Members, invitations, views, notifications, **`getCalendarEvent`** |
| `src/lib/records.ts` | Record API + formatters |
| `src/lib/calendar.ts` | Calendar helpers incl. **`recordPath`** |
| `src/lib/kanban.ts` | Deal-board drag logic |
| `src/components/` | Shell, navigation, timeline, UI primitives |
| `src/pages/` | One page per route |

**Pages:** `AuditLogs` · `Calendar` · `Dashboard` · `DealBoard` · `Login` · `Notifications` ·
`Reports` · `SavedViews` · `Search` · `Settings` · `records/{RecordList, RecordDetail, RecordCreate, ProjectDetail}`

**Components:** `ActivityTimeline` · `AppNav` · **`AssigneeField`** · `AuthenticatedShell` ·
**`CalendarEventModal`** · `ProtectedRoute` · `RecordExtras` · `RelatedRecords` ·
`ScheduleMeetingForm` · `ThemeSwitcher` · `ui`

---

## 6. Recent work — four features

These are the newest changes, the least documented in `docs/`, and the most likely to be misunderstood.

### 6.1 Role-scoped task assignment

**Requirement.** Owner may assign to anyone. Manager to anyone *except* the org owner. Admin plays no
role in assignment (it is a maintainer, not an authority). Sales and viewer cannot assign at all.

**Design.** Enforced in the **service layer**, in two independent halves:

1. **Who may assign** — the `tasks.assign` permission, granted to `owner` and `manager` only in
   `rbac.ts`. Deliberately withheld from `admin`, `sales`, `viewer`.
2. **Whom they may assign to** — `checkTaskAssignment(actor, assigneeId)` in `records.ts`, which
   resolves the target's role from `organization_members`.

```ts
checkTaskAssignment(actor, assigneeId: string | null)
// null            → clearing an assignment; allowed for the two assigning roles
// non-member      → "That person is not a member of this workspace."
// manager → owner → refused
// owner → anyone  → allowed
```

**Invariants worth preserving:**

- **Validation runs before any write**, so a refused assignment can never leave a half-created task.
- `assignee_id: null` **clears**; `assignee_id: ""` clears; omitting the key leaves it alone. Explicit
  clear is update-only — you cannot create a task that is born unassigned-by-clearing.
- `GET /tasks/assignees` is registered **before** `/:id`.
- The picker renders only for owner/manager. `AssigneeSelect` keeps an unknown current value selectable
  as **"(former member)"** so an unrelated edit cannot silently clear an assignment.

**Client:** `components/AssigneeField.tsx` (`useAssignableMembers`, `canAssignTasks`, `AssigneeSelect`),
wired into `RecordCreate.tsx` and `RecordDetail.tsx`. The detail view shows an "Assignee" row for
owner/manager only.

**Tests:** `integration/records.test.ts` — creates an `acmeSales` member via `createMember`, retargets
"somebody else's task", 10 assignment-rule assertions.

### 6.2 Calendar events announce themselves

**Requirement.** Creating or scheduling a task or meeting pushes a notification to **all roles except
the creator**.

**Design.** `notifyOrgMembers(scope, actor, input)` in `activity.ts`:

- Selects live members of the org (`users.deleted_at IS NULL`), **minus the creator**.
- Inserts one `notifications` row per recipient in a loop, inside the caller's transaction.
- **Best-effort**: `scope.bestEffort('notification.write', …)` so a notification failure never rolls
  back the business write.

**A task is announced only when it first appears on the calendar** — either created with a
`due_date`, or updated such that `existing['due_date'] === null` and a date is supplied. A task that
merely *moves* is not re-announced; it was already on the calendar.

**Notification types:** `calendar_meeting` (`entityType: 'meeting'`) and `calendar_task`
(`entityType: 'task'`), both with `link: '/calendar'`.

**Tests:** `integration/calendar.test.ts` (fan-out assertions) and `records.test.ts`.

### 6.3 One shared event window

**Requirement.** Every event, meeting and task is viewable by clicking its calendar marker, for any
role, using the **same window** when opened from notifications.

**Design.** One read backs both surfaces:

```
getCalendarEvent(actor, kind, id)   →  services/calendar.ts
GET /calendar/events/:kind/:id      →  routes/v1/calendar.ts
```

It is gated on **`activities.read` + `tasks.read`** — the same pair the agenda needs — so it adds no
reach beyond what the user already has.

**Client:** `components/CalendarEventModal.tsx`. `Calendar.tsx` chips became `<button>`s that open it.
`Notifications.tsx` uses `eventTargetOf()` to decide whether a row *is* an event; notification rows
become `.link-button` buttons only when they carry `entityType` of `meeting`/`task` **and** an
`entityId`. Everything else keeps the existing safe internal-link rendering.

> **This is the property that made feature 4 cheap.** Any notification carrying
> `entityType`/`entityId` opens the shared window with **zero client changes**.

**Tests:** `client/src/pages/Calendar.test.tsx`, `Notifications.test.tsx`.

### 6.4 Due reminders ⚠️ read this before deploying

**Requirement.** Whenever an event / meeting / task is due, send **two system-wide notifications to
all roles** — one hour before, one fifteen minutes before.

> **Note the deliberate asymmetry with §6.2.** The create-time broadcast *excludes* the creator.
> The due reminders **include** them. "It is due in an hour" is a fact about the work, not a reaction
> to somebody's action, and the person who booked the meeting is exactly as likely to be the one
> running late. Both helpers exist for this reason:
> `notifyOrgMembers()` (excludes) vs `notifyAllMembers()` (includes).

#### 6.4.1 Why a ledger and not a queue

"Send it twice, once" fails in two different directions — a duplicated message, or a lost one — and a
queue alone fixes neither. So the design splits it:

| Piece | Responsibility |
|---|---|
| **`event_reminders` table** | Remembers, per item **per lead time**, whether the notice has gone out. The **only** thing that makes the feature exactly-once. Written in the same transaction as the notification it guards. |
| **`enqueue`** | Hands work to the queue, which owns retries and backoff. |
| **`sweepDueReminders()`** | The clock. Moves due ledger rows onto the queue, each one once. |
| **`deliverDueReminder(job)`** | The handler. Claims the ledger row, re-reads the item, tells everyone. |

#### 6.4.2 Schema (`0010_event_reminders.sql`)

```sql
UNIQUE (organization_id, entity_kind, entity_id, lead_minutes)   -- one row per notice per event
lead_minutes CHECK (lead_minutes BETWEEN 1 AND 10080)
enqueued_at   -- claimed by the sweep
sent_at       -- claimed by the handler
```

`entity_id` has **no foreign key on purpose**: a reminder points at either an `activities` row (a
meeting) or a `tasks` row, and one column cannot reference two tables. The handler re-reads the row
it names and delivers nothing when it is gone, so an orphan is a no-op rather than a leak.

Partial index `idx_event_reminders_pending ON event_reminders (fire_at) WHERE sent_at IS NULL` — the
settled history costs nothing to skip.

#### 6.4.3 The one rule

`records.ts` has a single helper rather than four branches:

```ts
refreshTaskReminders(tx, actor, taskId)
```

It re-derives the notices from the row **as it now stands**, so:

| Write | Effect |
|---|---|
| Task created with a due date | arms 60 min + 15 min |
| Task created without one | no-op |
| Due date moved | `fire_at` rewritten **in place**, `sent_at` cleared (re-armed). Never piles up a second set. |
| Status → `completed` / `cancelled` | pending notices retired |
| Status reopened | notices brought back |
| Soft-deleted | row no longer live → retired |
| Restored | back on the calendar → re-armed |

Every write path that can change a task calls this. Meetings arm once in `scheduleMeeting`
(meetings cannot be edited or deleted in this codebase).

#### 6.4.4 Delivery, exactly-once

`deliverDueReminder` claims `sent_at` and inserts the notifications **in one transaction**. So:

- a retried job, a duplicated job, or two workers racing all find the row already `sent_at` and stop;
- a crash *before* anyone was told rolls the claim back with everything else.

The sweep's claim is a single `UPDATE … RETURNING` over a CTE, so two sweeps racing cannot both take
a row. An enqueue failure puts the row back (`enqueued_at = NULL`) rather than stranding the notice.

**Role-gating: none.** These are due reminders, not permissions — every live member is notified,
whatever their role, creator included.

**Notification types:** `calendar_due_1h`, `calendar_due_15m`. Title `Due in 1 hour: <title>` /
`Due in 15 minutes: <title>`. Item titles are capped at 180 chars so the prefix plus title never
exceeds the 200-char column limit. `entityType`/`entityId` set → the shared window (§6.3) opens them
for free.

#### 6.4.5 Known behaviours and choices

- **A due time already in the past when scheduled** produces a ledger row with `fire_at` in the past,
  which the next sweep picks up and delivers **immediately**. There is no backdating guard. This was
  a deliberate simplicity trade-off; if you want "silently skip", add a `fire_at < now() - interval`
  guard to the sweep's WHERE clause.
- **Rescheduling re-arms unconditionally**, even if the old notice already went out. A meeting moved
  to a new time earns fresh notices for the new time. Arguably chatty, but predictable.
- **`due_date` cannot be cleared through the public API** — `prepare()` drops a null for tasks. So
  "un-date a task" is not a supported write today. The null path still exists internally (completion,
  deletion) and is tested. *If you add date-clearing, `refreshTaskReminders` already handles it.*

#### 6.4.6 ⚠️ Operational requirement

**Reminders are armed by the writer but delivered by `npm run worker`.**

A deployment running only the API will happily schedule reminders that **never fire**. This is
noted in `docs/DEPLOYMENT.md` and `docs/PROJECT_STATUS.md`. The sweep interval is overridable via
`REMINDER_SWEEP_INTERVAL_MS` (default 30 000).

> There is now a **root-level `npm run worker`** script (added in the third
> wave). `npm run worker -w server` still works.

#### 6.4.7 Tests

`server/src/tests/integration/reminders.test.ts` — **37 assertions** across five sections:

1. Every calendar item earns exactly two notices, at the right lead times.
2. The notices follow the item: moved, retired on completion, brought back on reopen, never doubling.
3. A due notice reaches **every role**, creator included, via sweep → queue → worker.
4. A notice about something deleted, finished or unknown says **nothing**.
5. Two sweeps racing hand out between them, not twice.

---

### 6.5 Third wave (2026-10-22) -- meeting lifecycle, negative testing, first end-to-end run

Everything in this section is **verified by execution** and **not yet committed**.

#### 6.5.1 Meetings can be amended and cancelled

| Route | Permission | Who |
|---|---|---|
| `PATCH /api/v1/calendar/meetings/:id` | `activities.update` | manager, admin, owner |
| `DELETE /api/v1/calendar/meetings/:id` | `activities.delete` | admin, owner |

Both permissions already existed in `rbac.ts`, so **the matrix did not change**.
Design decisions worth knowing:

- **Editing is a permission, not an ownership question.** A manager can correct
  somebody else's typo on the shared calendar; sales can schedule but not amend.
- **The advance notices re-arm only when the start time actually moves.** A
  corrected title is not a new appointment. The comparison is on instants, so a
  client re-sending the same time is a genuine no-op.
- **Deleting cascades the invitations** (`meeting_invites.meeting_id` is
  `ON DELETE CASCADE`), retires the *pending* notices, and **keeps the
  delivered ones as history**.
- **Invitees are not notified of a cancellation.** Delivered notifications are
  immutable, so the honest statement is "the meeting is gone from the
  calendar", not a retroactive fan-out.
- **The parent record's timeline records the cancellation** — a meeting that
  vanishes silently is a support ticket.

Files: `server/src/services/calendar.ts` (`updateMeeting`, `deleteMeeting`),
`server/src/routes/v1/calendar.ts`, `server/src/lib/logger.ts` (two new
`SecurityEventName`s).

#### 6.5.2 The `due_date` contract

| Sent | Means |
|---|---|
| key absent | unchanged |
| `null` | **cleared** (was: dropped, and the patch was refused) |
| `''` | **cleared** |
| an unparsable value | 422; the stored date is untouched |

The fix is in `prepare()` in `server/src/services/records.ts`. It also required
tightening the "a task gained a date" notification condition, which would
otherwise have announced "scheduled for null" when a task was sent back to the
backlog.

#### 6.5.3 Negative testing

| Suite | Assertions | What it proves |
|---|---:|---|
| `security/crossTenant.test.ts` | 46 | One workspace cannot reach another through records, the event window, the agenda, notifications, attachment download/list/delete, export download, meeting edit/delete, the invitations inbox, or a queue job's payload. Every refusal is **404, never 403**, and never echoes the foreign row. Each negative assertion has a positive control in the owning tenant. |
| `security/authorizationMatrix.test.ts` | 104 | Seventeen routes × five roles. The expectation is **derived from `ROLE_PERMISSIONS`** (so it cannot rot), and the product decisions that matter are pinned separately: an admin cannot assign tasks, a manager cannot read the audit log, a sales member can schedule but not amend. |
| `unit/csv.test.ts` | 53 | Formula injection was **already handled**; the suite exists so it cannot be quietly removed. |
| `integration/taskDueDate.test.ts` | 21 | The contract above, and that clearing a date retires its two notices. |
| `integration/meetingLifecycle.test.ts` | 37 | Notice re-arming, invite cascade, audit shape, parent timeline, and that a non-meeting activity is invisible to the meeting verbs. |

Three suspicions were checked and found **already correct**: CSV formula
injection, the `tasks.assign` gate on `GET /tasks/assignees`, and the absence
of a server-side global search (the client fans out to the same
permission-gated list endpoints).

#### 6.5.4 The first end-to-end test

`client/e2e/smoke.spec.ts` — one test, in Chromium, against the real API,
across two signed-in sessions: sign in → create a dated task → the second
member's inbox carries the notice → the notification opens the shared event
window → the record is completed → the calendar shows it done.

It boots its own API (port 3100, throwaway database) and its own Vite dev
server (port 5273), so it neither disturbs nor depends on a development
session. The Vite proxy target is now configurable via `VITE_API_TARGET`.

```
npm run test:e2e        # needs `npx playwright install chromium` once
```

#### 6.5.5 Two real defects, both invisible to every other suite

| Finding | What it was | Found by |
|---|---|---|
| **BIG-40** | `GET /attachments/file/:id` was registered *after* `GET /attachments/:entityType/:entityId`, so the parameterised route swallowed it and **every attachment download answered 400** "Unknown entity type 'file'". | the cross-tenant suite |
| **BIG-41** | `navigate('../<id>')` resolves against the route **hierarchy**, not the URL. The route table is flat, so `..` meant the root: creating any record from the UI navigated to `/<id>`, which matches no route, and the catch-all sent the user to the dashboard. | the end-to-end test |

BIG-41 is the argument for the end-to-end test: the record *was* created, the
API answered 201, and every unit and component test passed. Only a browser
following the link could see that the user was never shown what they had just
made. Six relative `..` navigations were fixed (`RecordCreate.tsx`,
`RecordDetail.tsx`).

---

## 7. Background job system

`server/src/services/queue.ts` is a **PostgreSQL job queue** — no Redis, no external broker.

| Function | Does |
|---|---|
| `enqueue({ type, organizationId, payload }, db?)` | Adds a job. `run_at` is both "not before" and the backoff mechanism. |
| `claimNext(workerId, db?)` | `FOR UPDATE SKIP LOCKED` — N workers never double-execute. |
| `complete` / `fail` | Terminal states; `failed` after `max_attempts`. |
| `registerHandler(type, fn)` / `clearHandlers()` | Handler registry. **Tests use `clearHandlers()`.** |
| `runWorkerOnce(workerId)` | One claim-and-dispatch pass. This is what tests call. |
| `startWorker` / `stopWorker` | The `setInterval` loop. |

### 7.1 Handlers live in the composition root

`queue.ts` is **transport**. `worker.ts` decides what runs. No production code calls `registerHandler`
except `worker.ts`:

```ts
// server/src/worker.ts
registerHandler(REMINDER_JOB_TYPE, deliverDueReminder);
startWorker(WORKER_ID, INTERVAL_MS);
startReminderSweep(SWEEP_INTERVAL_MS);
```

Today `event_due_reminder` is the **only** production job type. The `docs` and the queue's own
docstring previously named "the export runner" as the first candidate — that is now stale; the
reminder scheduler is.

### 7.2 `organization_id` is nullable on `job_queue`

Some jobs are per-tenant, some are global (retention sweeps). Tenant isolation for per-tenant jobs is
enforced by the **handler reading the row's own `organization_id`** — never by trusting the payload.
`deliverDueReminder` does exactly this, and ignores the `kind`/`entityId` in the payload in favour of
the ledger row's own columns, so a job cannot be pointed at a different table than the ledger says.

### 7.3 Two timers, one process

`worker.ts` runs the dispatch loop *and* the reminder sweep as **separate** intervals, deliberately:
finding work and running work are different jobs, and a slow handler should not delay the search for
the next one.

### 7.4 The worker is not optional anymore

Before §6.4, running without the worker was harmless — nothing was produced. **Now it silently
disables due reminders.** See [§6.4.6](#646--operational-requirement).

---

## 8. Testing

### 8.1 Suites

**Server — 27 suites, 1238 assertions.**

| Group | Files |
|---|---|
| `unit/` | `config` · `csv` · `kms` · `modules` · `rbac` (+ `mongodb` — **excluded**, see §11.4) |
| `integration/` | `activity` · `auth` · `calendar` · `http` · `http-mfa` · `http-routes` · `item8` · **`meetingLifecycle`** · `members` · `preferences` · `queue` · `readOnly` · `records` · `reminders` · `reports` · `retention` · `savedViews` · **`taskDueDate`** |
| `security/` | `mfa` (71 assertions) · `scenarios` (168 assertions, STRIDE-mapped) · **`authorizationMatrix`** · **`crossTenant`** |

**Client — 15 files, 173 tests.** `pages/{Calendar, DealBoard, Notifications, Settings, records/ProjectDetail}` ·
`components/{RelatedRecords, ui}` · `lib/{api, calendar, kanban, records, redirect, sessionWindow, theme, workspace}`

**End-to-end — 1 test.** `client/e2e/smoke.spec.ts`, Playwright + Chromium.

### 8.2 Commands

```bash
npm test                                  # server suite (all)
npm test --workspace=@bigcrm/client       # client suite
npm run test:e2e                          # Playwright smoke test
npm run test:security                     # 14 threat scenarios
npm run test:coverage --workspace=@bigcrm/server   # c8, thresholds enforced
npm run typecheck && npm run lint         # both workspaces (and the e2e project)
npm run worker                            # the background worker
```

Coverage thresholds: lines 85, functions 75, branches 70, statements 85.

### 8.3 Conventions inside the suites

- Each server suite is a **child process** with a clean DB; suites are order-independent.
- Assertion style is an explicit `T(label, condition, evidence)` plus a `=== N PASSED ===` summary,
  not a test framework. `process.exit(1)` on any failure.
- Fixtures use a shared `SEED` / `mkOrg` helper: `acme` (owner of Acme), `globex` (a separate org),
  `acmeSales` (a `sales` member of Acme). Orgs created inline get names like `RemArm Ltd` with
  predictable emails.
- Client tests run under Vitest + jsdom + Testing Library, with `setFetchImplementation` stubs.
  A Vitest future-flag warning about React Router v7 is **expected noise**, not a failure.

---

## 9. Documentation map

`docs/` contains 14 documents plus `evidence/`. They are unusually rigorous — and unusually honest,
which is worth preserving.

| Doc | What it is |
|---|---|
| `API.md` | Endpoint reference; base path `/api/v1` |
| `ARCHITECTURE.md` | Principles — *"Security is a layer, not a pass at the end"* |
| `DATABASE.md` | PostgreSQL design decisions, per-table |
| `DEPLOYMENT.md` | Target architecture + checklist. States plainly there is **no deployed environment, no container image, no Terraform** |
| `DISASTER_RECOVERY.md` | Proposals, explicitly marked *"not verified capabilities"* — **no restore has been performed** |
| `INCIDENT_RESPONSE.md` | *"Contain before you diagnose"* playbook |
| `OPERATIONS.md` | Monitoring endpoints and what each exposes |
| `PROJECT_AUDIT.md` | Audit of three repositories, conducted as the build progressed |
| `PROJECT_STATUS.md` | Honest status accounting — no unexercised claims, nothing silently omitted |
| `SECURITY.md` | What is *actually implemented*; every control names its file and proving test |
| `SECURITY_ARCHITECTURE.md` | How and why, complements SECURITY.md |
| `SECURITY_FINDINGS.md` | Findings register: issue → evidence → regression test |
| `TESTING.md` | Testing overview *(assertion count is stale)* |
| `THREAT_MODEL.md` | STRIDE per trust boundary; severity = impact × likelihood |
| `evidence/` | ZAP/DAST, Trivy, load-test and backup-restore-drill artifacts, dated |

> **Preserve this style.** The project's most valuable property is that it *never* claims something it
> has not exercised. `PROJECT_STATUS.md` and `DISASTER_RECOVERY.md` say so in their first lines. If
> you add a feature, add the test, then claim it — in that order.

---

## 10. Deployment and hosting

### 10.1 What exists

- **`Dockerfile`** — production-grade. Multi-stage, `node:22.18.0-bookworm-slim`, distroless runtime,
  non-root UID 10001, read-only, no secrets, healthcheck on `/internal/health`,
  `NODE_ENV=production`, `--max-old-space-size=256`, `--enable-source-maps`.
- **`docker-compose.yml`** — local stack: `postgres:17-alpine` (loopback-only port), Mailpit, LocalStack KMS.
- **`.github/workflows/ci.yml`** — static analysis, verification, container build, DAST.
- **`infra/`** — `dast/` (Caddyfile, nginx.conf, zap-wrapper.sh) and `scripts/`
  (backup-restore-drill.sh, dast-scan.sh, load-test.mjs, trivy-scan.sh).
- **`docs/DEPLOYMENT.md`** — target AWS ECS Fargate: api service + worker service across 2 AZs, RDS
  PostgreSQL Multi-AZ, S3, Secrets Manager, KMS, CloudTrail, CloudWatch.

### 10.2 What does **not** exist

**There is no deployed environment.** No container image is published, no Terraform, no hosting
account. `docs/DEPLOYMENT.md` says so explicitly. `docs/DISASTER_RECOVERY.md` says no restore has
ever been performed.

### 10.3 Open decision: hosting on Vercel

The user asked about hosting on Vercel with Apache CouchDB. Both questions were analysed; nothing was
implemented. **The decision is still open.**

#### ❌ CouchDB — ruled out, decisively

Not a configuration change: it is a rewrite of the entire data layer, plus lost correctness.

- **The app refuses to boot on a non-Postgres URL.** `config/env.ts:237`:
  `fail('DATABASE_URL must be a postgres:// or postgresql:// URL')`.
- **CouchDB has no cross-document transactions.** `convertLead`, the task write + notification
  fan-out + `event_reminders` ledger, and `upsertMembers` idempotency are all transactional.
- **No `SAVEPOINT`** — `bestEffort()` is the mechanism behind "a rejected optional write must not
  roll back the business write", and there is a regression test for it.
- **No `FOR UPDATE SKIP LOCKED`** (job claiming), **no `ON CONFLICT … DO UPDATE`** (ledger re-arm),
  **no referential integrity**, **no triggers** (the append-only audit log), **no partial unique
  indexes** (org-scoped uniqueness), **no `CHECK` across two columns**.
- **Tenant isolation is enforced in SQL** — `TenantScope` would have to be redesigned.
- Migration runner with SHA-256 checksums would need replacing wholesale.
- **Most damning: this repo already removed a document database.** `index.ts:44-54` records that the
  MongoDB Atlas integration was disabled on 2026-10-11, leaving PostgreSQL as the sole system of
  record. Going to CouchDB reverses a documented decision.

**Alternatives if a managed/distributed Postgres is the goal:** Vercel Postgres (Neon), Supabase,
Railway, Aiven — all drop-in via `DATABASE_URL`. For distribution, CockroachDB/YugabyteDB speak the
Postgres wire protocol, but validate against the suite (triggers, deferrable FKs, `SKIP LOCKED`).

#### Three hosting options

| | **A. Vercel (client) + containers (API/worker)** ⭐ | **B. All Vercel, serverless** | **C. Railway / Render / Fly** |
|---|---|---|---|
| Code changes | ~1 | ~6 areas | **0** |
| Worker & due reminders | Works natively | Needs Vercel Cron, likely **Pro plan** | Works natively |
| Rate limiting | Global | Per-instance (weaker) | Global |
| Storage | Local or S3 | **S3 required** | Local or S3 |
| Cookies / CSRF | Needs `SameSite` change if domains split | Works unchanged **if same-origin** | Works unchanged |
| Effort | Low | Medium–High | Lowest |

**Why the server does not fit Vercel as-is** (all verified in code):

1. `index.ts` calls `app.listen()` and installs SIGTERM/SIGINT drain + `process.exit`. Nothing exports
   the app. (`createApp()` already exists in `app.ts`, so the refactor is small.)
2. **`migrate()` runs at boot** — N concurrent lambdas racing on `schema_migrations`, plus a
   `process.exit(1)` if no migrations are recorded.
3. **Three `setInterval` loops** would never fire: `queue.ts` dispatch, `reminders.ts` sweep, and
   `retention.ts` (started in the *API* process at `index.ts:107`, 6-hour interval).
4. `pg.Pool` defaults to **10 connections per lambda** → connection exhaustion without a pooled
   connection string (Neon `-pooler`, Supabase `:6543`, PgBouncer).
5. `STORAGE_DRIVER=local` writes to `.bigcrm-storage` — read-only, ephemeral, not shared across
   instances.
6. `express-rate-limit` uses its **default in-memory store** — counters are per-instance.
7. `client/src/lib/api.ts:28` hardcodes `API_BASE = '/api/v1'` with `credentials: 'same-origin'`.
   The frontend was built for **one origin behind a reverse proxy**. Splitting to `app.*` + `api.*`
   forces `credentials: 'include'`, `COOKIES_SAMESITE=none`, and a widened `APP_ORIGINS` — i.e. it
   touches the security boundary. **Keeping one origin via a Vercel rewrite avoids all of it.**

**Recommendation given:** Option A — Vercel hosts the React client (its strength), containers host the
API and worker (what the code is built for). Option C is the least work overall. Option B is viable
but costs a Pro subscription for cron and touches auth.

**Required env vars either way** (all fail-closed at boot):
`DATABASE_URL`, `DATABASE_SSL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ISSUER`,
`JWT_AUDIENCE`, `SECRETS_PEPPER`, `STORAGE_SIGNING_SECRET`, `APP_ORIGINS` (non-empty, https in prod).
Plus for a real deployment: `EMAIL_PROVIDER=smtp` + `SMTP_URL`, `STORAGE_DRIVER=s3` + bucket/region,
`BLOCK_NEW_ACCOUNTS`, and `npm run worker` running somewhere.

---

## 11. Known gaps, risks and stale claims

### 11.1 The repo is both "frozen" and being changed

`README.md` line 1 reads **"THIS REPO IS NOW FREEZED"**. The commit immediately before HEAD is the
motion-graphics work and HEAD itself is the four features in §6. Either the banner is stale, or it
was intended as "frozen for external contribution" while local work continued. **Ask the owner, then
either remove the banner or state what it means.**

### 11.2 The worker will not be running in any real deployment

Until §6.4.6 is addressed, a deployed instance will schedule due reminders and never deliver them.
Highest-priority operational gap.

### 11.3 Nothing is deployed

No environment, no image, no IaC, no restore ever performed. All four are stated in the docs and all
four are still true.

### 11.4 Dead MongoDB integration

`server/src/integrations/mongodb.ts` exists but is entirely commented out (rationale preserved inline).
`server/src/tests/unit/mongodb.test.ts` is excluded from `tsconfig.json`, so the test runner detects
it and prints `SKIPPED (excluded from tsconfig)`. `index.ts:44-54` explains the failure mode it fixed
(a degraded secondary store logged and continued, failing *open*). Either delete it or keep it as a
monument — but it currently costs a confusing line in every test run.

### 11.5 Stale documents

Fixed in the third wave:

| Claim | Reality |
|---|---|
| `docs/TESTING.md`: "905 assertions" | **1238** — updated |
| `docs/PROJECT_STATUS.md`: "905 assertions", "21 suites" | **1238**, 27 — updated |
| `README.md` links `CHANGELOG.md` | **File does not exist** — link now points at `docs/PROJECT_STATUS.md` |
| `README.md` line 129: "21 suites" | **27** — updated |
| `INSTALL.md`: "905 assertions, 21 suites" | **1238**, 27 — updated |
| No root `npm run worker` script | **Added** in the third wave |
| `queue.ts` docstring: first producer is "the export runner" | It is the due-reminder scheduler — still open |
| `README.md` "Key service modules" table | Omits `calendar.ts`, `reminders.ts`, `transfers.ts` — still open |

### 11.6 Features referenced in code but not built

`docs/PROJECT_STATUS.md` notes the export runner was intended to be queue-backed for 50k+ rows; it is
still synchronous. The queue is ready; the producer is not.

### 11.7 Rate limiting is per-process

Fine on one container, weakened on serverless, weakened further under horizontal scale. If abuse
resistance matters, move to a shared store.

### 11.8 ~~`due_date` cannot be cleared~~ — fixed in the third wave

See [§6.5.2](#652-the-due_date-contract). `null` and `''` now clear the date, and the two advance
notices retire with it. Covered by `integration/taskDueDate.test.ts` (21 assertions).

### 11.9 Email is not configured by default

`EMAIL_PROVIDER=log` writes to logs and sends nothing. A production deployment **must** set SMTP or
password resets and invitations will silently not arrive.

### 11.10 Three smaller mismatches, recorded rather than fixed

| Issue | Note |
|---|---|
| The CSRF guard checks `Origin` but never validates `X-CSRF-Token` | The client sends the double-submit token; the server accepts on the Origin check alone. The comment in `middleware/security.ts` promises a token round-trip it does not perform. Changing CSRF semantics is a deliberate decision, not a cleanup. |
| `saved_views.read` / `saved_views.manage` are declared in the matrix and used by no route | Not a privilege gap — `services/savedViews.ts` enforces ownership and sharing itself. The matrix and the routes disagree about who "reads" views. |
| `server/src/lib/password.ts` contains two literal NUL bytes | The file is therefore treated as binary by `grep`/`ripgrep`, so review of the password code is blind. It typechecks and runs; the bytes look deliberate. |

---

## 12. Conventions and gotchas

**Things that will bite you if you do not know them.**

1. **Server source uses 1-space indentation.** This is real, not a rendering artifact. Tools that
   assume 2 or 4 will mangle alignment.
2. **`sed -i` by line number has corrupted TSX in this repo before.** Always re-typecheck after
   mechanical edits. Prefer a python script using `str.count(anchor)` + `str.replace` with **verified
   anchors**, so a failed match aborts loudly instead of silently doing nothing.
3. **Import cycles are safe here** — but only via `import type`. `activity.ts` imports `ActorRef` from
   `records.ts` with `import type` only; making it a value import creates a real cycle.
4. **Route order is load-bearing.** Literal segments before `:id` (see §5.2).
5. **`scope.bestEffort` vs `tx.bestEffort` matters.** Calling `bestEffort` on the *outer* scope from
   inside `scope.transaction` degrades to a plain try/catch **outside** the transaction (because
   `inTransaction === false`). Calling it on the `tx` callback argument gives a real SAVEPOINT. The
   §6.2 notification call sites were fixed to use `tx.bestEffort` so the comment and the behaviour
   agree. Check which one you are writing.
6. **`notifications.title` is 1–200 chars.** Helpers truncate type 80 / title 200 / body 2000 /
   link 500. If you compose a title from a prefix plus a user string, budget for the prefix.
7. **Meetings are `activities` rows** (`type='meeting'`, keyed on `occurred_at`); **calendar tasks
   come from `tasks.due_date`**. Two different tables, one calendar. `MAX_RANGE_DAYS = 93`,
   `MAX_ROWS = 500`.
8. **`deals` is the `projects` table.** The UI renamed it; the database did not.
9. **Client tests must run from `client/`.** `npx vitest run --config vite.config.ts src/pages/X.test.tsx`
   — a workspace `cd` from the repo root overrides `workdir`.
10. **React Router v7 future-flag warnings in test output are expected.**
11. **`admin` is not a superuser.** Rank ≠ permission. Check `rbac.ts` rather than assuming.
12. **Never claim a behaviour the suite does not exercise.** This repo's culture is
    "prove it, then say it" (`PROJECT_STATUS.md` RULE 5/6). Follow it.
13. **Licence is proprietary.** No permission to redistribute, fork publicly, or incorporate into
    another project.

---

## 13. Suggested next steps

Roughly in priority order.

### Do first (correctness / operability)

1. **Commit and push the third wave.** It is verified but uncommitted; see
   [§6.5](#65-third-wave-2026-10-22--meeting-lifecycle-negative-testing-first-end-to-end-run).
2. **Decide the hosting question** ([§10.3](#103-open-decision-hosting-on-vercel)). Recommendation:
   Option A. Then actually deploy *something* — the gap between "works locally" and "is running" is
   the single largest risk in this project.
3. **Make the worker observable.** The root `npm run worker` script now exists; add a log line or
   metric on every delivered reminder; consider alerting on `event_reminders` rows older than
   `fire_at + 10min` with `sent_at IS NULL` (that is the "reminders are silently stuck" alarm).
4. **Resolve the README "FREEZED" banner** ([§11.1](#111-the-repo-is-both-frozen-and-being-changed)).
   Still open, and now more confusing: the third wave changed the product again.

### Do next (product completeness)

5. **Backfill the due-reminder and meeting-lifecycle features into `docs/`** — the reminder feature
   exists only in this file and in code comments, and the meeting edit/delete verbs are not in
   `docs/API.md` yet.
6. **Queue-backed export runner.** The queue is built and proven; `PROJECT_STATUS.md` already names
   this as the next producer. Would replace the synchronous export path.
7. **Email in production** — pick a provider, set SMTP, verify the invitation and password-reset flows
   end-to-end against it.
8. **Grow the end-to-end suite.** One test is a smoke test, not a safety net. The next ones worth
   having: the record list (filters, saved views), the import/export round trip, and the invitation
   accept/decline flow.
9. **Decide the CSRF question** ([§11.10](#1110-three-smaller-mismatches-recorded-rather-than-fixed)):
   either validate `X-CSRF-Token` server-side or correct the comment that says you do.

### Do when the platform is running

9. **A real restore drill.** `DISASTER_RECOVERY.md` is honest that no restore has ever been performed;
   `infra/scripts/backup-restore-drill.sh` exists and has never been run against real data.
10. **Shared rate-limit store** if abuse resistance matters.
11. **Decide the fate of `integrations/mongodb.ts`** ([§11.4](#114-dead-mongodb-integration)).

---

## 14. Glossary

| Term | Meaning here |
|---|---|
| **Workspace / organisation** | One tenant. `organization_id` on every row. |
| **Record** | Any of the 9 CRUD types: contacts, companies, leads, deals(=projects), pipelines, pipeline_stages, tasks, notes, tags. |
| **Project** | The UI name for the `deals` record type. |
| **Meeting** | An `activities` row with `type='meeting'`, keyed on `occurred_at`. |
| **Dated task** | A `tasks` row with a non-null `due_date`. |
| **Calendar item** | A meeting or a dated task — the union that appears on the calendar. |
| **Ledger** | `event_reminders` — the exactly-once record of whether a due notice was sent. Not a queue. |
| **Sweep** | The interval that moves due ledger rows onto the job queue. |
| **Fan-out** | Writing one notification row per recipient. `notifyOrgMembers` (excludes creator) / `notifyAllMembers` (includes). |
| **`bestEffort`** | SAVEPOINT-wrapped optional work that must not roll back the business write. |
| **`TenantScope`** | The type that makes an unscoped tenant query a compile error. |
| **Composition root** | `worker.ts` / `index.ts` — where handlers are registered and processes are wired. |

---

*Generated for handoff purposes. Verify §2.2 by re-running the suite before trusting it — see the
note there about the assertion count drift.*
