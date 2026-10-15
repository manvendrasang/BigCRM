import { useTheme } from '../lib/theme';
import type { ThemePreference } from '../lib/theme';

/**
 * Appearance switcher.
 *
 * A real `<select>` rather than a custom dropdown: it is keyboard accessible,
 * announced correctly by screen readers, and picks up the OS's own popup and
 * forced-colors treatment for free. Styling it away would cost all three.
 *
 * The glyphs are decorative -- the option text carries the meaning -- so the
 * control is hidden from assistive technology and the select carries the label.
 */
const OPTIONS: { value: ThemePreference; label: string; glyph: string }[] = [
 { value: 'light', label: 'Light', glyph: 'Sun' },
 { value: 'dark', label: 'Dark', glyph: 'Moon' },
 { value: 'system', label: 'System', glyph: '' },
];

export function ThemeSwitcher(): JSX.Element {
 const { preference, setPreference } = useTheme();
 const current = OPTIONS.find((o) => o.value === preference) ?? OPTIONS[0]!;

 return (
 <div className="theme-switcher">
 <span className="theme-switcher-glyph" aria-hidden="true">
 {current.glyph}
 </span>
 <label className="visually-hidden" htmlFor="theme-preference">
 Appearance
 </label>
 <select
 id="theme-preference"
 className="theme-switcher-select"
 value={preference}
 onChange={(e) => setPreference(e.target.value as ThemePreference)}
 >
 {OPTIONS.map((o) => (
 <option key={o.value} value={o.value}>
 {o.label}
 </option>
 ))}
 </select>
 </div>
 );
}