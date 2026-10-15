# syntax=docker/dockerfile:1.7
# BigCRM API image. RULE 89: minimal, pinned, non-root, read-only, no secrets.

ARG NODE_VERSION=22.18.0
ARG NODE_IMAGE=node:${NODE_VERSION}-bookworm-slim

# ── dependencies ─────────────────────────────────────────────────────────────
# Separate stage so a source-only change does not invalidate the dependency layer.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# `npm ci` installs exactly the lockfile — RULE 128.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root --ignore-scripts

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY server/ server/
RUN npm run build --workspace @bigcrm/server \
 && npm prune --omit=dev --workspaces --include-workspace-root

# `tsc` emits JavaScript only. The migrations are .sql and are resolved at
# runtime relative to the compiled module (`join(dirname(import.meta.url),
# 'migrations')`), so they must be placed alongside it or the container aborts at
# startup with ENOENT on dist/db/migrations. Third Dockerfile defect that only
# running the image exposed — see SECURITY_FINDINGS.md BIG-31.
COPY --chown=node:node server/src/db/migrations ./server/dist/db/migrations

# ── test ─────────────────────────────────────────────────────────────────────
# This stage produces a *runner image*, not a build-time test.
#
# It previously ran `RUN node .../run.ts` with `ARG DATABASE_URL`, which cannot
# work: `docker build` has no database to connect to, and supplying a live
# DATABASE_URL as a build argument would bake the credential into the image
# history where `docker history` and every registry mirror expose it.
#
# The tests therefore run the way they are meant to — a container started next
# to a database, as an entrypoint:
#
#   docker build -t bigcrm-api .
#   docker build --target test -t bigcrm-api:test-runner .
#   docker network create bigcrm-net
#   docker run -d --name bigcrm-db --network bigcrm-net \
#     -e POSTGRES_PASSWORD=... -e POSTGRES_DB=bigcrm_test postgres:17-alpine
#   docker run --rm --network bigcrm-net \
#     -e DATABASE_URL=postgres://...@bigcrm-db:5432/bigcrm_test \
#     -e SECRETS_PEPPER=... bigcrm-api:test-runner
#
# `docker-compose.yml` wires exactly this. Note the runner keeps the source
# tree and the dev dependencies: it is a test tool, not a deployable artefact.
FROM deps AS test
WORKDIR /app
COPY server/ server/
COPY package.json ./
ENV NODE_ENV=test LOG_LEVEL=silent
ENTRYPOINT ["node", "--experimental-strip-types", "--no-warnings", "server/src/tests/run.ts"]

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# Rule 89: no compiler toolchain in the shipped image.
#
# `apt-get upgrade` is not cosmetic. A Trivy scan of the image as originally
# written reported 23 CRITICAL/HIGH findings in the Debian layer (libgnutls30,
# perl-base, libpcre2, libpam) purely from the base image being behind on
# security updates, with 28 packages upgradeable. A base image pinned by digest
# still ships whatever patches existed when it was cut; upgrading at build time
# is what makes the digest pin a floor rather than a ceiling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Remove npm and corepack. The runtime `CMD` is `node server/dist/index.js` and
# nothing in the running container invokes a package manager, yet npm ships ~19 MB
# of bundled dependencies (tar, pacote, sigstore, minimatch, brace-expansion …)
# that accounted for 41 CRITICAL/HIGH findings in the same scan.
#
# This is attack-surface removal, not CVE cosmetics: a package manager able to
# fetch and execute code has no business being present in an image whose only job
# is to serve HTTP. `--force` because npm's bin directory is also on PATH.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && npm cache clean --force 2>/dev/null || true

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Non-root with a numeric UID. No secrets are baked in: configuration arrives at
# runtime from the environment or a secrets manager (RULE 56).
# npm workspaces hoist every dependency to the repository root, so there is no
# /app/server/node_modules after `npm prune`. Copying it fails the build with
# `"/app/server/node_modules": not found` — the second Dockerfile defect that only
# running the build exposed (see SECURITY_FINDINGS.md BIG-22).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --chown=node:node package.json ./

# Writable storage for the local driver (attachments, exports). `/app` itself
# is root-owned, so the default relative `.bigcrm-storage` fails with EACCES
# under `USER node` — which is what the first export attempt proved: a 500 on
# `mkdir`. An explicit, owned directory fails closed at build time instead of
# at the first upload. Mount a volume here for persistence; without one the
# files live and die with the container, which the docs state plainly.
RUN mkdir -p /data/storage && chown node:node /data/storage
ENV STORAGE_LOCAL_DIR=/data/storage

USER node
EXPOSE 3000

# RULE 118: liveness only. Never credentials, environment values, or topology.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/dist/index.js"]