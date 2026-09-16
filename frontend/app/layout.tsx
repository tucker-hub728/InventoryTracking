import type { CSSProperties } from 'react';
import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';

import { siteConfig } from '@/config/site';
import {
  resolveDeploymentTier,
  tierFavicon,
  tierMarking,
  type DeploymentTier,
} from '@/config/deployment-tier';
import { AppProviders } from '@/components/providers/app-providers';
import { ThemeScript } from '@/components/providers/theme-script';

import './globals.css';

/**
 * The deployment tier, read per request. `connection()` is what makes that true:
 * without it Next may prerender this layout at BUILD time and freeze whatever
 * `DEPLOYMENT_TIER` the build machine had into every environment the image is
 * promoted to. See `config/deployment-tier.ts` for why this can't be build-time.
 */
async function currentTier(): Promise<DeploymentTier> {
  await connection();
  return resolveDeploymentTier(process.env.DEPLOYMENT_TIER);
}

export async function generateMetadata(): Promise<Metadata> {
  const tier = await currentTier();
  const marking = tierMarking(tier);
  // Marked tiers prefix every tab title, e.g. "[SANDBOX] Inventory · IMS" —
  // people switch environments by tab, before they look at the page.
  const prefix = marking ? `[${marking.label}] ` : '';
  const favicon = tierFavicon(tier);
  return {
    title: {
      default: `${prefix}${siteConfig.shortName} — ${siteConfig.name}`,
      template: `${prefix}%s · ${siteConfig.shortName}`,
    },
    description: siteConfig.description,
    applicationName: siteConfig.name,
    formatDetection: { telephone: false },
    // Production keeps the browser's default icon, exactly as before.
    ...(favicon ? { icons: { icon: favicon } } : {}),
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e10' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const tier = await currentTier();
  const marking = tierMarking(tier);
  // `data-tier` is the one hook every tier style keys off (globals.css); the
  // colour rides along as custom properties so it has a single definition.
  const tierStyle = marking
    ? ({ '--tier': marking.color, '--tier-fg': marking.onColor } as CSSProperties)
    : undefined;

  return (
    <html lang="en" data-tier={tier} style={tierStyle} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Fonts are loaded app-wide via <link> (with preconnect + display=swap)
            rather than next/font by design; the family names are referenced by
            the global stylesheet and Tailwind config. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {/* Sync theme before paint to prevent flash */}
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-bg text-text antialiased">
        <Suspense fallback={null}>
          <AppProviders tier={tier}>{children}</AppProviders>
        </Suspense>
      </body>
    </html>
  );
}
