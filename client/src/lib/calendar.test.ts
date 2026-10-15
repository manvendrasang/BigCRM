/**
 * Calendar arithmetic tests.
 *
 * Grids are easy to eyeball and hard to get right: a month starting on
 * Sunday needs six leading fillers under Monday-start, February 2024 needs
 * 29 in-month days, and some months span six weeks. Each boundary is pinned.
 */
import { describe, expect, it } from 'vitest';
import { buildMonthGrid, shiftMonth } from './calendar';

describe('buildMonthGrid', () => {
 it('covers complete Monday-start weeks', () => {
 // October 2026 starts on a Thursday: 3 leading fillers (Mon-Wed).
 const weeks = buildMonthGrid(2026, 9);
 expect(weeks.length).toBeGreaterThanOrEqual(4);
 expect(weeks.length).toBeLessThanOrEqual(6);
 for (const week of weeks) {
 expect(week).toHaveLength(7);
 // Monday first: 2026-09-28 is a Monday.
 expect(week[0]!.date.getUTCDay()).toBe(1);
 }
 expect(weeks[0]![0]!.key).toBe('2026-09-28');
 expect(weeks[0]![0]!.inMonth).toBe(false);
 });

 it('marks exactly the in-month days', () => {
 const weeks = buildMonthGrid(2026, 9);
 const inMonth = weeks.flat().filter((d) => d.inMonth);
 expect(inMonth).toHaveLength(31);
 expect(inMonth[0]!.key).toBe('2026-10-01');
 expect(inMonth[30]!.key).toBe('2026-10-31');
 });

 it('handles February in a leap year', () => {
 const weeks = buildMonthGrid(2024, 1);
 const inMonth = weeks.flat().filter((d) => d.inMonth);
 expect(inMonth).toHaveLength(29);
 expect(inMonth[28]!.key).toBe('2024-02-29');
 });

 it('handles a month starting on Sunday (six leading fillers)', () => {
 // November 2026 starts on a Sunday.
 const weeks = buildMonthGrid(2026, 10);
 expect(weeks[0]![0]!.key).toBe('2026-10-26');
 expect(weeks[0]!.filter((d) => !d.inMonth)).toHaveLength(6);
 });

 it('emits unique day keys with no gaps', () => {
 const days = buildMonthGrid(2026, 9).flat();
 const keys = days.map((d) => d.key);
 expect(new Set(keys).size).toBe(keys.length);
 for (let i = 1; i < days.length; i++) {
 const prev = Date.parse(`${days[i - 1]!.key}T00:00:00Z`);
 const curr = Date.parse(`${days[i]!.key}T00:00:00Z`);
 expect(curr - prev).toBe(86_400_000);
 }
 });
});

describe('shiftMonth', () => {
 it('rolls over December to January', () => {
 expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
 });

 it('rolls back January to December', () => {
 expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
 });
});
