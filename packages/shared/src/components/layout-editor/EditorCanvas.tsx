import { Table2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LayoutBundle } from '../../lib/layout-ops'
import { ItemEditForm } from '../ItemEditForm'
import type { ActiveLayoutData } from '../item-edit/types'
import { RecordReadView } from '../RecordReadView'
import { PdfCanvas } from './canvases/PdfCanvas'
import { type LayoutDesign, LayoutDesignContext } from './design-context'

// The centre of the editor: the layout drawn by the renderer its type really
// uses (spec §7.7) — the record form for forms and addendums, the read view
// for summary and detail, the PDF sections for file layouts. Grid-column
// (table) layouts keep the classic editor until their canvas lands.

export type CanvasRenderer = 'item-edit-form' | 'read-view' | 'pdf' | 'classic'

export function canvasRenderer(layoutType: string): CanvasRenderer {
  switch (layoutType) {
    case 'summary':
    case 'detail':
      return 'read-view'
    case 'file':
      return 'pdf'
    case 'table':
      return 'classic'
    default:
      return 'item-edit-form'
  }
}

export function EditorCanvas({
  collection,
  bundle,
  layout,
  record,
  design,
  onOpenClassic
}: {
  collection: string
  bundle: LayoutBundle
  layout: ActiveLayoutData
  record: Record<string, unknown> | null
  design: LayoutDesign
  onOpenClassic?: () => void
}) {
  const renderer = canvasRenderer(String(bundle.layout.layout_type ?? 'grouped'))
  let body: ReactNode
  if (renderer === 'item-edit-form')
    body = (
      <ItemEditForm
        collection={collection}
        documentTitle={false}
        design={{ layout, record, context: design }}
      />
    )
  else if (renderer === 'read-view')
    body = <RecordReadView collection={collection} design={{ layout, record, context: design }} />
  else if (renderer === 'pdf')
    body = (
      <LayoutDesignContext.Provider value={design}>
        <PdfCanvas bundle={bundle} collection={collection} />
      </LayoutDesignContext.Provider>
    )
  else
    body = (
      <div className='m-auto flex max-w-[420px] flex-col items-center gap-2 py-16 text-center'>
        <Table2 className='h-6 w-6 text-slate-400' />
        <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Grid columns are edited in the classic editor for now
        </p>
        <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          This layout sets the columns when the records show as a grid inside another record.
        </p>
        {onOpenClassic && (
          <button
            type='button'
            onClick={onOpenClassic}
            className='mt-1 text-[12.5px] font-medium text-[#0089ad] underline-offset-2 hover:underline dark:text-nvr-cyan'
          >
            Open in classic editor
          </button>
        )}
      </div>
    )
  return (
    <div data-editor-canvas='' data-renderer={renderer} className='flex min-h-full flex-col'>
      {body}
    </div>
  )
}
