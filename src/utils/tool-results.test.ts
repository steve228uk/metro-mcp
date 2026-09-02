import { expect, test } from 'bun:test';
import { normalizeToolResult } from './tool-results.js';

test('preserves a native MCP tool result', () => {
  const result = {
    content: [
      {
        type: 'image' as const,
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      },
    ],
    structuredContent: { source: 'fixture' },
  };

  expect(normalizeToolResult(result)).toBe(result);
});

test('serializes ordinary plugin results as text', () => {
  expect(normalizeToolResult({ ok: true })).toEqual({
    content: [{ type: 'text', text: '{"ok":true}' }],
  });
});
