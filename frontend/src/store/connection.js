import { create } from 'zustand';

// 'online'  — last request succeeded
// 'waking'  — backend/database is cold-starting (Render Free sleep / Neon suspend); requests are being retried
// 'offline' — repeated failures; the UI stays usable with cached data
export const useConnection = create((set) => ({
  status: 'online',
  attempt: 0,
  lastOkAt: null,
  setStatus: (status, attempt = 0) => set((s) => ({ status, attempt, lastOkAt: status === 'online' ? Date.now() : s.lastOkAt })),
}));
