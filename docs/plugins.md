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

## MCP Apps — interactive UIs

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) lets tools return interactive HTML UIs that render inside a sandboxed iframe in MCP-capable hosts (Claude Desktop, VS Code Copilot, Goose, and others). Instead of returning text for the AI to summarize, the tool opens a live dashboard the user can filter, explore, and interact with directly.

metro-mcp exposes two primitives for this:

| API | Purpose |
|---|---|
| `ctx.registerAppResource(uri, config)` | Register an HTML page at a `ui://` URI |
| `appUri` in `registerTool` | Link a tool's result to an app resource |

### How it works

1. You register an HTML resource at a `ui://my-plugin/dashboard` URI
2. You add `appUri: 'ui://my-plugin/dashboard'` to a tool
3. When an MCP Apps host invokes the tool, it fetches the `ui://` resource and renders it in a sandboxed iframe
4. The iframe communicates with the host via a `postMessage` JSON-RPC bridge — receiving the tool's result and calling other tools for live updates

Non-MCP-Apps hosts (CLI, simple clients) ignore `appUri` and display the tool's text result normally — fully backward-compatible.

### Registering an app resource

```typescript
ctx.registerAppResource('ui://my-plugin/dashboard', {
  name: 'My Dashboard',
  description: 'Interactive data viewer',
  handler: async () => MY_HTML,
});
```

The HTML is served with MIME type `text/html;profile=mcp-app` automatically. The URI must start with `ui://`. Use `ui://your-plugin-name/...` as a namespace to avoid collisions with built-in apps (`ui://metro/...`).

### Linking a tool to an app

```typescript
ctx.registerTool('get_my_data', {
  description: 'Get data with a visual dashboard',
  parameters: z.object({}),
  appUri: 'ui://my-plugin/dashboard',  // ← that's all
  handler: async () => fetchMyData(),
});
```

metro-mcp automatically injects `_meta.ui.resourceUri` into the tool result — you don't touch `_meta` in your handler.

### The postMessage bridge

The iframe communicates with the host via JSON-RPC over `postMessage`. Copy this bootstrap snippet into your app's `<script>` tag — it exposes a `mcpBridge` global:

```html
<script>
(function() {
  var pending = new Map(), handlers = new Map(), nextId = 1;
  function send(msg) { window.parent.postMessage(JSON.stringify(msg), '*'); }
  window.addEventListener('message', function(e) {
    var msg; try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && pending.has(msg.id)) {
      var cb = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
      return;
    }
    if (msg.method) {
      if (msg.method === 'ui/notifications/host-context-changed') {
        var css = msg.params && msg.params.cssVariables;
        if (css) Object.keys(css).forEach(function(k) { document.documentElement.style.setProperty(k, css[k]); });
      }
      var h = handlers.get(msg.method); if (h) h(msg.params || {});
    }
  });
  window.mcpBridge = {
    initialize: function() {
      return new Promise(function(resolve, reject) {
        var id = nextId++; pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method: 'ui/initialize',
          params: { appInfo: { name: 'my-app', version: '1.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' } });
      });
    },
    call: function(method, params) {
      return new Promise(function(resolve, reject) {
        var id = nextId++; pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params: params || {} });
      });
    },
    on: function(method, handler) { handlers.set(method, handler); }
  };
})();
</script>
```

| Method | Description |
|---|---|
| `mcpBridge.initialize()` | Handshake with host (call first, returns `Promise<void>`) |
| `mcpBridge.call(method, params)` | JSON-RPC call — returns `Promise<result>` |
| `mcpBridge.on(method, handler)` | Listen for host notifications |

### Calling tools and resources from the app

```javascript
// Call a tool (re-fetch data)
mcpBridge.call('tools/call', { name: 'get_my_data', arguments: { limit: 50 } })
  .then(function(result) {
    var text = result.content[0].text;
    // render...
  });

// Read a resource
mcpBridge.call('resources/read', { uri: 'metro://profiler/data' })
  .then(function(result) {
    var json = JSON.parse(result.contents[0].text);
    // render...
  });
```

### Receiving the tool result automatically

The host sends `ui/notifications/tool-result` to the iframe when the linked tool finishes:

```javascript
mcpBridge.on('ui/notifications/tool-result', function(params) {
  var text = params.result.content[0].text;
  // render the initial data without calling tools/call
});
```

### Theming

The host sends CSS variables via `ui/notifications/host-context-changed`. The bridge bootstrap applies them to `:root` automatically. Use CSS custom properties with safe defaults:

```css
body {
  background: var(--color-bg, #0d0d0d);
  color: var(--color-text-primary, #e8e8e8);
  font-family: var(--font-sans, -apple-system, sans-serif);
}
```

### Security

MCP App iframes run in a strict sandbox:
- **No external network access by default** — CSP blocks all external connections. Your HTML must be fully self-contained (no CDN links).
- **No parent page access** — the iframe cannot read cookies, localStorage, or the parent DOM.
- External access requires declaring permissions explicitly in your resource — most hosts will reject or warn.

### Full example

```typescript
import { definePlugin } from 'metro-mcp';
import { z } from 'zod';

const BRIDGE = `/* paste the bootstrap snippet above */`;

const MY_HTML = \`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: var(--font-sans, sans-serif); color: var(--color-text-primary, #e8e8e8); padding: 16px; }
  </style>
</head>
<body>
  <h2>My Plugin</h2>
  <div id="root">Loading…</div>
  <script>
    \${BRIDGE}
    mcpBridge.initialize()
      .then(() => mcpBridge.call('tools/call', { name: 'my_tool', arguments: {} }))
      .then(function(result) {
        document.getElementById('root').textContent = result.content[0].text;
      });
  <\/script>
</body>
</html>\`;

export default definePlugin({
  name: 'my-plugin',
  async setup(ctx) {
    // 1. Register the HTML resource
    ctx.registerAppResource('ui://my-plugin/dashboard', {
      name: 'My Dashboard',
      description: 'Interactive data viewer',
      handler: async () => MY_HTML,
    });

    // 2. Link the tool — appUri is the only change needed
    ctx.registerTool('my_tool', {
      description: 'Returns data shown in the dashboard',
      parameters: z.object({}),
      appUri: 'ui://my-plugin/dashboard',
      handler: async () => {
        const data = await ctx.evalInApp('JSON.stringify(global.__MY_DATA__)');
        return data || '{}';
      },
    });
  },
});
```

## Validating a plugin

Use the [`validate-plugin` CLI command](/cli#validate-plugin) to check that your plugin file exports a valid `PluginDefinition` before loading it into the server:

```bash
bunx metro-mcp validate-plugin ./src/index.ts
```
