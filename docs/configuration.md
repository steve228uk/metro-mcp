# Configuration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METRO_HOST` | `localhost` | Metro bundler host |
| `METRO_PORT` | `8081` | Metro bundler port |
| `DEBUG` | — | Enable debug logging |

## CLI Arguments

```bash
npx -y metro-mcp --host 192.168.1.100 --port 19000
# or
bunx metro-mcp --host 192.168.1.100 --port 19000
```

| Argument | Description |
|----------|-------------|
| `--host`, `-h` | Metro bundler host |
| `--port`, `-p` | Metro bundler port |

## Config File

Create `metro-mcp.config.ts` in your project root:

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
  profiler: {
    newArchitecture: true,  // Set to false for legacy bridge apps
  },
});
```

## Metro Middleware (Optional)

Add the `withMetroMcp` wrapper to your Metro config to make pressing **"j"** and **"Open Debugger"** work alongside the MCP. Without it, those actions steal the CDP connection and disconnect the MCP. With it, they route through the MCP's proxy automatically.

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withMetroMcp } = require('metro-mcp/metro');

module.exports = withMetroMcp(getDefaultConfig(__dirname));
```

Or for bare React Native:

```js
// metro.config.js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withMetroMcp } = require('metro-mcp/metro');

module.exports = withMetroMcp(mergeConfig(getDefaultConfig(__dirname), {}));
```

### How it works

The middleware intercepts Metro's `/json` and `/json/list` responses — the standard CDP target discovery endpoints — and rewrites `webSocketDebuggerUrl` to point at the MCP's CDP proxy. Any tool that uses standard CDP discovery (Metro's "j" handler, the dev menu, Flipper, custom scripts) will connect through the proxy instead of directly to Hermes.

The middleware discovers the proxy port via the `METRO_MCP_PROXY_PORT` environment variable or a `.metro-mcp-proxy-port` file that the MCP server writes on startup. If the MCP server isn't running, the middleware is a no-op — all requests pass through unchanged.

### What if I don't add the middleware?

Everything still works. The only difference is:

| Action | Without middleware | With middleware |
|--------|-------------------|----------------|
| MCP tools | Work normally | Work normally |
| `open_devtools` MCP tool | Opens DevTools via proxy | Opens DevTools via proxy |
| Press "j" in Metro | Disconnects MCP | Works alongside MCP |
| "Open Debugger" in dev menu | Disconnects MCP | Works alongside MCP |

## Profiler Options

| Option | Default | Description |
|--------|---------|-------------|
| `profiler.newArchitecture` | `true` | Controls which profiling path is used. When `true` (default), `__REACT_DEVTOOLS_GLOBAL_HOOK__` is used as the primary path — works on all architectures including Bridgeless/Fusebox. When `false`, CDP `Profiler.*` domain calls are attempted first (suitable for legacy bridge apps). |

### Which value should I use?

- **Expo SDK 50+ / RN 0.74+ (New Architecture / Bridgeless)**: keep `true` (default)
- **Legacy bridge apps on older RN / Hermes**: set to `false` — the CDP Profiler domain may be available and provides a lower-overhead CPU call-graph

The server also auto-detects Fusebox targets via the `prefersFuseboxFrontend` CDP capability and skips CDP fallbacks automatically, regardless of this setting.
