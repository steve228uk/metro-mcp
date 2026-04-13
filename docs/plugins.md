# Custom Plugins

metro-mcp is plugin-based. You can extend it with your own MCP tools, resources, and prompts — either as local files or published npm packages.

## Quickstart

Scaffold a new plugin package interactively:

```bash
bunx metro-mcp create-plugin
```

This prompts for a name, description, and author, then generates a ready-to-use package in a new directory (`metro-mcp-plugin-<name>/`) with a hello-world plugin, build config, README, and LICENSE.

```
✓ Plugin metro-mcp-plugin-my-plugin ready!

Next steps:
  cd metro-mcp-plugin-my-plugin
  bun run build
```

## Plugin structure

A plugin is a `definePlugin()` call with a `name` and an async `setup` function:

```typescript
import { definePlugin } from 'metro-mcp';
import { z } from 'zod';

export default definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Does useful things',

  async setup(ctx) {
    ctx.registerTool('my_tool', {
      description: 'Does something useful',
      parameters: z.object({
        input: z.string().describe('Input value'),
      }),
      handler: async ({ input }) => {
        return `You said: ${input}`;
      },
    });
  },
});
```

The `setup` function receives a `PluginContext` and is called once when the server starts. Register all your tools, resources, and prompts here.

## Registering tools

Tools are the primary way to expose functionality to AI clients.

```typescript
ctx.registerTool('evaluate_expression', {
  description: 'Evaluate a JS expression in the running app',
  parameters: z.object({
    expression: z.string().describe('JavaScript expression'),
    awaitPromise: z.boolean().default(true),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
  },
  handler: async ({ expression, awaitPromise }, toolCtx) => {
    const result = await ctx.evalInApp(expression, { awaitPromise });
    return result ?? 'undefined';
  },
});
```

### Tool annotations

Annotations are hints for AI clients about how the tool behaves. They help clients decide when to auto-approve tool calls.

| Annotation | Type | Description |
|---|---|---|
| `title` | `string` | Human-readable display name |
| `readOnlyHint` | `boolean` | Tool does not modify state (safe to auto-approve) |
| `destructiveHint` | `boolean` | Tool may perform irreversible actions |
| `idempotentHint` | `boolean` | Calling multiple times with same args has no extra effect |
| `openWorldHint` | `boolean` | Tool may interact with external systems |

### Progress reporting

The handler receives a second `ctx` argument with an optional `sendProgress` helper for long-running operations:

```typescript
handler: async ({ items }, { sendProgress }) => {
  for (let i = 0; i < items.length; i++) {
    await processItem(items[i]);
    await sendProgress?.(i + 1, items.length, `Processing ${items[i]}`);
  }
  return 'Done';
},
```

## Registering resources

Resources expose readable data to AI clients (component trees, logs, state snapshots, etc.).

```typescript
ctx.registerResource('metro://my-plugin/state', {
  name: 'App State',
  description: 'Current application state snapshot',
  mimeType: 'application/json',  // defaults to 'application/json'
  handler: async () => {
    const state = await ctx.evalInApp('JSON.stringify(global.__REDUX_STORE__?.getState())');
    return state as string;
  },
  onSubscribe: (uri) => {
    ctx.logger.info(`Client subscribed to ${uri}`);
  },
  onUnsubscribe: (uri) => {
    ctx.logger.info(`Client unsubscribed from ${uri}`);
  },
});
```

### Push updates

When your resource data changes, notify subscribed clients:

```typescript
async setup(ctx) {
  // Listen for CDP events and push updates
  ctx.cdp.on('Runtime.consoleAPICalled', () => {
    ctx.notifyResourceUpdated('metro://my-plugin/logs');
  });

  ctx.registerResource('metro://my-plugin/logs', {
    name: 'Plugin Logs',
    description: 'Streaming log output',
    handler: async () => JSON.stringify(logBuffer),
  });
},
```

## Registering prompts

Prompts are pre-built message templates that AI clients can invoke.

```typescript
ctx.registerPrompt('debug_crash', {
  description: 'Gather context for a crash report',
  arguments: [
    { name: 'error', description: 'The error message', required: true },
  ],
  handler: async ({ error }) => [
    {
      role: 'user',
      content: `The app crashed with: ${error}\n\nPlease check the recent logs and component tree to diagnose the issue.`,
    },
  ],
});
```

## Plugin context API

The `ctx` object passed to `setup` provides everything you need to interact with the app:

### `ctx.cdp` — Chrome DevTools Protocol

Send CDP commands and listen to CDP events directly:

```typescript
// Send a command
const result = await ctx.cdp.send('Runtime.evaluate', {
  expression: 'window.__MY_GLOBAL__',
  returnByValue: true,
});

// Listen for events
ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
  console.log('Console event:', params);
});

// Check connection status
if (ctx.cdp.isConnected) {
  const target = ctx.cdp.getTarget(); // MetroTarget | null
}
```

### `ctx.events` — Metro bundler events

Listen to Metro build events over WebSocket:

```typescript
ctx.events.on('bundling_error', (event) => {
  ctx.logger.error('Bundle error:', event);
});

ctx.events.on('bundle_transform_progressed', (event) => {
  // Build progress
});
```

### `ctx.evalInApp` — Evaluate JavaScript

Run JavaScript in the connected app and return the result:

```typescript
const value = await ctx.evalInApp('global.__MY_STORE__.getState()');

// Await promises returned by the expression
const data = await ctx.evalInApp('fetch("/api/data").then(r => r.json())', {
  awaitPromise: true,
  timeout: 15000,
});
```

### `ctx.metro` — Metro HTTP access

Make HTTP requests to the Metro bundler:

```typescript
const { host, port } = ctx.metro;
const response = await ctx.metro.fetch('/status');
const data = await response.json();
```

### `ctx.exec` — Shell commands

Run shell commands and capture output:

```typescript
const devices = await ctx.exec('xcrun simctl list devices --json');
const parsed = JSON.parse(devices);
```

### `ctx.format` — Formatting helpers

Token-efficient helpers for formatting data to return to AI clients:

| Method | Description |
|---|---|
| `format.summarize(items, lastN?)` | `"47 items. Last 5: ..."` — avoids flooding context with large arrays |
| `format.compact(obj)` | `"key=value key2=value2"` — flat key-value string |
| `format.truncate(str, maxLen)` | Truncate with `...` |
| `format.structureOnly(tree)` | Strip props/state from a component tree, keep structure |

### `ctx.logger` — Plugin logger

Prefixed logger for your plugin's output:

```typescript
ctx.logger.info('Plugin ready');
ctx.logger.warn('Something unexpected');
ctx.logger.error('Failed to connect', err);
ctx.logger.debug('Raw CDP response', data);  // Only shown with DEBUG=1
```

### Device helpers

```typescript
// Returns a stable key for the active device, e.g. "8081-abc123"
const key = ctx.getActiveDeviceKey();

// Returns a human-readable name, e.g. "iPhone 16 Pro Simulator"
const name = ctx.getActiveDeviceName();
```

## Loading plugins

### Via config file

```typescript
// metro-mcp.config.ts
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  plugins: [
    'metro-mcp-plugin-my-plugin',  // npm package
    './local-plugin.ts',           // local file (relative to config)
  ],
});
```

### Via CLI flag

```bash
bunx metro-mcp --plugin ./my-plugin.ts
```

Repeatable — pass `--plugin` multiple times to load several plugins.

### Via environment variable

```bash
METRO_MCP_PLUGINS=./plugin-a.ts:metro-mcp-plugin-foo bunx metro-mcp
```

Plugins from CLI flags and env vars are appended after any plugins in the config file.

### In an MCP client config

```json
{
  "mcpServers": {
    "metro-mcp": {
      "command": "bunx",
      "args": ["metro-mcp", "--plugin", "./my-plugin.ts"]
    }
  }
}
```

## Package naming

npm packages must follow the `metro-mcp-plugin-*` naming convention. When a plugin path in your config doesn't start with `.` or `/`, metro-mcp resolves it as an npm package name.

```typescript
plugins: [
  'metro-mcp-plugin-mmkv',    // resolves from node_modules
  './local-plugin.ts',        // resolves as a local file
]
```

## Publishing to npm

The `create-plugin` scaffold generates a package ready to publish:

```bash
# Build the plugin
bun run build

# Publish to npm
npm publish
```

The generated `package.json` lists `metro-mcp` and `zod` as `peerDependencies` — users provide them through their metro-mcp installation, so there's no version conflict.

## Validating a plugin

Use the [`validate-plugin` CLI command](/cli#validate-plugin) to check that your plugin file exports a valid `PluginDefinition` before loading it into the server:

```bash
bunx metro-mcp validate-plugin ./src/index.ts
```
