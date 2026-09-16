import { NivaroProvider, PipelineEditorView } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useParams } from 'react-router'
import { exportPipeline } from '@/lib/api'
import { PagePresence } from '@/components/page-presence'
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
      <div className='relative flex flex-1 min-h-0 flex-col'>
        {/* #42 — who else is editing this template right now */}
        <div className='pointer-events-none absolute right-6 top-3 z-20'>
          <PagePresence />
        </div>
        <PipelineEditorView templateId={id} onBack={goBack} onExport={() => exportPipeline(id)} />
      </div>
    </NivaroProvider>
  )
}
