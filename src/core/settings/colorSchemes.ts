// Every color scheme the UI offers. Adding one means adding an entry here and a matching
// `[data-scheme='<id>']` block of CSS variables in `app/globals.css`; the selection UI reads this list.
export interface ColorScheme {
  id: string;
  label: string;
  // The three main colors (the `--bg`, `--text` and `--primary` variables) shown to identify the scheme.
  colors: { bg: string; text: string; primary: string };
}

export const COLOR_SCHEMES = [
  { id: 'dark', label: 'Dark', colors: { bg: '#0c0d0f', text: '#f3f4f5', primary: '#f3f4f5' } },
  { id: 'light', label: 'Light', colors: { bg: '#ffffff', text: '#1f2328', primary: '#1f2328' } },
] as const satisfies readonly ColorScheme[];

export type ColorSchemeId = (typeof COLOR_SCHEMES)[number]['id'];

export const DEFAULT_COLOR_SCHEME: ColorSchemeId = 'dark';

export function isColorSchemeId(value: unknown): value is ColorSchemeId {
  return COLOR_SCHEMES.some((scheme) => scheme.id === value);
}

// A user's own choice wins over the application default; an unknown or missing value falls through.
export function resolveColorScheme(userChoice: unknown, applicationDefault: unknown): ColorSchemeId {
  if (isColorSchemeId(userChoice)) return userChoice;
  return isColorSchemeId(applicationDefault) ? applicationDefault : DEFAULT_COLOR_SCHEME;
}
