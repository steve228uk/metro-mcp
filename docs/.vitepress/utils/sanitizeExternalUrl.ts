export function sanitizeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const normalized = trimmed.startsWith('git+') ? trimmed.slice(4) : trimmed

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString()
    }
  } catch {
    return undefined
  }

  return undefined
}
