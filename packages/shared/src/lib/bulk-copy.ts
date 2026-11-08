/**
 * Plain words for the bulk bar and the row ⋯ menu (army 11 N2/N7): records are
 * named by their friendly id ("MM26-81441"), never by row id, and a one-record
 * action never talks about "the selected records".
 */

interface ActionCopyIn {
  kind: string
  label: string
  summary: string
  confirm_text: string | null
}

/**
 * The sentence above a ONE-record action's confirm in the row menu. A field
 * action reads its own summary for this record ("Sets On hold to Yes on
 * MM26-81441."); other kinds keep the configured text with the selection
 * wording turned to this record.
 */
export function rowActionSentence(action: ActionCopyIn, recordName: string): string {
  const name = recordName.trim() || 'this record'
  if (action.kind === 'update_fields' && action.summary.trim())
    return `${action.summary.trim().replace(/\.$/, '')} on ${name}.`
  const text = (action.confirm_text ?? action.summary ?? '').trim()
  if (!text) return `${action.label} on ${name}.`
  return text
    .replace(/\bthe selected records\b/gi, name)
    .replace(/\bselected records\b/gi, name)
    .replace(/\beach record\b/gi, name)
}

interface OutcomeIn {
  item: string
  label?: string | null
}

/**
 * The name a bulk preview / result line gives a record: the friendly id the
 * server read (outcome `label`), else the label the host passed for the
 * target, else a neutral "A record" — never "#<row id>".
 */
export function outcomeName(
  o: OutcomeIn,
  targets: Array<{ id: string | number; label?: string | null }>
): string {
  const own = String(o.label ?? '').trim()
  if (own) return own
  const t = targets.find((x) => String(x.id).toLowerCase() === String(o.item).toLowerCase())
  const host = String(t?.label ?? '').trim()
  return host || 'A record'
}
