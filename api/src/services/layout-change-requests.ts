/**
 * Layout change requests (#2609) ride the support desk: a "Form change"
 * support request (nivaro_tasks kind 'support') about the record, so the
 * requester follows it under My requests and the desk sees it with the rest.
 *
 * nivaro_tasks has no column for the layout and field the request is about. The
 * server stores them as structured data beside the request (a nivaro_extension_settings
 * row 'nivaro-core' / `form_change:<task id>`, written only by POST
 * /layout-change-requests), and that row alone files the request under a form. The plain
 * words line it also appends to the description —
 * `Form: <name> (#<layout id>) · Field: <label> (<field>)` — is for the desk to read and
 * is never parsed: a requester can type anything into their message.
 */

export const FORM_CHANGE_CATEGORY = 'Form change'
export const FORM_CHANGE_DESCRIPTION =
  'Suggestions about how a record form looks or works, sent from the record page.'
export const FORM_CHANGE_LINK_PREFIX = 'form_change:'

export interface FormChangeLink {
  layout_id: number
  layout_name: string
  field: string | null
  field_label: string | null
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

export function formChangeTrailer(
  layout: { id: number; name: string } | null,
  field: { name: string; label: string } | null
): string {
  if (!layout) return ''
  const f = field ? ` · Field: ${oneLine(field.label) || field.name} (${field.name})` : ''
  return `\n\nForm: ${oneLine(layout.name)} (#${layout.id})${f}`
}

/** The stored link row's value → a link; null when it is not one. */
export function parseFormChangeLink(value: string | null | undefined): FormChangeLink | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<FormChangeLink>
    const id = Number(v.layout_id)
    if (!Number.isInteger(id) || id <= 0) return null
    return {
      layout_id: id,
      layout_name: String(v.layout_name ?? ''),
      field: typeof v.field === 'string' ? v.field : null,
      field_label: typeof v.field_label === 'string' ? v.field_label : null
    }
  } catch {
    return null
  }
}

/** The requester's message: the description without the line the server appended for `link`. */
export function formChangeMessage(
  description: string | null | undefined,
  link: FormChangeLink | null
): string {
  const text = description ?? ''
  if (!link) return text.trim()
  const trailer = formChangeTrailer(
    { id: link.layout_id, name: link.layout_name },
    link.field ? { name: link.field, label: link.field_label ?? link.field } : null
  )
  return (text.endsWith(trailer) ? text.slice(0, -trailer.length) : text).trim()
}

/** "Form change: <first line of the message>" — the request's summary. */
export function formChangeTitle(message: string): string {
  const first = oneLine(message.split('\n')[0] ?? '')
  return `Form change: ${first.length > 120 ? `${first.slice(0, 117)}…` : first}`
}
