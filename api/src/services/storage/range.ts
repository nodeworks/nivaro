/**
 * One `Range: bytes=…` header against an object of `size` bytes: the inclusive byte range, the
 * word 'unsatisfiable', or null (no range, a multi-range or a malformed one: the whole object).
 * A leaf (no I/O): the env providers and services/stored-object-stream.ts both read ranges here.
 */
export function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(.+)$/.exec(header.trim())
  if (!m) return null
  const spec = m[1].trim()
  if (spec.includes(',')) return null
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts) return null
  const [, a, b] = parts
  if (size <= 0) return 'unsatisfiable'
  if (a === '' && b === '') return null
  if (a === '') {
    const suffix = Number(b)
    if (!suffix) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(a)
  if (start >= size) return 'unsatisfiable'
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}
