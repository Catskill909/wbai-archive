/* Theme preference — applied BEFORE the first paint.
 *
 * Why this is its own file loaded synchronously in <head>, and not three lines
 * inside app.js:
 *
 *   1. app.js runs at the END of <body>. By then the page has already painted
 *      in whatever the *system* prefers, so a listener who chose light on a
 *      dark phone would see a dark flash on every single load. The choice has
 *      to land on <html> before the first paint, which means a blocking
 *      script in <head>.
 *   2. It can't be an inline <script>: server.js sends `script-src 'self'`
 *      (no 'unsafe-inline'), so the browser would refuse to run it — silently,
 *      as far as the layout is concerned, leaving the flash in place.
 *
 * It is deliberately tiny; it blocks the parser.
 *
 * The stylesheet defines the same token set four times — :root (dark default),
 * the prefers-color-scheme:light media query, and :root[data-theme="dark"|
 * "light"]. This file only decides whether that data-theme attribute is
 * present. No attribute => the media query decides => "follow the system",
 * which is the state everyone starts in.
 *
 * app.js's toggle drives everything through window.WBAITheme below, so the
 * read/apply logic exists exactly once.
 */
(function () {
  var KEY = 'wbai-theme';

  /* Browser-chrome tint per theme. These must stay equal to --surface-1 in
     styles.css (the appbar sits directly under the browser's own bar, and any
     difference between the two reads as a seam across the top of the screen). */
  var BAR = { dark: '#1c1615', light: '#ffffff' };

  /* The two <meta name="theme-color"> tags are media-scoped, which is exactly
     right while we're following the system and useless the moment someone
     overrides it — a forced-light page on a dark phone would keep the dark
     tint. So an override writes the SAME colour into both tags (whichever one
     the browser matches, it gets the right answer), and going back to "follow
     the system" restores what the HTML shipped with. */
  var metas = [].slice.call(document.querySelectorAll('meta[name="theme-color"]'));
  var metaDefaults = metas.map(function (m) { return m.getAttribute('content'); });

  function stored() {
    // Private mode / disabled storage throws on access, not on write.
    try {
      var v = localStorage.getItem(KEY);
      return (v === 'light' || v === 'dark') ? v : '';
    } catch (e) { return ''; }
  }

  function system() {
    return (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'dark';
  }

  // pref: 'light' | 'dark' | '' (empty = follow the system)
  function apply(pref) {
    if (pref) document.documentElement.setAttribute('data-theme', pref);
    else document.documentElement.removeAttribute('data-theme');
    metas.forEach(function (m, i) {
      m.setAttribute('content', pref ? BAR[pref] : metaDefaults[i]);
    });
  }

  function save(pref) {
    try {
      if (pref) localStorage.setItem(KEY, pref);
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }

  window.WBAITheme = {
    stored: stored,
    system: system,
    apply: apply,
    save: save,
    // What the listener is actually looking at right now.
    active: function () { return stored() || system(); }
  };

  apply(stored());
})();
