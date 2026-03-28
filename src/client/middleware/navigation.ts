/**
 * React Navigation event tracking.
 */

import { ClientBuffer } from '../client-buffer.js';

export interface NavigationRef {
  current?: {
    getRootState: () => unknown;
    addListener?: (event: string, handler: (e: unknown) => void) => () => void;
  };
  addListener?: (event: string, handler: (e: unknown) => void) => () => void;
}

export interface NavigationEvent {
  timestamp: number;
  type: string;
  routeName?: string;
  params?: unknown;
}

export function createNavigationTracking(navigationRef: NavigationRef) {
  const events = new ClientBuffer<NavigationEvent>(100);

  function getState(): unknown {
    try {
      return navigationRef.current?.getRootState?.() || null;
    } catch {
      return null;
    }
  }

  // Try to listen for state changes
  const addListener = navigationRef.addListener || navigationRef.current?.addListener;
  if (addListener) {
    try {
      addListener('state', (e: unknown) => {
        const state = getState() as Record<string, unknown> | null;
        if (state?.routes) {
          const routes = state.routes as Array<Record<string, unknown>>;
          const index = (state.index as number) ?? routes.length - 1;
          const currentRoute = routes[index];
          events.push({
            timestamp: Date.now(),
            type: 'state_change',
            routeName: currentRoute?.name as string,
            params: currentRoute?.params,
          });
        }
      });
    } catch {
      // Navigation listener not available
    }
  }

  return { events, getState };
}
