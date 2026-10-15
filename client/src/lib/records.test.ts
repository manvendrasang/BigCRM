/**
 * Records client tests.
 *
 * These lock in the two properties that would silently break every record
 * screen: that list responses preserve `pageInfo` (the default unwrap drops
 * it, which is why `listRecords` uses `raw: true`), and that the display
 * formatters degrade to an em dash on missing or mistyped fields rather than
 * throwing — because the server may add, rename, or drop a column without a
 * coordinated client deploy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { field, listRecords, money, shortDate } from './records';
import { resetApiClient, setFetchImplementation } from './api';

afterEach(() => {
  resetApiClient();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listRecords', () => {
  it('preserves pageInfo from the list envelope', async () => {
    const seen: string[] = [];
    setFetchImplementation(async (url) => {
      seen.push(url);
      return jsonResponse({
        data: [{ id: 'a' }, { id: 'b' }],
        pageInfo: { limit: 25, offset: 0, totalCount: 400, hasMore: true },
      });
    });

    const result = await listRecords('contacts', { limit: 25, offset: 0 });

    expect(result.data).toHaveLength(2);
    expect(result.pageInfo.totalCount).toBe(400);
    expect(result.pageInfo.hasMore).toBe(true);
    expect(seen[0]).toContain('/contacts?');
    expect(seen[0]).toContain('limit=25');
  });

  it('sends the free-text query only when non-blank', async () => {
    const seen: string[] = [];
    setFetchImplementation(async (url) => {
      seen.push(url);
      return jsonResponse({ data: [], pageInfo: { limit: 25, offset: 0, totalCount: 0, hasMore: false } });
    });

    await listRecords('contacts', { q: '  ' });
    expect(seen[0]).not.toContain('q=');

    await listRecords('contacts', { q: 'ada' });
    expect(seen[1]).toContain('q=ada');
  });

  it('degrades to an empty list when the envelope is malformed', async () => {
    setFetchImplementation(async () => jsonResponse({ data: null, pageInfo: null }));
    const result = await listRecords('contacts');
    expect(result.data).toEqual([]);
    expect(result.pageInfo.totalCount).toBe(0);
  });
});

describe('field', () => {
  it('renders strings, numbers and booleans', () => {
    expect(field({ a: 'x' }, 'a')).toBe('x');
    expect(field({ a: 42 }, 'a')).toBe('42');
    expect(field({ a: false }, 'a')).toBe('false');
  });

  it('renders an em dash for missing, null, or empty values', () => {
    expect(field({}, 'a')).toBe('—');
    expect(field({ a: null }, 'a')).toBe('—');
    expect(field({ a: '' }, 'a')).toBe('—');
    expect(field(null, 'a')).toBe('—');
    expect(field('not-an-object', 'a')).toBe('—');
  });

  it('renders an em dash for objects and arrays rather than [object Object]', () => {
    expect(field({ a: { nested: 1 } }, 'a')).toBe('—');
    expect(field({ a: [1, 2] }, 'a')).toBe('—');
  });
});

describe('money', () => {
  it('formats integer cents as currency', () => {
    expect(money(12345, 'USD')).toBe('$123.45');
  });

  it('renders an em dash for non-numbers', () => {
    expect(money(null)).toBe('—');
    expect(money('12345')).toBe('—');
    expect(money(NaN)).toBe('—');
  });
});

describe('shortDate', () => {
  it('renders ISO timestamps as short dates', () => {
    const out = shortDate('2026-10-11T00:00:00.000Z');
    expect(out).toContain('2026');
  });

  it('renders an em dash for blank input and passes through the unparseable', () => {
    expect(shortDate('')).toBe('—');
    expect(shortDate(null)).toBe('—');
    expect(shortDate('not-a-date')).toBe('not-a-date');
  });
});
