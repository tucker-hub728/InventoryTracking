/**
 * Curated accent palette. `soft` is the tinted background for pills/hover
 * in light mode; `softDark` is the analogous dim tint for dark mode.
 */
export interface AccentDefinition {
  value: string;
  soft: string;
  softDark: string;
  label: string;
}

export const ACCENTS: readonly AccentDefinition[] = [
  { value: '#2547d0', soft: '#eef1fb', softDark: '#1c2440', label: 'Indigo' },
  { value: '#15803d', soft: '#ecfdf5', softDark: '#11261b', label: 'Forest' },
  { value: '#374151', soft: '#f3f4f6', softDark: '#222730', label: 'Slate' },
  { value: '#9333ea', soft: '#f5f0ff', softDark: '#2a1a3d', label: 'Plum' },
  { value: '#b45309', soft: '#fef3c7', softDark: '#3a2510', label: 'Amber' },
] as const;

export type ThemeMode = 'light' | 'dark';
export type Density = 'compact' | 'regular';
export type SidebarVariant = 'labeled' | 'icon';
export type LoginVariant = 'split' | 'centered';

export const DEFAULT_TWEAKS = {
  theme: 'light' as ThemeMode,
  accent: ACCENTS[0]!.value,
  density: 'compact' as Density,
  sidebar: 'labeled' as SidebarVariant,
  login: 'split' as LoginVariant,
} as const;

export function softAccent(hex: string, theme: ThemeMode): string {
  const match = ACCENTS.find((a) => a.value === hex);
  if (!match) return theme === 'dark' ? '#1c2440' : '#eef1fb';
  return theme === 'dark' ? match.softDark : match.soft;
}
