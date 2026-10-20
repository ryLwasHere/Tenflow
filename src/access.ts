import type { Role } from './state';

// Single source for who may open which page. This is a UI guard only: the app has no backend, so nothing here is a
// security boundary (anyone with the browser can edit localStorage). Real enforcement needs server-side authorization.
export const ROUTE_ROLES: Record<string, Role[]> = {
  '/proses': ['hr', 'admin'],
  '/dashboard': ['hr', 'admin'],
  '/config': ['admin'],
};

export const canAccess = (role: Role | undefined, path: string): boolean => !!role && (ROUTE_ROLES[path]?.includes(role) ?? false);
