/**
 * An integration obligation's ledger reason in a person's words — "skip_when_empty:
 * nuvolo_id empty" reads "this record has no Nuvolo ID yet". Render time only:
 * the stored vocabulary (skipReason in api services/integration-obligations.ts,
 * mirrored in efp-ops obligations/writer.ts) stays as written, because the
 * board, digest and reconciliation match on it.
 *
 * Byte-identical twins: api/src/services/obligation-reason-text.ts and
 * packages/shared/src/lib/obligation-reason-text.ts (no imports, so both sides
 * can carry it). Change both.
 */

const ACRONYMS = new Set(['id', 'po', 'req', 'url', 'sku', 'uom', 'erp', 'api', 'ids'])

/** `nuvolo_id` → "Nuvolo ID", `po_number` → "PO number". */
function fieldWords(key: string): string {
  const words = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (words.length === 0) return key
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w)) return w === 'ids' ? 'IDs' : w.toUpperCase()
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

export function plainObligationReason(reason: string): string {
  const r = String(reason ?? '').trim()
  let m = /^skip_when_empty: (.+) empty$/.exec(r)
  if (m) return `this record has no ${fieldWords(m[1])} yet`
  m = /^skip_unless_any: none of (.+) is set$/.exec(r)
  if (m) {
    const names = m[1].split(/,\s*/).filter(Boolean).map(fieldWords)
    return `this record has none of ${names.join(', ')} yet`
  }
  m = /^guard unmet: (.+)$/.exec(r)
  if (m) return `its send condition was not met (${m[1]})`
  m = /^not configured: (.+) missing on the action$/.exec(r)
  if (m) return `the send is not set up yet (${m[1]} is missing)`
  m = /^payload template error: (.+)$/.exec(r)
  if (m) return `the message could not be built (${m[1]})`
  m = /^flow condition rejected at "(.+)"$/.exec(r)
  if (m) return `a flow step ("${m[1]}") stopped it`
  return r
}
