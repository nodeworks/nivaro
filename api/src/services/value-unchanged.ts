/** Loose "already that value" test for a bulk write: null/''/undefined agree,
 *  booleans accept 1/'1'/'true', numbers compare numerically, else as strings.
 *  A record already holding every value an action would set is SKIPPED —
 *  no write, no change reason on its history (the note belongs to the
 *  records that actually moved). */
export function valueUnchanged(current: unknown, next: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === ''
  if (empty(current) && empty(next)) return true
  if (empty(current) !== empty(next)) return false
  const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
  const falsy = (v: unknown) => v === false || v === 0 || v === '0' || v === 'false'
  if ((truthy(current) || falsy(current)) && (truthy(next) || falsy(next)))
    return truthy(current) === truthy(next)
  const nc = Number(current)
  const nn = Number(next)
  if (
    typeof current !== 'object' &&
    typeof next !== 'object' &&
    String(current).trim() !== '' &&
    String(next).trim() !== '' &&
    Number.isFinite(nc) &&
    Number.isFinite(nn)
  )
    return nc === nn
  return JSON.stringify(current) === JSON.stringify(next)
}
