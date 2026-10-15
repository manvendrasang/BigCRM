# DATABASE

PostgreSQL 15+ (developed and tested against **17.5**).

## 1. Conventions

| Concern | Choice | Why |
|---|---|---|
| Primary key | `uuid`, application-generated | Unguessable (RULE 3: never *rely* on this, but free) |
| Money | `BIGINT` minor units (cents) | No floating point for money. The legacy CRM stored `REAL` |
| Timestamps | `timestamptz` | Timezone-correct; app renders ISO-8601 UTC |
| Booleans | native `boolean` | Legacy used `INTEGER 0/1` |
| Soft delete | `deleted_at`, `deleted_by` | History preserved (RULE 74) |
| Tenant | `organization_id uuid NOT NULL` + index | Every tenant row |
| Audit diffs | `jsonb` | Structured, queryable |
| Email | `*_normalized` column with a unique index | Duplicate detection must be canonical *before* the constraint |

## 2. Tables (39)

**Identity & tenancy** — `organizations`, `users`, `organization_members`,
`teams`, `team_members`

**CRM core** — `companies`, `contacts`, `leads`, `pipelines`, `pipeline_stages`,
`deals`

**Activity** — `activities`, `tasks`, `notes`, `comments`, `attachments`

**Tags & custom data** — `tags`, `contact_tags`, `company_tags`, `lead_tags`,
`deal_tags`, `custom_fields`, `custom_field_values`

**Notifications** — `notifications`

**Audit & telemetry** — `audit_logs`, `security_events`

**Sessions & credentials** — `sessions`, `password_resets`,
`email_verifications`, `invitations`, `mfa_recovery_codes`, `api_tokens`

**Workspace** — `saved_views`, `import_jobs`, `export_jobs`,
`webhook_endpoints`, `webhook_deliveries`, `idempotency_keys`

Plus `schema_migrations` created by the runner.

## 3. Integrity enforced by the database

Application checks are convenience. These are the actual guarantees:

| Constraint | Enforces |
|---|---|
| `uq_contacts_org_email_norm` (partial unique) | One contact per normalized email per org among live rows |
| `uq_companies_org_name_norm` (partial unique) | One company per normalized name per org |
| `uq_members` `UNIQUE (organization_id, user_id)` | One membership per user per org |
| `uq_tags` `UNIQUE (organization_id, name_normalized)` | Tag creation race is resolved by the index, not a SELECT (RULE 146) |
| `deals_stage_matches_pipeline` composite FK | **A deal's stage must belong to its pipeline** |
| `tasks_completed_consistent` CHECK | `(status='completed') = (completed_at IS NOT NULL)` |
| `uq_sessions_refresh_jti` | One live refresh token per session — makes reuse a *detectable race* |
| `CHECK` on all enum columns | `status`, `lifecycle_stage`, `role`, `priority`, `severity`, … |
| `CHECK (value_c >= 0)`, `CHECK (score BETWEEN 0 AND 100)` | No negative money, bounded scores |
| `CHECK (color ~ '^#[0-9a-fA-F]{6}$')` | Colour values are safe to render |
| `CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$')` | Custom-field keys are safe in URLs and HTML |
| `UNIQUE (organization_id, idempotency_key)` | Retries cannot duplicate an operation |
| 89 foreign keys with explicit `ON DELETE` | No silent orphans; cascade/restrict/set-null chosen per relationship |
| `trg_audit_logs_no_update` trigger | Audit rows are append-only even at the SQL layer |

## 4. DDL ordering is significant

PostgreSQL rejects a foreign key that references a table not yet created:

```
42P01  relation "o" does not exist
```

This is **exactly the legacy defect** — the CRM shipped a migration where
`contacts` referenced `companies` before `companies` existed, which SQLite
accepted silently. It was reproduced during this build to confirm the audit
finding.

Tables are therefore created in dependency order, and `uq_stages_pipeline_id` is
declared *before* `deals` because the composite FK requires it:

```
42830  there is no unique constraint matching given keys for referenced table
```

Migrations run against real PostgreSQL on every test run, so neither class can
reach a schema again.

## 5. Index strategy (128 indexes)

Every tenant table carries `organization_id` as the leading column of at least
one index.

| Pattern | Index |
|---|---|
| Keyset list pages | `(organization_id, updated_at DESC, id DESC)` — supports `(sort, id)` cursors |
| Membership lookups | `organization_members (organization_id)`, `(user_id)` |
| Session liveness | `sessions (last_seen_at) WHERE revoked_at IS NULL` |
| Refresh reuse detection | `uq_sessions_refresh_jti` (unique) |
| Dashboard counts | `tasks (organization_id) WHERE deleted_at IS NULL`, `(organization_id, status)` |
| Overdue scans | `tasks (organization_id, due_date) WHERE due_date IS NOT NULL` |
| Timeline | `activities (organization_id, entity_type, entity_id, occurred_at DESC)` |
| Unread badges | `notifications (user_id) WHERE read_at IS NULL` |
| Audit browsing | `audit_logs (organization_id, created_at DESC, id DESC)`, `(actor_id, …)` |
| Security alerting | `security_events (severity, created_at DESC)` |
| Queue draining | `webhook_deliveries (next_attempt_at) WHERE status='pending'` |
| Idempotency expiry | `idempotency_keys (expires_at)` |

Partial indexes (`WHERE deleted_at IS NULL`) keep soft-deleted rows out of hot
paths, which is where the legacy CRM's unconditional indexes would have hurt.

## 6. Soft delete

`deleted_at` / `deleted_by` on user-facing records. All list queries filter
`deleted_at IS NULL`. Deletion is audited. Restoration is supported for contacts
and companies.

Rows are **not** permanently deleted while retention requires them — see
`DISASTER_RECOVERY.md` §Retention.

## 7. Transactions

Every multi-statement business operation is one transaction. Invitation
acceptance additionally uses a *claim* pattern so single-use is enforced by the
database rather than by a prior read:

```sql
UPDATE invitations SET accepted_at = $1
 WHERE id = $2 AND accepted_at IS NULL
 RETURNING id
```

Zero rows returned ⇒ someone else already accepted it.

## 8. Row Level Security (documented, not enabled)

RLS on tenant tables keyed to a session variable would be genuine defence in
depth:

```sql
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING (organization_id = current_setting('app.organization_id')::uuid);
```

**Not enabled.** It depends on a per-connection setting surviving a pool, which is
exactly the class of bug that produced `LEG-01`. Correctness today rests on
`TenantScope`, which is enforced at compile time, at runtime, and by test.

## 9. Connection management

| Setting | Value | Why |
|---|---|---|
| Pool size | `DB_POOL_MAX`, default 10 | Bounded; the legacy system opened a connection per query |
| `statement_timeout` | `DB_STATEMENT_TIMEOUT_MS`, default 15 s | RULE 77 — no infinite requests |
| `connectionTimeoutMillis` | 10 s | Fail fast |
| `idleTimeoutMillis` | 30 s | Release idle connections |
| `ssl` | required when `NODE_ENV=production` | RULE 52 |
| idle-client error | logged, not fatal | A dropped idle socket must not kill the process |

The legacy CRM opened a fresh SQLite connection **and three PRAGMAs** for every
query: measured 585 µs versus 2 µs on a reused connection.

## 10. Migrations

`NNN_name.sql` in `server/src/db/migrations/`. The runner:

- records version + **SHA-256 checksum**
- runs DDL and the bookkeeping row in **one transaction**
- **refuses to start** if a landed migration's checksum changed
- refuses `@destructive` migrations without `--allow-destructive` (RULE 131)

Never edit a landed migration. Add a new one.

### Planned `0002_mfa.sql`

`users.totp_secret_encrypted bytea` + `mfa_enrolled_at`, with KMS envelope
encryption. Tracked as `BIG-10`/`BIG-11`.

## 11. Backup and recovery

Managed by the platform, not the application: RDS automated backups, PITR, and
cross-region replicas. **No backup in this project has been restored** — a backup
that was never restored is not a backup. `DISASTER_RECOVERY.md` defines the
procedure and states the drill as outstanding.
