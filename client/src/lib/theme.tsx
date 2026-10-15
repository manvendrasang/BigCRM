import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

/**
 * Appearance preference: explicit light, explicit dark, or follow the OS.
 *
 * The default (nothing stored) is **light**. 'system' remains a choice for
 * users who want OS-following, but a fresh office machine opens a light CRM.
 * 'system' is represented by the ABSENCE of `data-theme` on <html>, which lets
 * the token layer resolve it through `prefers-color-scheme`. That keeps one
 * source of truth — CSS — rather than duplicating the media query in JS.
 *
 * `theme-init.js` has already applied the stored value before first paint, so
 * this provider starts from whatever is on <html> rather than re-reading
 * storage and risking a visible flip.
 *
 * This preference is cosmetic. It is persisted to localStorage, never sent to
 * the API, and switching it triggers no network request and touches no record.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'bigcrm.theme';

interface ThemeContextValue {
  /** What the user chose. */
  preference: ThemePreference;
  /** What is actually on screen right now, with 'system' resolved. */
  resolved: 'light' | 'dark';
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Storage unavailable (private mode, blocked partition). Fall through.
  }
  // No stored choice: light, not the OS. Office machines with a dark OS would
  // otherwise open a dark CRM nobody asked for.
  return 'light';
}

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

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    systemPrefersDark() ? 'dark' : 'light',
  );

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    applyPreference(next);
    setResolved(next === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal: the theme still applies for this page view.
    }
  }, []);

  // Adopt whatever theme-init.js already decided, so React state and the DOM
  // agree from the first render rather than correcting a frame later.
  useEffect(() => {
    applyPreference(preference);
    setResolved(preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference);
    // Runs once on mount: `preference` is captured deliberately so a later OS
    // change never rewrites the user's stored choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return ctx;
}