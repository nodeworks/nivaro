import { LayoutEditor } from '@nivaro/shared'
import { AdminLayoutEditorHost } from '@/lib/layout-editor-host'

/**
 * A record page's Edit layout mode (spec §7.4): the layout editor as an
 * overlay on the layout this record resolved to, previewing this record.
 * Loaded lazily by ItemEdit, and only for admins, so nobody else downloads it.
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
  onClose: () => void
}) {
  return (
    <AdminLayoutEditorHost collection={collection}>
      <LayoutEditor
        collection={collection}
        layoutId={layoutId}
        mode='overlay'
        previewRecordId={recordId}
        onBack={onClose}
      />
    </AdminLayoutEditorHost>
  )
}
