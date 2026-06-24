'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import {
  ACCENTS,
  DEFAULT_TWEAKS,
  softAccent,
  type Density,
  type LoginVariant,
  type SidebarVariant,
  type ThemeMode,
} from '@/config/theme';

interface UIState {
  theme: ThemeMode;
  accent: string;
  density: Density;
  sidebar: SidebarVariant;
  login: LoginVariant;
  hydrated: boolean;

  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setAccent: (accent: string) => void;
  setDensity: (density: Density) => void;
  setSidebar: (sidebar: SidebarVariant) => void;
  toggleSidebar: () => void;
  setLogin: (login: LoginVariant) => void;
  reset: () => void;
  _setHydrated: () => void;
}

/**
 * UI preferences store. Persisted to localStorage so theme/density survive
 * reload. Side-effects (writing to data-theme/data-density on document)
 * are handled by the ThemeApplier component, not the store, so SSR stays
 * pure.
 */
export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_TWEAKS,
      hydrated: false,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      setAccent: (accent) => set({ accent }),
      setDensity: (density) => set({ density }),
      setSidebar: (sidebar) => set({ sidebar }),
      toggleSidebar: () =>
        set({ sidebar: get().sidebar === 'icon' ? 'labeled' : 'icon' }),
      setLogin: (login) => set({ login }),
      reset: () => set({ ...DEFAULT_TWEAKS }),
      _setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'ims:ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        theme: s.theme,
        accent: s.accent,
        density: s.density,
        sidebar: s.sidebar,
        login: s.login,
      }),
      onRehydrateStorage: () => (state) => {
        state?._setHydrated();
      },
    },
  ),
);

/** Selector: resolve the soft accent for the current theme. */
export const selectAccentSoft = (s: UIState) => softAccent(s.accent, s.theme);

export { ACCENTS };
