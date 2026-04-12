# Custom Plugins

metro-mcp is plugin-based. You can extend it with local files or npm packages.

## Creating a plugin

```typescript
import { definePlugin } from 'metro-mcp';
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
          expression: `doSomething(${JSON.stringify(input)})`,
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

    // Token-efficient formatting helpers
    ctx.format.summarize(items, 5);
    ctx.format.compact(obj);
    ctx.format.truncate(str, 100);
  },
});
```

## Loading plugins

```typescript
// metro-mcp.config.ts
import { defineConfig } from 'metro-mcp';

export default defineConfig({
  metro: { host: 'localhost', port: 8081 },
  plugins: [
    'metro-mcp-plugin-custom',  // npm package
    './my-custom-plugin.ts',    // local file
  ],
});
```

npm packages use the `metro-mcp-plugin-*` naming convention.

## Loading plugins without a config file

Load plugins via CLI or env var — useful when you want to load a plugin without creating a config file, or for clients that don't support MCP roots:

```bash
# Single plugin
bunx metro-mcp --plugin ./my-plugin.ts

# Multiple plugins (colon-separated env var)
METRO_MCP_PLUGINS=./plugin-a.ts:metro-mcp-plugin-foo bunx metro-mcp
```

In an MCP server config:

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

Plugins specified this way are appended after any plugins defined in the config file.
