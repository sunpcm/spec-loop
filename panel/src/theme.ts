export type PanelTheme = 'light' | 'dark';

export interface PanelThemeSelection {
  theme: PanelTheme;
  followsSystem: boolean;
}

const THEME_STORAGE_KEY = 'spec-loop-panel-theme-v1';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isPanelTheme(value: unknown): value is PanelTheme {
  return value === 'light' || value === 'dark';
}

export function readStoredPanelTheme(): PanelTheme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPanelTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function getSystemPanelTheme(): PanelTheme {
  try {
    return window.matchMedia?.(LIGHT_QUERY).matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function readPanelThemeSelection(): PanelThemeSelection {
  const stored = readStoredPanelTheme();
  return stored
    ? { theme: stored, followsSystem: false }
    : { theme: getSystemPanelTheme(), followsSystem: true };
}

export function applyPanelTheme(theme: PanelTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function persistPanelTheme(theme: PanelTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A denied storage API must not block the in-memory theme toggle.
  }
}

export function subscribeToSystemTheme(
  listener: (theme: PanelTheme) => void,
): () => void {
  try {
    const media = window.matchMedia(LIGHT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      listener(event.matches ? 'light' : 'dark');
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  } catch {
    return () => undefined;
  }
}

export function initializePanelTheme(): PanelThemeSelection {
  const selection = readPanelThemeSelection();
  applyPanelTheme(selection.theme);
  return selection;
}
