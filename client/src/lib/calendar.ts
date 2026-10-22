/**
 * Pure calendar arithmetic for the month view.
 *
 * Kept out of the page so it is unit-testable without rendering: week
 * alignment, leap years and six-week months are exactly the kind of logic
 * that looks right in a browser and is wrong on the 1st of the month. Weeks
 * start on Monday; the grid always covers complete weeks, so leading and
 * trailing days belong to the adjacent months.
 */

export interface CalendarDay {
 /** Midnight UTC -- identity only, never displayed raw. */
 date: Date;
 /** ISO `YYYY-MM-DD` key for grouping agenda entries. */
 key: string;
 /** False for the leading/trailing filler days. */
 inMonth: boolean;
}

const dayKey = (d: Date): string =>
 `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

export function buildMonthGrid(year: number, month: number): CalendarDay[][] {
 // `month` is 0-based (January is 0), matching `Date.UTC`.
 const first = new Date(Date.UTC(year, month, 1));
 // Monday-start offset: Sunday (0) trails the week, everything else leads.
 const lead = (first.getUTCDay() + 6) % 7;
 const start = new Date(Date.UTC(year, month, 1 - lead));
 const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

 const cells: CalendarDay[] = [];
 const total = Math.ceil((lead + daysInMonth) / 7) * 7;
 for (let i = 0; i < total; i++) {
 const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
 cells.push({
 date,
 key: dayKey(date),
 inMonth: date.getUTCMonth() === month,
 });
 }

 const weeks: CalendarDay[][] = [];
 for (let w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
 return weeks;
}

/** Previous/next month, rolling the year over December/January. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
 const d = new Date(Date.UTC(year, month + delta, 1));
 return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

export const MONTH_LABEL = (year: number, month: number): string =>
 new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const RECORD_PATH: Record<string, string> = {
  contact: 'contacts',
  company: 'companies',
  lead: 'leads',
  deal: 'deals',
  task: 'tasks',
};

/**
 * Internal path to a record's detail page, or null when the type has none.
 *
 * One map for the calendar chip, the agenda entry and the event window, so a
 * meeting's "open the record" link cannot point three different places.
 */
export const recordPath = (entityType: string | null, entityId: string | null): string | null =>
  entityType && entityId && RECORD_PATH[entityType] ? `/${RECORD_PATH[entityType]}/${entityId}` : null;
