-- 0009 -- per-account appearance preference.
--
-- The theme used to live only in localStorage, which made it a property of the
-- BROWSER rather than the account. On a shared office machine the next person
-- to sign in inherited the previous person's dark mode, and the login screen
-- they saw before authenticating was painted in a stranger's theme.
--
-- It is a column rather than a table because it is the only preference that
-- exists and it belongs to exactly one user: a one-column table would add a
-- join to the hot path and a second place to forget to cascade.
--
-- The column is NOT NULL DEFAULT 'light' so every existing row is valid without
-- a backfill, and the CHECK keeps the enum in the database as well as in the
-- service -- a hand-written UPDATE cannot store a preference the client could
-- not have sent. Adding a column rewrites no rows and takes no lock that
-- conflicts with reads.
ALTER TABLE users
 ADD COLUMN IF NOT EXISTS theme_preference text NOT NULL DEFAULT 'light';

DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE conname = 'users_theme_preference_check'
 ) THEN
  ALTER TABLE users
   ADD CONSTRAINT users_theme_preference_check
   CHECK (theme_preference IN ('light','dark','system'));
 END IF;
END $$;