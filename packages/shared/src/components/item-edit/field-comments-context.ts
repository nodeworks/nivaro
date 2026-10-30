import { createContext, useContext } from 'react'

/**
 * #3232 — what the record form hands every field label (and the record's
 * Comments panel) about comments left on single fields. A leaf module: the
 * comments panel and the field-comment popover both read it without importing
 * each other. Null outside a saved record form = no field comments.
 */
export interface FieldCommentsApi {
  collection: string
  item: string
  /** Open (unresolved) field comments per field. */
  counts: Record<string, number>
  /** The field whose comment popover is open (a `?field=` link opens one). */
  openField: string | null
  setOpenField: (field: string | null) => void
  /** The label the form shows for a field (layout renames included). */
  labelOf: (field: string) => string
  /** Bring the field into view and flash it (switches step/tab when needed). */
  jump: (field: string) => void
}

export const FieldCommentsContext = createContext<FieldCommentsApi | null>(null)

export const useFieldComments = () => useContext(FieldCommentsContext)
