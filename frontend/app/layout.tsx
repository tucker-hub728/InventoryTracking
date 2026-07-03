import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';

import { siteConfig } from '@/config/site';
import { AppProviders } from '@/components/providers/app-providers';
import { ThemeScript } from '@/components/providers/theme-script';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.shortName} — ${siteConfig.name}`,
    template: `%s · ${siteConfig.shortName}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e10' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          no-page-custom-font targets the Pages Router (pages/_document.js). This
          is the App Router root layout, so this <link> loads globally for every
          page — the rule's "single page only" premise doesn't apply here.
        */}
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
          <AppProviders>{children}</AppProviders>
        </Suspense>
      </body>
    </html>
  );
}
