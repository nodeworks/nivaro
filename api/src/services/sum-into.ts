/**
 * `_sum_into` — a total the SERVER derives on an item PATCH (realtime gaps R1,
 * 2026-11-17). A month-columnar grid (record-grid editor: forecasts, budgets)
 * used to send its own total, summed from the months it had loaded: when
 * someone else had saved other months since, the stored total was wrong.
 * The grid now sends only the months it changed plus
 * `_sum_into: { field: 'total', of: ['january', …] }`, and the total is
 * summed from the row AS IT WILL BE STORED (the stored row + this write).
 *
 * The total is derived, so it is not one of the caller's fields: it never
 * makes the mid-air check (`_base_revision`) refuse a write that only
 * changed other months than the newer save.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_OF = 120

export interface SumInto {
  field: string
  of: string[]
}

/** Read and strip `_sum_into` from a payload. Anything malformed (bad
 *  names, the target among its own inputs, too many inputs) is ignored. */
export function takeSumInto(data: Record<string, unknown>): SumInto | null {
  const raw = data._sum_into
  delete data._sum_into
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const field = (raw as { field?: unknown }).field
  const of = (raw as { of?: unknown }).of
  if (typeof field !== 'string' || !IDENT.test(field) || field.startsWith('_')) return null
  if (!Array.isArray(of) || of.length === 0 || of.length > MAX_OF) return null
  const names = [...new Set(of)]
  if (!names.every((f) => typeof f === 'string' && IDENT.test(f) && !f.startsWith('_'))) return null
  if (names.includes(field)) return null
  return { field, of: names as string[] }
}

/** Only the inputs the caller may read count — a total must not reveal
 *  fields the caller cannot see. `readable` null = every field. */
export function readableSumInputs(sum: SumInto, readable: string[] | null): SumInto {
  if (readable === null || readable.includes('*')) return sum
  const ok = new Set(readable)
  return { field: sum.field, of: sum.of.filter((f) => ok.has(f)) }
}

/** The total over the row as it will be stored: this write's value where it
 *  sends one, else the stored value. Empty / non-numeric values count 0. */
export function sumOver(
  of: string[],
  payload: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined
): number {
  let total = 0
  for (const f of of) {
    const v = Object.hasOwn(payload, f) ? payload[f] : stored?.[f]
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : 0
    if (Number.isFinite(n)) total += n
  }
  // Month amounts are money: keep the sum free of binary-float tails.
  return Math.round(total * 1e6) / 1e6
}
