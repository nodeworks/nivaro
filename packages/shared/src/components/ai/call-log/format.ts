/** Number and label formatting for the AI call log. Pure. */

export const usd = (n: number | null | undefined, digits = 2): string =>
  n == null || Number.isNaN(n)
    ? '–'
    : n > 0 && n < 0.0001
      ? '<$0.0001'
      : `$${n.toFixed(n < 0.1 && n > 0 ? 4 : digits)}`

export const num = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? '–' : n.toLocaleString('en-US')

export const tok = (n: number | null | undefined): string =>
  n == null
    ? '–'
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 10_000
        ? `${(n / 1000).toFixed(1)}k`
        : n.toLocaleString('en-US')

export const secs = (ms: number | null | undefined): string =>
  ms == null ? '–' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`

export const pctOf = (part: number, whole: number): string =>
  whole > 0
    ? `${part / whole < 0.1 && part > 0 ? ((part / whole) * 100).toFixed(1) : Math.round((part / whole) * 100)}%`
    : '–'

const RESULT_LABEL: Record<string, string> = {
  ok: 'OK',
  end_turn: 'Answered',
  tool_use: 'Called tools',
  max_tokens: 'Hit the length limit',
  stopped: 'Stopped by the person',
  stop_sequence: 'Stop sequence',
  error: 'Error'
}

/** A result key ('error', 'end_turn', …) in words. */
export const resultLabel = (key: string | null | undefined): string =>
  RESULT_LABEL[key ?? 'ok'] ?? String(key).replace(/_/g, ' ')

/** The result of one call: error, else the stop reason. */
export const resultOf = (r: { status: string; stop_reason: string | null }): string =>
  r.status === 'error' ? 'error' : (r.stop_reason ?? 'ok')

export const featureLabel = (f: string): string =>
  f === 'chat'
    ? 'Ask AI'
    : f === 'chat-bot'
      ? 'Chat bot'
      : f.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** A bucket key (YYYY-MM-DD or YYYY-MM-DDTHH, UTC) as a short local label. */
export function bucketLabel(key: string, bucket: 'day' | 'hour'): string {
  if (bucket === 'hour') {
    const d = new Date(`${key}:00:00.000Z`)
    return Number.isNaN(d.getTime())
      ? key
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
  }
  const d = new Date(`${key}T00:00:00.000Z`)
  return Number.isNaN(d.getTime())
    ? key
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** The [from, to) of a bucket key, as ISO strings, for drilling into it. */
export function bucketRange(
  key: string,
  bucket: 'day' | 'hour'
): { from: string; to: string } | null {
  const start = bucket === 'hour' ? new Date(`${key}:00:00.000Z`) : new Date(`${key}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start.getTime() + (bucket === 'hour' ? 3_600_000 : 86_400_000))
  return { from: start.toISOString(), to: end.toISOString() }
}

export function whenShort(iso: string | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
