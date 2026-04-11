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
