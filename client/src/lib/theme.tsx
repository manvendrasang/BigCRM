import {
 createContext,
 useCallback,
 useContext,
 useEffect,
 useMemo,
 useState,
} from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './auth';
import { fetchThemePreference, saveThemePreference } from './preferences';

/**
 * Appearance preference: explicit light, explicit dark, or follow the OS.
 *
 * The account owns this preference, not the browser. That is the whole point of
 * the design and it is worth stating why, because the previous implementation
 * used localStorage and looked fine to its author:
 *
 * * The login screen has to be neutral. With a browser-scoped preference, the
 *   page a stranger sees before authenticating is painted in whatever theme the
 *   last person left behind.
 * * The preference has to outlive the session. Closing the window signs you out
 *   (see sessionWindow.ts), so browser storage is the one thing that would
 *   survive a shared machine -- which is precisely what must not happen.
 *
 * So: `theme-init.js` paints **light** before the first frame regardless of what
 * was chosen before, and the stored preference is applied once the caller is
 * authenticated. On a fresh sign-in that is the requested sequence -- light, then
 * the account's own theme -- and a person who never chose anything simply keeps
 * light.
 *
 * The flip is applied without touching React's render path for unauthenticated
 * pages, so nothing about the theme depends on a network request succeeding.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/** What an account that never chose gets. Light, never the OS. */
export const DEFAULT_THEME = 'light';

interface ThemeContextValue {
 /** What the user chose. */
 preference: ThemePreference;
 /** What is actually on screen right now, with 'system' resolved. */
 resolved: 'light' | 'dark';
 setPreference: (next: ThemePreference) => void;
 /** Applies the account's stored preference. No write back. */
 applyAccountTheme: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyPreference(preference: ThemePreference): void {
 if (typeof document === 'undefined') return;
 const root = document.documentElement;
 if (preference === 'system') root.removeAttribute('data-theme');
 else root.setAttribute('data-theme', preference);
}

function systemPrefersDark(): boolean {
 return (
 typeof window !== 'undefined' &&
 typeof window.matchMedia === 'function' &&
 window.matchMedia('(prefers-color-scheme: dark)').matches
 );
}

function resolvedOf(preference: ThemePreference): 'light' | 'dark' {
 if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
 return preference;
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
 // Always light on first paint. `theme-init.js` has already written
 // `data-theme="light"`; this state exists so React agrees with the DOM instead
 // of correcting it a frame later.
 const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME);
 const [resolved, setResolved] = useState<'light' | 'dark'>(DEFAULT_THEME);

 const setPreferenceStateAndDom = useCallback((next: ThemePreference): void => {
  setPreferenceState(next);
  applyPreference(next);
  setResolved(resolvedOf(next));
 }, []);

 const setPreference = useCallback(
  (next: ThemePreference) => {
  setPreferenceStateAndDom(next);
  // The theme applies immediately; persistence is best effort. A failed write
  // costs the preference on the next sign-in and nothing else, so it must not
  // surface as an error the user has to dismiss to keep using the app.
  void saveThemePreference(next).catch(() => {});
  },
  [setPreferenceStateAndDom],
 );

 const applyAccountTheme = useCallback(
  (next: ThemePreference) => {
  setPreferenceStateAndDom(next);
  },
  [setPreferenceStateAndDom],
 );

 // Adopt whatever `theme-init.js` decided (light) so React state and the DOM
 // agree from the first render.
 useEffect(() => {
  applyPreference(DEFAULT_THEME);
  setResolved(DEFAULT_THEME);
 }, []);

 // Track OS changes only while 'system' is selected, so an explicit choice is
 // never overridden by the OS flipping at sunset.
 useEffect(() => {
  if (preference !== 'system') return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = (event: MediaQueryListEvent): void => {
  setResolved(event.matches ? 'dark' : 'light');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
 }, [preference]);

 const value = useMemo<ThemeContextValue>(
  () => ({ preference, resolved, setPreference, applyAccountTheme }),
  [preference, resolved, setPreference, applyAccountTheme],
 );

 return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
 const ctx = useContext(ThemeContext);
 if (ctx === null) throw new Error('useTheme must be used inside <ThemeProvider>.');
 return ctx;
}

/**
 * Applies the signed-in account's stored preference.
 *
 * Rendered inside the auth provider (which sits below the theme provider) so it
 * can watch the actor: light while signed out, the account's own theme once
 * there is somebody to attribute it to. It fetches on becoming authenticated
 * rather than on mount, so a signed-out visitor never makes a request they have
 * no permission to make.
 */
export function AccountTheme(): null {
 const { actor } = useAuth();
 const { applyAccountTheme } = useTheme();

 useEffect(() => {
  if (actor === null) return;
  let cancelled = false;
  void fetchThemePreference()
  .then((theme) => {
  if (!cancelled) applyAccountTheme(theme);
  })
  // A preference that cannot be fetched leaves the page light, which is the
  // documented default rather than a broken state.
  .catch(() => {});
  return () => {
  cancelled = true;
  };
 }, [actor, applyAccountTheme]);

 return null;
}