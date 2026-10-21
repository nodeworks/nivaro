import { invalidateRecordLayoutQueries, LayoutEditor } from '@nivaro/shared'
import { useQueryClient } from '@tanstack/react-query'
import { AdminLayoutEditorHost } from '@/lib/layout-editor-host'

/**
 * A record page's Edit layout mode (spec §7.4): the layout editor as an
 * overlay on the layout this record resolved to, previewing this record.
 * Loaded lazily by ItemEdit, and only for admins, so nobody else downloads it.
 * Closing returns to the record at once; the record re-reads its layout once
 * the editor's last save has landed.
 */
export default function RecordLayoutEditor({
  collection,
  layoutId,
  recordId,
  onClose
}: {
  collection: string
  layoutId: number
  recordId: string | null
  /** Closed; `saved` settles once the editor's last save has landed. */
  onClose: (saved: Promise<void>) => void
}) {
  const qc = useQueryClient()
  const onBack = (saved: Promise<void>) => {
    onClose(saved)
    void saved.then(() => invalidateRecordLayoutQueries(qc, collection))
  }
  return (
    <AdminLayoutEditorHost collection={collection}>
      <LayoutEditor
        collection={collection}
        layoutId={layoutId}
        mode='overlay'
        previewRecordId={recordId}
        onBack={onBack}
      />
    </AdminLayoutEditorHost>
  )
}
