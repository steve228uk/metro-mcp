# metro-mcp

[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=metro-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22metro-mcp%22%5D%2C%22env%22%3A%7B%7D%7D)
[![Install in Cursor](https://img.shields.io/badge/Install_in-Cursor-000000?style=flat-square&logoColor=white)](https://cursor.com/en/install-mcp?name=metro-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1ldHJvLW1jcCJdLCJlbnYiOnt9fQ==)

A plugin-based MCP server for React Native runtime debugging, inspection, and automation. Connects to Metro bundler via Chrome DevTools Protocol — **no app code changes needed** for most features.

Works with **Expo**, **bare React Native**, and any project using **Metro + Hermes**.

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

## Requirements

- **Node.js** 18+ or **Bun** 1.0+
- **iOS**: Xcode 14+ with Simulator (`xcrun simctl` is used for most operations)
- **Android**: Android SDK with `adb` on your PATH
- **IDB** *(optional)*: Some iOS operations fall back to [IDB (idb-companion)](https://github.com/facebook/idb) — install with `brew install idb-companion`. Tools will tell you when IDB is needed.

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
| **profiler** | 5 | CPU profiling (Hermes CDP) + React render tracking |
| **maestro** | 2 | Maestro test flow generation |
| **appium** | 3 | Appium/WebdriverIO Jest test generation |

**Total: 55 tools, 9 resources, 7 prompts** — see the [full tools reference](docs/tools.md).

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

## Configuration

See [configuration docs](docs/configuration.md) for environment variables, CLI arguments, and config file options.

## Custom Plugins

metro-mcp is fully extensible. See the [plugins guide](docs/plugins.md) to build your own tools and resources.

## Compatibility

- **React Native**: 0.70+ (Hermes required)
- **Expo**: SDK 49+
- **Runtime**: Node.js 18+ or Bun 1.0+
- **Platforms**: iOS Simulator, Android Emulator, physical devices via USB

## License

MIT
