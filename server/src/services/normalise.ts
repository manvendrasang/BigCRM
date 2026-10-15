/**
 * Normalisation (RULE 177, 178).
 *
 * Duplicate detection is only as good as the canonicalisation feeding it. The
 * legacy CRM lowercased the email for its duplicate *check* but stored the raw
 * value, so `Ada@X.com` and `ada@x.com` could both be persisted as distinct
 * contacts. Here one function produces the canonical form and both the stored
 * column and the uniqueness constraint use it, so the database — not a racing
 * SELECT — is the arbiter.
 */
import { createHash } from 'node:crypto';

/** Canonical email: trimmed, lowercased, Unicode-normalised. */
export const normaliseEmail = (v: unknown): string =>
  String(v ?? '').trim().normalize('NFKC').toLowerCase();

/**
 * E.164-ish canonical phone. Extensions and punctuation are dropped so
 * `+1 (555) 010-0 ext 2` and `+15550100` collapse to the same key. Anything that
 * is not a plausible phone is returned unchanged so it is still searchable.
 */
export const normalisePhone = (v: unknown): string => {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  const extIndex = raw.search(/\b(?:ext|x|extension)\b\.?\s*\d+/i);
  const main = extIndex === -1 ? raw : raw.slice(0, extIndex);
  const digits = main.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return raw.toLowerCase();
  return `+${digits}`;
};

/** Company name key: casefold, strip punctuation and legal suffixes. */
export const normaliseCompanyName = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'’`]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|sas|ag|bv|nv|pty|llp|pllc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Domain from a URL or bare host, lowercased and de-www'd. */
export const normaliseDomain = (v: unknown): string => {
  const raw = String(v ?? '').trim().toLowerCase();
  if (!raw) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
};

export const slugify = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'org';

/** Stable hash used for deterministic dedupe keys and cache partition hints. */
export const digest = (v: unknown): string =>
  createHash('sha256').update(String(v ?? '')).digest('hex');

export const displayName = (first?: unknown, last?: unknown): string =>
  [String(first ?? '').trim(), String(last ?? '').trim()].filter(Boolean).join(' ');

/** Two-letter ISO country, uppercased, or null. */
export const normaliseCountry = (v: unknown): string | null => {
  const raw = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : null;
};

/** Human label for an enum value that failed validation, for audit records. */
export const enumLabel = (v: unknown): string => String(v ?? '').slice(0, 40);