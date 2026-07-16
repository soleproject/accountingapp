/* Pre-paint bootstrap: runs synchronously before React hydrates so the
 * first frame already reflects the user's stored preferences. Reference
 * via next/script with strategy="beforeInteractive" in app/layout.tsx.
 *
 * Kept as an external file (not inline) so React 19 / Next 16 doesn't
 * emit the "script tag while rendering React component" warning that
 * inline <Script> children trigger.
 */
(function () {
  // Apply the dark-mode class on <html> before first paint so the page
  // doesn't flash light → dark for users with the dark preference saved
  // (or system-dark when no preference is set).
  try {
    var t = localStorage.getItem('rs_theme');
    var d =
      t === 'dark' ||
      (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (d) document.documentElement.classList.add('dark');
  } catch (e) {
    /* localStorage unavailable (Safari private mode etc.) — skip */
  }

  // Publish the persisted sidebar width as --rs-sidebar-w before paint
  // so pages that anchor layout to the sidebar's reserved width (e.g.
  // /ai-chat viewport-centering) don't jump on first render. Default is
  // the expanded width (224px) when no preference has been stored yet.
  try {
    var c = localStorage.getItem('rs_sidebar_collapsed') === '1';
    document.documentElement.style.setProperty(
      '--rs-sidebar-w',
      c ? '56px' : '224px',
    );
  } catch (e) {
    /* localStorage unavailable — fall back to CSS default */
  }
})();
