import { NivaroProvider, PipelineEditorView } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useParams } from 'react-router'
import { exportPipeline } from '@/lib/api'
import { useGoBack } from '@/lib/nav'

// The pipeline editor lives in @nivaro/shared (PipelineEditorView) so headless
// frontends can host it too — this page is the thin admin host, same pattern
// as CollectionBrowserV2Page / ItemEdit.
const client = createNivaro(window.location.origin)

export function PipelineEditPage() {
  const { id } = useParams<{ id: string }>()
  const goBack = useGoBack('/pipelines')

  if (!id) return null
  return (
    <NivaroProvider client={client}>
      <PipelineEditorView templateId={id} onBack={goBack} onExport={() => exportPipeline(id)} />
    </NivaroProvider>
  )
}
