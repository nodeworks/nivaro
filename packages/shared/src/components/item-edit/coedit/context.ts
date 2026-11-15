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

/**
 * Shared text under a held record lock (Rob, 2026-11-14): the rich-text fields people write
 * together stay open while someone else holds the record lock — every other field follows the
 * lock — and a save that changes only them neither takes the lock nor is refused by it. A
 * step's own edit lock (post-approval, admin-only) wins: then they are read-only too.
 */
export function sharedTextUnderLock(o: {
  sharedFields: ReadonlySet<string>
  /** Fields with unsaved changes. */
  unsavedFields: readonly string[]
  /** Unsaved changes that are not plain fields (lines, links, unlinks, line drafts). */
  otherChanges: number
  /** Someone else holds the record lock. */
  heldByOther: boolean
  /** The step's own edit lock refuses this person (post-approval / admin-only). */
  stepLocked: boolean
  recordGone: boolean
}): { onlySharedUnsaved: boolean; open: boolean; saveOk: boolean } {
  const onlySharedUnsaved =
    o.sharedFields.size > 0 &&
    o.unsavedFields.length > 0 &&
    o.otherChanges === 0 &&
    o.unsavedFields.every((f) => o.sharedFields.has(f))
  const open = o.sharedFields.size > 0 && o.heldByOther && !o.recordGone && !o.stepLocked
  return { onlySharedUnsaved, open, saveOk: open && onlySharedUnsaved }
}

/**
 * Which fields Save checks in the form (required, rules, limits). A save of shared text alone
 * under someone else's record lock checks only the fields it sends — every other field is
 * read-only to this person, so its gaps are not theirs to fill (the server still judges the
 * write). Otherwise: null = every field, as always.
 */
export function saveValidationScope(
  sharedTextSaveOk: boolean,
  unsavedFields: readonly string[]
): ReadonlySet<string> | null {
  return sharedTextSaveOk ? new Set(unsavedFields) : null
}
