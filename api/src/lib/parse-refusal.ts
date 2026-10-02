// api/src/lib/parse-refusal.ts
/**
 * The refusal as the caller received it, read back from an API-log row's stored response body.
 * The log keeps the first part of the body; a body cut mid-JSON still yields its code by pattern.
 * Shared by API Analytics (refusals by code) and the Traffic Map's caller panel.
 */
export function parseRefusal(
  raw: unknown,
  status: number
): { code: string; message: string | null } {
  const fallback = status === 429 ? 'RATE_LIMITED' : status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED'
  if (typeof raw !== 'string' || !raw) return { code: fallback, message: null }
  try {
    const body = JSON.parse(raw) as Record<string, unknown>
    const first = Array.isArray(body.errors)
      ? (body.errors[0] as Record<string, unknown> | undefined)
      : undefined
    const ext = (first?.extensions ?? {}) as Record<string, unknown>
    const code = body.code ?? ext.code
    const message = body.message ?? first?.message ?? body.error
    return {
      code: typeof code === 'string' && code ? code : fallback,
      message: typeof message === 'string' ? message.slice(0, 300) : null
    }
  } catch {
    const code = raw.match(/"code"\s*:\s*"([A-Z0-9_]+)"/)?.[1]
    const message = raw.match(/"message"\s*:\s*"([^"]{1,300})/)?.[1]
    return { code: code ?? fallback, message: message ?? null }
  }
}
