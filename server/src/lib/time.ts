export const nowIso = (): string => new Date().toISOString();
export const isoPlus = (seconds: number, from: Date = new Date()): string =>
 new Date(from.getTime() + seconds * 1000).toISOString();
export const secondsUntil = (iso: string, from: Date = new Date()): number =>
 Math.floor((new Date(iso).getTime() - from.getTime()) / 1000);
export const isExpired = (iso: string | null | undefined, from: Date = new Date()): boolean =>
 !iso || secondsUntil(iso, from) <= 0;
