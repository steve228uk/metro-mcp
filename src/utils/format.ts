import type { ComponentNode, FormatUtils } from '../plugin.js';

/**
 * Summarize a list of items: "47 items. Last 5: ..."
 */
export function summarize<T>(items: T[], lastN = 5): string {
  const total = items.length;
  if (total === 0) return 'No items.';
  const last = items.slice(-lastN);
  const lines = last.map((item) => {
    if (typeof item === 'string') return item;
    return JSON.stringify(item);
  });
  return `${total} items total. Last ${Math.min(lastN, total)}:\n${lines.join('\n')}`;
}

/**
 * Compact representation: single-line key=value format.
 */
export function compact(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    return `[${obj.map(compact).join(', ')}]`;
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.map(([k, v]) => `${k}=${compact(v)}`).join(' ');
}

/**
 * Truncate a string with "..." suffix.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Strip props and state from a component tree, keeping only names and structure.
 */
export function structureOnly(tree: ComponentNode): ComponentNode {
  const result: ComponentNode = { name: tree.name };
  if (tree.children && tree.children.length > 0) {
    result.children = tree.children.map(structureOnly);
  }
  return result;
}

/**
 * Format a timestamp to a readable string.
 */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Create a FormatUtils instance.
 */
export function createFormatUtils(): FormatUtils {
  return { summarize, compact, truncate, structureOnly };
}
