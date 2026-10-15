# SECURITY

What is actually implemented in BigCRM. Each control names its file and, where one
exists, the test that proves it.

Verified by execution: **549 assertions, 0 failures** (`npm test`).

## 1. Controls

### Authentication
| Control | Implementation | Test |
|---|---|---|
| Password hashing | scrypt (N=2^15,r=8,p=1) or Argon2id, peppered, PHC-encoded | `X3` |
| Constant-time verify | `timingSafeEqual`, malformed hashes return `false` | `X3` |
| No enumeration | decoy-hash verification; identical code **and** message | auth |
| Minimum strength | length, 4 character classes, denylist, no email/name/domain | auth |
| Lockout | per-account, `MAX_FAILED_LOGINS` then `LOCKOUT_SEC` | auth |
| Rate limiting | global, auth-IP, auth-account, search, export, upload, sensitive | -- |
| Tokens | 15-min access; rotating single-use refresh with reuse detection | auth, `S9` |
| Session expiry | idle **and** absolute, both checked every request | `S9` |
| Revocation | per-session, revoke-all, on role change, on removal, on password change/reset | `S9`, `S10` |
| No token in web storage | `HttpOnly` cookie only | design |

### Authorization
| Control | Implementation | Test |
|---|---|---|
| RBAC | 5 roles, 107/103/72/37/15 permissions | rbac |
| Hierarchy | `ROLE_RANK`; no peer/superior modification | `S3`, rbac |
| No self-escalation | self role change refused | `S3` |
| Owner ≠ admin | distinct permissions, asserted invariant | rbac |
| Last owner | `wouldOrphanOwners()` on demote and remove | rbac |
| Invitation authority | inviter may only offer a role they could assign | `S11` |
| Defence in depth | denial -> 403 logged + counted; resource absent -> 404 | -- |

### Multi-tenancy
| Control | Implementation | Test |
|---|---|---|
| Compile-time | `TenantScope` requires an organizationId | -- |
| Runtime | `assertTenantPredicate()` throws on an unscoped tenant query | `S1` |
| Schema | `organization_id NOT NULL` + index on every tenant table | `S2` |
| Cross-tenant reads | 404, never 403 -- existence is not leaked | `S2` |
| Cross-tenant writes | membership re-checked on every authenticated request | -- |

### Input handling
| Control | Implementation | Test |
|---|---|---|
| XSS | allowlist sanitiser; `escapeHtml`; no raw-HTML render path | `S4` |
| SQL injection | all values bound; identifiers allowlisted via `allowlist()` | -- |
| Mass assignment | explicit per-entity field allowlists | -- |
| Upload | magic-byte detection; SVG/HTML/executables never accepted | `S6` |
| Path traversal | filenames validated; keys are opaque UUIDs | `S6` |
| CSV injection | `= + - @ TAB CR` prefixed with `'` on export | `S13` |
| Pagination | signed cursors, `first` capped at 100, invalid values rejected | `X1` |
| SSRF | DNS-resolving guard; blocks RFC1918, link-local, ULA, CGNAT, metadata | `S7` |

### Browser & transport
| Control | Implementation |
|---|---|
| CSP | `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`; **no** `unsafe-eval`, **no** `unsafe-inline` in `script-src`; per-response nonce |
| Cookies | `HttpOnly`, `Secure` in production, `SameSite=Lax` |
| HSTS | `max-age=31536000; includeSubDomains; preload` |
| Other headers | `nosniff`, `strict-origin-when-cross-origin`, COOP `same-origin`, CORP `same-origin`, `X-Powered-By` removed, restrictive `Permissions-Policy` |
| CORS | explicit allowlist; **empty list denies** (RULE 37) |
| CSRF | `Origin`/`Referer` validation **and** a mandatory custom header **and** `SameSite=Lax` |

`style-src` requires `'unsafe-inline'` because React sets inline styles. This is
the single accepted relaxation, documented in `SECURITY_FINDINGS.md` A3.

### Data protection
| Control | Implementation |
|---|---|
| Encryption at rest | delegated to the platform (KMS) -- **not configured here** |
| Field-level encryption | pepper on all passwords; TOTP pending (BIG-11) |
| PII minimisation | `auditDiff()` allowlist; secrets/PII cannot enter audit rows |
| Log hygiene | recursive redaction, email masking, IP masking |
| Audit integrity | append-only enforced by a PostgreSQL trigger (`S14`) |
| Retention | configurable per-entity; **no scheduler yet** (BIG-12) |

### Secrets
Fail-closed configuration. In production: placeholders rejected, short secrets
rejected, duplicate secrets rejected, empty `APP_ORIGIN` rejected, console email
provider rejected. Secrets are never logged, never returned in responses, never
in URLs except single-use token links.

## 2. Known gaps

See `SECURITY_FINDINGS.md`. Open items: `BIG-10` (MFA column), `BIG-11` (MFA
encryption), `BIG-12` (retention scheduler), `BIG-19` (metrics route),
`BIG-20` (headers untested over HTTP), `BIG-21` (`pg` driver untested).

## 3. Accepted risks

`SECURITY_FINDINGS.md` §Accepted risks -- A1 audit-write failure, A2 scrypt cost,
A3 `style-src 'unsafe-inline'`.

## 4. Outstanding platform controls

WAF, container scanning, IaC scanning, Secrets Manager, KMS rotation, private
RDS with PITR, S3 Block Public Access, CloudTrail, backup restore drill. None can
be implemented or verified on this host. Full list in `DEPLOYMENT.md` §Production
checklist.

## 5. Reporting

Report suspected vulnerabilities to the repository owner. Do not open a public
issue containing exploit detail against a deployment you have not been authorised
to test. `INCIDENT_RESPONSE.md` covers triage.
