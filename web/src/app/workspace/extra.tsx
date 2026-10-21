import type { RouteObject } from 'react-router';
import { ChangeSchedulePage } from './ChangeSchedule';
import { CmdbHealthPage, CmdbMapPage } from './Cmdb';
import { DashboardsPage } from './Dashboards';
import { ScriptsPage } from './Scripts';

/**
 * Module-specific workspace pages (change schedule, CMDB map, dashboards, admin tools...).
 * Each entry is a child route of /workspace.
 */
export const workspaceExtraRoutes: RouteObject[] = [
  { path: 'dashboards', element: <DashboardsPage /> },
  { path: 'change-schedule', element: <ChangeSchedulePage /> },
  { path: 'cmdb/health', element: <CmdbHealthPage /> },
  { path: 'cmdb/map/:id', element: <CmdbMapPage /> },
  { path: 'admin/scripts', element: <ScriptsPage /> },
];
