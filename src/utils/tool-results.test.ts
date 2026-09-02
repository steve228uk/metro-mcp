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

test('serializes content-shaped objects that are not valid MCP results', () => {
  const result = { content: [{ type: 'custom', value: 42 }] };

  expect(normalizeToolResult(result)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  });
});
