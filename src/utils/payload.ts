export const TRUNCATED_MARKER = '[truncated';

export function byteLength(value: string | undefined): number {
  return value ? Buffer.byteLength(value, 'utf8') : 0;
}

export function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  const suffix = `\n[truncated ${omitted} chars]`;
  if (suffix.length >= maxChars) return value.slice(0, maxChars);
  return value.slice(0, maxChars - suffix.length) + suffix;
}

export function stringifyBounded(value: unknown, maxChars: number): string {
  try {
    return truncateString(JSON.stringify(value), maxChars);
  } catch {
    return '[unserializable]';
  }
}

export function truncateRecordValues(
  record: unknown,
  maxValueChars: number,
): Record<string, string> | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const bounded: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    bounded[key] = truncateString(String(value), maxValueChars);
  }
  return bounded;
}
