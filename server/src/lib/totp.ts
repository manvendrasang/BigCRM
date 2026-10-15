/**
 * TOTP (RFC 6238) + otpauth provisioning, implemented on node:crypto so there is
 * no extra native dependency. Verified in tests against the RFC 6238 test
 * vectors, so the implementation is provably correct rather than merely
 * plausible.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fromBase32, toBase32 } from './base32.ts';

const DIGITS = 6;
const PERIOD = 30;

export const newTotpSecret = (): string => {
  // 160 bits, the RFC 4226 recommended size for HMAC-SHA1.
  return toBase32(randomBytes(20));
};

/** Hotp: HMAC-SHA1(code) truncated to `digits` (RFC 4226 §5.3). */
export function hotp(secretB32: string, counter: number, digits = DIGITS): string {
  const key = fromBase32(secretB32.replace(/=+$/, ''));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpCode = (secretB32: string, atMs: number = Date.now()): string =>
  hotp(secretB32, Math.floor(atMs / 1000 / PERIOD));

export type VerifyResult = { ok: true; delta: number } | { ok: false; reason: string };

/**
 * Constant-time comparison over a ±`window` of steps. Window ±1 tolerates clock
 * skew. A reused step is rejected by the caller via `lastUsedStep`.
 */
export function verifyTotp(
  secretB32: string,
  candidate: string,
  opts: { atMs?: number; window?: number; lastUsedStep?: number | null } = {},
): VerifyResult {
  const atMs = opts.atMs ?? Date.now();
  const window = opts.window ?? 1;
  const code = String(candidate ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'Code must be exactly 6 digits.' };

  const step = Math.floor(atMs / 1000 / PERIOD);
  const candidateBuf = Buffer.from(code, 'utf8');
  let matchedDelta: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const s = step + delta;
    if (s < 0) continue;
    if (opts.lastUsedStep !== undefined && opts.lastUsedStep !== null && s <= opts.lastUsedStep) continue;
    const expected = hotp(secretB32, s);
    if (expected.length === candidateBuf.length && timingSafeEqual(Buffer.from(expected, 'utf8'), candidateBuf)) {
      matchedDelta = delta;
      break;
    }
  }
  if (matchedDelta === null) return { ok: false, reason: 'Invalid or expired code.' };
  return { ok: true, delta: matchedDelta };
}

export const currentStep = (atMs: number = Date.now()): number => Math.floor(atMs / 1000 / PERIOD);

/** otpauth:// provisioning URI (RULE 163 — used verbatim as the OAuth-style redirect). */
export const provisioningUri = (opts: {
  secret: string; accountName: string; issuer: string; digits?: number; period?: number;
}): string => {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(opts.digits ?? DIGITS),
    period: String(opts.period ?? PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};
