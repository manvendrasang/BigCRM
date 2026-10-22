/**
 * CSV hardening (RULE 100, RULE 155, security scenario 13).
 *
 * Export and import were previously covered only indirectly, through the
 * transfer service. These assertions pin the property that matters: a cell a
 * spreadsheet would evaluate as a formula cannot survive an export, and an
 * import cannot be made to allocate unbounded memory or smuggle a NUL.
 *
 * The payloads are the interesting part, not the prose. Query names, phone
 * numbers and company names are all attacker-controlled text that reaches a
 * spreadsheet on somebody else's machine.
 */
import {
  containsFormula, csvCell, csvNeedsQuoting, csvRow, parseCsv, sanitizeCsvCell, toCsv,
} from '../../lib/csv.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 120)}`;
  if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const throws = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

console.log('\n=== formula neutralisation ===');
{
  for (const trigger of ['=', '+', '-', '@']) {
    const cell = `${trigger}SUM(A1:A9)`;
    const out = sanitizeCsvCell(cell);
    T(`a cell starting with ${JSON.stringify(trigger)} is neutralised`,
      out === `'${cell}`, out);
    T(`  ...and the visible text is preserved for ${JSON.stringify(trigger)}`,
      out.slice(1) === cell, out);
  }

  // Some spreadsheet engines treat a leading TAB or CR as "skip to the formula",
  // which is why both are in the trigger set rather than only the four operators.
  const tabbed = sanitizeCsvCell('\t=1+1');
  T('a leading TAB before a formula is neutralised', tabbed === "'\t=1+1", JSON.stringify(tabbed));
  const cr = sanitizeCsvCell('\r=1+1');
  T('a leading CR before a formula is neutralised', cr === "'\r=1+1", JSON.stringify(cr));

  // The classic bypass: a space is invisible in a spreadsheet cell but the
  // evaluator still parses what follows.
  for (const padded of [' =1+1', '   @SUM(A1)', '\t-2+3']) {
    const out = sanitizeCsvCell(padded);
    T(`leading whitespace before ${JSON.stringify(padded.trim()[0])} is neutralised`,
      out.startsWith("'"), JSON.stringify(out));
  }

  const hyperlink = sanitizeCsvCell('=HYPERLINK("http://evil.example","click")');
  T('a HYPERLINK payload is neutralised', hyperlink.startsWith("'="), hyperlink);
}

console.log('\n=== benign values are untouched ===');
{
  T('plain text is unchanged', sanitizeCsvCell('Acme Ltd') === 'Acme Ltd');
  T('an empty string stays empty', sanitizeCsvCell('') === '');
  T('null becomes an empty cell', sanitizeCsvCell(null) === '');
  T('undefined becomes an empty cell', sanitizeCsvCell(undefined) === '');
  T('a number is stringified', sanitizeCsvCell(42) === '42');
  T('a zero survives (it is falsy, not absent)', sanitizeCsvCell(0) === '0');
  T('a lowercase e-mail is unchanged', sanitizeCsvCell('a@b.example') === 'a@b.example');
  T("a '+' in the middle of a value is not a formula", sanitizeCsvCell('C++ dev') === 'C++ dev');
  T('an internal NUL byte is stripped', sanitizeCsvCell('a\u0000b') === 'ab');
  T('a lone minus is still neutralised (pinned behaviour)', sanitizeCsvCell('-') === "'-");
}

console.log('\n=== containsFormula reports import-side payloads ===');
{
  T('an equals payload is detected', containsFormula('=1+1'));
  T('a padded payload is detected', containsFormula('  =1+1'));
  T('a tabbed payload is detected', containsFormula('\t=1+1'));
  T('ordinary text is not detected', !containsFormula('Acme Ltd'));
  T('a mid-string equals is not detected', !containsFormula('a=b'));
  T('an empty string is not detected', !containsFormula(''));
}

console.log('\n=== quoting and row assembly ===');
{
  T('a comma forces quoting', csvNeedsQuoting('a,b'));
  T('a newline forces quoting', csvNeedsQuoting('a\nb'));
  T('a CR forces quoting', csvNeedsQuoting('a\rb'));
  T('ordinary text does not force quoting', !csvNeedsQuoting('a b'));
  T('a comma cell is quoted', csvCell('a,b') === '"a,b"', csvCell('a,b'));
  T('an embedded quote is doubled', csvCell('a"b') === '"a""b"', csvCell('a"b'));
  T('a neutralised formula is quoted when it also carries a comma',
    csvCell('=1,2') === `"'=1,2"`, csvCell('=1,2'));
  T('a row joins cells with commas', csvRow(['a', 'b', 'c']) === 'a,b,c');
}

console.log('\n=== round trip ===');
{
  const csv = toCsv(['name', 'note'], [['Acme Ltd', 'hello, world'], ['Globex', 'say "hi"']]);
  const parsed = parseCsv(csv);
  T('the header row round-trips', JSON.stringify(parsed[0]) === JSON.stringify(['name', 'note']), parsed[0]);
  T('a quoted comma round-trips', parsed[1]?.[1] === 'hello, world', parsed[1]);
  T('a doubled quote round-trips', parsed[2]?.[1] === 'say "hi"', parsed[2]);
  T('no phantom row is emitted for the trailing newline', parsed.length === 3, parsed.length);

  // Sanitisation is deliberately lossy: the apostrophe is what stops the
  // evaluation, so a re-imported export carries it. That is the contract.
  const dangerous = toCsv(['name'], [['=cmd|/c calc']]);
  T('the written cell is prefixed', dangerous.includes(`"'=cmd|/c calc"`) || dangerous.includes(`'=cmd|/c calc`), dangerous);
  T('re-parsing returns the neutralised text', parseCsv(dangerous)[1]?.[0] === "'=cmd|/c calc", parseCsv(dangerous)[1]);

  T('CRLF input parses', JSON.stringify(parseCsv('a,b\r\nc,d\r\n')) === JSON.stringify([['a', 'b'], ['c', 'd']]));
  T('a quoted newline stays inside the field',
    parseCsv('a,"line1\nline2"\n')[0]?.[1] === 'line1\nline2');
  T('an empty input is an empty file', parseCsv('').length === 0);
}

console.log('\n=== parser bounds and malformed input ===');
{
  T('a NUL byte is refused', throws(() => parseCsv('a\0b')));
  T('an unexpected quote is refused', throws(() => parseCsv('ab"cd"')));
  T('an unterminated quoted field is refused', throws(() => parseCsv('a,"open')));
  T('the column cap is enforced', throws(() => parseCsv('a,b,c', { maxCols: 2 })));
  T('the row cap is enforced', throws(() => parseCsv('a\nb\nc\n', { maxRows: 2 })));
  T('a file at the caps is accepted', parseCsv('a,b\nc,d\n', { maxCols: 2, maxRows: 2 }).length === 2);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
