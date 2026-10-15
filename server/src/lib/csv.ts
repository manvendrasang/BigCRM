/**
 * CSV import/export hardening (RULE 100, RULE 155, scenario 13).
 *
 * Export: any cell starting with = + - @ TAB CR is prefixed with a single quote,
 * which neutralises spreadsheet formula evaluation. Import: field count is
 * bounded, NUL and control bytes are rejected, and row length is capped so a
 * crafted file cannot exhaust memory.
 */
import { badRequest } from './errors.ts';

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@']);
const TAB = '\t';
const CR = '\r';

export const csvNeedsQuoting = (v: string): boolean =>
 v.includes(',') || v.includes('"') || v.includes('\n') || v.includes(CR);

/** Neutralises spreadsheet formula injection while preserving the visible text. */
export const sanitizeCsvCell = (value: unknown): string => {
 let s = value === null || value === undefined ? '' : String(value);
 // eslint-disable-next-line no-control-regex
 s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
 if (s.length === 0) return s;
 const first = s[0]!;
 if (FORMULA_TRIGGERS.has(first) || first === TAB || first === CR) return `'${s}`;
 // Leading whitespace before a trigger is also interpreted by some spreadsheet apps.
 if (/^[\s]*[=+\-@]/.test(s)) return `'${s}`;
 return s;
};

export const csvCell = (value: unknown): string => {
 const s = sanitizeCsvCell(value);
 return csvNeedsQuoting(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const csvRow = (cells: readonly unknown[]): string => cells.map(csvCell).join(',');

export const toCsv = (headers: readonly string[], rows: readonly unknown[][]): string => {
 const head = csvRow(headers);
 const body = rows.map((r) => csvRow(r)).join('\n');
 return `${head}\n${body}\n`;
};

/** RFC 4180 parser with hard bounds. Returns [] when the input is unusable. */
export function parseCsv(input: string, opts: { maxRows?: number; maxCols?: number } = {}): string[][] {
 const maxRows = opts.maxRows ?? 100_000;
 const maxCols = opts.maxCols ?? 200;
 const text = String(input ?? '');
 if (text.includes('\u0000')) throw badRequest('CSV contains NUL bytes.');
 // Normalise CRLF/CR so quoted fields containing newlines survive.
 const rows: string[][] = [];
 let row: string[] = [];
 let field = '';
 let inQuotes = false;
 let i = 0;
 const pushField = (): void => {
 row.push(field);
 field = '';
 if (row.length > maxCols) throw badRequest(`CSV exceeds ${maxCols} columns.`);
 };
 const pushRow = (): void => {
 pushField();
 rows.push(row);
 if (rows.length > maxRows) throw badRequest(`CSV exceeds ${maxRows} rows.`);
 row = [];
 };
 while (i < text.length) {
 const ch = text[i]!;
 if (inQuotes) {
 if (ch === '"') {
 if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
 inQuotes = false; i++; continue;
 }
 field += ch; i++; continue;
 }
 if (ch === '"') {
 if (field.length !== 0) throw badRequest('Malformed CSV: unexpected quote inside an unquoted field.');
 inQuotes = true; i++; continue;
 }
 if (ch === ',') { pushField(); i++; continue; }
 if (ch === '\n') { pushRow(); i++; continue; }
 if (ch === CR) { i++; if (text[i] === '\n') i++; pushRow(); continue; }
 field += ch; i++;
 }
 if (inQuotes) throw badRequest('Malformed CSV: unterminated quoted field.');
 if (field.length > 0 || row.length > 0) pushRow();
 return rows;
}

/** Detects a formula-injection payload so it can be reported during import. */
export const containsFormula = (v: string): boolean => {
 const s = String(v ?? '');
 return s.length > 0 && (FORMULA_TRIGGERS.has(s[0]!) || /^[\s]*[=+\-@]/.test(s));
};

/** Stable, non-semantic value for a spreadsheet column of "true"/"false". */
export const csvBool = (v: unknown): string => (v ? 'true' : 'false');