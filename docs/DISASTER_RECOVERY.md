# DISASTER RECOVERY

> **Status: these are proposals, not verified capabilities.** No backup has been
> restored. No RPO or RTO below has been measured. `PROJECT_STATUS.md` §5 lists
> this as outstanding. A backup that has never been restored is not a backup.

## 1. Targets

| Tier | Systems | RPO | RTO |
|---|---|---|---|
| **Tier 0** -- auth, org, members | `users`, `organizations`, `organization_members`, `sessions` | 5 min (PITR) | 60 min |
| **Tier 1** -- core CRM | `contacts`, `companies`, `leads`, `deals`, `pipelines`, `tasks`, `notes`, `activities` | 5 min | 2 h |
| **Tier 2** -- supporting | tags, custom fields, attachments metadata, saved views, notifications | 15 min | 4 h |
| **Tier 3** -- transient | sessions, tokens, idempotency keys, import/export jobs, webhook deliveries | 1 h | 4 h |

Tier 0 is defined by what a customer cannot be locked out of. Tier 3 is
regenerable.

## 2. Scenarios

| # | Scenario | Detection | Response | Target RTO |
|---|---|---|---|---|
| 1 | Single node / task failure | Health check | Orchestrator replaces | <5 min |
| 2 | Primary AZ loss | Multi-AZ failover | RDS automatic failover | <2 min |
| 3 | Region loss | Dashboard | Rebuild in the secondary region | <4 h |
| 4 | Database corruption | Integrity checks, anomaly | PITR restore to before first bad write | <2 h |
| 5 | Accidental bulk delete | Audit log | PITR, or restore from backup | <2 h |
| 6 | Ransomware / destructive actor | GuardDuty, CloudTrail anomaly | Isolate, rotate credentials, restore to a clean point | <8 h |
| 7 | Credential compromise | Security alert | Revoke -> rotate -> investigate | <1 h |
| 8 | Object storage loss | Versioning, replication | Restore from a prior version | <2 h |
| 9 | Bad migration | Boot failure | Roll forward with a compensating migration | <1 h |

## 3. Backup strategy

| Data | Method | Frequency | Retention |
|---|---|---|---|
| RDS | Automated snapshots + PITR | Continuous WAL | 35 days |
| RDS | Cross-region copy | Continuous | 30 days |
| S3 | Versioning + lifecycle | Continuous | 90 days |
| S3 | Cross-region replication | Continuous | 30 days |
| Config | IaC in git, reviewed | Per change | Indefinite |
| Audit log | Included in RDS backup | Continuous | 35 days hot, then archive |

### Backup isolation (RULE 108)

The application role has **no** backup or snapshot privileges. Backup writes use
a separate role. Backups are encrypted with a dedicated KMS key and are not
writable by application credentials -- ransomware must not be able to delete them.

### Immutability

S3 Object Lock in compliance mode for the backup bucket, so retention cannot be
shortened or objects deleted, even by the root account.

## 4. Restore procedure

```
1. DECLARE -- incident commander opens a recovery incident
2. FREEZE -- stop all writers; scale the API to zero
3. PRESERVE -- snapshot the current (damaged) instance before any change
4. DETERMINE -- exact point in time to restore to
5. RESTORE
 Tier 0/1 -> PITR to the chosen timestamp
 Tier 2/3 -> object restore, or let rows regenerate
6. VERIFY
 - migrate() applies cleanly (schema_migrations checksum match)
 - Row counts per table match the pre-incident snapshot
 - Referential integrity: no orphaned FKs
 - audit_logs is append-only and complete
 - A canary login, and one read per Tier 0/1 table
7. RESTORE SERVICE -- scale up gradually, watch 5xx and latency
8. NOTIFY -- confirm with the incident commander before user communication
9. DOCUMENT -- full timeline; post-incident review
```

### Verification is mandatory

A restore is not complete until verified. Minimum checks:

- [ ] Schema migration state matches the code version
- [ ] Row counts plausible per table
- [ ] No orphaned foreign keys
- [ ] `audit_logs` present and append-only
- [ ] Login works; a session can be created and revoked
- [ ] One read and one write per Tier 0/1 table
- [ ] Attachments resolve (S3 keys still present)
- [ ] Background worker restarts cleanly

## 5. Drill schedule

| Drill | Frequency | Owner | Success criterion |
|---|---|---|---|
| Point-in-time restore | Monthly | SRE | Restored within 30 min; verification passes |
| Full snapshot restore | Quarterly | SRE | Restored within 2 h |
| Cross-region rebuild | Twice yearly | SRE + Platform | RTO < 4 h |
| Region loss game day | Annually | All | Full Tier 0/1 recovery |
| Secret rotation drill | Quarterly | Security | Rotate a non-critical secret end-to-end |
| Access review | Quarterly | Security | Privileged accounts reviewed |

**A drill that has never been run is a hypothesis.** The first drill will almost
certainly surface problems -- that is the point.

## 6. Business continuity (RULE 111)

If a tier is unavailable:

| Tier | Degraded behaviour | Customer impact |
|---|---|---|
| **Tier 0** down | **No access at all** | Total outage -- highest restoration priority |
| Tier 1 down | Read-only mode from cache; writes queued and replayed | Users can read, cannot save |
| Tier 2 down | Records usable; tags/custom fields/saved views unavailable | Degraded |
| Tier 3 down | Background jobs paused; scheduled work resumes later | Delayed imports/exports, delayed notifications |
| S3 down | Attachments unavailable; all record data intact | Degraded |
| Email down | Verification and reset emails queue | New signups and resets blocked |
| WAF/CDN down | Origin reachable directly | Reduced protection -- page |

**Read-only mode** requires implementation: the API must refuse writes with a
clear error and queue nothing silently. Not built.

## 7. Communications

| When | Audience | Content |
|---|---|---|
| SEV1 declared | Internal | What's affected, what's known, next update time |
| +30 min | Internal | Updated impact, mitigation progress |
| +2 h | Affected customers | Impact, workaround, ETA (no root-cause speculation) |
| Resolution | Affected customers | What happened, what was done, what changed |
| Per assessment | Regulators / affected individuals | Per jurisdiction |

Never disclose: exploit detail, unpatched vulnerability specifics, or the
existence of a vulnerability not yet fixed.

## 8. Post-recovery review

- Was the chosen RPO met? RTO?
- Did verification catch everything it should have?
- Which check was hardest to perform -- that is a tooling gap
- Was documentation accurate? Correct it now
- What will make the next recovery faster?
- **Add a test for each control gap found** (RULE 185)

## 9. Outstanding

Everything in this document is unverified. Specifically:

- [ ] No backup has ever been restored
- [ ] No RPO/RTO has been measured
- [ ] No Terraform exists, so none of the platform controls are provisioned
- [ ] No read-only degraded mode
- [ ] Legal hold is not implemented -- **destructive retention must not be
 enabled until it is**
- [ ] Incident contacts in `INCIDENT_RESPONSE.md` are unfilled
