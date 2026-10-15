# DEPLOYMENT

## What exists today

There is **no deployed environment, no container image, and no Terraform**. This
document specifies the target architecture and the checklist that must pass
before a production release. Nothing here should be read as a description of a
running system (RULE 4).

The host available for development has no Docker daemon, no `terraform` binary
and no AWS credentials, so none of it could be built or verified.

## Local

```bash
npm install
npm test                        # 549 assertions, real PostgreSQL via PGlite
cp server/.env.example server/.env
# set the secrets marked REQUIRED
npm run migrate
npm run dev                     # http://localhost:3000
```

`PGLITE_DATA_DIR=memory` needs no database installation. `DATABASE_URL` selects
node-postgres instead.

## Target production topology

```
Internet
  → CloudFront (TLS, caching static assets only)
  → WAF (managed rules, rate-based, bot control)
  → ALB (TLS 1.2+, HSTS, target private:port)
  → ECS Fargate services in PRIVATE subnets, no public IP
      ├─ api    (≥2 tasks across ≥2 AZs)
      └─ worker (imports, exports, webhooks, retention)
  → RDS PostgreSQL (private, Multi-AZ, KMS, PITR)
  → S3 (Block Public Access, SSE-KMS, versioning)
  → Secrets Manager · KMS · CloudTrail · CloudWatch
```

Database, cache and queues have **no public IP and no internet egress path**.

## Container requirements (RULE 89)

- Multi-stage build; runtime image carries no toolchain
- Minimal base, version **pinned by digest**
- Runs as a non-root user with a numeric UID
- Read-only root filesystem; `tmpfs` for `/tmp`
- All Linux capabilities dropped; no privileged mode; `no-new-privileges`
- No secrets in layers or environment defaults
- Pinned base images, scanned with Trivy or Grype
- Image scanned in CI and again before deploy

## Required environment

Set through Secrets Manager, never files.

| Variable | Requirement |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://` — **required**; placeholders rejected |
| `APP_ORIGINS` | **required, non-empty**; https only |
| `JWT_ISSUER`, `JWT_AUDIENCE` | required |
| `JWT_ACCESS_SECRET` | ≥32 chars, distinct |
| `JWT_REFRESH_SECRET` | ≥32 chars, distinct from access + pepper |
| `SECRETS_PEPPER` | ≥32 chars, distinct |
| `STORAGE_SIGNING_SECRET` | ≥32 chars, distinct |
| `EMAIL_PROVIDER` | **`console` is refused in production** |
| `COOKIES_SECURE` | `true` |
| `HSTS_ENABLED` | `true` |

Startup aborts on any missing, placeholder, short, or duplicated secret.

## Database

- RDS PostgreSQL 16+ in **private** subnets, no public IP
- Storage encrypted with a customer KMS key
- Automated backups + **point-in-time recovery**
- `DELETE FROM audit_logs` is impossible by design — the append-only trigger
  fires regardless of credentials
- `sslmode=require`; app role has no superuser rights
- Run migrations as a **separate** role before the new code serves traffic
- Backward-compatible migrations: expand, migrate, contract

Migrations run automatically at startup. A checksum mismatch on a landed
migration aborts the boot rather than diverging silently.

## Object storage

- S3 with **Block Public Access** on (all four settings)
- Bucket-owner-enforced ownership, no ACLs
- SSE-KMS with a customer key
- Versioning on; lifecycle to abort incomplete multipart uploads
- Least-privilege IAM: `s3:GetObject`/`PutObject`/`DeleteObject` on the required
  prefix only. **Never `s3:*`.** Separate read/write/delete roles
- Bucket policy denies non-TLS requests and unencrypted uploads
- Keys: `organizations/{orgId}/documents/{uuid}{ext}` — opaque, never a filename
- Presigned URLs ≤5 minutes, permission-specific, generated **only after**
  an authorization check
- CloudTrail data events for read access

## Production checklist (RULE 218)

### Secrets
- [ ] No production secret in the repository or history
- [ ] Secret scanning in CI and on push
- [ ] All secrets in Secrets Manager; app uses IAM role assumption, not static keys
- [ ] Legacy Atlas credentials and the legacy JWT secret **rotated**

### Application
- [ ] HTTPS enforced, HTTP redirected, TLS 1.2+
- [ ] HSTS enabled after TLS is confirmed
- [ ] `Secure; HttpOnly; SameSite` cookies
- [ ] CSP applied in enforcing mode
- [ ] CORS allowlist non-empty and correct
- [ ] CSRF guard active on all state-changing routes
- [ ] Rate limits tuned per endpoint
- [ ] MFA available and required for privileged roles
- [ ] Session expiry and revocation verified on the deployed instance

### Platform
- [ ] WAF attached with managed rules
- [ ] Private subnets; no public IPs on app or database
- [ ] Security groups least-privilege; no DB→internet
- [ ] Egress restricted to required destinations
- [ ] Private endpoints for S3, KMS, Secrets Manager
- [ ] RDS encrypted, PITR on, backups verified
- [ ] S3 Block Public Access, SSE-KMS, versioning, lifecycle
- [ ] CloudTrail, VPC Flow Logs, S3 data events
- [ ] GuardDuty / Security Hub
- [ ] CloudWatch alarms on 5xx, latency, DB connections, queue depth

### Delivery
- [ ] `npm run typecheck` clean
- [ ] `npm test` green
- [ ] Container image scanned, no Critical/High
- [ ] Terraform scanned with Checkov/tfsec
- [ ] Rollback plan for application **and** database
- [ ] Backup restore rehearsed and timed
- [ ] DAST against staging
- [ ] External penetration test before first production release

## Deployment sequence

```
build → scan image → terraform plan → apply → migrate (separate role)
      → deploy staging → smoke test → DAST → approval → canary 10% → 100%
```

- **Canary**, not all-at-once. Watch 5xx rate and p99 latency.
- Rollback = previous task definition + previous image tag.
- Database rollback is **forward-fix only** unless a migration is explicitly
  marked `@destructive` and a tested down-migration exists.
- Never deploy code requiring a new column before old code tolerates its absence.

## Observability

| Signal | Alert |
|---|---|
| 5xx rate | >1% over 5 min |
| p99 latency | >2 s |
| `permission_denials_total` | sustained spike |
| `tenant_denials_total` | **any** sustained rate — possible attack |
| `auth_failures_total{reason=unknown_account}` | enumeration sweep |
| `security_events` severity `high`/`critical` | immediate page |
| DB connections | >80% of pool |
| Queue depth | growing 15 min |
| Export volume | any bulk export outside a change window |

## Not done

Terraform, Dockerfile, CI/CD, IaC scanning, image scanning, DAST, load testing,
backup restore drill, and an external penetration test. All listed in
`PROJECT_STATUS.md` §5.
