# Installing BigCRM

From an empty machine to a running application. Every command is meant to be
copied verbatim; where a value matters, it is called out.

Requirements:

| Requirement | Version | Check |
|---|---|---|
| Node.js | 22 or newer | `node --version` |
| npm | 10 or newer | `npm --version` |
| Docker | only for the optional PostgreSQL/Mailpit path | `docker --version` |

Nothing else. There is no global CLI, no package to install globally, and no
database server is required for the default setup -- the API embeds a real
PostgreSQL (PGlite) that runs from a directory on disk.

---

## 1. Get the code

```bash
git clone <your-repository-url> bigcrm
cd bigcrm
```

You now have the repository. `server/`, `client/`, `docs/`, `Dockerfile`,
`docker-compose.yml` and `.github/workflows/ci.yml` are all included.

## 2. Install dependencies

```bash
npm install
```

This is an npm workspace, so one command at the root installs the API, the web
client and all tooling. It creates `node_modules/` at the root; there is no
second install step.

## 3. Create the configuration file

The API refuses to start without four secrets. They are generated for you:

```bash
npm run bootstrap
```

This reads `server/.env.example`, generates four independent 48-byte secrets,
and writes `server/.env` with mode `0600`:

| Variable | Purpose |
|---|---|
| `JWT_ACCESS_SECRET` | Signs access tokens |
| `JWT_REFRESH_SECRET` | Signs refresh tokens |
| `SECRETS_PEPPER` | Mixed into every password hash |
| `STORAGE_SIGNING_SECRET` | Signs storage object keys |

The values are never printed to the terminal. A secret that appears on screen
ends up in a shell history or a screen share.

To generate `server/.env` by hand instead, copy the example and set the same
four variables yourself:

```bash
cp server/.env.example server/.env
# then fill in the four secrets, each >= 32 characters and all different
openssl rand -base64 48   # use for each, one at a time
```

> **Do not overwrite an existing `server/.env`** unless you mean it. Rotating
> `SECRETS_PEPPER` invalidates every stored password hash, and rotating the JWT
> secrets invalidates every session. `npm run bootstrap` refuses without
> `--force` for that reason.

### The two values worth checking

In `server/.env`:

```bash
# Keep the database on disk so your data survives a restart.
PGLITE_DATA_DIR=.pgdata

# Who you sign in as the very first time. Minimum 12 characters. Required
# only for `npm run seed`; leave empty to skip seeding.
SEED_OWNER_PASSWORD='Choose-A-Strong-One-12+'
```

`APP_ORIGINS` already contains the two origins development needs
(`http://localhost:3000` and `http://localhost:5173`). If you serve the client
from somewhere else, add that origin there too -- omitting it makes every
request fail with `403 Cross-origin request rejected`, including sign-in.

## 4. Create the database schema

```bash
npm run migrate
```

Applies every migration in order and records what it applied. Safe to re-run.
Check the result any time with:

```bash
npm run migrate:status
```

## 5. Create the first account

```bash
npm run seed
```

This creates one organization and one **owner**, printing the email it used.
There is no public sign-up: accounts exist only when an owner or admin creates
them under Settings > Members.

Sign-in details come from `SEED_OWNER_PASSWORD` in step 3.

## 6. Run it

Two processes, two terminals, from the repository root:

```bash
# Terminal 1 -- API on http://localhost:3000
npm run dev
```

```bash
# Terminal 2 -- web client on http://localhost:5173
npm run dev:web
```

Open **http://localhost:5173** and sign in with the seeded owner.

`npm run dev` runs the API with `--watch`, so editing a server file restarts it
automatically. The Vite dev server proxies `/api` to port 3000, so the browser
only ever talks to one origin.

### Optional: richer sample data

```bash
cd server
node --experimental-strip-types --no-warnings --env-file=.env seed/load.ts
```

Loads additional demo organizations and records. Skip it if you want a clean
workspace.

## 7. Confirm it works

```bash
npm run typecheck   # both workspaces, 0 errors
npm run lint        # 0 errors
npm test            # server suite, 1238 assertions across 27 suites
npm run test:coverage --workspace=@bigcrm/client
npm run test:e2e    # Playwright smoke test (needs `npx playwright install chromium` once)
```

---

## Using real PostgreSQL instead of the embedded one

The embedded database is for development and tests. Production, and anything
that must behave like production, should use a real server. PGlite is real
PostgreSQL 17 compiled to WebAssembly, but it is a single-process embedded
engine, not a server.

```bash
docker compose up -d db
```

That starts PostgreSQL 17 on `127.0.0.1:5432` with credentials in
`docker-compose.yml`. Then in `server/.env`:

```bash
DATABASE_URL=postgres://bigcrm:bigcrm_dev_password@localhost:5432/bigcrm
DATABASE_SSL=disable   # loopback; see below for anything else
```

Re-run `npm run migrate` and `npm run seed`.

Two more optional services:

```bash
docker compose up -d mail    # Mailpit: web UI on :8025, SMTP on :1025
docker compose --profile kms up -d kms   # LocalStack KMS, opt-in
```

Mailpit captures outbound email in a browser instead of logging it, so
verification and reset links can actually be clicked. Set `EMAIL_PROVIDER=smtp`
and `SMTP_URL=smtp://localhost:1025` to use it.

For the KMS provider, follow the key ceremony in `server/.env.example`
(create key, generate data key, store the ciphertext in
`KMS_MFA_KEY_CIPHERTEXT`).

---

## Configuration reference

`server/.env.example` documents every variable and is the authoritative list.
The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Controls nothing security-relevant |
| `PORT` | `3000` | API port |
| `PGLITE_DATA_DIR` | `memory` | `.pgdata` to persist |
| `DATABASE_URL` | unset | Required in production |
| `DATABASE_SSL` | `disable` | `require` or `verify-full` for anything real |
| `APP_ORIGINS` | localhost:3000,5173 | Must include the browser's origin |
| `BLOCK_NEW_ACCOUNTS` | `true` | Sign-up is closed by default |
| `COOKIES_SECURE` | `false` | Must be `true` behind HTTPS |
| `HSTS_ENABLED` | `false` | Enable only after TLS is confirmed |
| `REQUIRE_MFA_FOR_PRIVILEGED` | `false` | Forces MFA for owner/admin |
| `MAX_FAILED_LOGINS` | `10` | Attempts before lockout |
| `RETENTION_PURGE_ENABLED` | `false` | Destructive; leave off |
| `PASSWORD_ALGORITHM` | `scrypt` | `argon2id` needs a working native binding |

Configuration **fails closed**. The API refuses to start on a missing, short,
duplicated or placeholder secret; on an empty `APP_ORIGINS` in production; on
the console email provider in production; and on a missing `DATABASE_URL` in
production. A startup failure is the intended outcome, not a bug to work around.

---

## Building for production

```bash
npm run build
```

Compiles the API to `server/dist/` and builds the client to `client/dist/`.

The `Dockerfile` builds the same artifacts in a multi-stage image. It expects
the four secrets and `DATABASE_URL` as build-time or runtime arguments; see
`docs/DEPLOYMENT.md` for the full deployment contract, including the reverse
proxy and TLS requirements.

---

## Tests

```bash
npm test                     # server: 1238 assertions, 27 suites
npm run test:security        # 14 threat scenarios
npm test --workspace=@bigcrm/client        # client: 173 tests
npm run test:e2e             # Playwright: one end-to-end smoke test in Chromium
npm run test:coverage --workspace=@bigcrm/server
```

The server suite runs against an in-memory database and leaves no trace on your
development data. It uses `server/.env.test`, which is committed-adjacent and
safe to read: it contains no real secrets.

---

## Troubleshooting

**`RuntimeError: Aborted()` on startup** -- PGlite allows exactly one process to
open its data directory. Another `npm run dev` is already running:

```bash
pgrep -af "src/index.ts"    # find it
kill <pid>                  # then start yours
```

**`403 Cross-origin request rejected`** -- the browser's origin is missing from
`APP_ORIGINS` in `server/.env`. Add it and restart the API.

**`ERR_REQUIRE_ESM` or syntax errors on `--experimental-strip-types`** -- Node
is older than 22. Check `node --version`.

**Password rejected after signing in** -- check whether you typed the owner
password correctly. A password containing the account's email or name is
refused by policy, and the sign-in page cannot show you the rule.

**Sign-in works, then everything 401s** -- the API restarted and rotated its
access token, or `SECRETS_PEPPER` changed. Restoring the previous
`server/.env` is the fix.

**Port already in use** -- something else holds 3000 or 5173. Change `PORT`, or
for the client use `npm run dev:web -- --port 5174`.

---

## Next steps

| Document | Covers |
|---|---|
| `README.md` | Features, roles, file map |
| `docs/PROJECT_STATUS.md` | What exists, what is verified, what changed |
| `docs/API.md` | Every endpoint |
| `docs/DEPLOYMENT.md` | Production deployment |
| `docs/SECURITY.md` | Security controls |
| `docs/TESTING.md` | What the suites cover |