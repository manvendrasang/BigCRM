# API

Base path `/api/v1`. The v1 route layer is mounted in full
(`server/src/routes/v1/index.ts`); the active DAST scan drives 56 of its routes.

## Conventions

### Field casing — camelCase in responses, snake_case in the database
Every read path maps its rows to camelCase at the service boundary
(`rowToField`, `rowToView`, `rowToEndpoint`, `rowToAuditLog`, …). Clients read
`entityType`, `createdAt`, `changedFields`.

This is not automatic and not enforced by types alone. A service that returns its
raw `TenantScope.query()` result leaks snake_case into the API and the page
silently renders blank cells — see BIG-33, where the audit viewer did exactly
that while typecheck and lint stayed green. **A new read endpoint needs a
mapper, not just a SELECT.** The permissive `Record<string, unknown>` return
type will not catch its absence.

### Success
```json
{ "data": { … }, "requestId": "…" }
```

### Lists — cursor pagination
```json
{
  "data": [ … ],
  "pageInfo": {
    "hasNextPage": true,
    "hasPreviousPage": false,
    "startCursor": "eyJ0Ijoi…",
    "endCursor": "eyJ0Ijoi…"
  },
  "totalCount": 421
}
```
`?first=` defaults to 25, **hard cap 100**, out-of-range values are **rejected**
(not clamped). Cursors are HMAC-signed; a tampered cursor returns 400. The
response reports the values actually applied — the legacy CRM echoed the raw
query values, so its envelope lied about the window (`LEG-14`).

### Errors
```json
{
  "code": "VALIDATION_FAILED",
  "message": "Request validation failed.",
  "details": { "email": "Enter a valid email address." },
  "requestId": "9f2c1ab4e0d3"
}
```
No stack traces, SQL, paths, hostnames, or secrets — ever (RULE 120).

| Code | Status | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed input |
| `UNAUTHENTICATED` | 401 | No/invalid/expired/revoked session, or not a member |
| `INVALID_CREDENTIALS` | 401 | Login failure — **identical for unknown account** |
| `FORBIDDEN` | 403 | Authenticated, insufficient permission |
| `NOT_FOUND` | 404 | Absent **or in another tenant** — never disambiguated |
| `CONFLICT` | 409 | Duplicate, or last-owner protection |
| `PAYLOAD_TOO_LARGE` | 413 | Body/file limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Upload rejected |
| `VALIDATION_FAILED` | 422 | Field-level validation |
| `RATE_LIMITED` | 429 | Throttled |
| `INTERNAL_ERROR` | 500 | Logged internally, generic externally |

## Authentication

`Authorization: Bearer <access-token>` **or** the `HttpOnly` cookie
(`bigcrm_at`). Access tokens last 15 minutes; refresh tokens rotate and are
single-use. State-changing requests must carry an allowlisted `Origin` and a
custom header.

## Implemented surface

Every row below is mounted and exercised — over a real socket where the claim is
about HTTP behaviour, and at the service layer otherwise.

### Authentication

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/v1/auth/register` | — | Atomic: user + org + membership |
| POST | `/api/v1/auth/login` | — | Timing-equalised; per-account limit; returns `mfaRequired` when enrolled |
| POST | `/api/v1/auth/refresh` | — | Rotating, reuse → family revoked |
| POST | `/api/v1/auth/logout` | session | Revokes the current session |
| POST | `/api/v1/auth/logout-all` | session | Revokes every session |
| GET | `/api/v1/auth/sessions` | session | Active sessions + device labels |
| DELETE | `/api/v1/auth/sessions/{id}` | session | Scoped to the caller; 404 for another user's id |
| POST | `/api/v1/auth/password` | session | **Revokes all sessions**, then clears the cookies |
| POST | `/api/v1/auth/password/forgot` | — | Enumeration-safe; token echoed only outside production |
| POST | `/api/v1/auth/password/reset` | — | Single-use token |
| POST | `/api/v1/auth/verify-email` | — | Single-use token |
| POST | `/api/v1/auth/verify-email/resend` | session | — |
| GET | `/api/v1/auth/me` | session | User + org + role |

Token delivery: the access token is returned in the body **and** set as an
`HttpOnly` cookie (`bigcrm_at`); the refresh token is **only ever** an HttpOnly
cookie (`bigcrm_at_refresh`) and never appears in a body; a readable
`bigcrm_csrf` cookie is issued for the CSRF header.

### Multi-factor authentication

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/auth/mfa/status` | session | Enabled flag, recovery codes remaining |
| POST | `/api/v1/auth/mfa/enroll` | session | Returns the secret + `otpauth://` URI **once**; `mfa_enabled` stays false |
| POST | `/api/v1/auth/mfa/enroll/confirm` | session | Verifies the code, then returns recovery codes **once** |
| POST | `/api/v1/auth/mfa/recovery-codes` | session | Requires the current factor; revokes the previous set |
| POST | `/api/v1/auth/mfa/disable` | session | Requires a TOTP or recovery code — a session alone is not enough |
| POST | `/api/v1/auth/mfa/challenge` | — | **Public.** Completes a login challenge and issues the session |

Enrollment is three-legged on purpose: until the user proves they can generate a
code, the stored secret is encrypted but grants nothing — a database CHECK
constraint refuses `mfa_enabled = true` without one.

### Organization and membership

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET/PATCH | `/api/v1/org` | `organization.read` / `.update` | Allowlisted fields; unknown field → 422 |
| GET | `/api/v1/org/roles` | `organization.read` | Assignable roles + hierarchy |
| GET | `/api/v1/org/members` | `users.read` | Tenant-scoped |
| PATCH | `/api/v1/org/members/{id}/role` | `users.update` | Hierarchy enforced; self-change refused; sessions revoked |
| DELETE | `/api/v1/org/members/{id}` | `users.remove` | Last-owner protected |
| POST | `/api/v1/org/members/transfer-ownership` | owner only | Re-authentication required; atomic; revokes both users' sessions |
| GET | `/api/v1/org/invitations` | `users.invite` | — |
| POST | `/api/v1/org/invitations` | `users.invite` | Role bounded by inviter; **token never in the response** |
| DELETE | `/api/v1/org/invitations/{id}` | `users.invite` | Revoke |
| GET | `/api/v1/org/invitations/preview?token=` | — | Safe preview only |
| POST | `/api/v1/org/invitations/accept` | — | Existing users must prove identity; a token alone never suffices |
| GET/POST | `/api/v1/org/teams` | `teams.read` / `.manage` | — |

`owner` is ungrantable by invitation or role change — it can only be reached
through `transfer-ownership`.

### CRM records

Mounted for `contacts`, `companies`, `leads`, `deals`, `pipelines`,
`pipeline_stages`, `tasks`, `notes`, `tags`. The router is generated from the
record types, so an HTTP verb maps to exactly one `<resource>.<verb>` permission.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/{type}` | `{type}.read` | `?q=` (wildcard-escaped, allowlisted columns), `?sort=`, `?order=`, `?limit=` (≤200), `?offset=`, exact filters, `?includeDeleted=` |
| POST | `/api/v1/{type}` | `{type}.create` | `pipelines` also accepts `stages[]` and creates them atomically |
| GET | `/api/v1/{type}/{id}` | `{type}.read` | Soft-deleted rows are **not** retrievable by id |
| PATCH | `/api/v1/{type}/{id}` | `{type}.update` | Only spec-permitted columns; a client cannot set `organization_id` |
| DELETE | `/api/v1/{type}/{id}` | `{type}.delete` | Soft delete. `tags` are refused — a shared vocabulary entry is not an auditable record |
| POST | `/api/v1/{type}/{id}/restore` | `{type}.restore` | A separate permission: "delete" must not imply "undo delete" |
| GET | `/api/v1/pipelines/{id}/stages` | `pipeline_stages.read` | Ordered by position |
| POST | `/api/v1/deals/{id}/stage` | `deals.advance` | Re-reads the stage; applies probability and won/lost; refuses a foreign pipeline |
| POST | `/api/v1/leads/{id}/convert` | `leads.convert` | Contact + optional company + optional deal, **all or nothing** |

An unknown `?filter=` is a 400, not a silent no-op: a client that typos a filter
must be told, or it believes it filtered by something it did not.

### Implemented in the 2026-10-11 scope

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/reports/:name` | `reports.read` | `pipeline`, `lead-funnel`, `task-load`, `overview`. Unknown names 404 |
| GET | `/api/v1/custom-fields/:entityType` | `custom_fields.read` | Definitions in position order |
| POST | `/api/v1/custom-fields` | `custom_fields.manage` | Key uniqueness, select options, typed validation |
| DELETE | `/api/v1/custom-fields/:id` | `custom_fields.manage` | Soft delete; values retained for audit |
| GET | `/api/v1/custom-fields/:entityType/:entityId/values` | `custom_fields.read` | Keyed by field key |
| PUT | `/api/v1/custom-fields/:fieldId/values/:entityId` | `custom_fields.manage` | Validated per type; null clears |
| GET | `/api/v1/attachments/:entityType/:entityId` | `attachments.read` | Non-deleted, newest first |
| POST | `/api/v1/attachments` | `attachments.create` | Raw bytes + `X-` headers; magic-byte validation |
| GET | `/api/v1/attachments/file/:id` | `attachments.read` | `attachment` disposition; cross-tenant ids 404 |
| DELETE | `/api/v1/attachments/file/:id` | `attachments.delete` | Soft delete; bytes retained |
| POST | `/api/v1/transfers/exports` | `exports.manage` | Synchronous CSV; formula cells neutralised; idempotent |
| GET | `/api/v1/transfers/exports/:id/download` | `exports.manage` | 7-day expiry; cross-tenant ids 404 |
| POST | `/api/v1/transfers/imports` | `imports.manage` | Raw CSV body; per-row errors with line numbers; idempotent |
| GET | `/api/v1/org/audit-logs` | `audit.read` | Exact-match filters; omits before/after JSON |
| GET | `/api/v1/notifications` | session | Org-AND-user scoped; `?unread=true` |
| POST | `/api/v1/notifications/:id/read` | session | Another user's id 404s |
| POST | `/api/v1/notifications/read-all` | session | Marks the caller's unread |
| GET | `/api/v1/activities/:entityType/:entityId` | `activities.read` | Record timeline, newest first |
| GET/POST/DELETE | `/api/v1/views` | `saved_views.read/manage` | Own + org-shared; shared is admin-only |
| GET | `/api/v1/webhooks/events` | `webhooks.manage` | Allowed event names |
| GET/POST | `/api/v1/webhooks` | `webhooks.manage` | Create returns the secret once |
| POST | `/api/v1/webhooks/:id/enable` · `/disable` | `webhooks.manage` | Re-enable is manual |
| DELETE | `/api/v1/webhooks/:id` | `webhooks.manage` | Soft delete |

Cross-entity search is client-side (fans out to the five tenant-scoped list
endpoints); there is deliberately no server `GET /api/v1/search`. The dashboard
is served by `GET /api/v1/reports/overview`; there is deliberately no separate
`GET /api/v1/dashboard`.

### Not yet implemented

Listed so the gap is explicit. Nothing in this table is mounted — a request to
one of these paths returns `401` (unauthenticated) or `404` (authenticated),
never a misleading success.

| Method | Path | Intended permission |
|---|---|---|
| GET | `/api/v1/notifications` | session |
| GET | `/api/v1/audit` | `audit.read` |

### Operational

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Liveness. `{status}` only |
| GET | `/ready` | none | Dependency state as a bare word; fails closed with 503 |
| GET | `/internal/metrics` | `security.read` | Path configurable; never public |
| GET | `/api/v1/security/events` | `security.read` | — |
| GET | `/api/v1/security/rbac` | `security.read` | Effective matrix for the UI |

### Non-API endpoints
| Path | Purpose |
|---|---|
| `/health` | Liveness — no internals |
| `/ready` | Readiness — DB reachable; **protected diagnostics** |
| `/internal/metrics` | Prometheus; private network or authenticated |
| `/docs` | OpenAPI — **disable or restrict in production** (RULE 119) |

## Rate limits

| Bucket | Default | Key |
|---|---|---|
| global | 1000 / 15 min | network |
| auth (IP) | 10 / 15 min | network |
| auth (account) | 30 / 15 min | email |
| search | 60 / 15 min | user |
| export | 5 / 15 min | user |
| upload | 20 / 15 min | user |
| sensitive action | 10 / hour | user |

Rate limiting is never IP-only (RULE 67).

## Idempotency

`Idempotency-Key` on imports, exports, bulk operations and webhooks. Unique on
`(organization_id, key, endpoint)`, so a retry cannot duplicate work.
