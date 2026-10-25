// UI preferences, kept in localStorage. Nothing here is sensitive.

const KEY = 'bw.settings.v1';

const DEFAULTS = {
  theme: null, // 'light' | 'sepia' | 'dark'; null follows the operating system
  layout: 'single', // 'single' | 'spread' | 'continuous'
  zoom: 'smart', // 'smart' | 'page-fit' | 'page-width' | 'page-actual'
  sort: 'recent', // 'recent' | 'title' | 'modified' | 'size'
  sidebar: false,
  sidebarTab: 'contents', // 'contents' | 'pages'
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export const settings = {
  get(key) {
    return load()[key];
  },
  set(key, value) {
    load()[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* private mode or storage full: the setting lasts for this session only */
    }
  },
};

export const THEMES = ['light', 'sepia', 'dark'];
export const THEME_LABELS = { light: 'Light', sepia: 'Sepia', dark: 'Dark' };

export function currentTheme() {
  const saved = settings.get('theme');
  if (THEMES.includes(saved)) return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme = currentTheme()) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

export function setTheme(theme) {
  settings.set('theme', theme);
  applyTheme(theme);
}

export function nextTheme() {
  return THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
}
