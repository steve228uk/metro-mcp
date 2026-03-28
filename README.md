# metro-mcp

A plugin-based MCP server for React Native runtime debugging, inspection, and automation. Connects to Metro bundler via Chrome DevTools Protocol — **no app code changes needed** for most features.

Works with **Expo**, **bare React Native**, and any project using **Metro + Hermes**.

## Quick Start

### Claude Code

```bash
claude mcp add metro-mcp -- bunx metro-mcp
```

### Cursor / VS Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "metro-mcp": {
      "command": "bunx",
      "args": ["metro-mcp"]
    }
  }
}
```

### With custom Metro port

```bash
claude mcp add metro-mcp -- bunx metro-mcp --port 19000
```

## Requirements

- **Bun** 1.0+ (runtime)
- **iOS**: Xcode 14+ with Simulator (`xcrun simctl` is used for most operations)
- **Android**: Android SDK with `adb` on your PATH
- **IDB** *(optional)*: Some iOS operations fall back to [IDB (idb-companion)](https://github.com/facebook/idb) — install with `brew install idb-companion`. Tools will tell you when IDB is needed and how to install it.

## How It Works

metro-mcp connects to your running Metro dev server the same way Chrome DevTools does:

1. Discovers Metro via port scanning (8081, 8082, 19000-19002)
2. Connects to Hermes via Chrome DevTools Protocol (CDP)
3. Streams console logs, network requests, errors into buffers
4. Exposes everything as MCP tools, resources, and prompts

**No app modifications required** for core debugging features.

## Features

| Plugin | Tools | Description |
|--------|-------|-------------|
| **console** | 2 | Console log collection with filtering |
| **network** | 3 | Network request tracking and search |
| **errors** | 2 | Exception collection with auto-symbolication |
| **evaluate** | 1 | Execute JavaScript in app runtime |
| **device** | 3 | Device and connection management |
| **source** | 1 | Stack trace symbolication |
| **redux** | 3 | Redux state inspection and action dispatch |
| **components** | 4 | React component tree inspection |
| **storage** | 3 | AsyncStorage reading |
| **bundle** | 2 | Metro bundle diagnostics |
| **simulator** | 6 | iOS simulator / Android device control |
| **deeplink** | 2 | Cross-platform deep link testing |
| **ui-interact** | 6 | UI automation (tap, swipe, type) |
| **navigation** | 4 | React Navigation / Expo Router state |
| **accessibility** | 3 | Accessibility auditing |
| **commands** | 2 | Custom app commands |
| **maestro** | 2 | Maestro test flow generation |

**Total: 47 tools, 7 resources, 7 prompts**

## Tools Reference

### Console

- **`get_console_logs`** — Get recent console output. Filter by `level` (log/warn/error/info/debug), `search` text, `limit`. Supports `summary` and `compact` modes.
- **`clear_console_logs`** — Clear the log buffer.

### Network

- **`get_network_requests`** — Get buffered HTTP requests with method, URL, status, timing.
- **`get_request_details`** — Get full headers and body for a specific request by URL.
- **`search_network`** — Filter by URL pattern, method, status code, or errors only.

### Errors

- **`get_errors`** — Get uncaught exceptions with symbolicated stack traces.
- **`clear_errors`** — Clear the error buffer.

### Evaluate

- **`evaluate_js`** — Execute any JavaScript expression in the running app and return the result. Supports async/await.

### Device

- **`list_devices`** — List connected debuggable targets from Metro.
- **`get_app_info`** — Bundle URL, platform, device name, VM type.
- **`get_connection_status`** — CDP connection state and Metro status.

### Source

- **`symbolicate`** — Convert minified stack traces to original source locations.

### Redux (no app changes needed)

- **`get_redux_state`** — Get the full state tree or a specific slice via dot-path (e.g., `user.profile`).
- **`dispatch_redux_action`** — Dispatch an action to the Redux store.
- **`get_redux_actions`** — Get recent dispatched actions (real-time with client SDK).

### Components (no app changes needed)

- **`get_component_tree`** — Get the React component tree. Use `structureOnly=true` for compact output (~1-3KB).
- **`find_components`** — Search by component name pattern.
- **`inspect_component`** — Get detailed props, state, and hooks for a specific component.
- **`get_testable_elements`** — List all elements with `testID` or `accessibilityLabel`.

### Storage (no app changes needed)

- **`get_storage_keys`** — List all AsyncStorage keys.
- **`get_storage_item`** — Read a specific key value.
- **`get_all_storage`** — Dump all key-value pairs.

### Bundle

- **`get_bundle_status`** — Metro server status and health check.
- **`get_bundle_errors`** — Compilation/transform errors with file paths.

### Simulator (cross-platform)

- **`take_screenshot`** — Capture simulator/device screenshot.
- **`list_simulators`** — List iOS simulators and Android emulators.
- **`install_certificate`** — Add root certificate to device.
- **`get_native_logs`** — Native logs (iOS syslog / Android logcat).
- **`app_lifecycle`** — Launch, terminate, install, uninstall apps.
- **`get_screen_orientation`** — Get current orientation.

### Deep Link

- **`open_deeplink`** — Open a URL or deep link on the device.
- **`list_url_schemes`** — List registered URL schemes.

### UI Interact

All tools use the CDP fiber tree first, falling back to `simctl`/`adb`, then IDB as a last resort. IDB is optional — tools will prompt you to install it when needed.

- **`list_elements`** — Get interactive elements from the React component tree (labels, testIDs, roles). No IDB needed.
- **`tap_element`** — Tap by label/testID (CDP fiber tree) or coordinates (simctl/adb → IDB fallback).
- **`type_text`** — Type into a TextInput by testID/label or the first visible input (CDP → adb → IDB).
- **`long_press`** — Long press by label/testID (CDP) or coordinates (adb → IDB).
- **`swipe`** — Scroll/swipe in a direction (CDP ScrollView → adb → IDB).
- **`press_button`** — Press HOME (simctl), BACK/ENTER/DELETE (CDP + adb), VOLUME/POWER (adb → IDB).

### Navigation (no app changes needed)

- **`get_navigation_state`** — Full React Navigation / Expo Router state.
- **`get_current_route`** — Currently focused route name and params.
- **`get_route_history`** — Navigation back stack.
- **`list_routes`** — All registered route names.

### Accessibility (no app changes needed)

- **`audit_accessibility`** — Full screen audit for missing labels, roles, testIDs, alt text.
- **`check_element_accessibility`** — Deep check on a specific component.
- **`get_accessibility_summary`** — Counts overview of accessibility coverage.

### Commands

- **`list_commands`** — List custom commands registered by the app.
- **`run_command`** — Execute a custom command with parameters.

### Maestro

- **`generate_maestro_flow`** — Generate Maestro YAML from a test description.
- **`record_interaction`** — Start/stop recording for Maestro flow generation.

## Resources

| URI | Description |
|-----|-------------|
| `metro://logs` | Live console log stream |
| `metro://network` | Live network request stream |
| `metro://errors` | Live error stream |
| `metro://status` | Connection status |
| `metro://redux/state` | Redux state snapshot |
| `metro://navigation` | Navigation state |
| `metro://bundle/status` | Metro bundle status |

## Prompts

| Name | Description |
|------|-------------|
| `debug-app` | General debugging session |
| `debug-errors` | Error investigation workflow |
| `debug-performance` | Performance analysis |
| `diagnose-network` | Network issue diagnosis |
| `trace-action` | Trace user action through state + network |
| `generate-tests` | Generate Maestro tests from current screen |
| `audit-accessibility` | Accessibility audit with fixes |

## Client SDK (Optional)

For enhanced features like real-time Redux action tracking, navigation events, and custom commands, add the optional client SDK.

### Without SDK (zero dependencies)

Register commands and state directly on globals — no package needed:

```typescript
// In your app entry point (dev only)
if (__DEV__) {
  global.__METRO_MCP__ = {
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

### With SDK (recommended)

```bash
bun add -d metro-mcp
```

```typescript
import { MetroMCPClient } from 'metro-mcp/client';

if (__DEV__) {
  const mcp = new MetroMCPClient();

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

### Standalone command registration

If you only need custom commands without the full SDK:

```typescript
import { registerCommand } from 'metro-mcp/client';

if (__DEV__) {
  registerCommand('login', async ({ email, password }) => {
    return await authService.login(email, password);
  });
}
```

## Custom Plugins

Create plugins as npm packages or local files:

```typescript
import { definePlugin } from 'metro-mcp/plugin';
import { z } from 'zod';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',

  async setup(ctx) {
    // Access CDP connection
    ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
      // Handle console events
    });

    // Register MCP tools
    ctx.registerTool('my_tool', {
      description: 'Does something useful',
      parameters: z.object({
        input: z.string().describe('Input value'),
      }),
      handler: async ({ input }) => {
        const result = await ctx.cdp.send('Runtime.evaluate', {
          expression: `doSomething("${input}")`,
          returnByValue: true,
        });
        return result;
      },
    });

    // Register resources
    ctx.registerResource('metro://my-data', {
      name: 'My Data',
      description: 'Custom data source',
      handler: async () => JSON.stringify({ data: 'hello' }),
    });

    // Run shell commands
    const output = await ctx.exec('xcrun simctl list');

    // Use token-efficient formatting
    ctx.format.summarize(items, 5);
    ctx.format.compact(obj);
    ctx.format.truncate(str, 100);
  },
});
```

### Loading custom plugins

```typescript
// metro-mcp.config.ts
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  metro: { host: 'localhost', port: 8081 },
  plugins: [
    'metro-mcp-plugin-custom',     // npm package
    './my-custom-plugin.ts',       // local file
  ],
});
```

**Naming convention**: npm packages use `metro-mcp-plugin-*` prefix.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METRO_HOST` | `localhost` | Metro bundler host |
| `METRO_PORT` | `8081` | Metro bundler port |
| `DEBUG` | — | Enable debug logging |

### CLI Arguments

```bash
metro-mcp --host 192.168.1.100 --port 19000 --intercept-fetch
```

### Config File

Create `metro-mcp.config.ts` in your project root:

```typescript
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  metro: {
    host: 'localhost',
    port: 8081,
    autoDiscover: true,  // Scan common ports
  },
  plugins: [],
  bufferSizes: {
    logs: 500,
    network: 200,
    errors: 100,
  },
  network: {
    interceptFetch: false, // Opt-in: inject JS to wrap fetch()
  },
});
```

## Token-Efficient Output

All tools support modifiers to reduce context window usage:

- **`summary: true`** — Counts + last N items
- **`structureOnly: true`** — Component tree without props/state (~1-3KB)
- **`compact: true`** — Single-line compressed format (30-50% smaller)
- **`maxLength: number`** — Truncate long values
- **`limit: number`** — Cap number of results

## Compatibility

- **React Native**: 0.70+ (Hermes required)
- **Expo**: SDK 49+
- **Runtime**: Bun 1.0+
- **Platforms**: iOS Simulator, Android Emulator, physical devices via USB

## License

MIT
