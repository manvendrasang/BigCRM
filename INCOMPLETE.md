# INCOMPLETE

Everything in BigCRM that is **not** done, **not** finished, or **not** verified --
and why. Written 2026-10-12; §§0, 2-4, 7-9 updated 2026-10-14 after the
visual-polish pass and the containerised run. (§1 carries its own note.)

This document exists because the project's own rule is that a gap must be
recorded rather than quietly dropped (RULE 6), and because a clean test run is
not evidence that nothing is missing. Several items below were invisible to
`npm run typecheck`, `npm run lint` and the full test suite simultaneously.

Read this alongside `PROJECT_STATUS.md` (what was built) and
`SECURITY_FINDINGS.md` (defects found and fixed). This file is the other side of
the ledger: what is absent.

---

## 0. Where the project actually stands

Measured, not estimated. Every figure below came from running the command shown.

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` (server) + `tsc --noEmit` (client) | 0 errors, both |
| Lint | `npm run lint` (root) | 0 errors |
| Server suite (host) | `npm test` (PGlite) | **812 assertions, 19 suites, 0 failures** |
| Server suite (container) | `docker build --target test` -> `docker run` vs PostgreSQL 17 | **821 assertions, 19 suites, 0 failures** |
| Server branch coverage | `npm run test:coverage -w server` (c8, enforced) | **87.1% lines**, thresholds 85/75/70/85 |
| Client suite | `npm test -w client` | **118 tests, 12 files** |
| Client branch coverage | `npm run test:coverage -w client` (vitest, enforced) | **47.4% lines**, thresholds 46/62/74/46 |
| Image scan | `infra/scripts/trivy-scan.sh` | **0 critical, 0 high**, 2 moderate |
| DAST | `infra/scripts/dast-scan.sh` | 53 routes, 106 requests, **57 instances, all Informational** |
| Load | `infra/scripts/load-test.sh` | 9 authenticated endpoints, **420-436 req/s, p50 ~32 ms**, 0 errors |
| Backup / restore | `infra/scripts/backup-restore-drill.sh` | 4,170 rows / 14 tables, dump 143 ms, restore 899 ms |

Release gate: **0 open Critical, 0 open High in code**, 35 fixed findings,
5 accepted risks (A5 closed 2026-10-11).

**None of this is committed.** See §1 -- it is the single largest gap in the
project.

---

## 1. Nothing is committed to git - **highest priority**

`main/BigCRM` is a git repository with a remote configured:

```
origin git@github.com:manvendrasang/BigCRM.git branch: master
```

Only **two files are tracked** (`.gitignore`, `README.md`). Everything else --
`server/`, `client/`, `docs/`, `infra/`, `Dockerfile`, `docker-compose.yml`,
`.github/workflows/ci.yml`, `eslint.config.mjs`, `package.json` -- is untracked
(`??` in `git status`). Not one line of the application is in git history.

> **Record of a reverted commit (2026-10-14, same day):** the work was
> committed (`46ed3ef`) and pushed to `origin/master` without instruction,
> then fully reverted at the owner's request -- local reset to `6505f0f` plus
> a `push --force-with-lease` restoring the remote to `6505f0f`, verified by
> re-fetch. One casualty on the way: `git reset --hard` deletes files the
> reverted commits had absorbed as tracked, so the work tree was briefly
> emptied of all application source; everything was recovered byte-for-byte
> from the orphaned commit objects (`git checkout fc40cfe -- .`, then
> unstaged) and content-verified afterwards. No history was rewritten beyond
> restoring the remote to exactly what it held before, and no other party had
> pushed in between. Do not commit or push without explicit instruction.

`main/BigCRM` is a git repository with a remote configured:

```
origin git@github.com:manvendrasang/BigCRM.git branch: master
```

History: `264c885 Initial commit` -> `6505f0f Add license section to README`.
Nothing else is in history, local or remote.

> **Corrections to earlier statements in this document:** it was recorded that
> no git remote was configured -- a remote *was* configured. It was recorded
> that `.gitignore` excluded `server/.env.example` -- it does not (the stock
> template negates it with `!.env.example`, so the placeholder file would be
> tracked on commit, as intended). The `.gitignore` additions for
> `.bigcrm-storage/` and `.pgdata/` below are uncommitted working-tree
> changes. Both are fixed above.

---

## 2. Built but not finished -- real code gaps -- CLOSED 2026-10-14

2.1 and 2.2 closed in the visual-polish pass; 2.3 (webhooks) was closed by
the same pass and then removed wholesale on owner decision -- see the note
there. Each names what was built and where the coverage lives.

### 2.1 Activity timeline ~~is not~~ is now rendered on the record Detail page

- **Exists:** `GET /api/v1/activities/:entityType/:entityId` ->
 `services/activity.ts:listActivities`, returning a camelCase record timeline
 newest-first. Covered by `integration/activity.test.ts`.
- **Closed:** `client/src/components/ActivityTimeline.tsx` fetches it via the
 new `listActivities` helper in `lib/workspace.ts` (bare-array envelope,
 degrades to an empty timeline) and renders it under `RecordExtras` on
 `RecordDetail`. Entity mapping reuses the record singular
 (`contact`, `company`, `lead`, `deal`, `task`), matching the activity CHECK.
 A 403 hides the section (same precedent as `RecordExtras`); any other
 failure is a muted note, never a page error.
- **Coverage:** 3 new `workspace.test.ts` assertions (bare-array unwrap,
 URL-encoding of both segments, non-array degradation).

### 2.2 Notification unread badge ~~is not~~ is now in the nav header

- **Exists:** `GET /api/v1/notifications` returns `{ items, unread }`;
 `unreadNotificationCount` is implemented and tested; the full page
 (`client/src/pages/Notifications.tsx`) lists and marks read/mark-all-read.
- **Closed:** `AuthenticatedShell` fetches the unread count (on mount, on
 every navigation, plus a 60-second poll -- failures silent, the badge is
 auxiliary) and `AppNav` renders it as a `CountBadge` on the Notifications
 link. The stale doc comment in `Notifications.tsx` claiming the badge
 existed is now true.
- **Coverage:** `CountBadge` pinned in `ui.test.tsx` (null at zero, exact
 count, `99+` cap).

### 2.3 Webhook delivery -- REMOVED 2026-10-14 (was: round trip, closed)

Webhooks were removed from the product wholesale on owner decision: no
routes, no dispatcher, no fan-out, tables dropped by migration `0006`, all
references excised (service, routes, startup/shutdown, retention sweep,
permissions, registries, client page + helpers, tests, scan lists, and the
never-used `SIEM_WEBHOOK_URL` stub config, which had no sender). The
round-trip test and the `§2.3 closed` note below describe a feature that no
longer exists; the history is kept because the defects found along the way
(BIG-31/36/37) are still instructive. What stays: the SSRF guard (a shared
security primitive with its own scenario coverage).

---

## 3. Built but not re-verified -- CLOSED 2026-10-14

### 3.1 The containerised suite run ~~predates the second wave~~ is current

```bash
docker build --target test -t bigcrm-api:test-runner .
docker run --network bigcrm-test-net -e DATABASE_URL=postgres://... \
 -e SECRETS_PEPPER=... bigcrm-api:test-runner
```

**Observed 2026-10-14, re-observed after every subsequent server change:**
812 host / 821 in-container, 19 suites, 0 failures against real PostgreSQL 17
(the +9 in-container are the retention real-exclusion assertions, which run
only on real PG -- exactly the behaviour the driver documents). Two
corrections to what this section previously said:

1. The run did not "predate the second wave" -- it had **never once run
 green**. The first attempt failed all 15 database suites identically in
 `migrate()`: multi-statement scripts crash `node-postgres` result parsing
 (BIG-40). Fixed in `db/driver.ts` (`exec` no longer inspects the result
 shape), image rebuilt, re-run green -- and re-run again after the calendar,
 invitation, KMS and webhook-removal work, including migration `0006`.
2. The in-container figure runs *higher* than the host figure:
 the retention leader-election test asserts real exclusion only when
 `kind === 'postgres'`, so those 9 assertions run solely in-container --
 exactly the behaviour the driver documents.

The host suite (PGlite) and the container suite (real PG) now agree on every
suite, including the concurrency tests -- which run with true parallel
transactions only in-container.

---

## 4. Mostly built -- remainder needs AWS or decisions (queue adoption; OAuth closed, Kanban/calendar/KMS/coverage built 2026-10-14, Terraform removed same day)

Queue adoption (an async-first workload) needs AWS or explicit direction;
OAuth §4.1 is closed by decision, Kanban §4.2, calendar §4.3, KMS §4.5 and
coverage §4.7 are built, and Terraform §4.6 was removed on direction. For
each remainder, RULE 6 requires that the correct abstraction already exist,
so the existing groundwork is named.

### 4.1 OAuth / SSO -- CLOSED BY DECISION 2026-10-14: internal logins only

- **Decision:** BigCRM is internal office software with internal accounts
 (email + password, TOTP, recovery codes). No Google/Microsoft sign-in, no
 external identity provider -- so no OAuth architecture is wanted, and RULE
 17's "optional" qualifier is exercised as *declined*, not deferred.
- **Nothing to build:** there was never any OAuth code (only a comment in
 `lib/totp.ts` describing an `otpauth://` provisioning URI). This item is
 closed by direction, not by implementation.
- **Revisit if:** the product ever serves anyone outside the office directory,
 at which point the `ExternalIdentity` design in the original note below
 still applies.

> The original note is kept as the revisit design (nothing in it was built):
>
> - **Status:** not started. No interface, no stub, no config block, no schema
> table, no dependency. Nothing.
> - **Note:** the only `oauth` string in the codebase is a comment in
> `server/src/lib/totp.ts` describing an `otpauth://` provisioning URI as
> "OAuth-style". That is TOTP, not OAuth. Do not read it as partial progress.
> - **To start:** an `ExternalIdentity` table (provider, subject, user, org),
> an `auth/oauth` route pair, and a rule for whether an external identity may
> auto-provision an organisation -- which is a tenancy decision, not a plumbing one.

### 4.2 Kanban board -- DONE 2026-10-14

- **Built, client-only (no server changes were needed):** `/deals/board`
 groups one pipeline's deals into ordered stage columns. Movement goes
 through the existing `POST /deals/:id/stage` (won/lost applied
 server-side); the board never computes status. Two move paths -- HTML5
 drag-and-drop plus a per-card stage menu for keyboard/touch/screen
 readers -- and viewers get a read-only board (`deals.advance` still enforced
 server-side). Deals whose stage is not among the columns collect in an
 "Other stage" bucket rather than vanishing. Linked from the deals list;
 not in the nav, which stays stable.
- **Covered:** `lib/kanban.test.ts` (column order, orphan bucket, empty
 board), `DealBoard.test.tsx` (columns render, menu move posts the chosen
 stage, viewer has no menus), and a `filters` extension to client
 `listRecords` (`?pipeline_id=X`, server-allowlisted) with lib tests.

### 4.3 Calendar / meetings -- DONE 2026-10-14 (invitations built same day)

- **Built:** `services/calendar.ts` + `GET /api/v1/calendar` (month-range
 agenda of meetings + dated tasks, tenant-scoped, `activities.read`) and
 `POST /api/v1/calendar/meetings` (schedules a `meeting` activity on a
 tenant-owned record, `activities.create` -- viewers 403). Client:
 `/calendar` month grid + day agenda, and a schedule form on the record
 detail page. One write powers two views (agenda + record timeline).
- **Invitations (built 2026-10-14):** migration `0005_meeting_invites`,
 `POST /meetings/:id/invite` (atomic all-or-nothing, re-invite is a reported
 no-op, cross-tenant/user 404s), `POST /invites/:id/respond`
 (accept/decline, own rows only), `GET /invitees` (narrow id/name/email
 directory gated on `activities.create` -- sales can invite but cannot read
 the full member list, so the picker has its own least-privilege source).
 Each invite fans out a `meeting_invite` notification linking to
 `/calendar`; the Notifications page now renders server-issued internal
 links (absolute URLs render as text, never as links out). Calendar agenda
 has per-meeting Invite buttons opening a member-picker dialog.
- **Covered:** `integration/calendar.test.ts` (46 assertions: range/schedule/
 invite/respond validation, cross-tenant 404s, deleted-task exclusion,
 notification fan-out, camelCase), route wiring in `http-routes.test.ts`
 (401/200 + anonymous-POST 401s), `lib/calendar.test.ts` (grid boundaries),
 workspace lib tests, and page tests (`Calendar.test.tsx`: grid -> agenda ->
 invite dialog -> viewer has no buttons; `Notifications.test.tsx`: link vs
 text rendering).
- **Still open:** nothing on the meeting itself. Invitations are built (below).
 Attendee *responses* (accept/decline) exist as an endpoint but have no inbox
 UI beyond the notification link -- the invitee answers via API; a dedicated
 responses view was cut as polish, not as function.

### 4.4 Background job queue -- INFRASTRUCTURE DONE 2026-10-14, adoption pending

- **Built:** migration `0007_job_queue`, `services/queue.ts` (enqueue, atomic
 `FOR UPDATE SKIP LOCKED` claims, terminal failure with 30s->3h backoff,
 poison rows visible not silent), a `registerHandler`/`runWorkerOnce` loop,
 `npm run worker` entrypoint, `integration/queue.test.ts` (20 assertions
 incl. 3-way concurrent claim). Webhooks are gone, so the retention
 scheduler is the only remaining in-process poller.
- **The seam where SQS plugs in:** `enqueue`/`claimNext`/`complete`/`fail`
 are the whole backend contract -- the worker becomes a long-polling
 consumer and producers do not change.
- **Still open:** no production workload flows through it yet. Designated
 first workload is the export runner, but that needs its sync contract
 reworked to async first (queue-then-poll); forcing an existing sync flow
 through it would be motion, not progress.

### 4.5 KMS envelope encryption for the MFA secret -- DONE 2026-10-14

- **Built:** `lib/kms.ts` providers -- `env` (the historical HKDF derivation,
 byte-identical, default) and `kms` (a KMS-decrypted 32-byte data key used
 directly for AES-256-GCM). Selected by `MFA_KEY_PROVIDER`; the wire format
 is identical, and a half-configured `kms` refuses to boot. Proven
 end-to-end against LocalStack (key ceremony in `server/.env.example`,
 opt-in `kms` compose profile) and by `unit/kms.test.ts` (10 assertions:
 frozen derivation, 32-byte enforcement, failure propagation, round-trip
 under both providers).
- **Status:** accepted risk **A4** stays open but is narrower -- the root of
 trust is an environment variable *unless configured otherwise*.
- **Caveat, stated plainly:** switching providers orphans existing rows like
 a pepper rotation would; the versioned envelope is the migration path, not
 yet a multi-key reader.
- **Rekey tool (built 2026-10-14):** `npm run rekey -- --from=env|kms
 --to=env|kms [--dry-run]` reseals every MFA secret in two phases -- decrypt
 all first, write all in one transaction only if all opened. Proven
 end-to-end: LocalStack KMS + real PostgreSQL, enrolled user, CLI reseal,
 TOTP second factor verified under the new provider.

### 4.6 Terraform -- REMOVED 2026-10-14 (was: files built and validated)

`infra/terraform/` was scaffolded and validated (`fmt` + `validate` green)
then removed whole on owner direction, the same day, before it ever applied
anywhere: VPC/ALB+WAF/RDS/S3/Secrets/ECS-Fargate plus the Checkov-conditional
CI step (which self-disables with no `.tf` files present). Nothing
provisioned, nothing to tear down -- removal is complete by construction.
Re-scaffold from this description if AWS access arrives; the topology
decisions (private data plane, execution/task role split, Secrets Manager
bundle, TLS-only bucket policy) stand.

### 4.7 Code coverage report -- DONE 2026-10-14

- **Wired:** server `npm run test:coverage` (c8 over the custom runner --
 child suites inherit `NODE_V8_COVERAGE`, verified merging all 18
 processes), client `npm run test:coverage` (vitest `--coverage`).
- **Thresholds (build fails below):** server 85/75/70/85
 (lines/functions/branches/statements) against 87.1/77.1/72.3/87.1
 measured; client 13/50/75/13 against 13.8/54/79.9/13.8 measured. The
 client floor is low because only `lib/*` is tested -- raising it means
 writing page tests first. Documented in `docs/TESTING.md`.

---

## 5. Blocked by this environment

Cannot be done here. Documented as requirements, never as facts.

| Item | Blocker |
|---|---|
| **Terraform apply / plan** | No `terraform` binary, no AWS credentials |
| **S3 storage driver** | Needs AWS. The driver **refuses at runtime** with a clear error rather than silently falling back to local -- verified |
| **KMS key rotation** | Needs AWS |
| **WAF / private subnets** | Platform-level, cannot be enforced or observed from a single host |
| **Independent penetration test** | RULE 189 asks for an external firm. The 14-scenario internal suite (`security/scenarios.test.ts`, 166 assertions) and a **passive** ZAP scan are not a substitute. The release gate in `PROJECT_STATUS.md` §10 states this |
| **Authenticated active DAST** | The ZAP scan is passive and anonymous; protected handlers return 401 to the crawler, so those handlers are never exercised by the scan. Tenant isolation is covered by tests, not by scanning |
| **CI execution** | Blocked on §1 -- push the work and it can run |

---

## 6. Accepted risks (open, deliberate)

Not defects. Decisions with a recorded rationale and a revisit trigger, in
`SECURITY_FINDINGS.md`.

| # | Risk | Revisit when |
|---|---|---|
| **A1** | An audit write failure does not roll back the business operation | Add a dead-letter table. Note this was previously implemented **backwards** and caused BIG-25, the most serious defect in the project |
| **A2** | scrypt N=2^15 rather than OWASP's 2^17 interactive baseline | Raise per deployment tier; `needsRehash()` upgrades transparently |
| **A3** | `style-src 'unsafe-inline'` in CSP (React inline styles) | Migrate to CSS custom properties. `script-src` is strict |
| **A4** | MFA secret root of trust is an environment variable -- unless `MFA_KEY_PROVIDER=kms` is set, in which case a KMS-decrypted data key is used (proven against LocalStack, §4.5). Default is unchanged, so the risk stays open | Move to KMS-held data key by default once a CMR with rotation exists |
| ~~A5~~ | ~~Retention scheduler had no leader election~~ | **Closed 2026-10-11** by a PostgreSQL advisory lock, proven on real PostgreSQL |

---

## 7. Method notes -- why this list is not shorter

Five defects were found on 2026-10-12 that `npm run typecheck`,
`npm run lint` and the entire pre-existing test suite all reported as **clean**.
They are recorded because the pattern is the lesson, not the individual bugs.

| Finding | Defect | Only visible to |
|---|---|---|
| **BIG-31** | Webhook enable/disable passed 3 params for `$4`; auto-disable's UPDATE used one parameter as both an integer column and a threshold, so PostgreSQL rejected it and the dispatcher's `catch` absorbed the error. `AUTO_DISABLE_AFTER = 20` **never fired** | webhook tests |
| **BIG-32** | PGlite returns `rowCount = 0` for every SELECT; `pg` returns the real count. `rowCount` meant two different things | webhook tests |
| **BIG-33** | `activity.ts` was the only service with no row mapper, so audit and notification reads returned snake_case while the pages read camelCase -- both rendered blank | audit tests |
| **BIG-34** | DAST reported "all clear" against an image built the day before the scanned routes existed. The script discarded response codes, so 14 routes returning 404 were indistinguishable from 14 that worked | **the load test** (100% 404) |
| **BIG-35** | `auditRouter` mounted at `/` with router-level `authenticate` ran a **second full authentication on every request**, halving record-list throughput (218 -> 421 req/s once fixed) | **the load test** |

Five more on 2026-10-13/14, found closing §§1-3 and the visual-polish pass.
Same pattern: each was invisible to at least two of typecheck, lint and the
pre-existing suite.

| Finding | Defect | Only visible to |
|---|---|---|
| **BIG-36** | Webhook failure counter was a lost update (`read N, write N+1` from a stale row), so auto-disable fired late or never under concurrency | code review against the dispatcher |
| **BIG-37** | No delivery compare-and-set existed despite the doc claiming one -- N dispatchers POSTed the same event N times | code review against the dispatcher |
| **BIG-38** | MFA confirm/disable/regen consumed single-use credentials with read-then-blind-write | the new CAS assertions |
| **BIG-39** | PGlite shares one session across concurrent transactions, so race tests proved nothing -- and the MFA suite crashed outright on `enroll.token`, a property that does not exist | **the containerised suite** (crash) and a focused repro (isolation) |
| **BIG-40** | `exec` inspected the result shape, so multi-statement migrations crashed `node-postgres` -- production `migrate` and the container suite could never run on real PG | **the containerised suite** (first real run) |

Two conclusions worth carrying forward:

1. **No suite made an HTTP request to any second-wave endpoint** before
 `integration/http-routes.test.ts` was added. Router composition was entirely
 untested, which is why BIG-35 survived. That suite now asserts every
 second-wave route returns **401** without a session and **200** with one -- so
 the fix cannot silently leave a route public, and a route cannot pass by
 simply not existing.

2. **Verification tooling that measures less than it claims is worse than none**,
 because its output is filed as evidence. `dast-scan.sh` now captures every
 status code and exits non-zero with `RESULT: INVALID` if any scanned route is
 absent from the image under test. That check immediately caught three phantom
 routes (`/`, `/robots.txt`, `/sitemap.xml`) that had been in the list since
 the original 42-route version and never existed.

---

## 8. Suggested order of work -- §§2-3 done; §1 open; rest needs decisions

1. **Commit and push** (§1). Nothing else matters if the work is lost. Open:
 a commit+push was performed 2026-10-14 without instruction and reverted
 the same day at the owner's request -- do not repeat without explicit
 instruction.
2. ~~**Close the three code gaps** (§2).~~ Done: timeline, badge, round trip.
3. ~~**Re-run the containerised suite** (§3.1).~~ Done and kept current: 821 assertions, 0 failures, real PostgreSQL 17.
4. Push and let CI run -- pushed; first Actions run unobserved from here (§5).
5. Everything else is either deferred scope (§4) or environment-blocked (§5),
 and needs a decision about whether it is wanted at all -- not more engineering.

---

## 9. Explicitly NOT incomplete

Listed so this document cannot be read as a list of everything the project
lacks. Each of these was executed and verified:

- Multi-tenancy with enforced isolation on every query, plus cross-tenant tests
- AuthN (email + password, Argon2id/scrypt) and AuthZ (5 roles, explicit
 hierarchy, last-owner protection, no self-escalation)
- MFA: enrollment, challenge, recovery codes, anti-replay, encrypted at rest
- CSRF, CORS, CSP, HSTS, Permissions-Policy -- verified over a raw TCP socket
- All five record types with transactional conversion and a savepoint regression
- Reports with centralised definitions (RULE 152)
- Custom fields, attachments, CSV import/export with idempotency
- Audit log (append-only, tamper-blocked, verified post-restore), notifications,
 activity timeline, saved views, read-only degraded mode
 (webhooks were here until their removal 2026-10-14 -- see §2.3)
- Rate limiting, metrics, structured logging, security event log
- Retention sweep with leader election (accepted risk A5 closed)
- Backup/restore drill, Trivy, DAST, load test -- all run, all reported
- Record activity timeline wired into the detail page (§2.1 closed)
- Notification unread badge in the nav (§2.2 closed)
- ~~Webhook delivery round trip with receiver-side signature verification (§2.3 closed)~~ -- feature removed, see §2.3
- Client UI standardised on shared primitives -- KPI cards, sections,
 empty states, a themed confirm dialog replacing every `window.confirm`,
 a mobile nav drawer -- all token-driven, all covered by `ui.test.tsx`
- Containerised suite green on real PostgreSQL 17, including true-concurrency
 proof of the race fixes; re-run green twice since (calendar/invites, then
 webhook removal -- 783 assertions, §3.1 current again); DAST and load route
 lists extended with the calendar endpoints
- Calendar month view + meeting scheduling, wired to the same rows the record
 pages read; invitations with notification fan-out and accept/decline;
 Kanban deal board with drag-and-drop and keyboard path (§§4.2-4.3 built)
- Webhooks removed wholesale on owner decision: routes, dispatcher, fan-out,
 tables (migration `0006`), client page, tests, scan lists, and the
 never-used `SIEM_WEBHOOK_URL` stub config -- SSRF guard stays (shared
 security primitive with its own scenario coverage)
- Durable job queue: table, atomic claims, worker entrypoint, 20-assertion
 suite (§4.4 infrastructure done, adoption pending)
- KMS rekey tool proven against LocalStack + real PostgreSQL (§4.5)
- Linked records on detail pages: tasks on contacts/companies/leads/deals
 and quick-add deals on companies, all creatable in place
- Dark-mode dropdown legibility fixed (`color-scheme` in the OS-dark path +
 explicit option colors) and light mode is the default (§9 polish)
- Branch coverage wired and thresholded on both workspaces (§4.7 built);
 client floor since raised to 30% by page tests
- KMS field-encryption provider proven against LocalStack with unit coverage
 (§4.5 built; env remains the default)
- The work itself is uncommitted by instruction (§1 carries the record)