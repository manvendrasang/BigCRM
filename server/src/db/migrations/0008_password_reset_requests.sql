-- 0008 -- member-initiated password reset requests.
--
-- This deployment has no mailbox round-trip a member can rely on, so "reset my
-- password" is a human hand-off: the member clicks a button on the dashboard,
-- every owner/admin is notified, and one of them types the new password in
-- Settings > Members. The request is a durable ROW rather than an ephemeral
-- notification for two reasons:
--
-- 1. De-duplication. The partial unique index allows at most one `pending`
--    request per member, so an impatient second click is a no-op and does not
--    notify the office twice.
-- 2. Resolution. When an admin sets the password the row is marked
--    `completed` (with who and when), which is what the roster badge reads.
--
-- `status` is a CHECK rather than a boolean so a future cancel path does not
-- need a migration. `resolved_by` is nullable and ON DELETE SET NULL: the
-- history of the request should outlive the account of the admin who handled
-- it, and vice versa.
CREATE TABLE IF NOT EXISTS password_reset_requests (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending'
 CHECK (status IN ('pending','completed','cancelled')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- At most one OPEN request per member, per organization.
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_requests_open
 ON password_reset_requests (organization_id, user_id) WHERE status = 'pending';

-- Roster badge lookup: pending requests for one organization.
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_org
 ON password_reset_requests (organization_id, status);
