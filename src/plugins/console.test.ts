import { expect, test } from 'bun:test';
import { formatCDPArgs, formatCDPArgsDeep, MAX_CONSOLE_MESSAGE_CHARS } from './console.js';
import { TRUNCATED_MARKER } from '../utils/payload.js';

test('formats console strings with a bounded retained size', () => {
  const message = formatCDPArgs([
    { type: 'string', value: 'x'.repeat(MAX_CONSOLE_MESSAGE_CHARS * 2) },
  ]);

  expect(message.length).toBeLessThanOrEqual(MAX_CONSOLE_MESSAGE_CHARS);
  expect(message).toContain(TRUNCATED_MARKER);
});

test('deep console object resolution is bounded before storage', async () => {
  const message = await formatCDPArgsDeep(
    async () => ({
      result: {
        value: 'y'.repeat(MAX_CONSOLE_MESSAGE_CHARS * 2),
      },
    }),
    [{ type: 'object', objectId: 'object-1' }],
  );

  expect(message.length).toBeLessThanOrEqual(MAX_CONSOLE_MESSAGE_CHARS);
  expect(message).toContain(TRUNCATED_MARKER);
});
