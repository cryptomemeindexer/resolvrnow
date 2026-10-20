import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router';
import './styles.css';
import { LoginPage } from './app/Login';
import { PortalRoutes } from './app/portal/routes';
import { WorkspaceHome } from './app/workspace/Home';
import { ListPage } from './app/workspace/ListPage';
import { RecordPage } from './app/workspace/RecordPage';
import { WorkspaceShell } from './app/workspace/Shell';
import { workspaceExtraRoutes } from './app/workspace/extra';
import { Loading, ToastProvider } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { initTheme } from './lib/theme';

initTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

function RequireAuth({ children, agent }: { children: ReactNode; agent?: boolean }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Starting ResolvrNow…" />;
  if (!me) return <Navigate to="/login" state={{ from: `${location.pathname}${location.search}` }} replace />;
  if (agent && !me.is_agent && !me.is_admin) return <Navigate to="/portal" replace />;
  return <>{children}</>;
}

function RootRedirect() {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={me.is_agent || me.is_admin ? '/workspace' : '/portal'} replace />;
}

const router = createBrowserRouter([
  { path: '/', element: <RootRedirect /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/workspace',
    element: (
      <RequireAuth agent>
        <WorkspaceShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <WorkspaceHome /> },
      { path: 'list/:table', element: <ListPage /> },
      { path: 'record/:table/:sysId', element: <RecordPage /> },
      ...workspaceExtraRoutes,
    ],
  },
  {
    path: '/portal/*',
    element: (
      <RequireAuth>
        <PortalRoutes />
      </RequireAuth>
    ),
  },
  { path: '*', element: <RootRedirect /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
