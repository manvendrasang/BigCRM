# SECURITY ARCHITECTURE

Complements `SECURITY.md` (what is implemented) with **how** and **why**.

## 1. Trust boundaries

```
┌─ B0 ─ Internet (untrusted) ────────────────────────────────────────────┐
│ Browser, mobile clients, scanners, attackers │
└───────────────────────────┬───────────────────────────────────────────┘
 │ TLS 1.2+, TLS terminated at ALB
┌─ B1 ─ CDN + WAF ──────────▼───────────────────────────────────────────┐
│ Managed rules: injection, XSS, bots, floods. NOT a substitute for │
│ secure code -- documented as such (RULE 65). │
└───────────────────────────┬───────────────────────────────────────────┘
 │ only ALB accepts traffic
┌─ B2 ─ ALB (public subnets) ───────────────────────────────────────────┐
│ TLS termination, HSTS, request limits, access logs │
└───────────────────────────┬───────────────────────────────────────────┘
 │ mTLS / security group, no public IP on app
┌─ B3 ─ Private app subnets ────────────────────────────────────────────┐
│ Express API - worker - [enforced: authenticated + permission + │
│ tenant + ownership + validation on EVERY endpoint] │
└──────┬───────────────────────────────┬───────────────────────────────┘
 │ private DNS, 5432/443 │ private endpoint
┌─ B4 ─ RDS (private) ──┐ ┌─ B5 ─ S3 (private, Block Public Access) ┐
│ Encrypted at rest, │ │ SSE-KMS, versioning, lifecycle, │
│ PITR, least-privilege│ │ presigned URLs ≤5 min, key per org │
└──────────────────────┘ └────────────────────────────────────────┘
 │
┌─ B6 ─ Outbound ───────────────────────────────────────────────────────┐
│ Egress-restricted: email, KMS, S3, monitoring, package registries │
│ SSRF guard on any user-supplied URL (lib/ssrf.ts) │
└───────────────────────────────────────────────────────────────────────┘
```

### Controls at each boundary

| B | Authentication | Authorization | Validation | Encryption | Logging | Monitoring |
|---|---|---|---|---|---|---|
| B0->B1 | none expected | none | -- | TLS | WAF logs | WAF metrics |
| B1->B2 | none | none | managed rules | TLS | access logs | WAF rules |
| B2->B3 | network | none | -- | TLS/mTLS | ALB logs | ALB metrics |
| **B3** | **session** | **RBAC + tenant + ownership** | **Zod + allowlists** | TLS | **structured, redacted** | **metrics + audit** |
| B3->B4 | DB credentials | least-privilege role | parameterised SQL | TLS + at-rest | query log | slow query |
| B3->B5 | IAM role | object key + policy | magic bytes | SSE-KMS | access log | S3 data events |
| B3->B6 | provider creds | n/a | SSRF guard | TLS | delivery log | egress metrics |

**B3 is where the application is authoritative.** B1/B2 are layers of defence;
a WAF bypass must not become an authorization bypass.

## 2. Data classification

| Class | Examples | Controls |
|---|---|---|
| **PUBLIC** | industry taxonomy, pipeline stage names | none |
| **INTERNAL** | record counts, stage names, saved-view names | authn; tenant scope |
| **CONFIDENTIAL** | names, emails, phones, job titles, addresses, notes, activities, tasks, deals | authn + RBAC + tenant scope; masked in logs |
| **HIGHLY CONFIDENTIAL** | passwords, reset/invite tokens, TOTP secrets, MFA recovery codes, API tokens, integration secrets, webhook signing secrets, exports | peppered or hashed; never logged; never in responses; KMS envelope encryption |

PII handling: emails masked in logs (`a***@corp.test`), IPs masked
(`10.0.0.*`), passwords/tokens/`Authorization`/cookies redacted recursively,
PII absent from audit diffs unless allowlisted.

## 3. Content Security Policy

```
default-src 'self'
script-src 'self' <- no 'unsafe-inline', no 'unsafe-eval'
style-src 'self' 'unsafe-inline' <- accepted relaxation, documented
img-src 'self' data: blob:
font-src 'self' data:
connect-src 'self' <- no third-party endpoints
object-src 'none'
base-ancestors-> frame-ancestors 'none'
base-uri 'self'
form-action 'self'
manifest-src 'self'
worker-src 'self' blob:
upgrade-insecure-requests <- production only
```

A per-response nonce is generated (`res.locals.cspNonce`) so inline scripts can
be introduced later without weakening `script-src`. `theme-init.js` is an
**external file** specifically so it needs no inline allowance.

## 4. CSRF strategy

Cookie-based auth means CSRF is in scope. Three independent controls:

1. **`SameSite=Lax`** -- the cookie is not sent on cross-site POST.
2. **Origin/Referer validation** -- must be an allowlisted origin. Missing both on
 a state-changing request is treated as hostile.
3. **Mandatory custom header** -- the client must send one the browser will not
 add cross-origin, forcing a CORS preflight that our allowlist rejects.

No synchroniser token: that would require a server-side token store and would put
a token in the DOM. The layered approach has neither surface.

Custom header requirement: `X-Request-Id`, `Content-Type`, `Authorization`,
`X-CSRF-Token`, `Idempotency-Key`.

## 5. Key management

| Key | Purpose | Storage | Rotation |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | signs access tokens | Secrets Manager | 90 days |
| `JWT_REFRESH_SECRET` | signs refresh tokens (separate key) | Secrets Manager | 90 days |
| `SECRETS_PEPPER` | HMAC pepper for all password hashing | Secrets Manager, **no rotation** without a re-hash plan | -- |
| `STORAGE_SIGNING_SECRET` | signs storage/share links | Secrets Manager | 90 days |
| `SECRETS_PEPPER` must differ from both JWT secrets | | | enforced at startup |
| KMS CMK | envelope encryption for TOTP secrets, integration credentials | KMS | annual |

**Pepper rotation** would invalidate every stored password unless hashes are
re-hashed on next successful login. `needsRehash()` provides the hook; a rotation
runbook is in `INCIDENT_RESPONSE.md` §5.

## 6. Secret handling

- `.env` gitignored; `!.env.example` explicitly allowed so the example is committed
- Production refuses placeholder-looking values
- Production requires ≥32 chars and distinct values across variables
- Nothing secret is logged: recursive redaction covers `password`, `token`,
 `secret`, `authorization`, `cookie`, `totpSecret`, `apiKey`, `signingSecret`,
 and more
- Reset/invite/verify tokens are **never returned from a service** -- delivered
 through `integrations/email.ts`, the only module that composes token links
- `.env.example` contains documentation, never values

## 7. Supply chain

- Lockfile committed
- Dependency scanning in CI (not yet configured -- `DEPLOYMENT.md`)
- Container image: minimal base, pinned digests, non-root, read-only root
 filesystem, dropped capabilities, multi-stage, no embedded secrets
- Image scanning with Trivy or Grype
- IaC scanning with Checkov or tfsec
- No install scripts executed without review

**Not yet implemented** -- no lockfile-based CI exists. Listed in
`DEPLOYMENT.md`.

## 8. Threat detection

| Signal | Source | Alert |
|---|---|---|
| Repeated failed logins | `security_events` | per-IP and per-account |
| Account locked | `security_events` | immediate |
| Permission denials | `security_events` + `permission_denials_total` | rate threshold |
| Cross-tenant attempts | `tenant_denials_total` | **any sustained rate** |
| Refresh-token reuse | `security_events` (critical) | immediate |
| Role change / owner transfer | `audit_logs` | immediate |
| Bulk export | `audit_logs` | immediate |
| Bulk delete | `audit_logs` | immediate |
| MFA changes | `security_events` | immediate |
| Storage access anomalies | S3 data events | CloudTrail -> SIEM |
| Secret exposure | CI secret scan | immediate, blocks merge |

Logs ship to CloudWatch -> SIEM. `security_events.severity` supports filtering.

## 9. Account takeover detection

Signals combined for a risk score: new device, unusual IP/geo, impossible travel,
abnormal request rate, password reset followed by sensitive action, refresh-token
reuse, MFA disabled.

Deliberately **not** implemented: invasive fingerprinting. RULE 115 says *"Do not
create invasive tracking unnecessarily."* Collection stays at IP + user agent,
which is already visible in `sessions`.

## 10. Privileged operations

`security.manage`, `organization.delete`, `members.transfer_ownership` and
`retention.manage` are **owner-exclusive**, asserted by
`assertOwnerOnlyInvariant()`.

Production hardening (`DEPLOYMENT.md`): require MFA for privileged accounts
(`REQUIRE_MFA_FOR_PRIVILEGED`), and consider a dedicated admin route group with
separate authentication. Not yet built.

## 11. Browser-side rules

- Never store passwords, refresh tokens, or customer records in
 `localStorage`/`sessionStorage`
- No `innerHTML` / `dangerouslySetInnerHTML` with user content; rich text is
 sanitiser output only
- Route guards are **UX**, not security -- every request re-authorises
- Clear stale auth state on any 401 (the legacy task manager left a stale `user`
 in `localStorage`; see `SECURITY_FINDINGS.md` `LEG-03`)
- Reload safely, or respond to a broadcast event, when refresh fails
