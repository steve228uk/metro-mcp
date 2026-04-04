# Client SDK

The client SDK is an **optional** dev dependency for enhanced features like real-time Redux action tracking, navigation events, and performance marks. Most metro-mcp features work without it.

::: tip SDK moved to metro-bridge
The app-side SDK is now published as part of [`metro-bridge`](https://www.npmjs.com/package/metro-bridge). Install `metro-bridge` in your React Native app instead of `metro-mcp`.
:::

## Without the SDK

You can register commands and expose custom state directly on a global — no package needed:

```typescript
// In your app entry point (dev only)
if (__DEV__) {
  globalThis.__METRO_BRIDGE__ = {
    commands: {
      login: async ({ email, password }) => {
        return await authService.login(email, password);
      },
      resetOnboarding: () => {
        AsyncStorage.removeItem('onboarding_completed');
      },
      switchUser: ({ userId }) => {
        store.dispatch(switchUser(userId));
      },
    },
    state: {
      userStore: () => useUserStore.getState(),
    },
  };
}
```

## With the SDK

Install as a dev dependency:

```bash
npm install --save-dev metro-bridge
# or
yarn add --dev metro-bridge
# or
bun add -d metro-bridge
```

```typescript
import { MetroBridgeClient } from 'metro-bridge/client';

if (__DEV__) {
  const mcp = new MetroBridgeClient();

  // Custom commands
  mcp.registerCommand('login', async ({ email, password }) => {
    return await authService.login(email, password);
  });

  // Redux middleware (real-time action tracking)
  mcp.useReduxMiddleware(store);

  // Navigation events
  mcp.useNavigationTracking(navigationRef);

  // Performance marks
  mcp.mark('app_init');
  // ...later...
  mcp.mark('app_ready');
  mcp.measure('startup', 'app_init', 'app_ready');

  // Structured logs with channels
  mcp.log('auth', { event: 'login_success', userId: '123' });

  // State subscriptions (Zustand, Jotai, MobX, etc.)
  mcp.subscribeState('userStore', () => useUserStore.getState());

  // Lifecycle events (foreground/background/deep links)
  mcp.trackLifecycle();
}
```

## Standalone command registration

If you only need custom commands without the full SDK:

```typescript
import { registerCommand } from 'metro-bridge/client';

if (__DEV__) {
  registerCommand('login', async ({ email, password }) => {
    return await authService.login(email, password);
  });
}
```
