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
