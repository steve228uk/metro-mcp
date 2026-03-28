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

## Profiler Options

| Option | Default | Description |
|--------|---------|-------------|
| `profiler.newArchitecture` | `true` | Controls which profiling path is used. When `true` (default), `__REACT_DEVTOOLS_GLOBAL_HOOK__` is used as the primary path — works on all architectures including Bridgeless/Fusebox. When `false`, CDP `Profiler.*` domain calls are attempted first (suitable for legacy bridge apps). |

### Which value should I use?

- **Expo SDK 50+ / RN 0.74+ (New Architecture / Bridgeless)**: keep `true` (default)
- **Legacy bridge apps on older RN / Hermes**: set to `false` — the CDP Profiler domain may be available and provides a lower-overhead CPU call-graph

The server also auto-detects Fusebox targets via the `prefersFuseboxFrontend` CDP capability and skips CDP fallbacks automatically, regardless of this setting.
