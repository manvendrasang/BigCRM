export const nowIso = (): string => new Date().toISOString();
export const isoPlus = (seconds: number, from: Date = new Date()): string =>
 new Date(from.getTime() + seconds * 1000).toISOString();
export const secondsUntil = (iso: string, from: Date = new Date()): number =>
 Math.floor((new Date(iso).getTime() - from.getTime()) / 1000);
export const isExpired = (iso: string | null | undefined, from: Date = new Date()): boolean =>
 !iso || secondsUntil(iso, from) <= 0;
/** Strict ISO-8601 date-time. Rejects the loose strings that caused stored-XSS sinks. */
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_D = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDateTime = (v: string): boolean =>
 ISO_DT.test(v) && !Number.isNaN(Date.parse(v));
export const isIsoDate = (v: string): boolean => ISO_D.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
/** Normalises a calendar date to UTC midnight so comparisons are stable. */
export const dayStart = (v: string): string => (isIsoDate(v) ? `${v}T00:00:00.000Z` : new Date(v).toISOString());
