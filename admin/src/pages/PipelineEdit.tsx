import { createNivaro } from '@nivaro/sdk'
import { ItemEditAuthContext, NivaroProvider, PipelineEditorView } from '@nivaro/shared'
import { useState } from 'react'
import { useParams } from 'react-router'
import { PipelineDiagram } from '@/components/diagram/DiagramPanels'
import { DiagramTabs, type EditorView } from '@/components/diagram/DiagramTabs'
import { PagePresence } from '@/components/page-presence'
import { exportPipeline } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useGoBack } from '@/lib/nav'

// The pipeline editor lives in @nivaro/shared (PipelineEditorView) so headless
// frontends can host it too — this page is the thin admin host, same pattern
// as CollectionBrowserV2Page / ItemEdit.
const client = createNivaro(window.location.origin, { timeoutMs: 90_000 })

export function PipelineEditPage() {
  const { id } = useParams<{ id: string }>()
  const goBack = useGoBack('/pipelines')
  const { user } = useAuth()
  const [view, setView] = useState<EditorView>('editor')

  if (!id) return null
  return (
    <NivaroProvider client={client}>
      <ItemEditAuthContext.Provider value={{ isAdmin: !!user?.is_admin, userId: user?.id ?? '' }}>
        <div className='relative flex flex-1 min-h-0 flex-col'>
          {/* #42 — who else is editing this template right now */}
          <div className='pointer-events-none absolute right-6 top-3 z-20'>
            <PagePresence />
          </div>
          <DiagramTabs value={view} onChange={setView} />
          {view === 'diagram' ? (
            <PipelineDiagram templateId={id} />
          ) : (
            <PipelineEditorView
              templateId={id}
              onBack={goBack}
              onExport={() => exportPipeline(id)}
            />
          )}
        </div>
      </ItemEditAuthContext.Provider>
    </NivaroProvider>
  )
}
