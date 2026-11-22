import { QueryClient } from '@tanstack/react-query';

// Cache durations (staleTime) per data type. The API client already retries GETs during cold starts,
// so React Query's own retry is disabled to avoid multiplying requests.
export const STALE = {
  profile: 5 * 60_000,
  accounts: 2 * 60_000,
  campaigns: 30_000,
  dashboard: 45_000,
  stats: 30_000,
  config: 10 * 60_000,
  lists: 60_000,
  inbox: 30_000,
  admin: 30_000,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      placeholderData: (prev) => prev, // keep showing cached data while refetching (no flicker)
    },
    mutations: { retry: false },
  },
});

/** Invalidate the cached data affected by a change. */
export function invalidate(...keys) {
  keys.forEach((k) => queryClient.invalidateQueries({ queryKey: Array.isArray(k) ? k : [k] }));
}
