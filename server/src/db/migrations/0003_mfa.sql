-- 0003 — MFA: the TOTP secret gets a column, encrypted at rest.
--
-- Why this migration exists
-- -------------------------
-- `users.mfa_enabled` and `users.mfa_enrolled_at` existed from 0001, and the
-- TOTP implementation (RFC 6238) is complete and tested against the RFC test
-- vectors. There was nowhere to put the secret: `totp_secret_encrypted` was in
-- the repository column allowlist but had no column. MFA was therefore
-- unreachable — the code existed, the storage did not.
--
-- BIG-11 required more than a column. A TOTP secret is a bearer credential: it
-- generates a valid code with no user interaction, for the next five minutes,
-- from anywhere on earth. Storing it in plaintext would mean a single read-only
-- SQL injection, a backup dump, or a `SELECT *` in a support query yields
-- permanent 2FA bypass. So it is encrypted at rest.
--
-- Encryption design (services/mfa.ts):
--   • AES-256-GCM, authenticated, so a tampered ciphertext fails to decrypt
--     rather than yielding a garbage secret that silently mints codes nobody
--     can predict.
--   • The key is derived from SECRETS_PEPPER with HKDF and a purpose string, so
--     the same pepper used for password hashing cannot decrypt this field, and
--     this field's key cannot be reused elsewhere.
--   • Version byte prefixed, so the scheme can be rotated without a flag day.
--
-- `mfa_last_used_step` enforces single-use: HOTP is deterministic, so a code is
-- valid for its whole 30-second step. Without this column an observer who
-- shoulder-surfs one code can replay it until the step ends. Recording the
-- accepted step and refusing anything at or below it closes that window.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_encrypted text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_used_step bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_used_at timestamptz;

-- A user cannot be `mfa_enabled` without a stored secret. Enforced in the
-- database so no code path — migration, manual fix, bug — can produce an
-- account that claims 2FA is on while having no second factor.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_mfa_enabled_requires_secret;
ALTER TABLE users ADD CONSTRAINT users_mfa_enabled_requires_secret
  CHECK (mfa_enabled = false OR totp_secret_encrypted IS NOT NULL);

-- Recovery codes belong to a user and are consumed in order. The existing
-- partial index covers the unused case; this one supports "list what is left".
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user_created
  ON mfa_recovery_codes (user_id, created_at DESC);

-- Enrollment/challenge state. `email_verifications` was being reused as a
-- generic challenge store, which meant an MFA challenge and an email
-- verification were indistinguishable rows — a real problem when auditing
-- "was this token consumed?" and when revoking one without touching the other.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    char(64) NOT NULL UNIQUE,
  purpose       text   NOT NULL CHECK (purpose IN ('enroll', 'challenge', 'disable')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges (user_id, consumed_at);
-- Expired challenges are collected by the retention scheduler; this index keeps
-- that sweep from scanning the table.
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expiry ON mfa_challenges (expires_at)
  WHERE consumed_at IS NULL;
