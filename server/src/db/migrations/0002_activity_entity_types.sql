-- 0002 -- activity entity types, and the savepoint-compatible audit path.
--
-- Why this migration exists
-- -------------------------
-- `activities.entity_type` was constrained to contact/company/lead/deal/task/
-- note/organization/user. Pipelines and pipeline stages are first-class CRM
-- records with their own audit trail, so writing an activity for one violated
-- the CHECK.
--
-- The consequence was much worse than a missing timeline entry, and it is worth
-- recording precisely because it is invisible without executing the path:
--
-- In PostgreSQL, a statement error ABORTS the whole transaction. Catching the
-- exception in application code does not undo that. Every subsequent statement
-- in the transaction fails with 25P02 "current transaction is aborted", and
-- the COMMIT is downgraded to a ROLLBACK.
--
-- So a rejected activity INSERT discarded the surrounding create/update that
-- it was annotating, while the caller still held the row returned by
-- `RETURNING *` and reported success. The API answered 201 for a record that
-- did not exist.
--
-- Two changes, both required:
-- 1. Widen the CHECK so pipelines can be annotated at all.
-- 2. Contain the failure. See `TenantScope.bestEffort` in
-- src/repositories/base.ts, which wraps optional writes in a SAVEPOINT so a
-- rejected audit row cannot roll back the business write.
--
-- Fixing only (1) would hide the bug rather than remove it: the next optional
-- write to fail for any other reason would silently discard a user's data again.

-- ── activities: allow pipeline records ────────────────────────────────────────
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_entity_type_check;

ALTER TABLE activities ADD CONSTRAINT activities_entity_type_check
 CHECK (entity_type IN (
 'contact', 'company', 'lead', 'deal',
 'pipeline', 'pipeline_stage',
 'task', 'note', 'organization', 'user'
 ));

-- ── notes/comments reference pipelines? no. But custom_field_values and
-- saved_views are addressed by entity_type too; widen those that enumerate
-- the same vocabulary so a pipeline can carry notes and custom fields.

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_entity_type_check;
ALTER TABLE notes ADD CONSTRAINT notes_entity_type_check
 CHECK (entity_type IN ('contact', 'company', 'lead', 'deal'));

-- ── index supporting the activity timeline for the newly allowed types ────────
CREATE INDEX IF NOT EXISTS idx_activities_entity
 ON activities (organization_id, entity_type, entity_id, occurred_at DESC);

-- ── comment is addressed by entity_type as well; widen to match notes ────────
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_entity_type_check;
ALTER TABLE comments ADD CONSTRAINT comments_entity_type_check
 CHECK (entity_type IN ('contact', 'company', 'lead', 'deal', 'task'));
