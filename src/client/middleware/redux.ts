/**
 * Redux middleware that captures dispatched actions with timing and state diffs.
 */

import { ClientBuffer } from '../client-buffer.js';

export interface ReduxStore {
  getState(): unknown;
  dispatch(action: unknown): unknown;
  __metroMcpMiddleware?: unknown;
}

export interface ReduxAction {
  type: string;
  timestamp: number;
  payload?: unknown;
  duration?: number;
}

export function createReduxMiddleware() {
  const actions = new ClientBuffer<ReduxAction>(200);

  const middleware = (store: { getState: () => unknown }) => (next: (action: unknown) => unknown) => (action: unknown) => {
    const start = Date.now();
    const actionObj = action as Record<string, unknown>;

    const entry: ReduxAction = {
      type: (actionObj?.type as string) || 'UNKNOWN',
      timestamp: start,
      payload: actionObj?.payload,
    };

    const result = next(action);
    entry.duration = Date.now() - start;
    actions.push(entry);

    return result;
  };

  return { middleware, actions };
}
