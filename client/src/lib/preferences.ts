import { api } from './api';

/**
 * The caller's own appearance preference.
 *
 * Separate from `workspace.ts` on purpose: that module is about the organisation
 * and is gated by org permissions, whereas a viewer holds none of those and
 * must still control their own theme. No localStorage mirror -- the account is
 * the storage, and a cached copy is exactly what leaks one person's choice to
 * the next person at the same machine.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

/** Unreadable or absent values fall back to light rather than failing the app. */
export const DEFAULT_THEME: ThemePreference = 'light';

function toPreference(value: unknown): ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
  ? (value as ThemePreference)
  : DEFAULT_THEME;
}

/** Reads the signed-in account's stored preference. */
export async function fetchThemePreference(): Promise<ThemePreference> {
  const body = await api.get<{ theme?: unknown }>('/auth/me/preferences');
  return toPreference(body?.theme);
}

/** Stores the preference so the next sign-in restores it. */
export async function saveThemePreference(theme: ThemePreference): Promise<ThemePreference> {
  const body = await api.put<{ theme?: unknown }>('/auth/me/preferences', { theme });
  return toPreference(body?.theme);
}