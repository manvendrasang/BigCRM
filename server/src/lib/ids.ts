import { randomUUID, randomBytes, createHash } from 'node:crypto';
/** Opaque public identifier. UUIDv4 — unguessable, but never a security boundary (RULE 3). */
export const newId = (): string => randomUUID();
/** URL-safe high-entropy secret for tokens we store hashed. */
export const newSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const sha256Buf = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
/** Constant-time string comparison that tolerates length mismatch. */
export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
};
