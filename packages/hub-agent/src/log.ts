/**
 * One JSON object per line on stdout. Callers pass only safe fields (codes,
 * route templates, stack names, numbers); as a last guard, any key that looks
 * like it could carry a credential or a request body is dropped.
 */

export type Log = (o: object) => void

const UNSAFE_KEY = /authorization|token|secret|password|passwd|credential|cookie|body|header/i

function scrub(value: unknown, depth: number): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEY.test(k)) continue
    out[k] = scrub(v, depth + 1)
  }
  return out
}

export function createLog(write: (line: string) => void = (l) => process.stdout.write(l)): Log {
  return (o) => {
    try {
      write(`${JSON.stringify(scrub(o, 0))}\n`)
    } catch {
      // Logging never breaks a request.
    }
  }
}
