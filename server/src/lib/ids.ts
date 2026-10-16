import { randomUUID, randomBytes, createHash } from 'node:crypto';
/** Opaque public identifier. UUIDv4 -- unguessable, but never a security boundary (RULE 3). */
export const newId = (): string => randomUUID();
/** URL-safe high-entropy secret for tokens we store hashed. */
export const newSecret = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
