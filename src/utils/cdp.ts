/**
 * Extract a human-readable message from a CDP exceptionDetails object.
 * Works for both Runtime.evaluate responses and Runtime.exceptionThrown events.
 */
export function extractCDPExceptionMessage(
  details: Record<string, unknown>,
  fallback = 'Evaluation failed'
): string {
  const exception = details.exception as Record<string, unknown> | undefined;
  return (
    (exception?.description as string) ||
    (exception?.value as string) ||
    (details.text as string) ||
    fallback
  );
}

/** Decode the primitive formats CDP cannot carry in JSON's value field. */
export function decodeCDPUnserializableValue(value: unknown): unknown {
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (value === '-0') return -0;
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  throw new Error('Unsupported CDP unserializable value');
}
