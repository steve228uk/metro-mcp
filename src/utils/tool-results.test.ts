import { expect, test } from 'bun:test';
import { nativeToolResult } from '../plugin.js';
import { normalizeToolResult } from './tool-results.js';

test('preserves a native MCP tool result', () => {
  const result = nativeToolResult({
    content: [
      {
        type: 'image' as const,
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      },
    ],
    structuredContent: { source: 'fixture' },
  });

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

test('serializes valid content-shaped objects without explicit opt-in', () => {
  const result = {
    content: [{ type: 'text' as const, text: 'ordinary plugin data' }],
    isError: true,
  };

  expect(normalizeToolResult(result)).toEqual({
    content: [{ type: 'text', text: JSON.stringify(result) }],
  });
});

test('rejects invalid explicitly native results', () => {
  expect(() =>
    nativeToolResult({
      content: [{ type: 'custom', value: 42 }],
    } as never),
  ).toThrow('Invalid native MCP tool result');
});
