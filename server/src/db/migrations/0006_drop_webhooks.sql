-- 0006 -- remove webhooks.
--
-- Webhooks were removed from the product (owner decision 2026-10-14): no
-- routes, no dispatcher, no fan-out. The tables go too, deliveries first --
-- they hold the foreign key to endpoints. `IF EXISTS` keeps this replayable
-- on databases that never ran 0001 (fresh PGlite test databases run every
-- migration in order, so the tables exist there too, but idempotence is
-- cheap and a half-applied 0001 must not wedge the runner).
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_endpoints;
