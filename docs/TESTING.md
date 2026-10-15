# TESTING

## Run

```bash
npm test # all suites -- 838 assertions
npm run test:security # the 14 RULE 222 scenarios only -- 166 assertions
npm run typecheck # tsc --noEmit, strict + noUncheckedIndexedAccess -- 0 errors
```

Individually:

```bash
cd server
node --experimental-strip-types --no-warnings --env-file=.env.test src/tests/unit/rbac.test.ts
node --experimental-strip-types --no-warnings --env-file=.env.test src/tests/integration/auth.test.ts
node --experimental-strip-types --no-warnings --env-file=.env.test src/tests/security/scenarios.test.ts
```

`src/tests/run.ts` executes each suite in a **fresh child process** so each gets a
clean database, then reports only results it observed (RULE 5).

## Current results

```
SKIPPED (excluded from tsconfig): unit/mongodb.test.ts
Running 20 suite(s)
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
PASS integration/members.test.ts 50 assertions
PASS integration/queue.test.ts 20 assertions
PASS integration/readOnly.test.ts 7 assertions
PASS integration/records.test.ts 94 assertions
PASS integration/reports.test.ts 15 assertions
PASS integration/retention.test.ts 20 assertions
PASS integration/savedViews.test.ts 12 assertions
PASS security/mfa.test.ts 71 assertions
PASS security/scenarios.test.ts 168 assertions
TOTAL: 874 assertions passed, 0 failed across 20 suites
```

## Environment

| Setting | Value | Why |
|---|---|---|
| `PGLITE_DATA_DIR=memory` | ephemeral | Each process starts from an empty database |
| `DATABASE_URL` | unset | Production path; not exercised here |
| `LOG_LEVEL` | `silent` | Keep output readable |

PGlite is **real PostgreSQL 17.5**, not a mock. Foreign keys, unique constraints,
CHECK constraints, triggers, `UPDATE ... RETURNING` and transactions all behave
exactly as they do in production. This matters: it is what caught the legacy
SQLite-only DDL defect and my own composite-FK ordering bug.

## Layout

```
src/tests/
 run.ts runner (fresh process per suite)
 unit/config.test.ts 19 -- production config fail-closed, TLS posture, CA handling
 unit/kms.test.ts 10 -- envelope encryption; rekey between env and kms backends
 unit/modules.test.ts 75 -- every module loads; disabled sources inert; no secret literals
 unit/rbac.test.ts 26 -- permission matrix, hierarchy, invariants
 integration/auth.test.ts 26 -- register, login, lockout, sessions, token reuse
 integration/calendar.test.ts 53 -- agenda, meetings, invitees, invites inbox
 integration/http.test.ts 100 -- headers/CORS/CSRF/cookies/errors over a real socket
 integration/http-mfa.test.ts 28 -- MFA enrollment and login challenge over HTTP
 integration/members.test.ts 50 -- in-house account creation, role bounds, permission gate, member-initiated password reset
 integration/records.test.ts 94 -- records, tenant isolation, transactional conversion, viewer task scope
 integration/retention.test.ts 20 -- batched purge; audit rows never deleted
 security/scenarios.test.ts 168 -- 14 RULE 222 scenarios + supporting controls
```

## Branch coverage -- wired 2026-10-14

```bash
npm run test:coverage --workspace=@bigcrm/server # c8, enforced thresholds
npm run test:coverage --workspace=@bigcrm/client # vitest --coverage, enforced thresholds
```

Measured at wiring (all suites green):

| Workspace | Lines | Functions | Branches | Statements | Thresholds (fail build below) |
|---|---|---:|---:|---:|---|
| server (c8, 18 suites, PGlite) | 87.1 | 77.1 | 72.3 | 87.1 | 85 / 75 / 70 / 85 |
| client (v8, 129 tests) | 54.1 | 62.3 | 74.9 | 54.1 | 46 / 62 / 74 / 46 |

Notes, stated plainly:

- Server coverage counts the child-process suites: `run.ts` spawns each suite
 with the parent's environment, so `NODE_V8_COVERAGE` propagates and c8
 merges all 18 processes. Verified, not assumed -- the numbers above came
 from a real `test:coverage` run.
- Client coverage is low on purpose-record: only `lib/*` (plus `ui.tsx`) is
 tested; pages render untested. The thresholds guard the measured floor.
 Raising them means writing page tests first.
- Reports land in `server/coverage/` and `client/coverage/` (both ignored).

## Coverage map

### `unit/rbac.test.ts`
Owner-only invariant - owner  admin - admin cannot delete the org - role rank
ordering - no self-promotion - no peer/superior modification - manager/admin
invitation ceilings - last-owner protection on demote and remove - export is
admin+ - a viewer writes nothing except the `status` of a task assigned to them,
and holds no `reports.read`, `custom_fields.read` or `saved_views.read`.

### `integration/auth.test.ts`
Registration atomicity - email canonicalisation - weak/common/short passwords
rejected - password must not contain the email - duplicate rejection - login -
short access-token TTL - required JWT claims - **identical error for unknown
account and wrong password** - account lockout - device label derivation -
multiple sessions - **password change revokes every session** - new password
works - old password rejected - same-password rejection - reset token issued -
reset for unknown account yields no token - reset completes - reset revokes all
sessions - **reset token is single-use** - bogus token rejected identically.

### `security/scenarios.test.ts`
| Scenario | Assertions |
|---|---|
| 1 Tenant escape | unscoped query **rejected**; scoped query empty; cross-org UPDATE no-op |
| 2 IDOR | contact, company, audit, task, deal all unreachable; member list scoped; foreign user id rejected |
| 3 Role escalation | owner unassignable - admin cannot demote owner - live self-promotion blocked - role unchanged - self role change refused |
| 4 Stored XSS | escaping leaves no `<>"'` - rich-text has no active construct - `javascript:` href stripped - event handlers stripped - `<img onerror>` stripped - safe markup preserved - external links get `rel=noopener` |
| 5 Storage isolation | keys namespaced by org - no predictable filename - uuid ids - forged key differs |
| 6 Uploads | SVG+script, renamed HTML, PE, traversal, NUL, no-extension, empty, oversized, extension/content mismatch all rejected; valid CSV accepted |
| 7 SSRF | loopback, link-local, RFC1918 ×3, IPv6 loopback, `localhost`, metadata hostnames, `.internal`, `.local`, `file://`, `gopher://`, embedded credentials all blocked; public https allowed; non-http rejected |
| 8 CORS | evil origin not allowlisted - dev origin allowlisted - allowlist non-empty - **empty list denies** |
| 9 Session theft | fresh validates - revoked rejected - refresh from revoked rejected |
| 10 Password change | two sessions exist - all revoked - old access token dead |
| 11 Invitation abuse | **no token in response** - no token substring - preview safe - existing user cannot join without identity - victim not added - owner invitation refused - viewer invitation allowed - admin cannot invite admin or owner |
| 12 Export abuse | viewer and sales lack export - manager lacks export - admin/owner have it - viewer cannot create imports/exports, read audit, manage users, change org settings, delete, read reports/custom fields/saved views, and cannot reset a password |
| 13 CSV injection | 7 formula payloads neutralised - quoting - plain values untouched - commas quoted - detector precision - RFC 4180 parsing - NUL rejected - unterminated quote rejected |
| 14 Audit tampering | UPDATE rejected - DELETE rejected - count unchanged - diff keeps business fields - drops password hash, tokens, email, phone, name |
| Supporting | signed cursors - page caps - **TOTP vs RFC 6238 vector** - password hashing properties - malformed hash handling - strength policy - log redaction - email masking - circular objects |

## Not covered yet

| Gap | Reason |
|---|---|
| HTTP status codes, headers, CORS/CSRF over a socket | No route layer |
| Records service (CRUD, duplicate detection, lead conversion) | Service not written |
| MFA enrolment/challenge endpoints | No routes; no column (`BIG-10`) |
| Import/export end-to-end | Job runner not written |
| Storage provider | S3 not available here |
| Property/fuzz testing | Planned for parsers (CSV, cursor, JWT) |
| Performance/load | No harness, no production-shaped dataset |
| `pg` pool path | Only PGlite executed (`BIG-21`) |

## Adding tests

Every discovered security defect becomes a permanent regression test
(RULE 185). Naming convention used throughout:

```
[FAIL] S<n>  <property>
```

A test must assert the **property**, not a proxy. Two failures in this codebase
were caused by weak assertions and are worth recording:

- `test.js` in TaskFlow asserted `priority !== 'urgent'` when the contract was
 "restores the original priority" -- so a silent data-loss bug shipped
 (`LEG-32`).
- My own first drafts asserted `!output.includes('onerror')` when the property
 was "no active construct"; and expected `owner may invite owner` when the
 design is stricter.

When a test fails, decide whether the **code** or the **assertion** is wrong, and
record which. `SECURITY_FINDINGS.md` cites both directions.
