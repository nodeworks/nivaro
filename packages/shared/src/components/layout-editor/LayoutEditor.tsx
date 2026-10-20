import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { cn } from '../../lib/utils'
import { modalHostOf } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { AddPanel } from './AddPanel'
import { bundleToActiveLayout, previewForRole, roleMarker } from './bundle-to-active'
import { type DesignTarget, type LayoutDesign, targetKey } from './design-context'
import { LayoutDndProvider, useLayoutDnd } from './dnd/LayoutDndProvider'
import { EditorCanvas } from './EditorCanvas'
import { EditorTopBar, type PreviewAs } from './EditorTopBar'
import { versionsKey } from './HistoryPanel'
import { useLayoutEditorHost } from './host'
import { FormSettings, Inspector } from './inspector-slot'
import { LayoutsRail } from './LayoutsRail'
import type { DescribeField, Segment } from './overview/describe-conditions'
import {
  useApproxRecordCount,
  useInvalidateLayouts,
  useLayoutOverview,
  useOverviewFields,
  useRuleChoiceLabels
} from './overview/overview-api'
import { purposeSegments, Sentence } from './overview/purpose'
import type { OverviewRow } from './overview/types'
import { useRolePreview } from './settings/settings-api'
import { type LayoutDraft, layoutDraftKeys, parseBundle, useLayoutDraft } from './useLayoutDraft'

/**
 * The layout editor (spec §7.2): layouts rail and Add panel on the left, the
 * real form in design mode in the centre, the inspector (or Form settings) on
 * the right, and a top bar with Preview as, Show hidden, History, Undo / Redo
 * and the save status. One editor for every host: the Layouts tab (`page`)
 * and a record page's Edit layout mode (`overlay`, over the whole page).
 */
export interface LayoutEditorProps {
  collection: string
  layoutId: number
  onBack: () => void
  mode: 'page' | 'overlay'
  /** Another layout was picked in the rail — hosts mirror it into the URL. */
  onLayoutChange?: (layoutId: number) => void
  /** Open the preview on this record (the record page that opened the editor). */
  previewRecordId?: string | null
  /** Shown for layouts this editor cannot draw yet (grid columns). */
  onOpenClassic?: (layoutId: number) => void
  /** Overlay mode: where the overlay mounts. Default: the modal dialog/sheet
   *  the editor is declared in (its scroll/pointer lock would make a body
   *  portal dead), else document.body. */
  portalContainer?: HTMLElement | null
}

export const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  if (!t?.closest) return false
  return (
    t.isContentEditable ||
    !!t.closest(
      'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])'
    )
  )
}

/** ⌘Z / ⇧⌘Z / Ctrl+Y (Ctrl elsewhere) — never while typing, where the field's own undo wins. */
function useUndoKeys(draft: LayoutDraft) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)
      if (k !== 'z' && !redo) return
      if (isTyping(e.target)) return
      e.preventDefault()
      if (redo) draft.redo()
      else draft.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft.undo, draft.redo])
}

/** Unsent typing or a batch still in flight: warn before the tab closes, send what can be sent. */
function useLeaveGuard(draft: LayoutDraft) {
  const busy = draft.status === 'saving'
  useEffect(() => {
    if (!busy) return
    const onBefore = (e: BeforeUnloadEvent) => {
      draft.flush()
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [busy, draft.flush])
  useEffect(() => {
    const onHide = () => draft.flush()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [draft.flush])
}

/** Every save refreshes History and whatever shows this collection's layouts. */
function useSavedRefresh(draft: LayoutDraft, layoutId: number, collection: string) {
  const qc = useQueryClient()
  const invalidateLayouts = useInvalidateLayouts(collection)
  const rev = draft.bundle?.rev
  useEffect(() => {
    if (draft.status !== 'saved' || !rev) return
    void qc.invalidateQueries({ queryKey: versionsKey(layoutId) })
    invalidateLayouts()
  }, [draft.status, rev, layoutId, qc, invalidateLayouts])
}

function useParentBundle(parentId: number | null) {
  const client = useNivaroClient()
  return useQuery<LayoutBundle | null>({
    queryKey: layoutDraftKeys.bundle(parentId ?? 0),
    queryFn: async () =>
      parseBundle(await client.request<unknown>(get(`/collection-layouts/${parentId}/bundle`))),
    enabled: parentId != null,
    staleTime: 30_000
  })
}

function usePreviewRecord(collection: string, id: string | null) {
  const client = useNivaroClient()
  return useQuery<Record<string, unknown> | null>({
    queryKey: ['layout-editor', 'preview-record', collection, id],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> | null }>(
          get(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`)
        )
        .then((r) => r.data ?? null),
    enabled: id != null,
    staleTime: 30_000
  })
}

/** Is `t` still on the layout (or supplied by its parent)? Undo, redo and other
 *  writers can take the selected thing away. */
export function targetExists(
  t: DesignTarget,
  bundle: LayoutBundle,
  parent: LayoutBundle | null = null
): boolean {
  const has = (b: LayoutBundle) => {
    if (t.kind === 'group') return t.key === UNGROUPED_KEY || b.groups.some((g) => g.key === t.key)
    const gk = t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key
    return b.placements.some((p) => p.field === t.field && p.group_key === gk)
  }
  return has(bundle) || (parent != null && has(parent))
}

/**
 * Overlay mode behaves as a modal dialog: focus moves in on open and back to
 * whatever opened it on close; Escape leaves (onBack) unless a popover or
 * menu is open, the key is typed into a field, or a drag is on (`dragging`):
 * this handler is registered before dnd-kit's, so it would run first and
 * close the editor mid-drag instead of cancelling the drag.
 */
function useOverlayDialog(active: boolean, onBack: () => void, dragging: { current: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const backRef = useRef(onBack)
  backRef.current = onBack
  useEffect(() => {
    if (!active) return
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dragging.current || isTyping(e.target)) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]')) return
      e.preventDefault()
      backRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener?.isConnected) opener.focus()
    }
  }, [active, dragging])
  return ref
}

/** The canvas, inside the drag-and-drop layer so it can read LayoutDesign.dnd. Nodes a
 *  parent layout supplies never drag (DesignNode locks them). */
function Canvas({
  collection,
  bundle,
  parent,
  preview,
  record,
  selected,
  onSelect,
  showHidden,
  apply,
  onOpenClassic
}: {
  collection: string
  bundle: LayoutBundle
  parent: LayoutBundle | null
  preview: PreviewAs
  record: Record<string, unknown> | null
  selected: DesignTarget | null
  onSelect: (t: DesignTarget) => void
  showHidden: boolean
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  onOpenClassic?: () => void
}) {
  const dnd = useLayoutDnd()
  const canvas = useMemo(() => bundleToActiveLayout(bundle, parent), [bundle, parent])
  const layout = useMemo(
    () => previewForRole(canvas.active, preview.roleId, showHidden),
    [canvas.active, preview.roleId, showHidden]
  )
  // Field permissions of the previewed role (groups it loses are dropped above).
  const { data: rolePreview = null } = useRolePreview(collection, preview.roleId)
  const roleMark = useMemo(
    () => (preview.roleId ? roleMarker(rolePreview) : undefined),
    [preview.roleId, rolePreview]
  )
  const design = useMemo<LayoutDesign>(
    () => ({
      selected,
      onSelect,
      showHidden,
      inheritedFrom: (t) => canvas.inherited.get(targetKey(t)) ?? null,
      dnd,
      roleMark
    }),
    [selected, onSelect, showHidden, canvas.inherited, dnd, roleMark]
  )
  return (
    <EditorCanvas
      collection={collection}
      bundle={bundle}
      layout={layout}
      record={record}
      design={design}
      apply={apply}
      onOpenClassic={onOpenClassic}
    />
  )
}

/** Overlay mode (record page): which layout this is and which records get it (spec §7.4). */
function EditingBanner({
  collection,
  name,
  row,
  rows,
  fields,
  onDone
}: {
  collection: string
  name: string
  row: OverviewRow | undefined
  rows: OverviewRow[]
  fields: DescribeField[]
  onDone: () => void
}) {
  const choices = useRuleChoiceLabels(collection, fields, rows)
  const { data: count } = useApproxRecordCount(collection, row, rows)
  const segs: Segment[] = !row
    ? []
    : row.section === 'forms' && (row.reason.kind === 'default' || row.reason.kind === 'fallback')
      ? [{ text: 'used by every record no rule catches' }]
      : purposeSegments(row, fields, choices)
  if (segs.length > 0 && typeof count === 'number')
    segs.push({ text: ` (≈ ${count.toLocaleString()} ${count === 1 ? 'record' : 'records'})` })
  return (
    <div
      data-editing-banner=''
      className='flex shrink-0 items-center gap-3 border-b border-nvr-cyan/30 bg-nvr-cyan/10 px-4 py-1.5 text-[12.5px] text-slate-700 dark:text-slate-200'
    >
      <p className='m-0 min-w-0 flex-1 truncate'>
        Editing <b className='font-semibold text-slate-900 dark:text-foreground'>{name}</b>
        {segs.length > 0 && (
          <>
            {' — '}
            <Sentence segs={segs} muted />
          </>
        )}
      </p>
      <button
        type='button'
        onClick={onDone}
        className='inline-flex h-7 shrink-0 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90'
      >
        Done
      </button>
    </div>
  )
}

const leftTab = (on: boolean) =>
  cn(
    'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors',
    on
      ? 'bg-accent text-slate-900 dark:text-foreground'
      : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
  )

export function LayoutEditor({
  collection,
  layoutId,
  onBack,
  mode,
  onLayoutChange,
  previewRecordId = null,
  onOpenClassic,
  portalContainer
}: LayoutEditorProps) {
  const host = useLayoutEditorHost()
  const [currentId, setCurrentId] = useState(layoutId)
  useEffect(() => setCurrentId(layoutId), [layoutId])
  const draft = useLayoutDraft(currentId)
  const bundle = draft.bundle

  const [left, setLeft] = useState<'layouts' | 'add'>('layouts')
  const [panel, setPanel] = useState<'inspector' | 'settings'>('inspector')
  const [selected, setSelected] = useState<DesignTarget | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [preview, setPreview] = useState<PreviewAs>({
    record: previewRecordId ? { id: previewRecordId, label: `#${previewRecordId}` } : null,
    roleId: null
  })

  const { data: overview } = useLayoutOverview(collection)
  const { data: fields = [] } = useOverviewFields(collection)
  const row = overview?.rows.find((r) => r.layout_id === currentId)
  const parentId =
    bundle?.layout.parent_layout_id != null ? Number(bundle.layout.parent_layout_id) : null
  const { data: parent = null } = useParentBundle(parentId)
  const { data: record = null } = usePreviewRecord(collection, preview.record?.id ?? null)

  useUndoKeys(draft)
  useLeaveGuard(draft)
  useSavedRefresh(draft, currentId, collection)

  // Undo, redo or another writer removed what was selected: nothing is.
  useEffect(() => {
    if (selected && bundle && !targetExists(selected, bundle, parent)) setSelected(null)
  }, [selected, bundle, parent])

  const overlay = mode === 'overlay'
  // Where the overlay mounts: resolved from a marker where it is declared.
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null)
  const dragging = useRef(false)
  const onDragActive = useCallback((on: boolean) => {
    dragging.current = on
  }, [])
  const dialogRef = useOverlayDialog(overlay && marker != null, onBack, dragging)

  const onSelect = useCallback((t: DesignTarget) => {
    setSelected(t)
    setPanel('inspector')
  }, [])

  // Form settings' "Preview as role" and the top bar's role are one choice.
  const onPreviewRoleChange = useCallback(
    (roleId: string | null) => setPreview((p) => (p.roleId === roleId ? p : { ...p, roleId })),
    []
  )

  const openLayout = (id: number) => {
    setPanel('inspector')
    if (id === currentId) return
    draft.flush()
    setSelected(null)
    setCurrentId(id)
    onLayoutChange?.(id)
  }

  const layoutName = String(bundle?.layout.name ?? row?.name ?? '')
  const layoutType = String(bundle?.layout.layout_type ?? row?.layout_type ?? 'grouped')
  const warning = host.warning ?? overview?.warning ?? null

  // Overlay mode is a modal dialog over the record page.
  const dialogProps = overlay
    ? {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': `Edit layout ${layoutName}`,
        tabIndex: -1
      }
    : {}
  const body: ReactNode = (
    <div
      ref={overlay ? dialogRef : undefined}
      data-layout-editor=''
      data-mode={mode}
      {...dialogProps}
      className={cn(
        'flex min-h-0 flex-col bg-slate-50 outline-none dark:bg-background',
        overlay ? 'fixed inset-0 z-[90]' : 'flex-1'
      )}
    >
      <EditorTopBar
        collection={collection}
        layoutId={currentId}
        layoutName={layoutName}
        layoutType={layoutType}
        row={row}
        fields={fields}
        draft={draft}
        preview={preview}
        onPreview={setPreview}
        showHidden={showHidden}
        onShowHidden={setShowHidden}
        onBack={onBack}
        backLabel={overlay ? 'Back to record' : 'Layouts'}
      />
      {overlay && (
        <EditingBanner
          collection={collection}
          name={layoutName}
          row={row}
          rows={overview?.rows ?? []}
          fields={fields}
          onDone={onBack}
        />
      )}
      {warning && (
        <div
          role='note'
          className='flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
        >
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          {warning}
        </div>
      )}
      {/* Drag and drop spans the whole body: Add panel rows drag onto the canvas. */}
      <LayoutDndProvider bundle={bundle} apply={draft.apply} onDragActive={onDragActive}>
        <div className='flex min-h-0 flex-1 overflow-hidden'>
          <aside className='flex w-[260px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
            <div
              role='tablist'
              aria-label='Left panel'
              className='flex shrink-0 items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-border'
            >
              <button
                type='button'
                role='tab'
                aria-selected={left === 'layouts'}
                data-editor-tab='layouts'
                className={leftTab(left === 'layouts')}
                onClick={() => setLeft('layouts')}
              >
                Layouts
              </button>
              <button
                type='button'
                role='tab'
                aria-selected={left === 'add'}
                data-editor-tab='add'
                className={leftTab(left === 'add')}
                onClick={() => setLeft('add')}
                disabled={!bundle}
                data-tip='Add a field, section, panel or widget after the selection'
              >
                <Plus className='h-3.5 w-3.5' />
                Add
              </button>
            </div>
            <div className='min-h-0 flex-1 overflow-y-auto'>
              {left === 'add' && bundle ? (
                <AddPanel
                  bundle={bundle}
                  collection={collection}
                  selected={selected}
                  apply={draft.apply}
                  onSelect={onSelect}
                />
              ) : (
                <LayoutsRail
                  collection={collection}
                  currentId={currentId}
                  onOpen={openLayout}
                  settingsOpen={panel === 'settings'}
                  onSettings={() => setPanel('settings')}
                />
              )}
            </div>
          </aside>
          <main className='min-w-0 flex-1 overflow-y-auto'>
            {bundle ? (
              <Canvas
                collection={collection}
                bundle={bundle}
                parent={parent}
                preview={preview}
                record={record}
                selected={selected}
                onSelect={onSelect}
                showHidden={showHidden}
                apply={draft.apply}
                onOpenClassic={onOpenClassic ? () => onOpenClassic(currentId) : undefined}
              />
            ) : draft.error ? (
              <p className='p-6 text-[13px] text-red-700 dark:text-red-300'>{draft.error}</p>
            ) : (
              <div className='flex flex-col gap-3 p-6'>
                <Skeleton className='h-10 w-full rounded-lg' />
                <Skeleton className='h-48 w-full rounded-lg' />
              </div>
            )}
          </main>
          <aside
            data-editor-inspector=''
            className='w-[320px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white dark:border-border dark:bg-card'
          >
            {bundle &&
              (panel === 'settings' ? (
                <FormSettings
                  bundle={bundle}
                  apply={draft.apply}
                  flush={draft.flush}
                  collection={collection}
                  previewRoleId={preview.roleId}
                  onPreviewRoleChange={onPreviewRoleChange}
                />
              ) : (
                <Inspector
                  bundle={bundle}
                  target={selected}
                  apply={draft.apply}
                  flush={draft.flush}
                  collection={collection}
                  openLayout={openLayout}
                />
              ))}
          </aside>
        </div>
      </LayoutDndProvider>
    </div>
  )

  if (!overlay) return body
  // Fixed under the page outlet would be offset by its transform: portal out —
  // into the hosting modal when there is one (a body portal would sit under
  // its pointer/scroll lock), else body.
  const container = portalContainer ?? (marker ? (modalHostOf(marker) ?? document.body) : null)
  return (
    <>
      <span ref={setMarker} hidden data-layout-editor-marker='' />
      {container && createPortal(body, container)}
    </>
  )
}
