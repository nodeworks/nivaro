// Investigation group "actions" (Traffic Map drill-down Task 8): the `notebook` inspectable, the
// panel header actions (explain, live tail, save, share, export) and the toolbar's saved
// Investigations list. Imported once from registry/index.ts; edit only this folder.
import { inspectables } from '../../registry/inspectables'
import { inspectHeaderActions } from '../../registry/inspectHeaderActions'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { ExplainAction, ExportAction, SaveAction, ShareAction } from './actions'
import { InvestigationsList } from './InvestigationsList'
import { LiveTailAction, TAIL_KINDS } from './LiveTail'
import { NotebookPanel } from './NotebookPanel'

register(inspectables, {
  id: 'notebook',
  label: 'Investigation',
  Panel: NotebookPanel,
  title: (ref) => ref.label ?? 'Saved investigation'
})

register(inspectHeaderActions, { id: 'explain', order: 60, Component: ExplainAction })
register(inspectHeaderActions, {
  id: 'live-tail',
  order: 62,
  applies: (ref) => TAIL_KINDS.has(ref.kind),
  Component: LiveTailAction
})
register(inspectHeaderActions, {
  id: 'save-investigation',
  order: 64,
  applies: (ref) => ref.kind !== 'notebook',
  Component: SaveAction
})
register(inspectHeaderActions, { id: 'share', order: 66, Component: ShareAction })
register(inspectHeaderActions, { id: 'export', order: 68, Component: ExportAction })

register(toolbarItems, {
  id: 'investigations',
  slot: 'actions',
  order: 40,
  Component: InvestigationsList
})
