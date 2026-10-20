import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import { api, ApiError, type Me, setCsrfToken } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (userName: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const r = await api.get<{ result: Me }>('/api/app/me');
        setCsrfToken(r.result.csrf_token);
        return r.result;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener('app:unauthorized', onUnauthorized);
    return () => window.removeEventListener('app:unauthorized', onUnauthorized);
  }, [qc]);

  const login = useCallback(
    async (userName: string, password: string) => {
      const r = await api.post<{ result: { csrf_token: string } }>('/api/app/auth/login', { user_name: userName, password });
      setCsrfToken(r.result.csrf_token);
      const me = (await api.get<{ result: Me }>('/api/app/me')).result;
      // Drop data cached for the previous identity, but keep the observed `me` query alive.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], me);
      return me;
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/app/auth/logout');
    } finally {
      setCsrfToken(null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const me = meQuery.data ?? null;
    return {
      me,
      loading: meQuery.isLoading,
      login,
      logout,
      hasRole: (role: string) => !!me && (me.is_admin || me.roles.includes(role)),
    };
  }, [meQuery.data, meQuery.isLoading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
