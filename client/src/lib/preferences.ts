import { api } from './api';

/**
 * The caller's own appearance preference.
 *
 * Kept apart from `workspace.ts` on purpose: that module is about the
 * organisation (members, invitations, views) and is gated by org permissions,
 * whereas this is a property of the person reading it. A viewer holds none of
 * those org permissions and must still be able to read and change this, so
 * merging the two would invite a permission check that does not belong here.
 *
 * No localStorage mirror. The account is the storage (see theme.tsx), and a
 * cached copy in the browser is precisely the thing that leaks one person's
 * choice to the next person at the same machine.
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