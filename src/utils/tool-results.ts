import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  isNativeToolResult,
  type ToolHandlerResult,
} from '../plugin.js';

export function normalizeToolResult(result: ToolHandlerResult): CallToolResult {
  if (isNativeToolResult(result)) return result;
  const text =
    typeof result === 'string'
      ? result
      : (JSON.stringify(result) ?? String(result));
  return { content: [{ type: 'text', text }] };
}
