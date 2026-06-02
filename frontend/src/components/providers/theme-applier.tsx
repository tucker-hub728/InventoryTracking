'use client';

import { useEffect } from 'react';

import { useUIStore, selectAccentSoft } from '@/stores/ui.store';

/**
 * Syncs UI-store preferences (theme/density/accent) to the document.
 * Runs only after hydration so we don't fight the ThemeScript paint.
 */
export function ThemeApplier() {
  const theme = useUIStore((s) => s.theme);
  const density = useUIStore((s) => s.density);
  const accent = useUIStore((s) => s.accent);
  const accentSoft = useUIStore(selectAccentSoft);
  const hydrated = useUIStore((s) => s.hydrated);

  useEffect(() => {
    if (!hydrated) return;
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', density);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-soft', accentSoft);
  }, [theme, density, accent, accentSoft, hydrated]);

  return null;
}
