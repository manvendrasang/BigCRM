# INCIDENT RESPONSE

## Principles

1. **Contain before you diagnose.** Revoking access stops harm faster than
 understanding it.
2. **Preserve evidence** before rotating anything.
3. **Assume the secret is burned.** Revoke, then rotate -- in that order.
4. **Write it down while it happens.** Timeline beats recollection.
5. **Never test destructively against production** without explicit authorisation
 (RULE 190). Use staging.

## Severity routing

| SEV1 | SEV2 |
|---|---|
| Active data exposure, credential compromise, full outage | Partial outage, auth failures, elevated 5xx |
| Page immediately, all hands | Page during hours |
| Declare incident, open bridge, freeze deploys | Same, smaller group |

## Unified workflow

```
DETECT -> CONTAIN -> ERADICATE -> RECOVER -> DOCUMENT -> REVIEW
```

Roles: Incident Commander, Technical Lead, Communications, Scribe. One person
holds each; do not combine.

---

## 1. Leaked secret

**Most likely cause: a committed credential.**

> **Action required now:** the frozen repository `taskmanager/team-task-manager`
> contains live MongoDB Atlas credentials (username, password and cluster host) and a 96-char
> JWT secret in `.env`. Rotate both regardless of whether this platform uses them.

1. **Detect** -- secret-scanner alert, or manual discovery
2. **Preserve** -- record where, when, and which commits; snapshot logs
3. **Revoke** -- invalidate the credential at the provider *first*
4. **Rotate** -- issue a new secret; deploy via Secrets Manager, not a file
5. **Sessions** -- rotating the JWT secrets logs everyone out; rotate
 `JWT_ACCESS_SECRET` first to limit disruption
6. **Audit** -- CloudTrail: who used it, from where, for what
7. **Purge** -- rewrite history (`git filter-repo`); force-push with coordination;
 clone freshness is the real remediation
8. **Scan** -- run a full-history scan, not just the tip
9. **Document** -- timeline, blast radius, why the scanner missed it

**Prevention:** pre-commit secret scanning; CI scanning that blocks merge; least-
privilege and short-lived credentials so a leak is survivable; no credentials in
any `.env` on a developer machine that holds production access.

## 2. Compromised account

1. Contain -- revoke **all** sessions for the user (changing their password does
 this by design)
2. Reset the password; invalidate all reset tokens
3. Check `security_events` for the account: failed logins, `refresh_reuse`,
 role changes, MFA changes
4. Check `audit_logs` for the user: exports, bulk deletes, role changes
5. Verify membership in unexpected organizations
6. If MFA was enabled and disabled -> treat as confirmed compromise
7. Force MFA re-enrolment; invalidate recovery codes
8. Review access to that tenant's data; consider notifying affected parties
9. Document

## 3. Compromised administrator

Escalate to SEV1.

1. Revoke all sessions for every owner/admin in the affected organization
2. Review `audit_logs` for `member.role_changed`, `member.removed`,
 `organization.updated`, `organization.deleted`
3. Verify no unexpected owner was created -- `owner` is ungrantable by
 invitation, so any new owner came from ownership transfer
4. Review exports (`audit_logs`, action `export.created`)
5. Force password reset on all privileged accounts
6. Require MFA for all privileged roles
7. Rotate `SECRETS_PEPPER` if the attacker had code execution
8. Consider full tenant data review

## 4. Suspected tenant escape

The most serious class. The controls make it hard, but treat any
`tenant_denials_total` rise as an attack until proven otherwise.

1. Contain -- identify the actor from `security_events` and the request ids
2. Preserve -- full `audit_logs` and application logs **before** any change
3. Determine which tenants are involved
4. Rotate the affected user's password (revokes all sessions)
5. Review the actor's role; demote if warranted (revokes their sessions)
6. Assess data exposure: which entity types, which fields, which rows
7. Legal/privacy assessment; notification if required by jurisdiction
8. **Report the control failure** in `SECURITY_FINDINGS.md` and add a
 regression test before closing (RULE 185)
9. Never close without a passing test

## 5. Rotating `SECRETS_PEPPER`

Peppering means a pepper rotation invalidates every stored password -- users are
locked out.

1. **Do not rotate casually.** Only in response to confirmed compromise.
2. Deploy code that accepts both peppers: `newPepper`, `legacyPepper`.
3. On successful login, re-hash with `newPepper` (`needsRehash` already supports
 cost changes; extend it for the pepper version).
4. Run until the legacy path is dormant (or force a reset for stragglers).
5. Remove `legacyPepper` support.
6. Store the pepper version **inside each hash** so old hashes stay verifiable.

**This is not implemented.** The hash format has no pepper-version field, so
rotation today means a forced reset for every user.

## 6. Database breach

1. **Isolate** -- restrict network access to the RDS instance
2. **Preserve** -- snapshot before any change; enable point-in-time recovery
3. **Rotate** database credentials
4. **Assess** -- what was read? `pg_stat_statements` and CloudTrail
5. **Rotate at the application layer** -- every peppered password must be
 invalidated (see §5); sessions do **not** need rotation since JWT secrets are
 independent, but rotate them anyway for hygiene
6. Verify the append-only trigger held -- `audit_logs` should show no
 UPDATE/DELETE; a triggered exception means someone tried
7. **Assume PII was read.** Contacts, companies, leads, deals, notes are all PII.
8. Breach-notification assessment per jurisdiction

## 7. Object storage exposure

1. Verify Block Public Access is on for every bucket
2. CloudTrail data events: which keys, which principals, when
3. If a bucket was public: enable Block Public Access, then rotate
4. Delete and re-upload affected objects with new keys where feasible
5. Review application audit for `file.` actions
6. Treat any object key pattern as sensitive -- keys reveal organization ids
7. Verify IAM has no `s3:*`

## 8. Malicious upload

1. Identify the object and its `storage_key`
2. Confirm the MIME policy rejected it -- if it was **accepted**, the signature
 check failed and that is the incident
3. Delete the object; mark the attachment row deleted
4. Review `audit_logs` for the uploader
5. Confirm no other user can reach the object: presigned URLs are 5 min, so
 exposure is bounded
6. If accepted: treat as an XSS/RCE vector, revoke that user's sessions, and
 report the control gap

## 9. Credential theft (client side)

1. Confirm the token is `HttpOnly` -- if it is not, that is the finding
2. Revoke all sessions for the user
3. Invalidate the JWT signing secret if the theft mechanism is unknown
4. Review `security_events` for the device/IP
5. Add a CSP strengthening action item if XSS was the vector
6. Verify no token is in `localStorage`

## 10. DDoS

1. Confirm with the WAF/CDN -- do not absorb it at the origin
2. Enable WAF rate-based rules; tighten the global limiter
3. Enable CloudFront caching for static assets
4. Consider a challenge (CAPTCHA) on auth endpoints
5. Scale horizontally only if the WAF cannot absorb it
6. Watch `auth_failures_total` for an authentication-flood variant

## 11. Data corruption

1. **Stop writes** -- scale the API to zero or enable a write kill-switch
2. Preserve -- snapshot immediately, before any repair
3. Identify the blast radius: which tables, which tenants, since when
4. Restore from point-in-time recovery to just before the first bad write
5. Validate referential integrity and row counts after restore
6. Identify the cause -- application bug, migration, or direct DB access
7. `audit_logs` is append-only and survives, so it is the reliable record
8. Document; add a regression test

## 12. Insider threat

1. Preserve audit and access logs before alerting the subject
2. Export their activity: sessions, exports, bulk operations, role changes
3. Restrict access immediately
4. Follow the legal process; involve HR and legal early
5. Do not delete any data -- preservation is the priority
6. Review whether the audit trail was sufficient to detect it. If not, that is a
 product defect to fix

## 13. Post-incident review

Within 5 business days:

- Timeline with UTC timestamps
- Root cause -- including **why the control failed**, not just why the bug existed
- Blast radius: data, tenants, users, time window
- What detected it, and how much earlier a better control would have
- Every action item with an owner and a date
- **A regression test for each control failure** (RULE 185)
- An entry in `SECURITY_FINDINGS.md`, even if the finding is "monitoring gap"
- Action items that will not be done are recorded with the accepted risk -- never
 quietly dropped (RULE 6)

## Contacts

Fill in before go-live:

| Role | Name | Contact |
|---|---|---|
| Incident Commander | | |
| Security on-call | | |
| Platform / SRE | | |
| Privacy / DPO | | |
| Legal | | |
| Communications | | |

**An incident response plan with unfilled contacts is not a plan.**
