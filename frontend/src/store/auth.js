import { create } from 'zustand';
import { ApiError, post, refreshSession, setAccessToken, setOnAuthLost } from '../api/client.js';
import { useConnection } from './connection.js';
import { queryClient } from '../lib/query.js';

export const useAuth = create((set, get) => ({
  user: null,
  status: 'loading', // loading | authenticated | anonymous

  // Restores the session on page load. While the backend is cold-starting the refresh call can fail with a
  // network error or 5xx — keep retrying (with backoff) instead of logging the user out.
  async bootstrap() {
    const conn = useConnection.getState();
    for (let i = 0; i < 7; i += 1) {
      try {
        const data = await refreshSession();
        conn.setStatus('online');
        set({ user: data.user, status: 'authenticated' });
        return;
      } catch (err) {
        const cold = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
        if (!cold) {
          conn.setStatus('online');
          set({ user: null, status: 'anonymous' });
          return;
        }
        conn.setStatus('waking', i + 1);
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** i)));
      }
    }
    conn.setStatus('offline');
    set({ user: null, status: 'anonymous' });
  },

  /** Step 1. Returns { user } when signed in, or { otp: { challengeId, email, resendIn } } when a code was emailed. */
  async login(email, password, remember = true) {
    const data = await post('/api/auth/login', { email, password, remember }, { idempotent: true });
    if (data.otpRequired) return { otp: { challengeId: data.challengeId, email: data.email, resendIn: data.resendIn } };
    get().setSession(data);
    return { user: data.user };
  },

  /** Step 2 (email OTP). */
  async verifyOtp(challengeId, code) {
    const data = await post('/api/auth/login/verify', { challengeId, code });
    get().setSession(data);
    return data.user;
  },

  setSession(data) {
    setAccessToken(data.accessToken);
    queryClient.clear();
    set({ user: data.user, status: 'authenticated' });
  },

  setUser(user) { set({ user }); },

  async logout() {
    try { await post('/api/auth/logout'); } catch { /* ignore */ }
    get().clearSession();
  },

  clearSession() {
    setAccessToken(null);
    queryClient.clear();
    set({ user: null, status: 'anonymous' });
  },
}));

setOnAuthLost(() => useAuth.getState().clearSession());
