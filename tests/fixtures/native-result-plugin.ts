import { z } from 'zod';
import { definePlugin } from '../../src/plugin.js';

export default definePlugin({
  name: 'native-result-fixture',
  async setup(ctx) {
    ctx.registerTool('test_native_image', {
      description: 'Return a native MCP image block for protocol tests.',
      parameters: z.object({}),
      handler: async () => ({
        content: [
          {
            type: 'image',
            data: 'iVBORw0KGgo=',
            mimeType: 'image/png',
          },
        ],
        structuredContent: { source: 'fixture' },
      }),
    });
  },
});
