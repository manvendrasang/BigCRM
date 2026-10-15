-- 0005 -- meeting invitations.
--
-- A meeting (`activities` row of type `meeting`) is a timed note until people
-- are invited to it. `meeting_invites` records who was invited and whether
-- they answered, one row per (meeting, user). The invitation fan-out itself
-- (a `notifications` row per invitee) is written by the service in the same
-- transaction -- notifications are derived mail, this table is the source of
-- truth for "who is invited", so re-inviting is a no-op rather than a
-- duplicate, and deleting the meeting cascades the invites with it.
CREATE TABLE IF NOT EXISTS meeting_invites (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 meeting_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'invited'
 CHECK (status IN ('invited','accepted','declined')),
 created_at timestamptz NOT NULL DEFAULT now(),
 responded_at timestamptz,
 UNIQUE (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_invites_user
 ON meeting_invites (organization_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_invites_meeting
 ON meeting_invites (meeting_id);
