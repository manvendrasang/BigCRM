# BigCRM

A multi-tenant CRM for offices that create their own employee accounts rather
than accepting public sign-ups. Contacts, companies, leads, projects, tasks,
calendar, reports, notifications, attachments, import/export, saved views and an
append-only audit log, on a Node + PostgreSQL backend with a React frontend.

- **Setup:** [INSTALL.md](INSTALL.md)
- **Status and history:** [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)
- **Every endpoint:** [docs/API.md](docs/API.md)
- **Deployment:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## What it does

### Records

| Section | What it holds |
|---|---|
| **Contacts** | People, with company, lifecycle stage, owner, custom fields, notes, tasks, attachments |
| **Companies** | Accounts, with contacts, tasks and timeline |
| **Leads** | Unqualified people, convertible to contacts in one transactional step |
| **Projects** | Deals with value, currency, pipeline, stage, probability and close date. Renamed from "Deals"; each project has a dedicated window with a clickable stage stepper |
| **Tasks** | Work items with status, priority, assignee and due date, viewable as a list or on the calendar |
| **Activities** | Calls, meetings and notes, on a per-record timeline |
| **Notes, tags, comments, attachments** | On any record type |

Every record type supports search, filtering, sorting, pagination, soft delete
and restore, a per-record activity timeline, custom fields, and attachments.

### Workspace

- **Calendar** with meetings, invitees, responses and an agenda. Meetings can be amended or cancelled, and a moved meeting re-arms its advance notices
- **Reports**: pipeline, funnel, load and overview; export to CSV
- **Saved views**: private per user, or shared with the organization
- **Global search** across every record type
- **Notifications** with an unread badge, including password-reset requests
- **Import/export** CSV
- **Audit log**: every state change, append-only at the database level
- **Invitations** with an inbox and role bounded by the inviter's authority

### Accounts

- **In-house account creation.** No public sign-up. An owner or admin enters an
  email under Settings > Members; the system generates a password and shows it
  **once**. That is the only way an account comes into existence.
- **Member-initiated password reset.** The member asks from the dashboard, every
  owner and admin is notified, and one of them types the new password in by
  hand. No generated secret, no email link.
- **Appearance preference** per account. Light is the default; the account's own
  choice is applied after sign-in.

### Sessions

**A session ends when the window closes** -- every role, owner included.
Refreshing the page keeps you signed in; closing the window does not. Closing
one of several tabs does not sign out the others.

The browser cannot tell "closed" from "refreshed" during unload, so the decision
is made on the next page load using `sessionStorage` (per-tab, survives a
refresh, destroyed on close) plus a cross-tab liveness registry. See
`client/src/lib/sessionWindow.ts`.

---

## Roles and permissions

Five roles. The matrix lives in `server/src/services/rbac.ts` and is the only
authority -- the client asks the server what it may do rather than deciding.

| | **Viewer** | **Sales** | **Manager** | **Admin** | **Owner** |
|---|---|---|---|---|---|
| Read records | all | all | all | all | all |
| Create/edit contacts, companies, leads | no | yes | yes | yes | yes |
| Create/edit projects | no | yes | yes | yes | yes |
| Advance project stage | no | yes | yes | yes | yes |
| Create tasks | no | yes | yes | yes | yes |
| Update tasks | **assigned only, status only** | yes | yes | yes | yes |
| Delete/archive anything | no | archive contacts | yes | yes | yes |
| Bulk operations | no | no | yes | yes | yes |
| Reports / earnings | no | yes | yes | yes | yes |
| Custom fields | no | yes | yes | yes | yes |
| Saved views | no | yes | yes | yes | yes |
| Manage pipelines | no | no | yes | yes | yes |
| Import / export | no | no | export | yes | yes |
| Audit log | no | no | no | yes | yes |
| Create members | no | no | no | yes | yes |
| Assign roles | no | no | no | bounded by rank | bounded by rank |
| Reset another member's password | no | no | no | everyone **except** owners | everyone |
| Security posture, retention, KMS | read | no | no | read | yes |
| Delete organization, transfer ownership | no | no | no | no | yes |

## File map

### Root

| Path | Purpose |
|---|---|
| `INSTALL.md` | Setup from zero |
| `docs/PROJECT_STATUS.md` | What exists, what is verified, what changed |
| `docs/` | Architecture, API, deployment, security, testing, operations |
| `Dockerfile` | Multi-stage production image |
| `docker-compose.yml` | PostgreSQL, Mailpit, LocalStack KMS for development |
| `eslint.config.mjs` | Lint rules for both workspaces |
| `scripts/bootstrap.mjs` | Generates `server/.env` with fresh secrets |
| `.github/workflows/ci.yml` | Static analysis, verification, container build, DAST |

### `server/`

| Path | Purpose |
|---|---|
| `src/index.ts` | API entrypoint: config, migrations, listen |
| `src/worker.ts` | Background worker for the job queue |
| `src/app.ts` | Express assembly: middleware order, router mount, error handling |
| `src/config/env.ts` | Configuration parsing. **Fails closed** |
| `src/db/migrate.ts` | Migration runner with checksums |
| `src/db/migrations/` | SQL migrations, applied in order |
| `src/repositories/base.ts` | Tenant scope, SQL identifier allowlist, insert and count helpers |
| `src/services/` | Business logic, one module per bounded area |
| `src/routes/v1/` | HTTP layer: validation, permissions, response shape |
| `src/middleware/security.ts` | Authentication, RBAC, CSRF, rate limits, security events |
| `src/middleware/readOnly.ts` | Read-only degraded mode |
| `src/lib/` | Passwords, JWT, KMS, encryption, CSV, sanitisation, metrics, logging |
| `src/integrations/` | Email, S3, KMS providers |
| `src/tests/` | 27 suites: `unit/`, `integration/`, `security/` |

Key service modules:

| Module | Owns |
|---|---|
| `services/rbac.ts` | The permission matrix, role rank, hierarchy rules |
| `services/records.ts` | CRUD for all record types, tenant scoping, viewer task scope |
| `services/auth.ts` | Registration, login, sessions, tokens, MFA |
| `services/org.ts` | Organizations, members, invitations, teams, password resets |
| `services/queue.ts` | Durable job queue |
| `services/activity.ts` | Audit reads and notifications |
| `services/userPreferences.ts` | Per-account appearance |

### `client/`

| Path | Purpose |
|---|---|
| `src/main.tsx` | Bootstraps the window-close sign-out before rendering |
| `src/App.tsx` | Route table |
| `src/lib/api.ts` | HTTP client: token memory, CSRF header, refresh and retry, typed errors |
| `src/lib/auth.tsx` | Session state, sign-in, sign-out |
| `src/lib/sessionWindow.ts` | Sign out when the window closes |
| `src/lib/theme.tsx` | Account-backed appearance, light default |
| `src/lib/preferences.ts` | Read and write the account's preference |
| `src/lib/records.ts` | Record API and formatters |
| `src/lib/workspace.ts` | Members, invitations, views, notifications |
| `src/components/` | Shell, navigation, timeline, record extras, UI primitives |
| `src/pages/` | One page per route |
| `src/pages/records/` | List, detail, create, and the project window |
| `e2e/` | Playwright smoke test: the whole app in a real browser |
| `public/theme-init.js` | Applies light before the first frame |
| `src/styles/` | Design tokens and styles |

---

## Development

```bash
npm install
npm run bootstrap     # create server/.env with generated secrets
npm run migrate
npm run seed

npm run dev           # API on :3000
npm run dev:web       # client on :5173
```

| Command | Does |
|---|---|
| `npm run typecheck` | Both workspaces |
| `npm run lint` | Both workspaces |
| `npm test` | Server suite |
| `npm run test:security` | 14 threat scenarios |
| `npm run test:coverage --workspace=@bigcrm/server` | c8 with enforced thresholds |
| `npm test --workspace=@bigcrm/client` | Client suite |
| `npm run test:e2e` | Playwright smoke test (boots its own API and client) |
| `npm run worker` | The background worker: queue handlers and the reminder sweep |
| `npm run build` | API to `server/dist/`, client to `client/dist/` |

## License

Copyright © 2026 Manvendra Sang. All rights reserved.

This repository and all of its contents are proprietary software.

No permission is granted to use, copy, modify, reproduce, distribute, publish,
sublicense, sell, or incorporate any portion of this software into another
project without prior written permission from the copyright holder.

This restriction applies to the current version and all historical versions,
commits, releases, branches, and other versions of the repository (all past
commits and updates and future ones as well are included).

Viewing or accessing this repository does not grant a license or any other right
to use the software.

For licensing or commercial-use inquiries, contact the copyright holder.
