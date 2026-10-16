/* BigCRM theme bootstrap.
 *
 * Runs synchronously in <head> so the theme is decided before the first paint --
 * otherwise the page flashes one colour and then corrects itself.
 *
 * It always paints LIGHT. The account's stored preference is applied later, by
 * React, once the caller is authenticated (see src/lib/theme.tsx). That ordering
 * is deliberate and is the whole reason this file no longer reads the stored
 * theme:
 *
 *  * The preference belongs to the account, not to the browser. A browser-scoped
 *    value would paint the login screen in whatever theme the last person at
 *    this machine left behind -- the one place a stranger is guaranteed to be
 *    looking.
 *  * The session ends with the window (src/lib/sessionWindow.ts), so browser
 *    storage is the only thing that would survive on a shared desk. It must not
 *    be the thing that does.
 *
 * The cost is honest and accepted: a dark-theme user sees light for the moment
 * between page load and sign-in. That is the behaviour that was asked for, and
 * it is the safer default for a shared screen.
 *
 * This is a separate file rather than an inline <script> because the app's CSP
 * is `script-src 'self'`: an inline script would be blocked, and weakening the
 * policy to allow one is not an acceptable trade for a theming feature.
 *
 * It contains no credentials and touches only `data-theme` on <html>. */

(function () {
 var root = document.documentElement;
 // Light unless React says otherwise. `system` is represented later by the
 // ABSENCE of `data-theme`, which lets the token layer resolve it through
 // `prefers-color-scheme`; that stays a single source of truth in CSS.
 root.setAttribute('data-theme', 'light');
})();