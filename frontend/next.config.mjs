/** @type {import('next').NextConfig} */

// ── Content-Security-Policy ──────────────────────────────────────────────
// Built as a list so each source has a reason next to it. The directive that
// actually closes the reported finding is `frame-ancestors 'none'` (plus the
// X-Frame-Options belt-and-braces below): without it the Part 11 signing
// dialogs can be framed by a hostile page and UI-redressed into authorising
// an e-signature the operator never intended to give.
//
// NOTE on 'unsafe-inline' in script-src: Next's App Router inlines its
// hydration bootstrap, and removing this needs per-request nonces, which
// need middleware to rewrite the header on every response. That is a real
// change with its own risk, so it is deliberately NOT bundled into this
// hardening pass — see the note in the security remediation summary.
// 'unsafe-eval' is dev-only (React Refresh); production drops it.
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  // Tailwind injects inline <style>; Google Fonts serves the stylesheet.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  // fonts.gstatic.com serves the IBM Plex woff2 files (app/layout.tsx).
  "font-src 'self' https://fonts.gstatic.com data:",
  // data: — the signature pad's canvas.toDataURL('image/png') preview.
  // blob: — object URLs used when handing the signature blob to the upload.
  "img-src 'self' data: blob:",
  // Same-origin only: the browser talks to the BFF, never to the backend.
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Redundant with frame-ancestors for modern browsers, kept for older ones.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
];

// HSTS only in production. Sending it from a dev http:// origin is at best
// ignored and at worst pins localhost to https for two years.
if (!isDev) {
  securityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  });
}

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
