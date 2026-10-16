/**
 * Per-account appearance preference.
 *
 * One column, three values, one caller. It is deliberately its own module
 * rather than a field on the org service: the theme is a property of the person,
 * it is cosmetic, and it carries no authority -- nothing in this file touches
 * roles, sessions or audit-relevant state.
 *
 * Why server-side at all, given localStorage would have been less work:
 *
 * * The login screen must paint light for whoever is standing at the machine,
 *   not in whatever theme the last person left behind. A browser-scoped
 *   preference cannot express that, because the person who left it may not be
 *   the person arriving.
 * * The preference has to survive the logout-on-window-close behaviour: with a
 *   session that dies with the tab, localStorage is the only thing that would
 *   still be around, and it is the one thing that must NOT survive a shared
 *   machine.
 *
 * So the account is the storage, `light` is the default for anyone who never
 * chose, and the client applies it only once the caller is authenticated.
 */
import { initDriver } from '../repositories/base.ts';
import { validationFailed } from '../lib/errors.ts';
import type { ActorRef } from './records.ts';

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The value used by an account that never chose: light, never the OS. */
export const DEFAULT_THEME: ThemePreference = 'light';

export function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === 'string' && (THEME_PREFERENCES as readonly string[]).includes(v);
}

/**
 * Reads the caller's preference. Unknown/missing values collapse to
 * `DEFAULT_THEME` rather than throwing: a preference that cannot be understood
 * must never be the reason a user cannot sign in or load a page.
 */
export async function getThemePreference(actor: ActorRef): Promise<ThemePreference> {
  const db = await initDriver();
  const r = await db.query<{ theme_preference: string }>(
    'SELECT theme_preference FROM users WHERE id = $1',
    [actor.userId],
  );
  const value = r.rows[0]?.theme_preference;
  return isThemePreference(value) ? value : DEFAULT_THEME;
}

/**
 * Stores the caller's preference.
 *
 * No audit row: the audit log exists to reconstruct who changed what and
 * whether it was allowed. A theme grants nothing, reveals nothing, and cannot
 * be replayed for access, so writing one would add a row nobody ever reads and
 * make the audit table noisier for every real change. The write is still
 * tenant-bound through `organization_members`: `users` carries no
 * `organization_id`, so the membership row is what proves the target belongs to
 * the caller's organization, and a foreign user id matches nothing.
 */
export async function setThemePreference(
  actor: ActorRef,
  preference: ThemePreference,
): Promise<{ theme: ThemePreference }> {
  if (!isThemePreference(preference)) {
    throw validationFailed({ theme: 'Choose light, dark, or system.' });
  }
  const db = await initDriver();
  const r = await db.query<{ theme_preference: string }>(
    `UPDATE users SET theme_preference = $1, updated_at = now()
     WHERE id = $2 AND deleted_at IS NULL
     AND EXISTS (
      SELECT 1 FROM organization_members m
      WHERE m.user_id = users.id AND m.organization_id = $3
     )
     RETURNING theme_preference`,
    [preference, actor.userId, actor.organizationId],
  );
  if (!r.rows[0]) {
    // Only reachable if the session outlived the account (deleted mid-request),
    // or the target is not a member of this organization.
    throw validationFailed({ theme: 'Account not found.' });
  }
  return { theme: r.rows[0].theme_preference as ThemePreference };
}