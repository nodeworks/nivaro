import { type ComponentProps, type ReactNode, useMemo } from 'react'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import { ItemEditForm } from '../ItemEditForm'
import { PlacementTextContext } from '../item-edit/placement-behaviour'
import type { ActiveLayoutData } from '../item-edit/types'
import { RecordReadView } from '../RecordReadView'
import { PdfCanvas } from './canvases/PdfCanvas'
import { TableColumnsCanvas } from './canvases/TableColumnsCanvas'
import { type LayoutDesign, LayoutDesignContext } from './design-context'
import { useOverviewFields } from './overview/overview-api'

// The centre of the editor: the layout drawn by the renderer its type really
// uses (spec §7.7) — the record form for forms and addendums, the read view
// for summary and detail, the PDF sections for file layouts. Grid-column
// (table) layouts get the column strip.

export type CanvasRenderer = 'item-edit-form' | 'read-view' | 'pdf' | 'table'

export function canvasRenderer(layoutType: string): CanvasRenderer {
  switch (layoutType) {
    case 'summary':
    case 'detail':
      return 'read-view'
    case 'file':
      return 'pdf'
    case 'table':
      return 'table'
    default:
      return 'item-edit-form'
  }
}

function TableWithFields(props: ComponentProps<typeof TableColumnsCanvas>) {
  const { data: fields = [] } = useOverviewFields(props.collection)
  return <TableColumnsCanvas {...props} fields={fields} />
}

function PdfWithFields(props: ComponentProps<typeof PdfCanvas>) {
  const { data: fields = [] } = useOverviewFields(props.collection)
  return <PdfCanvas {...props} fields={fields} />
}

export function EditorCanvas({
  collection,
  bundle,
  layout,
  record,
  stateKey = null,
  roleId = null,
  design,
  apply,
  whenIdle
}: {
  collection: string
  bundle: LayoutBundle
  layout: ActiveLayoutData
  record: Record<string, unknown> | null
  /** Preview as if the record were in this pipeline state (form only). */
  stateKey?: string | null
  /** Preview as this role: labels and help that change by role follow it (#2703). */
  roleId?: string | null
  design: LayoutDesign
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  /** The draft's whenIdle: the PDF preview waits for the last save. */
  whenIdle?: () => Promise<void>
}) {
  const renderer = canvasRenderer(String(bundle.layout.layout_type ?? 'grouped'))
  const placementText = useMemo(() => ({ stateKey, roleId }), [stateKey, roleId])
  let body: ReactNode
  if (renderer === 'item-edit-form')
    body = (
      <ItemEditForm
        collection={collection}
        documentTitle={false}
        design={{ layout, record, context: design, stateKey }}
      />
    )
  else if (renderer === 'read-view')
    body = <RecordReadView collection={collection} design={{ layout, record, context: design }} />
  else if (renderer === 'pdf')
    body = (
      <LayoutDesignContext.Provider value={design}>
        <PdfWithFields bundle={bundle} collection={collection} whenIdle={whenIdle} />
      </LayoutDesignContext.Provider>
    )
  else
    body = (
      <LayoutDesignContext.Provider value={design}>
        <TableWithFields bundle={bundle} apply={apply} collection={collection} />
      </LayoutDesignContext.Provider>
    )
  return (
    <div data-editor-canvas='' data-renderer={renderer} className='flex min-h-full flex-col'>
      <PlacementTextContext.Provider value={placementText}>{body}</PlacementTextContext.Provider>
    </div>
  )
}
