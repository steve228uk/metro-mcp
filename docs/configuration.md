# Configuration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METRO_HOST` | `localhost` | Metro bundler host |
| `METRO_PORT` | `8081` | Metro bundler port |
| `METRO_MCP_CONFIG` | — | Path to config file (absolute or relative to CWD) |
| `METRO_MCP_PLUGINS` | — | Colon-separated plugin paths to load (e.g. `./my-plugin.ts:metro-mcp-plugin-foo`) |
| `METRO_MCP_PROXY_ENABLED` | `true` | Enable the CDP proxy for Chrome DevTools coexistence |
| `METRO_MCP_PROXY_PORT` | `0` (random) | Fixed port for the CDP proxy. Use `0` for a random available port |
| `DEBUG` | — | Enable debug logging |

## CLI Arguments

```bash
npx -y metro-mcp --host 192.168.1.100 --port 19000
# or
bunx metro-mcp --host 192.168.1.100 --port 19000
```

| Argument | Description |
|----------|-------------|
| `--host`, `-H` | Metro bundler host |
| `--port`, `-p` | Metro bundler port |
| `--config`, `-c` | Path to config file (overrides `METRO_MCP_CONFIG`) |
| `--plugin` | Load a plugin by path (repeatable) |

## Config File

metro-mcp loads `metro-mcp.config.ts` (or `.js`) from the **current working directory** at startup.

::: tip TypeScript vs JavaScript
`metro-mcp.config.ts` only works when running via `bunx` (Bun runtime). Use `metro-mcp.config.js` if running via `npx` / Node.js.
:::

**For global MCP installs** (the typical setup in Claude Code and Cursor), the server's CWD is not reliably set to your project root. Specify the config path explicitly instead:

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

Or via CLI when adding the MCP server:

```bash
claude mcp add metro-mcp -- bunx metro-mcp --config /Users/you/my-project/metro-mcp.config.ts
```

Run with `DEBUG=1` to see exactly where the server is looking for config:

```bash
DEBUG=1 bunx metro-mcp
# logs: Config search CWD: /some/path
# logs: Loaded config from /full/path/metro-mcp.config.ts
```

Create the config file:

```typescript
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  metro: {
    host: 'localhost',
    port: 8081,
    autoDiscover: true,  // Scan common ports automatically
  },
  plugins: [],
  bufferSizes: {
    logs: 500,
    network: 200,
    errors: 100,
  },
  network: {
    interceptFetch: false,  // Opt-in: inject JS to wrap fetch()
  },
  proxy: {
    enabled: true,   // CDP proxy for Chrome DevTools coexistence
    port: 0,         // 0 = random available port
  },
  profiler: {
    newArchitecture: true,  // Set to false for legacy bridge apps
  },
});
```

## CDP Proxy Options

The CDP proxy allows Chrome DevTools to connect alongside the MCP, working around Hermes's single-connection limitation. See the [Chrome DevTools](/guide/getting-started#chrome-devtools) section for details.

| Option | Default | Description |
|--------|---------|-------------|
| `proxy.enabled` | `true` | Enable the CDP proxy server. When enabled, external debuggers (Chrome DevTools, etc.) can connect to the proxy port and share the Hermes connection with the MCP. |
| `proxy.port` | `0` | Port for the proxy's WebSocket + HTTP server. `0` picks a random available port. Set a fixed port if you need a stable URL. |

The proxy also serves a `/json` endpoint for Chrome's target auto-discovery and a `/json/version` endpoint.

## Profiler Options

| Option | Default | Description |
|--------|---------|-------------|
| `profiler.newArchitecture` | `true` | Controls which profiling path is used. When `true` (default), `__REACT_DEVTOOLS_GLOBAL_HOOK__` is used as the primary path — works on all architectures including Bridgeless/Fusebox. When `false`, CDP `Profiler.*` domain calls are attempted first (suitable for legacy bridge apps). |

### Which value should I use?

- **Expo SDK 50+ / RN 0.74+ (New Architecture / Bridgeless)**: keep `true` (default)
- **Legacy bridge apps on older RN / Hermes**: set to `false` — the CDP Profiler domain may be available and provides a lower-overhead CPU call-graph

The server also auto-detects Fusebox targets via the `prefersFuseboxFrontend` CDP capability and skips CDP fallbacks automatically, regardless of this setting.
