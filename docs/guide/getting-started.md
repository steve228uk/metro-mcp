# Getting Started

metro-mcp is a plugin-based MCP server for React Native runtime debugging, inspection, and automation. It connects to Metro bundler via Chrome DevTools Protocol — **no app code changes needed** for most features.

Works with **Expo**, **bare React Native**, and any project using **Metro + Hermes**.

## Requirements

- **Node.js** 18+ or **Bun** 1.0+
- **iOS**: Xcode 14+ with Simulator (`xcrun simctl` is used for most operations)
- **Android**: Android SDK with `adb` on your PATH
- **IDB** *(optional)*: Some iOS operations fall back to [IDB (idb-companion)](https://github.com/facebook/idb) — install with `brew install idb-companion`. Tools will tell you when IDB is needed.

## Installation

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

Or use the one-click install buttons:

[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=metro-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22metro-mcp%22%5D%2C%22env%22%3A%7B%7D%7D)
[![Install in Cursor](https://img.shields.io/badge/Install_in-Cursor-000000?style=flat-square&logoColor=white)](https://cursor.com/en/install-mcp?name=metro-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1ldHJvLW1jcCJdLCJlbnYiOnt9fQ==)

### With a config file

For global MCP installs (the typical setup), the server's CWD is not reliably set to your project root, so pass the config path explicitly:

```bash
claude mcp add metro-mcp -- bunx metro-mcp --config /Users/you/my-project/metro-mcp.config.ts
```

Or set it via `METRO_MCP_CONFIG` in your MCP server config (useful in Cursor / VS Code):

```json
{
  "mcpServers": {
    "metro-mcp": {
      "command": "bunx",
      "args": ["metro-mcp"],
      "env": { "METRO_MCP_CONFIG": "/Users/you/my-project/metro-mcp.config.ts" }
    }
  }
}
```

See [Configuration](/configuration) for all options.

### With a custom Metro port

```bash
claude mcp add metro-mcp -- npx -y metro-mcp --port 19000
```

## How It Works

metro-mcp connects to your running Metro dev server the same way Chrome DevTools does:

1. Discovers Metro via port scanning (8081, 8082, 19000–19002)
2. Connects to Hermes via Chrome DevTools Protocol (CDP)
3. Streams console logs, network requests, and errors into buffers
4. Exposes everything as MCP tools, resources, and prompts

**No app modifications required** for core debugging features.

## Compatibility

| | Supported |
|---|---|
| **React Native** | 0.70+ (Hermes required) |
| **Expo** | SDK 49+ |
| **Node.js** | 18+ |
| **Bun** | 1.0+ |
| **Platforms** | iOS Simulator, Android Emulator, physical devices via USB |

## Chrome DevTools

Hermes only allows a **single CDP connection** at a time. metro-mcp solves this with a built-in **CDP proxy** that multiplexes the connection, letting Chrome DevTools and the MCP coexist.

Use the `open_devtools` MCP tool instead of pressing **"j"** in Metro or tapping **"Open Debugger"** in the dev menu — those will steal the connection and disconnect the MCP.

The proxy is enabled by default. To configure it:

```bash
# Fixed proxy port
METRO_MCP_PROXY_PORT=9222 npx metro-mcp

# Disable the proxy
METRO_MCP_PROXY_ENABLED=false npx metro-mcp
```

## Claude Code Status Bar

Get live Metro connection status in your Claude Code status bar.

Run `setup_statusline` in Claude Code — it writes a script to `~/.claude/metro-mcp-statusline.sh`, then:

```
/statusline add the script at ~/.claude/metro-mcp-statusline.sh
```

| State | Display |
|-------|---------|
| Not running | `Metro ○` (dimmed) |
| Running, not connected | `Metro ●` (red) |
| Connected | `Metro ● localhost:8081` (green) |

## Next Steps

- [Configuration](/configuration) — environment variables, CLI args, config file
- [App Integration (SDK)](/sdk) — optional SDK for enhanced features
- [Tools Reference](/tools) — all available MCP tools
- [Custom Plugins](/plugins) — extend metro-mcp with your own tools
