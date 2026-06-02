/**
 * Inline script that runs synchronously in <head> before paint, so we can
 * apply the persisted theme/density/accent without flicker.
 *
 * Mirrors the Zustand `ims:ui` persist key shape. Kept tiny intentionally.
 */
const script = `(function(){try{
  var raw = localStorage.getItem('ims:ui');
  var st = raw ? JSON.parse(raw).state : null;
  var theme = (st && st.theme) || 'light';
  var density = (st && st.density) || 'compact';
  var accent = (st && st.accent) || '#2547d0';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-density', density);
  document.documentElement.style.setProperty('--accent', accent);
}catch(_){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
