import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  isNativeToolResult,
  type ToolHandlerResult,
} from '../plugin.js';

function serializeToolValue(result: unknown): string {
  // BigInt is a valid evaluation result, but JSON.stringify throws before it
  // can produce the text response used by ordinary plugin tools. Keep the
  // familiar JavaScript literal spelling while making nested values JSON safe.
  if (typeof result === 'bigint') return `${result}n`;
  return JSON.stringify(
    result,
    (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
  ) ?? String(result);
}

export function normalizeToolResult(result: ToolHandlerResult): CallToolResult {
  if (isNativeToolResult(result)) return result;
  const text =
    typeof result === 'string'
      ? result
      : serializeToolValue(result);
  return { content: [{ type: 'text', text }] };
}
