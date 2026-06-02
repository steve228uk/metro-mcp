# Troubleshooting

## No devices found / can't connect

**metro-mcp discovers Metro by scanning common ports** (8081, 8082, 19000–19002). If your Metro runs on a different port, set it explicitly:

```bash
# CLI
npx metro-mcp --port 8088

# Environment variable
METRO_PORT=8088 npx metro-mcp

# MCP config
{
  "mcpServers": {
    "metro-mcp": {
      "command": "npx",
      "args": ["-y", "metro-mcp", "--port", "8088"]
    }
  }
}
```

Make sure your app is **running and fully bundled** before connecting — metro-mcp needs a live Metro server with an active Hermes session, not just Metro itself.

## Don't use the built-in debugger

Hermes only allows **one CDP connection at a time**. The built-in React Native debugger ("j" in Metro terminal, or "Open Debugger" in the dev menu) will steal the connection and disconnect metro-mcp.

metro-mcp includes a **CDP proxy** that lets both coexist. Always open DevTools through the MCP instead:

```
Use the open_devtools tool
```

This routes Chrome DevTools through the proxy so both connections remain active. If you accidentally opened the built-in debugger:

1. Close the Chrome DevTools window
2. Ask Claude to use `reload_app` or restart Metro
3. metro-mcp will reconnect automatically

## MCP running in multiple agents

metro-mcp supports multiple AI agents simultaneously for the same running app. Standard stdio installs start or reuse a shared localhost daemon, so Claude Code, Codex, Cursor, VS Code, and other clients connect to the same Metro/CDP runtime and share buffers.

If one agent was started from a different project directory or with different Metro flags/config, it creates a separate daemon. Use the same working directory, `--port`, `--host`, `--config`, and plugin settings in each MCP client when you want them to share one runtime.

If you need to inspect active MCP servers in Claude Code:

```
/mcp
```

This shows active MCP servers and lets you restart metro-mcp for that client.

## Restart the MCP server

Many issues (stale connection, state corruption, failed reconnects) are fixed by restarting the MCP server. In Claude Code:

```
/mcp restart metro-mcp
```

In Cursor or VS Code, use the MCP panel to restart the server, or restart the editor.

::: tip
After restarting, give metro-mcp a few seconds to rediscover Metro and reconnect to Hermes before running tools.
:::

## Restart Metro bundler

If metro-mcp connects but tools return empty results or stale data, the Metro/Hermes session may be in a bad state. Restart Metro:

```bash
# Expo
npx expo start --clear

# Bare React Native
npx react-native start --reset-cache
```

After Metro restarts, metro-mcp will automatically reconnect. You can verify the connection with `get_connection_status`.

## Physical devices

metro-mcp supports physical devices via USB, but requires extra setup:

- **iOS**: Ensure your device is trusted and connected via USB. `idb-companion` must be installed (`brew install idb-companion`) for some UI interaction tools.
- **Android**: `adb` must be on your PATH and `adb devices` must list your device. Run `adb reverse tcp:8081 tcp:8081` if Metro is unreachable.

Physical device debugging over WiFi is not currently supported.

## Tools return errors about architecture

Some profiling and component inspection tools behave differently depending on whether your app uses the New Architecture (Bridgeless/Fusebox) or the legacy bridge.

If profiling tools fail, try setting `newArchitecture` in your config:

```typescript
// metro-mcp.config.ts
export default defineConfig({
  profiler: {
    newArchitecture: false, // for legacy bridge apps
  },
})
```

See [Profiler Options](/configuration#profiler-options) for details.

## Checking the connection

Use `get_connection_status` to see the current state:

| Status | Meaning |
|--------|---------|
| `connected` | CDP session active, tools are operational |
| `connecting` | Attempting to connect to Hermes |
| `disconnected` | Metro not found or Hermes unavailable |

If you're stuck in `connecting`, check that Metro is running and that no other debugger (including another metro-mcp instance) holds the connection.

## Enable debug logging

For deeper diagnostics, enable verbose logging:

```bash
DEBUG=* npx metro-mcp
```

Or in your MCP config:

```json
{
  "mcpServers": {
    "metro-mcp": {
      "command": "npx",
      "args": ["-y", "metro-mcp"],
      "env": { "DEBUG": "*" }
    }
  }
}
```

This logs CDP messages, Metro discovery attempts, and proxy activity.

## Still stuck?

[Open an issue on GitHub](https://github.com/steve228uk/metro-mcp/issues) — include your metro-mcp version (`npx metro-mcp --version`), React Native / Expo SDK version, and the output of `get_connection_status`.
