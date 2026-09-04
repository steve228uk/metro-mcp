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

test('serializes a BigInt scalar using its JavaScript literal spelling', () => {
  expect(normalizeToolResult(1n)).toEqual({
    content: [{ type: 'text', text: '1n' }],
  });
});

test('serializes nested BigInts without throwing', () => {
  expect(normalizeToolResult({
    count: 1n,
    values: [2n, { total: 3n }],
  })).toEqual({
    content: [{
      type: 'text',
      text: '{"count":"1n","values":["2n",{"total":"3n"}]}',
    }],
  });
});

test('serializes boxed BigInts without throwing', () => {
  expect(normalizeToolResult(Object(4n))).toEqual({
    content: [{ type: 'text', text: '4n' }],
  });
  expect(normalizeToolResult({ count: Object(5n) })).toEqual({
    content: [{ type: 'text', text: '{"count":"5n"}' }],
  });
});

test('does not treat a spoofed BigInt tag as a boxed BigInt', () => {
  const result = {
    [Symbol.toStringTag]: 'BigInt',
    valueOf: () => {
      throw new Error('must not be called');
    },
  };
  expect(normalizeToolResult(result)).toEqual({
    content: [{ type: 'text', text: '{}' }],
  });
});

test('preserves existing JSON handling for non-BigInt primitives', () => {
  expect(normalizeToolResult({
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    negativeZero: -0,
  })).toEqual({
    content: [{
      type: 'text',
      text: '{"nan":null,"positiveInfinity":null,"negativeInfinity":null,"negativeZero":0}',
    }],
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
