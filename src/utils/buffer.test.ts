import { expect, test } from 'bun:test';
import { CircularBuffer } from './buffer.js';

test('circular buffer evicts old entries when byte budget is exceeded', () => {
  const buffer = new CircularBuffer<{ timestamp: number; text: string }>(10, {
    maxBytes: 10,
    sizeOf: (item) => item.text.length,
  });

  buffer.push({ timestamp: 1, text: '12345' });
  buffer.push({ timestamp: 2, text: '67890' });
  buffer.push({ timestamp: 3, text: 'abcde' });

  expect(buffer.getAll()).toEqual([
    { timestamp: 2, text: '67890' },
    { timestamp: 3, text: 'abcde' },
  ]);
  expect(buffer.byteSize).toBe(10);
});
