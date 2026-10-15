-- 0004 — webhook secret envelope + saved-view guard rails.
--
-- `webhook_endpoints.secret_enc` holds the endpoint signing secret under the
-- versioned AES-256-GCM envelope (same primitive as MFA secrets). The HMAC
-- signer needs the raw bytes, so a one-way hash cannot serve; the envelope is
-- the recoverable copy and `secret_hash` stays as the fast existence check.
-- Nullable because endpoints created before this migration have no sealed
-- copy — the dispatcher drops (does not retry) deliveries it cannot sign.
ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS secret_enc text;

-- Saved views created before the apply-time filter validation could store
-- arbitrary JSON. The 5 KB / 2 KB size bounds are enforced in the service, not
-- here — a CHECK on octet_length would reject old rows on sight rather than
-- at apply time, and old rows are read-only history until re-saved.
-- No DDL needed for views in this migration; this comment records the decision.
