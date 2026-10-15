# OPERATIONS

## Health endpoints

| Endpoint | Purpose | Exposes |
|---|---|---|
| `/health` | Liveness -- is the process up | Status only |
| `/ready` | Readiness -- should traffic be routed | DB reachability + latency |
| `/internal/metrics` | Prometheus | Metrics |

**None expose credentials, environment values, internal topology, dependency
versions or stack traces** (RULE 118). `/ready` must be bound to a private
network or authenticated; `/internal/metrics` likewise.

## Startup sequence

```
1. loadEnvFrom(process.env) fail-closed: abort on any missing/insecure value
2. migrate() checksummed, transactional; aborts on drift
3. initDriver() pool created, statement_timeout set
4. syncIndexes declared indexes built
5. app.listen()
6. readiness probe confirms the database
```

If step 1 or 2 fails the process exits non-zero. That is intentional: a
misconfigured instance must not serve traffic.

## Graceful shutdown

```
SIGTERM/SIGINT
 -> stop accepting connections
 -> finish in-flight requests (10 s budget)
 -> stop the worker and drain the queue
 -> close the database pool
 -> exit 0
```

Hard timeout forces exit 1 so the orchestrator restarts rather than waiting.

## Retention

Configurable per entity. Defaults:

| Data | Default | Behaviour |
|---|---|---|
| Audit log | 730 days | Append-only; purge only past retention |
| Sessions | 30 days past expiry | Revoked rows pruned |
| Notifications | 90 days | -- |
| Expired exports | 7 days | Objects deleted with the row |
| Consumed reset/verify tokens | on use | Deleted immediately |
| Accepted invitations | 90 days | -- |

Purge runs **only** when `RETENTION_PURGE_ENABLED=true`, with a dry-run mode
first.

**Status: no scheduler exists yet** (`BIG-12`). Until then these tables grow
unbounded. This is an open finding, not a working feature.

## Legal hold

A `legal_hold` flag on an organization pauses purging for that tenant's data.
**Not implemented.** Before enabling destructive retention in production this
must exist.

## Scaling

| Axis | Current state | Approach |
|---|---|---|
| API | Stateless | Scale horizontally; cookies are the only session state |
| Web | Stateless | TaskFlow's `NODE_ENV`-gated static serving is **not** reproduced; static assets belong on the CDN |
| DB connections | `DB_POOL_MAX` per task | Bound total: tasks × pool  RDS max connections |
| Long operations | Single request | Must become background jobs (exports, imports) |
| Worker | Not built | SQS with a DLQ |
| Cache | Not used | If added, keys must include `organizationId` + `userId` -- never tenant-agnostic (RULE 78) |

## Index maintenance

`syncIndexes()` builds declared indexes and drops undeclared ones. Review the diff
before applying: an index present in production but absent from the schema will be
dropped.

## Backup and restore

Managed by the platform. See `DISASTER_RECOVERY.md`.

**Operational rule: a backup that has never been restored is not a backup.**
A restore drill is a release requirement.

## Incident severity

| Level | Definition | Response |
|---|---|---|
| SEV1 | Active breach, data loss, full outage | Page immediately; `INCIDENT_RESPONSE.md` |
| SEV2 | Partial outage, sustained auth failures, elevated 5xx | Page during business hours |
| SEV3 | Degraded performance, single-feature failure | Business hours |
| SEV4 | Cosmetic, non-urgent | Backlog |

## Common tasks

**Revoke every session for a user** -- `security_events` + session rows; or
change/reset the password, which revokes all sessions by design.

**Force-logout one session** -- `POST /api/v1/auth/sessions/{id}/revoke` (routes
pending) or a direct `UPDATE sessions SET revoked_at` -- the next request fails
the session check immediately.

**Recover from a bad migration** -- forward-fix. Migrations are checksummed and
`@destructive` ones require explicit acknowledgement, so an accidental drop is
unlikely; a mistaken one still needs a compensating migration.

**Rotate a JWT secret** -- rotating `JWT_ACCESS_SECRET` invalidates access tokens
(15 min of disruption at most). Rotating `JWT_REFRESH_SECRET` invalidates refresh
tokens, logging everyone out. **`SECRETS_PEPPER` cannot be rotated without a
re-hash plan** -- see `INCIDENT_RESPONSE.md` §5.

**Add a permission** -- add to `ROLE_PERMISSIONS`, add to `OWNER_ONLY` if
owner-exclusive, then the invariant assertion in `unit/rbac.test.ts` will fail if
the sets have drifted.
