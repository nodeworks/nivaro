import { useQuery } from '@tanstack/react-query'
import { useEditorApi } from './editor-api'

/**
 * Query keys the layout editor's own readers share. Namespaced: screens
 * elsewhere keep other shapes under the bare ['field-config', c] (the body or
 * the array) and ['relations-for', c], and one shape read as the other
 * blanks a picker or crashes a render.
 */
export const editorQueryKeys = {
  /** A collection's field rows (GET /field-config/:c), always the array. */
  fieldList: (collection: string | null | undefined) =>
    ['layout-editor', 'field-list', collection] as const,
  /** Relations touching a collection (GET /data-model/relations/for/:c), always the array. */
  relationsFor: (collection: string | null | undefined) =>
    ['layout-editor', 'relations-for', collection] as const
}

export interface EditorFieldRow {
  field: string
  type?: string
  label?: string | null
  options?: unknown
}

/** A collection's fields as the array, under the editor's own key. */
export function useEditorFieldList(collection: string | null | undefined) {
  const api = useEditorApi()
  return useQuery<EditorFieldRow[]>({
    queryKey: editorQueryKeys.fieldList(collection),
    queryFn: () =>
      api.get(`/field-config/${collection}`).then((r) => {
        const rows = r.data?.data ?? r.data
        return Array.isArray(rows) ? rows : []
      }),
    enabled: !!collection,
    staleTime: 60_000
  })
}
