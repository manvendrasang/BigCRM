/* BigCRM theme bootstrap.
 *
 * Runs synchronously in <head> so the stored theme is applied before the first
 * paint — otherwise a dark-mode user sees a white flash on every navigation.
 *
 * This is a separate file rather than an inline <script> because the app's CSP
 * is `script-src 'self'`: an inline script would be blocked, and weakening the
 * policy to allow one is not an acceptable trade for a theming feature.
 *
 * It contains no credentials and touches only `data-theme` on <html>. */

(function () {
  var KEY = 'bigcrm.theme';
  var root = document.documentElement;
  try {
    var stored = window.localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') {
      root.setAttribute('data-theme', stored);
    } else if (stored === 'system') {
      // Explicit OS-following: leave data-theme absent for the token layer.
    } else {
      // Nothing stored: the default is light, not the OS.
      root.setAttribute('data-theme', 'light');
    }
  } catch (e) {
    // Private browsing or a blocked storage partition: fall back to light
    // rather than failing to render.
  }
})();