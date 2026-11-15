import { createContext, useContext } from 'react'

/**
 * Co-editing long text (realtime round 3, item 8) — which record form a field sits in.
 * No editor code here: the form and FieldRenderer load this with the main bundle, the editor
 * binding (useCoedit) rides the rich-text chunk.
 */

export interface CoeditFieldTarget {
  collection: string
  item: string
  field: string
  /** The field's value as last saved (the form's baseline). */
  saved: () => unknown
}

/**
 * The record form says which record its fields belong to, and what each field's saved value
 * is (realtime round 3, item 8). A rich-text field co-edits only inside that form — the same
 * editor in a grid row, a dialog or a new record stays a plain editor.
 */
export interface CoeditFormInfo {
  collection: string
  item: string
  /** The field's value as last saved (the form's baseline). */
  saved(field: string): unknown
}

export const CoeditFormContext = createContext<CoeditFormInfo | null>(null)

/** The co-edit target for a field rendered for `collection`/`item`, when the form allows it. */
export function useCoeditTarget(
  collection: string,
  item: string | null | undefined,
  field: string
): CoeditFieldTarget | null {
  const form = useContext(CoeditFormContext)
  if (!form || !item || item === 'new' || form.collection !== collection) return null
  if (String(form.item) !== String(item)) return null
  return { collection, item: String(item), field, saved: () => form.saved(field) }
}

/** The fields that write together: the rich-text editor's interfaces (FieldRenderer's). */
export function isCoeditInterface(field: {
  interface?: string | null
  type?: string | null
}): boolean {
  const iface = field.interface ?? ''
  return (
    iface === 'input-rich-text-html' ||
    iface === 'rich_text' ||
    iface === 'extension-editorjs' ||
    field.type === 'rich_text'
  )
}
