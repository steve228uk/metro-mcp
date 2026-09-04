import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  isNativeToolResult,
  type ToolHandlerResult,
} from '../plugin.js';

function serializeBigInt(value: unknown): string | undefined {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    // Use the intrinsic method as the brand check. Symbol.toStringTag and an
    // object's own valueOf() can both be overridden by ordinary plugin data.
    return `${BigInt.prototype.valueOf.call(value)}n`;
  } catch {}
  return undefined;
}

function serializeToolValue(result: unknown): string {
  // BigInt is a valid evaluation result, but JSON.stringify throws before it
  // can produce the text response used by ordinary plugin tools. Keep the
  // familiar JavaScript literal spelling while making nested values JSON safe.
  const bigint = serializeBigInt(result);
  if (bigint !== undefined) return bigint;
  return JSON.stringify(
    result,
    (_key, value: unknown) => serializeBigInt(value) ?? value,
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
