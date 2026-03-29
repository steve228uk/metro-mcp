# metro-mcp

[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=metro-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22metro-mcp%22%5D%2C%22env%22%3A%7B%7D%7D)
[![Install in Cursor](https://img.shields.io/badge/Install_in-Cursor-000000?style=flat-square&logoColor=white)](https://cursor.com/en/install-mcp?name=metro-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1ldHJvLW1jcCJdLCJlbnYiOnt9fQ==)

A plugin-based MCP server for React Native runtime debugging, inspection, and automation. Connects to Metro bundler via Chrome DevTools Protocol — **no app code changes needed** for most features.

Works with **Expo**, **bare React Native**, and any project using **Metro + Hermes**.

---

## Contents

- [Quick Start](#quick-start)
- [Requirements](#requirements)
- [How It Works](#how-it-works)
- [Features](#features)
- [Network Overrides](#network-overrides)
- [Test Recording](#test-recording)
- [App Integration](#app-integration-optional)
- [Configuration](#configuration)
- [Custom Plugins](#custom-plugins)
- [Compatibility](#compatibility)

---

## Quick Start

### Claude Code

```bash
claude mcp add metro-mcp -- npx -y metro-mcp
# or with Bun
claude mcp add metro-mcp -- bunx metro-mcp
```

### Cursor / VS Code

```json
{
  "mcpServers": {
    "metro-mcp": {
      "command": "npx",
      "args": ["-y", "metro-mcp"]
    }
  }
}
```

Or with Bun:

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
claude mcp add metro-mcp -- npx -y metro-mcp --port 19000
```

---

## Requirements

- **Node.js** 18+ or **Bun** 1.0+
- **iOS**: Xcode 14+ with Simulator (`xcrun simctl` is used for most operations)
- **Android**: Android SDK with `adb` on your PATH
- **IDB** *(optional)*: Some iOS operations fall back to [IDB (idb-companion)](https://github.com/facebook/idb) — install with `brew install idb-companion`. Tools will tell you when IDB is needed.

---

## How It Works

metro-mcp connects to your running Metro dev server the same way Chrome DevTools does:

1. Discovers Metro via port scanning (8081, 8082, 19000–19002)
2. Connects to Hermes via Chrome DevTools Protocol (CDP)
3. Streams console logs, network requests, and errors into buffers
4. Exposes everything as MCP tools, resources, and prompts

**No app modifications required** for core debugging features.

---

## Features

| Plugin | Tools | Description |
|--------|-------|-------------|
| **console** | 2 | Console log collection with filtering |
| **network** | 13 | Network request tracking, overrides, and mocking |
| **errors** | 2 | Exception collection with auto-symbolication |
| **evaluate** | 1 | Execute JavaScript in the app runtime |
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
| **profiler** | 5 | CPU profiling (Hermes CDP) + React render tracking |
| **test-recorder** | 4 | Record interactions and generate Appium, Maestro, or Detox tests |

**Total: 66 tools, 9 resources, 7 prompts** — see the [full tools reference](docs/tools.md).

---

## Network Overrides

Intercept any HTTP request made by your app — no app code changes required. Works like Chrome DevTools Local Overrides but via the CDP Fetch domain, so it works on device and in simulators.

Three override types:

- **response** — return a fake response; the real server is never called
- **request** — modify headers, URL, method, or body and forward to the real server
- **block** — fail the request with a network error

### Quick example

```
# Fake an API response
override_network_response  urlPattern="/api/users"  body='{"users":[]}'

# Inject an auth header into all API calls
override_network_request  urlPattern="/api/*"  headers={"Authorization":"Bearer test-token"}

# Block analytics
block_network_request  urlPattern="analytics.example.com"
```

### File-based overrides

Save overrides to a JSON file and auto-load them on startup:

```json
{
  "version": 1,
  "overrides": [
    {
      "name": "Mock users list",
      "urlPattern": "/api/users",
      "response": { "statusCode": 200, "body": { "users": [] } }
    },
    {
      "name": "Inject auth header",
      "urlPattern": "/api/*",
      "request": "./mocks/auth-request.json"
    }
  ]
}
```

Configure the file path and overrides load automatically on startup:

```bash
METRO_NETWORK_OVERRIDES=./network-overrides.json npx metro-mcp
```

Or in `metro-mcp.config.ts`:

```typescript
export default defineConfig({
  network: { overridesFile: './network-overrides.json' },
});
```

→ See the [network overrides guide](docs/network.md) for the full file format, folder loading, and tool reference.

---

## Test Recording

Record real user interactions (taps, text entry, scrolls) and generate production-ready tests — no app code changes required.

### AI-driven test generation

Describe a flow and the AI navigates the app, then generates the test:

> *"Write an Appium test for the guest checkout flow — start by tapping 'Start Shopping' on the welcome screen and end when the cart screen is visible."*

The AI calls `start_test_recording`, navigates using `tap_element`/`type_text`/`swipe`, then generates a complete test with real selectors observed from the fiber tree.

### Manual recording

```
start_test_recording   → inject interceptors
(interact with the app)
stop_test_recording    → retrieve event log
generate_test_from_recording format=appium
```

Supports **Appium (WebdriverIO)**, **Maestro YAML**, and **Detox**.

→ See the [testing guide](docs/testing.md) for full details, format examples, and tips.

---

## App Integration (Optional)

Register custom commands and expose state to the MCP server — no package needed. Add this to your app entry point in dev mode:

```typescript
if (__DEV__) {
  globalThis.__METRO_MCP__ = {
    commands: {
      // Run custom actions from the MCP client
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
      // Expose state snapshots readable via get_redux_state
      userStore: () => useUserStore.getState(),
    },
  };
}
```

Use `list_commands` and `run_command` to call these from the MCP client.

For enhanced features like real-time Redux action tracking, navigation events, performance marks, and React render profiling, see the [optional client SDK](docs/sdk.md) and [profiling guide](docs/profiling.md).

---

## Configuration

See [configuration docs](docs/configuration.md) for environment variables, CLI arguments, and config file options.

---

## Custom Plugins

metro-mcp is fully extensible. See the [plugins guide](docs/plugins.md) to build your own tools and resources.

---

## Compatibility

- **React Native**: 0.70+ (Hermes required)
- **Expo**: SDK 49+
- **Runtime**: Node.js 18+ or Bun 1.0+
- **Platforms**: iOS Simulator, Android Emulator, physical devices via USB

## License

MIT
