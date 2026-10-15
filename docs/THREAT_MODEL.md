# THREAT MODEL

STRIDE, applied per trust boundary. Severity reflects impact **and** likelihood
in this system's context.

Legend -- **Status**: `Mitigated` (control implemented + tested) - `Partial`
(control exists, not complete) - `Open` (no control) - `Accepted`.

---

## 1. Browser / SPA (B0)

| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| B-01 | Spoofing | Stolen session cookie via XSS | Critical | `HttpOnly` cookie; no token in web storage; strict CSP | Mitigated |
| B-02 | Tampering | Client edits a role/owner/org field in the body | Critical | Server derives all of these from the session; explicit field allowlists | Mitigated |
| B-03 | Repudiation | User denies an action | High | Server-generated audit with actor, IP, UA, request id; append-only | Mitigated |
| B-04 | Info disclosure | PII in console logs | High | Recursive redaction, email/IP masking | Mitigated |
| B-05 | DoS | Huge payload | Medium | Bounded body limit | Mitigated |
| B-06 | Elevation | Hidden admin button treated as a control | High | Backend re-authorises every request | Mitigated |

## 2. Edge / WAF / load balancer (B1, B2)

| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| E-01 | DoS | Volumetric flood | High | CDN, WAF, ALB, rate limits, autoscaling | Open (infra) |
| E-02 | Tampering | Header injection | High | Express normalises; IDs validated against `^[A-Za-z0-9_-]{8,64}$` | Mitigated |
| E-03 | Spoofing | Forged `X-Forwarded-For` to dodge IP limits | High | `trust proxy` set to the exact hop count | Partial |
| E-04 | Info disclosure | TLS downgrade | High | HSTS, redirect, TLS 1.2+ policy | Partial (infra) |
| E-05 | Elevation | Origin bypass straight to app | Critical | App in private subnets, no public IP | Open (infra) |

## 3. Application / API (B3) -- the primary battleground

### Authentication
| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| A-01 | Spoofing | Credential stuffing | High | Auth rate limit per IP **and** per account; lockout | Mitigated |
| A-02 | Spoofing | Account enumeration via timing | High | Decoy-hash verification | Mitigated |
| A-03 | Spoofing | Enumeration via error text | High | Identical code and message on every auth failure | Mitigated |
| A-04 | Spoofing | Password reset abuse | High | Random single-use hashed token, 15 min expiry, enumeration-safe | Mitigated |
| A-05 | Spoofing | Invitation redemption by the wrong person | Critical | Existing users must prove identity; token never in a response | Mitigated (`S11`) |
| A-06 | Elevation | Session fixation | High | New session id on every login; rotation on every refresh | Mitigated |
| A-07 | Elevation | Refresh-token theft and replay | Critical | Single-use rotation; reuse revokes the family | Mitigated |
| A-08 | Spoofing | Revoked session still usable | Critical | Revocation checked every request | Mitigated (`S9`) |
| A-09 | DoS | Session table growth | Medium | Bounded per user; absolute expiry | Mitigated |
| A-10 | Spoofing | MFA bypass | High | Replay window, single-use hashed recovery codes | Partial (no column -- BIG-10) |

### Authorization & tenancy
| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| Z-01 | Elevation | Tenant escape via `organizationId` | Critical | `TenantScope` + runtime predicate guard | Mitigated (`S1`) |
| Z-02 | Elevation | IDOR on `/contacts/:id` | Critical | `organization_id` on every query; 404 not 403 | Mitigated (`S2`) |
| Z-03 | Elevation | Viewer -> Admin | Critical | RBAC + hierarchy + self-escalation refusal | Mitigated (`S3`) |
| Z-04 | Elevation | Admin -> Owner | Critical | Owner-exclusive permissions; owner ungrantable | Mitigated |
| Z-05 | Denial | Removing the last owner | High | `wouldOrphanOwners()` | Mitigated |
| Z-06 | Info disclosure | Existence leak via 403 vs 404 | Medium | Uniform 404 | Mitigated |
| Z-07 | Elevation | Role change leaves old authority live | High | Sessions revoked on role change | Mitigated |
| Z-08 | Elevation | Cross-org FK assignment | High | Tenant guard + membership re-check | Mitigated |

### Input handling
| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| I-01 | Tampering | SQL injection | Critical | Parameter binding; `allowlist()` for identifiers | Mitigated |
| I-02 | Tampering | Stored XSS via unvalidated enum on update | Critical | Validation on every write path + allowlist sanitiser | Mitigated (`S4`) |
| I-03 | Tampering | Mass assignment to `role`/`owner_id` | High | Explicit per-entity allowlists | Mitigated |
| I-04 | Tampering | Path traversal in filenames | High | Filename validation; opaque UUID keys | Mitigated (`S6`) |
| I-05 | Elevation | Uploaded HTML/SVG executes same-origin | High | Never accepted; magic-byte detection | Mitigated (`S6`) |
| I-06 | Tampering | Polyglot / renamed executable | High | Signature authoritative; mismatch rejected | Mitigated (`S6`) |
| I-07 | Tampering | CSV formula injection | Medium | `= + - @ TAB CR` prefixed with `'` | Mitigated (`S13`) |
| I-08 | Tampering | Cursor tampering to widen a page | Medium | HMAC-signed cursors; hard cap | Mitigated (`X1`) |
| I-09 | DoS | Report/search/export exhaustion | High | Bounded page size; export rate limit; jobs for heavy work | Partial (jobs pending) |
| I-10 | Tampering | Prototype pollution via JSON | Medium | Zod schema stripping; no recursive merge of client objects | Mitigated |

### Server-side request forgery
| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| R-01 | Info disclosure | Reach `169.254.169.254` | Critical | Link-local blocked; metadata hostnames blocked | Mitigated (`S7`) |
| R-02 | Info disclosure | Reach internal services | Critical | RFC1918, loopback, ULA, CGNAT, multicast blocked | Mitigated (`S7`) |
| R-03 | Spoofing | DNS rebinding after validation | High | Hostname resolved and **every** address checked | Mitigated |
| R-04 | Info disclosure | Non-HTTP scheme | High | Protocol allowlist | Mitigated (`S7`) |
| R-05 | Spoofing | Embedded credentials in URL | Medium | Rejected | Mitigated (`S7`) |

### Data at rest
| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| D-01 | Info disclosure | Database dump cracks passwords | Critical | scrypt/Argon2id + HMAC pepper | Mitigated |
| D-02 | Tampering | Audit log edited to hide an action | High | Append-only trigger | Mitigated (`S14`) |
| D-03 | Info disclosure | Audit log becomes a PII copy | High | `auditDiff()` allowlist | Mitigated (`S14`) |
| D-04 | Info disclosure | Backup theft | Critical | Encrypted backups, separate credentials | Open (infra) |
| D-05 | Info disclosure | Snapshot left in place | Medium | Retention + purge | Partial (no scheduler) |

### Availability
| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| V-01 | DoS | Slow query holds a connection | High | `statement_timeout`; bounded pool | Mitigated |
| V-02 | DoS | Legacy per-query connection storm | High | Pooled driver | Mitigated |
| V-03 | DoS | No pagination -> unbounded result sets | High | Cursor pagination built | Partial (routes pending) |
| V-04 | DoS | Global lock serialising all DB work | High | Removed -- no module-level DB lock | Mitigated |
| V-05 | DoS | Worker death | Medium | Graceful shutdown; reconnect | Partial |

## 4. Database (B4)

| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| DB-01 | Spoofing | App uses a superuser | High | Separate least-privilege roles | Open (infra) |
| DB-02 | Info disclosure | Unencrypted at rest | Critical | RDS KMS encryption | Open (infra) |
| DB-03 | Info disclosure | Publicly reachable DB | Critical | Private subnets, no public IP | Open (infra) |
| DB-04 | Tampering | Constraint bypassed by app bug | High | FKs, CHECKs, unique indexes are authoritative | Mitigated |
| DB-05 | Denial | Long transaction blocks vacuum | Medium | Bounded transactions; statement timeout | Mitigated |

## 5. Object storage (B5)

| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| O-01 | Info disclosure | Public bucket | Critical | Block Public Access on; private ACL | Open (infra) |
| O-02 | Info disclosure | Guess another org's key | Critical | `organizations/{orgId}/documents/{uuid}{ext}` + authorization before signing | Mitigated (key design) / Open (bucket) |
| O-03 | Elevation | Permanent download link | High | Presigned URL ≤5 min | Open (provider) |
| O-04 | Tampering | Overwrite another org's object | High | Server-side key derivation; no user-supplied path | Mitigated |
| O-05 | Info disclosure | Unencrypted objects | High | SSE-KMS | Open (infra) |
| O-06 | Repudiation | Unlogged access | Medium | S3 data events -> CloudTrail | Open (infra) |
| O-07 | Tampering | Object deleted by app credentials | Medium | Separate read/write/delete roles | Open (infra) |

## 6. CI/CD (B7)

| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| C-01 | Tampering | Compromised dependency | High | Lockfile + pinning + scanning | Partial (lockfile yes, CI no) |
| C-02 | Info disclosure | Secret committed | Critical | Gitignore + CI secret scan + history rewrite | Partial |
| C-03 | Tampering | Poisoned build artefact | High | Image scan, signed artefacts | Open |
| C-04 | Elevation | CI deploys with admin credentials | High | OIDC role assumption, no static keys | Open |
| C-05 | Tampering | Unsigned migration to production | High | Migration approval + checksum enforcement | Mitigated (checksum) / Open (approval) |

## 7. Third-party integrations

| # | STRIDE | Threat | Severity | Control | Status |
|---|---|---|---|---|---|
| X-01 | Spoofing | Forged inbound webhook | Critical | HMAC signature + timestamp window + replay guard | Open (tables exist) |
| X-02 | Tampering | Payload assumed trusted because of the URL | High | Schema validation; independent authorization | Open |
| X-03 | Info disclosure | Over-broad OAuth scopes | High | Least privilege, revocable, encrypted refresh tokens | Open |
| X-04 | Spoofing | OAuth state/PKCE missing | High | State + PKCE; exact redirect-URI match | Open |
| X-05 | DoS | Webhook storm | Medium | Backoff, jitter, dead-letter, rate limit | Open |
| X-06 | Info disclosure | SSRF via webhook URL | Critical | `lib/ssrf.ts` | Mitigated |

## 8. Residual risk

| Risk | Severity | Why it remains |
|---|---|---|
| No route layer, so middleware is unproven end-to-end | High | `PROJECT_STATUS.md` §3 |
| No WAF / CDN / private networking | High | Not buildable here |
| No MFA persistence | Medium | `BIG-10` |
| No retention scheduler | Medium | `BIG-12` |
| `pg` pool path untested | Medium | `BIG-21` |
| Unpinned CI, no image/IaC scanning | High | No CI configured |

## 9. Abuse cases explicitly rejected

- Login 10,000× from one IP -> per-IP **and** per-account limits + lockout
- Enumerate 1M emails via `/forgot` -> identical response, no token row created
- Replay an invitation for a real user -> refused; identity must be proven
- Export 100k contacts as a viewer -> `reports.export` is admin+
- Move a deal into another org's pipeline -> composite FK + tenant guard
- Attach a contact to another org's company -> tenant guard, cross-tenant row unreachable
- Page through with a forged cursor -> signature check fails -> 400
- Upload `shell.php` renamed to `.png` -> signature mismatch -> rejected