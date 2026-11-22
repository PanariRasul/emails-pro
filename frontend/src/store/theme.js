import { create } from 'zustand';

const KEY = 'ep-theme';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const read = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
const resolve = (mode) => (mode === 'system' ? (media?.matches ? 'dark' : 'light') : mode);

function apply(mode) {
  const r = resolve(mode);
  document.documentElement.classList.toggle('dark', r === 'dark');
  return r;
}

export const useTheme = create((set, get) => ({
  mode: read(),
  resolved: resolve(read()),
  setMode(mode) {
    try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
    set({ mode, resolved: apply(mode) });
  },
  toggle() { get().setMode(get().resolved === 'dark' ? 'light' : 'dark'); },
}));

media?.addEventListener?.('change', () => {
  const { mode } = useTheme.getState();
  if (mode === 'system') useTheme.setState({ resolved: apply('system') });
});
