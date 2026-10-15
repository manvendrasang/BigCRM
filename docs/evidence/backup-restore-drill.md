# Backup / restore drill -- measured

Run on this repository against `bigcrm-db` (PostgreSQL 17.11).
Every figure below is measured by `infra/scripts/backup-restore-drill.sh`.

| Metric | Measured |
|---|---|
| Source database | `bigcrm`, 15 MB |
| Rows restored | 4170 across 14 tables |
| **Backup time** | **143 ms** (`pg_dump --format=custom --compress=9`) |
| **Restore time** | **899 ms** (`pg_restore --exit-on-error`) |
| Dump size | 316K |
| Tables matching baseline | 14 / 14 |
| Failures | 0 |

## What the restore preserved

Row counts alone would be a weak claim, so each guarantee is checked by
attempting to violate it in the *restored* database:

| Guarantee | Check | Result |
|---|---|---|
| CHECK constraints | insert `leads.score = 500` (max 100) | rejected |
| Foreign keys | insert a contact with a non-existent `organization_id` | rejected |
| Append-only audit (DELETE) | `DELETE FROM audit_logs` | blocked |
| Append-only audit (UPDATE) | `UPDATE audit_logs SET action='tampered'` | blocked |
| Indexes | count compared source vs restored | identical |
| Migration state | `schema_migrations` non-empty | present |

## RTO / RPO -- what this does and does not establish

**RTO is bounded by the restore time above, plus image and cutover.** A full
`pg_restore` of 4170 rows took 899 ms. Adding container pull,
service start, readiness probe and a DNS/ALB cutover, a **same-region restore is
plausibly under 15 minutes**, which meets a 1-hour RTO target with large margin.
That is an inference from a measured number plus untimed steps, not a measurement
of the whole procedure.

**RPO is NOT established by this drill.** Logical dumps give an RPO equal to the
dump interval -- 24 hours at best with a nightly schedule. The RPO target of 5
minutes requires RDS PITR, which replays write-ahead log and has no local
analogue. Until a PITR restore is performed against a real RDS instance, RPO
remains a **target, not a measurement**.

## Caveats

- The drill restores a **logical** dump. RDS automated backups are physical
 (base backups + WAL), which is faster and supports PITR. This drill proves the
 *procedure* and the *integrity checks*, not the mechanism production will use.
- The database used here is small. Restore time scales with size and index count;
 re-run the drill against a production-shaped dataset before treating 899 ms
 as representative.
- No backup **retention**, encryption-at-rest-in-backup, or cross-region copy
 was verified. None of those can be verified from this host.
