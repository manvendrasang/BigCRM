import { describe, it, expect } from 'vitest';
import { safeInternalPath, redirectTargetFrom, DASHBOARD_PATH } from './redirect';

describe('safeInternalPath', () => {
 it('accepts a plain root-relative path', () => {
 expect(safeInternalPath('/dashboard')).toBe('/dashboard');
 });

 it('preserves a query string', () => {
 expect(safeInternalPath('/contacts?page=2&sort=name')).toBe('/contacts?page=2&sort=name');
 });

 it('preserves a hash fragment', () => {
 expect(safeInternalPath('/deals#open')).toBe('/deals#open');
 });

 // The advisory this guards is an open redirect via protocol-relative forms.
 it('refuses a protocol-relative URL', () => {
 expect(safeInternalPath('//evil.example')).toBe(DASHBOARD_PATH);
 });

 it('refuses a backslash protocol-relative URL', () => {
 // `/\evil.example` is normalised to `//evil.example` by URL parsers.
 expect(safeInternalPath('/\\evil.example')).toBe(DASHBOARD_PATH);
 });

 it('refuses any backslash anywhere in the path', () => {
 expect(safeInternalPath('/a\\b')).toBe(DASHBOARD_PATH);
 });

 it('refuses an absolute URL', () => {
 expect(safeInternalPath('https://evil.example/steal')).toBe(DASHBOARD_PATH);
 });

 it('refuses a javascript: URL', () => {
 expect(safeInternalPath('javascript:alert(1)')).toBe(DASHBOARD_PATH);
 });

 it('refuses a data: URL', () => {
 expect(safeInternalPath('data:text/html,<script>')).toBe(DASHBOARD_PATH);
 });

 it('refuses a path that carries a scheme after the slash', () => {
 expect(safeInternalPath('/javascript:alert(1)')).toBe(DASHBOARD_PATH);
 });

 it('refuses a relative path with no leading slash', () => {
 expect(safeInternalPath('dashboard')).toBe(DASHBOARD_PATH);
 });

 it('refuses an empty or whitespace-only value', () => {
 expect(safeInternalPath('')).toBe(DASHBOARD_PATH);
 expect(safeInternalPath(' ')).toBe(DASHBOARD_PATH);
 });

 it('refuses a non-string', () => {
 expect(safeInternalPath(undefined)).toBe(DASHBOARD_PATH);
 expect(safeInternalPath(null)).toBe(DASHBOARD_PATH);
 expect(safeInternalPath({ toString: () => '/x' })).toBe(DASHBOARD_PATH);
 });

 it('refuses an over-long path', () => {
 expect(safeInternalPath(`/${'a'.repeat(4000)}`)).toBe(DASHBOARD_PATH);
 });

 it('refuses control characters that could split a header', () => {
 expect(safeInternalPath('/dash\nSet-Cookie: x=1')).toBe(DASHBOARD_PATH);
 expect(safeInternalPath('/dash\r\nLocation: https://evil.example')).toBe(DASHBOARD_PATH);
 });

 it('never returns a value that is not root-relative', () => {
 const hostile = [
 '//evil.example', '/\\evil.example', 'https://evil.example',
 'javascript:alert(1)', 'dashboard', '', '/a\\b', '/\r\nLocation: x',
 ];
 for (const candidate of hostile) {
 expect(safeInternalPath(candidate).startsWith('/')).toBe(true);
 expect(safeInternalPath(candidate).startsWith('//')).toBe(false);
 }
 });
});

describe('redirectTargetFrom', () => {
 it('uses a valid `from`', () => {
 expect(redirectTargetFrom({ from: '/contacts' })).toBe('/contacts');
 });

 it('replaces a hostile `from` with the dashboard', () => {
 expect(redirectTargetFrom({ from: '//evil.example' })).toBe(DASHBOARD_PATH);
 expect(redirectTargetFrom({ from: 'https://evil.example' })).toBe(DASHBOARD_PATH);
 });

 it('falls back when state is null or has no `from`', () => {
 expect(redirectTargetFrom(null)).toBe(DASHBOARD_PATH);
 expect(redirectTargetFrom(undefined)).toBe(DASHBOARD_PATH);
 expect(redirectTargetFrom({})).toBe(DASHBOARD_PATH);
 });

 it('ignores a `from` that is not a string', () => {
 expect(redirectTargetFrom({ from: ['/a', '/b'] })).toBe(DASHBOARD_PATH);
 expect(redirectTargetFrom({ from: { path: '/a' } })).toBe(DASHBOARD_PATH);
 });
});
