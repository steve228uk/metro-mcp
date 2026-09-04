import { z } from 'zod';
import { definePlugin } from '../../src/plugin.js';

export default definePlugin({
  name: 'metro-endpoint-fixture',
  description: 'Exposes the current Metro endpoint for runtime tests',
  async setup(ctx) {
    // PluginContext documents these fields as mutable. Assigning their current
    // values catches getter-only runtime implementations.
    ctx.metro.host = ctx.metro.host;
    ctx.metro.port = ctx.metro.port;
    ctx.registerTool('test_metro_endpoint', {
      description: 'Return the current Metro endpoint',
      parameters: z.object({}),
      handler: async () => ({ host: ctx.metro.host, port: ctx.metro.port }),
    });
  },
});
