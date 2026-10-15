/**
 * Environment configuration — FAILS CLOSED (RULE 207, 209).
 *
 * Every security-relevant setting is validated at startup. There are no
 * "development defaults" that silently become production defaults: a missing
 * or weak production secret aborts the boot rather than degrading to insecure
 * behaviour. RULE 208 — NODE_ENV never gates CSP/CORS/logging; each has its own
 * explicit variable.
 */
import { readFileSync } from 'node:fs';

export type Env = {
  nodeEnv: 'development' | 'test' | 'production';
  envName: string;                 // logical deployment name, used in logs
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  host: string;
  port: number;
  publicUrl: string;
  appOrigins: string[];            // CORS allowlist. NEVER empty-means-allow.
  trustProxyHops: number;
  databaseUrl: string | null;      // postgres://... production
  pgliteDataDir: string | null;    // embedded postgres dir for dev/test; 'memory' = ephemeral
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  db: {
    /** TLS posture for the PostgreSQL connection. RULE 52. */
    ssl: 'disable' | 'require' | 'verify-full';
    /** CA bundle for verify-full: inline PEM, or a path via sslCaFile. */
    sslCa: string | null;
    sslCaFile: string | null;
  };
  secretsPepper: string;           // HMAC pepper, >=32 chars in production
  /** Root of trust for field encryption (MFA secrets). `env` derives from
   *  SECRETS_PEPPER; `kms` decrypts a KMS-held data key once at startup. */
  mfaKeyProvider: 'env' | 'kms';
  /** Base64 of the KMS-encrypted 32-byte data key. Required when the provider
   *  is `kms`; region and endpoint flow through the SDK's standard
   *  `AWS_REGION` / `AWS_ENDPOINT_URL` variables (LocalStack included). */
  kmsMfaKeyCiphertext: string | null;
  jwt: {
    issuer: string;
    audience: string;
    accessSecret: string;
    refreshSecret: string;
    accessTtlSec: number;          // short (RULE 24)
    refreshTtlSec: number;
    cookieName: string;
    csrfCookieName: string;
  };
  cookiesSecure: boolean;
  cookiesSameSite: 'lax' | 'strict' | 'none';
  password: {
    algorithm: 'scrypt' | 'argon2id';
    minLength: number;
    maxLength: number;
  };
  session: {
    idleTimeoutSec: number;
    absoluteTimeoutSec: number;
    refreshIdleSec: number;        // absolute cap on a refresh rotation chain
    maxPerUser: number;
  };
  rateLimit: {
    globalWindowMs: number;
    globalMax: number;
    authWindowMs: number;
    authMax: number;
    searchMax: number;
    exportMax: number;
    uploadMax: number;
  };
  security: {
    hstsEnabled: boolean;
    hstsMaxAgeSec: number;
    cspReportOnly: boolean;
    blockNewAccounts: boolean;     // kill-switch for signup
    requireMfaForPrivileged: boolean;
    maxFailedLogins: number;
    lockoutSec: number;
    readOnlyMode: boolean;
  };
  email: { provider: 'log' | 'smtp'; from: string; smtpUrl: string | null };
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    bucket: string | null;
    region: string | null;
    presignTtlSec: number;
    maxUploadBytes: number;
  };
  observability: {
    metricsEnabled: boolean;
    metricsPath: string;
  };
  retention: {
    auditDays: number;
    sessionDays: number;
    notificationDays: number;
    exportDays: number;
    purgeEnabled: boolean;
  };
  /**
   * Read-only degraded mode. When true, every state-changing request is
   * rejected with 503 while reads continue to serve. Set during database
   * failover, restore, or any maintenance where writes are unsafe but the
   * API must stay up for reads. Deliberately an env var, not a database
   * flag: the mode exists for when the database cannot be trusted, so its
   * switch cannot live inside the database.
   */
  readOnlyMode: boolean;
  corsMaxAgeSec: number;
  bodyLimitBytes: number;
};

const PLACEHOLDER = /^(change[-_ ]?me|changeme|password|secret|placeholder|example|replace|xxx+|\$\{)/i;

const fail = (msg: string): never => { throw new Error(`[config] ${msg}`); };

const raw = process.env;
const nodeEnv = (raw.NODE_ENV ?? 'development') as Env['nodeEnv'];
const isProd = nodeEnv === 'production';

function req(name: string, min = 1): string {
  const v: string | undefined = raw[name];
  if (!v || v.trim().length < min) return fail(`${name} is required (missing or too short).`);
  return v.trim();
}
function int(name: string, min: number, max: number, dflt?: number): number {
  const v: string | undefined = raw[name];
  if (v === undefined || v === '') {
    if (dflt !== undefined) return dflt;
    return fail(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer in [${min}, ${max}] (got ${v})`);
  return n;
}
function bool(name: string, dflt: boolean): boolean {
  const v: string | undefined = raw[name];
  if (v === undefined || v === '') return dflt;
  const n = v.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(n)) return true;
  if (['false', '0', 'no', 'off'].includes(n)) return false;
  return fail(`${name} must be a boolean (got ${v})`);
}

/**
 * RULE 56/207: in production a secret may not be a placeholder, may not be
 * shorter than 32 chars, and may not equal any other configured secret.
 */
function secret(name: string, minLen = 32): string {
  const v: string = req(name, minLen);
  if (isProd) {
    if (v.length < minLen) fail(`${name} must be >= ${minLen} chars in production`);
    if (PLACEHOLDER.test(v)) fail(`${name} looks like a placeholder — refusing to boot in production`);
  }
  return v;
}

/** Parses one origin or aborts. Returns a definite URL so callers need no guard. */
function parseOrigin(o: string): URL {
  try { return new URL(o); } catch { return fail(`APP_ORIGINS contains an invalid origin: ${o}`); }
}

function origins(): string[] {
  const v = raw.APP_ORIGINS ?? '';
  const list = v.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (isProd && list.length === 0) {
    fail('APP_ORIGINS is required in production. An empty CORS allowlist must never mean "allow all" (RULE 37).');
  }
  for (const o of list) {
    const u = parseOrigin(o);
    if (!['https:', 'http:'].includes(u.protocol)) fail(`APP_ORIGINS origin must be http(s): ${o}`);
    if (isProd && u.protocol !== 'https:') fail(`APP_ORIGINS must use https in production: ${o}`);
  }
  return list;
}

function build(): Env {
  const originsList = origins();
  const accessSecret = secret('JWT_ACCESS_SECRET');
  const refreshSecret = secret('JWT_REFRESH_SECRET');
  if (accessSecret === refreshSecret) fail('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');

  const pepper = secret('SECRETS_PEPPER', 32);
  for (const s of [accessSecret, refreshSecret]) {
    if (s === pepper) fail('SECRETS_PEPPER must differ from the JWT secrets');
  }

  // ── field-encryption key provider (MFA secrets) ──
  // Unset means `env`: current behaviour, HKDF under SECRETS_PEPPER. `kms`
  // demands the encrypted data key here, at startup, so a half-configured
  // deployment refuses to boot rather than silently staying on env keys.
  const providerRaw = (raw.MFA_KEY_PROVIDER?.trim() || 'env').toLowerCase();
  if (providerRaw !== 'env' && providerRaw !== 'kms') {
    fail("MFA_KEY_PROVIDER must be 'env' or 'kms'");
  }
  const mfaKeyProvider = providerRaw as 'env' | 'kms';
  const kmsMfaKeyCiphertext = raw.KMS_MFA_KEY_CIPHERTEXT?.trim() || null;
  if (mfaKeyProvider === 'kms' && !kmsMfaKeyCiphertext) {
    fail('MFA_KEY_PROVIDER=kms requires KMS_MFA_KEY_CIPHERTEXT (base64 of the KMS-encrypted 32-byte data key)');
  }

  const databaseUrl = raw.DATABASE_URL?.trim() || null;
  const pgliteRaw = raw.PGLITE_DATA_DIR?.trim() || null;
  const pgliteDataDir = pgliteRaw === 'memory' ? 'memory' : pgliteRaw;
  if (!databaseUrl && !pgliteDataDir) {
    fail('Set DATABASE_URL (postgres) or PGLITE_DATA_DIR (embedded dev/test).');
  }
  if (isProd && !databaseUrl) {
    fail('DATABASE_URL is required in production; embedded Postgres is a dev/test convenience only.');
  }

  // ── TLS posture (RULE 52) ──
  const sslRaw = (raw.DATABASE_SSL?.trim() || (isProd ? 'verify-full' : 'disable')).toLowerCase();
  if (!['disable', 'require', 'verify-full'].includes(sslRaw)) {
    fail("DATABASE_SSL must be one of: disable, require, verify-full");
  }
  const dbSsl = sslRaw as 'disable' | 'require' | 'verify-full';
  if (isProd && dbSsl === 'disable') {
    // A plaintext connection to the system of record is the single worst
    // misconfiguration available to this service. Refuse, do not warn.
    fail('DATABASE_SSL=disable is not permitted in production. Use verify-full (or require on a private link).');
  }

  const sslCaFile = raw.DATABASE_SSL_CA_FILE?.trim() || null;
  let sslCa = raw.DATABASE_SSL_CA?.trim() || null;
  if (sslCaFile) {
    // Read eagerly so a missing mount fails at startup with a clear message
    // rather than at first connection, when the stack trace is 40 frames deep.
    try {
      sslCa = readFileSync(sslCaFile, 'utf8');
    } catch {
      fail(`DATABASE_SSL_CA_FILE is set but could not be read: ${sslCaFile}`);
    }
  }
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    fail('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }

  const st = secret('STORAGE_SIGNING_SECRET', 32);
  if ([st, pepper, accessSecret, refreshSecret].includes(pepper) && st === pepper) {
    fail('STORAGE_SIGNING_SECRET must differ from SECRETS_PEPPER');
  }

  return {
    nodeEnv,
    envName: raw.ENV_NAME?.trim() || 'bigcrm',
    logLevel: (raw.LOG_LEVEL as Env['logLevel']) || (isProd ? 'info' : 'debug'),
    host: raw.HOST?.trim() || '0.0.0.0',
    port: int('PORT', 1, 65535, 3000),
    publicUrl: (raw.PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
    appOrigins: originsList,
    trustProxyHops: int('TRUST_PROXY_HOPS', 0, 10, isProd ? 1 : 0),

    databaseUrl,
    pgliteDataDir,
    db: { ssl: dbSsl, sslCa, sslCaFile },
    dbPoolMax: int('DB_POOL_MAX', 1, 200, 10),
    dbStatementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 100, 600_000, 15_000),

    secretsPepper: pepper,
    mfaKeyProvider,
    kmsMfaKeyCiphertext,

    jwt: {
      issuer: req('JWT_ISSUER', 3),
      audience: req('JWT_AUDIENCE', 3),
      accessSecret,
      refreshSecret,
      accessTtlSec: int('JWT_ACCESS_TTL_SEC', 60, 3600, 900),        // 15 min (RULE 24)
      refreshTtlSec: int('JWT_REFRESH_TTL_SEC', 300, 60 * 60 * 24 * 30, 604_800),
      cookieName: raw.JWT_COOKIE_NAME?.trim() || 'bigcrm_at',
      csrfCookieName: raw.CSRF_COOKIE_NAME?.trim() || 'bigcrm_csrf',
    },

    cookiesSecure: bool('COOKIES_SECURE', isProd),
    cookiesSameSite: (raw.COOKIES_SAMESITE as Env['cookiesSameSite']) || 'lax',

    password: {
      algorithm: (raw.PASSWORD_ALGORITHM as Env['password']['algorithm']) || 'scrypt',
      minLength: int('PASSWORD_MIN_LENGTH', 10, 128, 12),
      maxLength: int('PASSWORD_MAX_LENGTH', 64, 1024, 256),
    },

    session: {
      idleTimeoutSec: int('SESSION_IDLE_TIMEOUT_SEC', 300, 86_400, 3600),
      absoluteTimeoutSec: int('SESSION_ABSOLUTE_TIMEOUT_SEC', 600, 60 * 60 * 24 * 30, 43_200),
      refreshIdleSec: int('JWT_REFRESH_IDLE_SEC', 300, 60 * 60 * 24 * 90, 2_592_000),
      maxPerUser: int('SESSION_MAX_PER_USER', 1, 200, 20),
    },

    rateLimit: {
      globalWindowMs: int('RATE_LIMIT_GLOBAL_WINDOW_MS', 1000, 3_600_000, 900_000),
      globalMax: int('RATE_LIMIT_GLOBAL_MAX', 10, 100_000, 1000),
      authWindowMs: int('RATE_LIMIT_AUTH_WINDOW_MS', 1000, 3_600_000, 900_000),
      authMax: int('RATE_LIMIT_AUTH_MAX', 3, 1000, 10),
      searchMax: int('RATE_LIMIT_SEARCH_MAX', 5, 10_000, 60),
      exportMax: int('RATE_LIMIT_EXPORT_MAX', 1, 1000, 5),
      uploadMax: int('RATE_LIMIT_UPLOAD_MAX', 1, 1000, 20),
    },

    security: {
      hstsEnabled: bool('HSTS_ENABLED', isProd),
      hstsMaxAgeSec: int('HSTS_MAX_AGE_SEC', 0, 63_072_000, 31_536_000),
      cspReportOnly: bool('CSP_REPORT_ONLY', false),
      blockNewAccounts: bool('BLOCK_NEW_ACCOUNTS', false),
      requireMfaForPrivileged: bool('REQUIRE_MFA_FOR_PRIVILEGED', false),
      maxFailedLogins: int('MAX_FAILED_LOGINS', 3, 100, 10),
      lockoutSec: int('LOCKOUT_SEC', 30, 86_400, 900),
      readOnlyMode: bool('READ_ONLY_MODE', false),
    },

    email: {
      provider: (raw.EMAIL_PROVIDER as Env['email']['provider']) || 'log',
      from: raw.EMAIL_FROM?.trim() || 'no-reply@bigcrm.local',
      smtpUrl: raw.SMTP_URL?.trim() || null,
    },


    storage: {
      driver: (raw.STORAGE_DRIVER as Env['storage']['driver']) || 'local',
      localDir: raw.STORAGE_LOCAL_DIR?.trim() || '.bigcrm-storage',
      bucket: raw.STORAGE_BUCKET?.trim() || null,
      region: raw.AWS_REGION?.trim() || null,
      presignTtlSec: int('STORAGE_PRESIGN_TTL_SEC', 30, 3600, 300),
      maxUploadBytes: int('MAX_UPLOAD_BYTES', 1024, 5 * 1024 * 1024 * 1024, 25 * 1024 * 1024),
    },

    observability: {
      metricsEnabled: bool('METRICS_ENABLED', !isProd),
      metricsPath: raw.METRICS_PATH?.trim() || '/internal/metrics',
    },

    retention: {
      auditDays: int('RETENTION_AUDIT_DAYS', 7, 3650, 730),
      sessionDays: int('RETENTION_SESSION_DAYS', 1, 365, 30),
      notificationDays: int('RETENTION_NOTIFICATION_DAYS', 1, 365, 90),
      exportDays: int('RETENTION_EXPORT_DAYS', 1, 365, 7),
      purgeEnabled: bool('RETENTION_PURGE_ENABLED', false),
    },

    /**
     * Read-only degraded mode. When true, every state-changing request is
     * rejected with 503 while reads continue to serve. Set during database
     * failover, restore, or any maintenance where writes are unsafe but the
     * API must stay up for reads. Deliberately an env var, not a database
     * flag: the mode exists for when the database cannot be trusted, so its
     * switch cannot live inside the database.
     */
    readOnlyMode: bool('READ_ONLY_MODE', false),

    corsMaxAgeSec: int('CORS_MAX_AGE_SEC', 0, 86_400, 600),
    bodyLimitBytes: int('BODY_LIMIT_BYTES', 1024, 100 * 1024 * 1024, 1_048_576),
  };
}

export const env: Env = build();

/** Validates the config a second time so tests can assert fail-closed behaviour. */
export function loadEnvFrom(source: NodeJS.ProcessEnv = process.env): Env {
  const saved = process.env;
  process.env = { ...source };
  try { return build(); } finally { process.env = saved; }
}

export const STORAGE_SIGNING_SECRET = secret('STORAGE_SIGNING_SECRET', 32);
