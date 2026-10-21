import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  BarChart3,
  Grid3x3,
  LayoutGrid,
  ListOrdered,
  Lock,
  Percent,
  Plus,
  Table2,
  Users
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { activeFreeze, dayWords, type LayoutFreeze } from '../../lib/layout-resolve'
import { useMyUserId } from '../../lib/presence-signals'
import { cn } from '../../lib/utils'
import { modalHostOf } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { AddPanel } from './AddPanel'
import { AutoArrangeButton } from './AutoArrange'
import { AiToolsButton } from './ai/AiToolsButton'
import { type AiPin, mergeMarks, pinsToMarks } from './ai/ai-tools-api'
import { AiFormsButton } from './ai-forms/AiFormsButton'
import { AskButton, AskPanel } from './assist/AskPanel'
import { type AskCite, useAskThread } from './assist/assist-api'
import { jumpToSetting } from './assist/jump'
import { ProposalsButton } from './assist/ProposalsButton'
import type { SettingEntry } from './assist/settings-index'
import { BulkChangesButton } from './bulk/BulkChangesButton'
import { useMacroRecorder } from './bulk/useMacroRecorder'
import { bundleToActiveLayout, previewForRole, roleMarker } from './bundle-to-active'
import { type CanvasCompare, CompareBanner, useCanvasCompare } from './CanvasCompare'
import {
  ChangeNoteFields,
  ChangeNoteSave,
  type ChangeNoteValue,
  changeNoteMeta,
  changeNotePolicyOf,
  changeNoteReady
} from './ChangeNote'
import { DroppedBanner, PresenceAvatars, RecoveryBanner, UnsavedList } from './CollabParts'
import { CommandPalette } from './commands/CommandPalette'
import {
  type DesignMark,
  type DesignOverlay,
  type DesignPeer,
  type DesignTarget,
  type FoldSignal,
  type LastChange,
  type LayoutDesign,
  nextSelection,
  type RevealSignal,
  type SelectOptions,
  targetKey
} from './design-context'
import { WIDTH_LABELS } from './field-zones'
import { LayoutDndProvider, useLayoutDnd } from './dnd/LayoutDndProvider'
import { NO_DND } from './dnd/node'
import { stagedTip, useDraftRecovery } from './draft-recovery'
import { canvasRenderer, EditorCanvas } from './EditorCanvas'
import { EditorTopBar, type PreviewAs } from './EditorTopBar'
import { noteKey, notesOf } from './editor-notes'
import { EntryEditorContext } from './entry/entry-editor-context'
import { TabOrderBar, useTabOrderEditor } from './entry/tab-order'
import { previewThemeClass, ThemePreviewTool, useAppIsDark } from './entry/theme-preview'
import { explainMarks, RuleLoopsBanner, RulesToggle, useRulesView } from './explain/CanvasRules'
import { useDriverHover } from './explain/driver-hover'
import type { OpenSource } from './explain/field-sources'
import type { RuleDep } from './explain/rule-graph'
import { useCanvasExplain, useDefaultGhosts } from './explain/use-explain'
import { FindReplaceButton } from './FindReplace'
import { OutputsButton } from './outputs/OutputsButton'
import { FormMapButton } from './FormMapButton'
import { useSectionChanges } from './history-api'
import { useLayoutEditorHost } from './host'
import { overriddenTargets, overrideMark } from './inheritance'
import { BulkInspector } from './inspector/BulkInspector'
import { requestInspectorTab } from './inspector/tab-request'
import { FormSettings, Inspector } from './inspector-slot'
import { isTyping } from './is-typing'
import { ARROW_DIRS, altArrowMove } from './keyboard-move'
import { LayoutsRail } from './LayoutsRail'
import { LintButton, LintPanel } from './lint/LintPanel'
import { useLayoutLint } from './lint/lint-api'
import { FieldStateMatrix } from './matrix/FieldStateMatrix'
import { RoleSectionMatrix } from './matrix/RoleSectionMatrix'
import { FindTool, OutlineTool, ShortcutsTool, ViewTools } from './nav/NavTools'
import { OutlinePanel } from './nav/OutlinePanel'
import { useEditorNav } from './nav/useEditorNav'
import { COMPACT_ZOOM } from './nav/view-prefs'
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
import { PlacementsTable } from './PlacementsTable'
import { amberStrip, segOption, segTrack } from './panel-style'
import { peersByTarget, useLayoutPresence } from './presence'
import { PreviewModes } from './preview/PreviewModes'
import { PreviewPanes } from './preview/PreviewPanes'
import { FormMoreMenu } from './reuse/FormMoreMenu'
import { useRailCopy } from './reuse/useRailCopy'
import { StagedByOthers } from './StagedChip'
import { StructureActions, usePinMarks } from './StructureMenu'
import { useRolePreview } from './settings/settings-api'
import { layoutKindOf } from './settings/settings-registry'
import { useStagedDraft, useStagedWriter } from './staged-api'
import { ImpactButton, TestingButton } from './testing/TestingPanels'
import { MenuSeparator, ToolButton } from './toolbar-kit'
import { type LeaveRequest, UnsavedConfirm, unsavedText } from './UnsavedConfirm'
import { describeTarget, targetFromKey, unsavedKeys } from './unsaved-marks'
import { UsagePanel } from './usage/UsagePanel'
import {
  usageTodayText,
  useFieldFillRates,
  useLayoutUsageToday,
  useShowFillRates
} from './usage/usage-api'
import {
  type LayoutDraft,
  layoutDraftKeys,
  touchesOverview,
  useLayoutBundle,
  useLayoutDraft
} from './useLayoutDraft'

/**
 * The layout editor (spec §7.2): layouts rail and Add panel on the left, the
 * real form in design mode in the centre, the inspector (or Form settings) on
 * the right, and a top bar with Preview as, Show hidden, History, Undo / Redo
 * and the save status. One editor for every host: the Layouts tab (`page`)
 * and a record page's Edit layout mode (`overlay`, over the whole page).
 * Changes wait for Save unless the top bar's Autosave is on (#2619); leaving
 * with unsaved changes asks first (Save / Discard / Keep editing).
 */
export interface LayoutEditorProps {
  collection: string
  layoutId: number
  /**
   * Leave the editor. `saved` resolves once the last edit has reached the
   * server (or failed): hosts close at once and re-read what the record page
   * renders after it (invalidateRecordLayoutQueries), so the refetch cannot
   * beat the save.
   */
  onBack: (saved: Promise<void>) => void
  mode: 'page' | 'overlay'
  /** Another layout was picked in the rail — hosts mirror it into the URL. */
  onLayoutChange?: (layoutId: number) => void
  /** Open the preview on this record (the record page that opened the editor). */
  previewRecordId?: string | null
  /** Overlay mode: where the overlay mounts. Default: the modal dialog/sheet
   *  the editor is declared in (its scroll/pointer lock would make a body
   *  portal dead), else document.body. */
  portalContainer?: HTMLElement | null
  /** Unsaved changes appeared / went — for hosts that guard their own navigation. */
  onDirtyChange?: (dirty: boolean) => void
}

export { isTyping }

/** ⌘Z / ⇧⌘Z / Ctrl+Y (Ctrl elsewhere) — never while typing, where the field's own undo wins.
 *  ⌘S / Ctrl+S saves, typing or not (typed text is already in the draft). */
function useUndoKeys(draft: LayoutDraft) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 's' && !e.shiftKey) {
        e.preventDefault()
        if (draft.autosave) draft.flush()
        else void draft.save()
        return
      }
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)
      if (k !== 'z' && !redo) return
      if (isTyping(e.target)) return
      e.preventDefault()
      if (redo) draft.redo()
      else draft.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft.undo, draft.redo, draft.autosave, draft.flush, draft.save])
}

/**
 * Alt+arrow moves the one selected field or section (#2603): one keystroke,
 * one apply, one undo step. Never while typing, during a keyboard or pointer
 * drag (Space picks up, arrows move the drag), or with a popover or menu open.
 * Focus follows the moved node so the next Alt+arrow continues from it.
 */
function useAltArrowKeys(
  bundle: LayoutBundle | null,
  selection: DesignTarget[],
  apply: LayoutDraft['apply'],
  dragging: { current: boolean },
  onMoved: (next: DesignTarget) => void
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = ARROW_DIRS[e.key]
      if (!dir || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.defaultPrevented) return
      if (!bundle || selection.length !== 1 || dragging.current || isTyping(e.target)) return
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="menu"]')) return
      e.preventDefault()
      const move = altArrowMove(bundle, selection[0], dir)
      if (!move) return
      apply(move.ops, { label: move.label })
      onMoved(move.next)
      const key = targetKey(move.next)
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-layout-editor] [data-design-target="${CSS.escape(key)}"]`
        )
        el?.focus({ preventScroll: true })
        el?.scrollIntoView?.({ block: 'nearest' })
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bundle, selection, apply, dragging, onMoved])
}

/** Unsent typing, a batch in flight or unsaved changes: warn before the tab closes, send what can be sent. */
function useLeaveGuard(draft: LayoutDraft) {
  const busy = draft.status === 'saving' || draft.dirty
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

/**
 * Every save refreshes History and whatever shows this collection's layouts:
 * at once when the batch changed what the overview says (name, rules, link,
 * New menu, kind, parent), otherwise only marked stale (refetched when shown).
 * Runs from the draft engine, so a save that lands after the editor closed
 * still refreshes.
 */
function useSavedRefresh(collection: string) {
  const qc = useQueryClient()
  const invalidateLayouts = useInvalidateLayouts(collection)
  return useCallback(
    (bundle: LayoutBundle, ops: LayoutOp[] | null) => {
      const id = Number(bundle.layout.id)
      if (Number.isFinite(id)) void qc.invalidateQueries({ queryKey: layoutDraftKeys.versions(id) })
      invalidateLayouts({ lazy: !touchesOverview(ops) })
    },
    [qc, invalidateLayouts]
  )
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

/**
 * In-app links clicked while there are unsaved changes (a sidebar item, a
 * breadcrumb): held, and `ask` decides; `go` follows the link after all. Works
 * in every host without a data router (admin's BrowserRouter has no
 * useBlocker): React Router's Link skips a click whose default was prevented.
 */
function useLinkGuard(dirty: boolean, ask: (go: () => void, anchor: HTMLElement) => void) {
  const askRef = useRef(ask)
  askRef.current = ask
  useEffect(() => {
    if (!dirty) return
    let passing = false
    const onClick = (e: MouseEvent) => {
      if (passing || e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
      let url: URL
      try {
        url = new URL(a.href, window.location.href)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return
      if (url.pathname + url.search === window.location.pathname + window.location.search) return
      e.preventDefault()
      e.stopPropagation()
      askRef.current(() => {
        passing = true
        try {
          a.click()
        } finally {
          passing = false
        }
      }, a)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty])
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
  roleId,
  stateKey = null,
  marks,
  overlay,
  ruleMarks,
  ghost,
  deps,
  noDnd = false,
  record,
  selected,
  selection,
  onSelect,
  showHidden,
  fold = null,
  reveal = null,
  apply,
  whenIdle,
  fillRate,
  unsaved,
  peers,
  compare,
  lastChanges
}: {
  collection: string
  bundle: LayoutBundle
  parent: LayoutBundle | null
  /** Expand all / Collapse all and Find's reveal (#2627 #2620). */
  fold?: FoldSignal | null
  reveal?: RevealSignal | null
  /** Preview as this role (null: any role). */
  roleId: string | null
  /** Preview as if the record were in this pipeline state. */
  stateKey?: string | null
  marks?: (t: DesignTarget) => DesignMark[]
  overlay?: (t: DesignTarget) => DesignOverlay | null
  /** The Rules view's tags (explain/CanvasRules), after the preview modes' own. */
  ruleMarks?: (t: DesignTarget) => DesignMark[]
  /** Default-value ghosts (#2633). */
  ghost?: (field: string) => string | null
  /** What each field drives: hovering a driver rings what it controls (#2641). */
  deps: RuleDep[]
  /** The second pane of a side-by-side preview: selectable, never draggable. */
  noDnd?: boolean
  record: Record<string, unknown> | null
  selected: DesignTarget | null
  selection: DesignTarget[]
  onSelect: (t: DesignTarget, opts?: SelectOptions) => void
  showHidden: boolean
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  whenIdle: () => Promise<void>
  /** "N% filled" hints on fields (#2588); undefined = off. */
  fillRate?: (field: string) => number | null
  /** Nodes an unsaved change touched (#2629). */
  unsaved?: (t: DesignTarget) => boolean
  /** Other people's selections (#2651). */
  peers?: (t: DesignTarget) => DesignPeer[]
  /** A comparison drawn on the form (#2591): ghosts back in place, marks per node. */
  compare: CanvasCompare | null
  /** Who last changed each section (#2611), by section key. */
  lastChanges: Record<string, LastChange> | undefined
}) {
  const liveDnd = useLayoutDnd()
  const dnd = noDnd ? NO_DND : liveDnd
  // Removed things come back as ghosts on the form and read view; table and PDF canvases
  // edit from the bundle itself, so they get the marks only.
  const renderer = canvasRenderer(String(bundle.layout.layout_type ?? 'grouped'))
  const ghosts = renderer === 'item-edit-form' || renderer === 'read-view'
  const shown = (ghosts && compare?.diff.bundle) || bundle
  const canvas = useMemo(() => bundleToActiveLayout(shown, parent), [shown, parent])
  // What this layout overrides of its parent's (#2635): a tag beside the node.
  const overrides = useMemo(
    () => (parent ? overriddenTargets(bundle, parent) : null),
    [bundle, parent]
  )
  const overrideMarks = useMemo(() => {
    if (!overrides?.size) return marks
    return (t: DesignTarget) => {
      const name = overrides.get(targetKey(t))
      const own = marks?.(t) ?? []
      return name ? [...own, overrideMark(name)] : own
    }
  }, [overrides, marks])
  const layout = useMemo(
    () => previewForRole(canvas.active, roleId, showHidden),
    [canvas.active, roleId, showHidden]
  )
  // Field permissions of the previewed role (groups it loses are dropped above).
  const { data: rolePreview = null } = useRolePreview(collection, roleId)
  const roleMark = useMemo(
    () => (roleId ? roleMarker(rolePreview) : undefined),
    [roleId, rolePreview]
  )
  // #2608: notes pinned to fields and sections show as markers on the canvas.
  const notes = useMemo(() => notesOf(bundle), [bundle])
  // Rules view tags (#2632 #2640) join the override and preview tags; pins go last.
  const ruleMarked = useMemo(
    () =>
      overrideMarks && ruleMarks
        ? (t: DesignTarget) => [...overrideMarks(t), ...ruleMarks(t)]
        : (overrideMarks ?? ruleMarks),
    [overrideMarks, ruleMarks]
  )
  const allMarks = usePinMarks(bundle, ruleMarked)
  const design = useMemo<LayoutDesign>(
    () => ({
      selected,
      selection,
      onSelect,
      showHidden,
      inheritedFrom: (t) => canvas.inherited.get(targetKey(t)) ?? null,
      dnd,
      roleMark,
      marks: allMarks,
      overlay,
      fillRate,
      note: (t) => {
        const k = noteKey(t)
        return k ? (notes.get(k) ?? null) : null
      },
      fold,
      reveal,
      unsaved,
      peers,
      diffMark: compare ? (t) => compare.diff.marks.get(targetKey(t)) ?? null : undefined,
      lastChange: lastChanges
        ? (t) => (t.kind === 'group' ? (lastChanges[t.key] ?? null) : null)
        : undefined,
      ghost,
      resizeWidth: noDnd
        ? undefined
        : (t, span) => {
            if (t.kind !== 'field' && t.kind !== 'slot') return
            apply(
              [
                {
                  op: 'update_placement',
                  at: { field: t.field, group_key: t.group_key },
                  patch: { col_span: span === 12 ? null : span }
                }
              ],
              { label: `Set the width to ${WIDTH_LABELS[span] ?? span}` }
            )
          }
    }),
    [
      selected,
      selection,
      onSelect,
      showHidden,
      canvas.inherited,
      dnd,
      roleMark,
      allMarks,
      overlay,
      fillRate,
      notes,
      fold,
      reveal,
      unsaved,
      peers,
      compare,
      lastChanges,
      ghost,
      apply,
      noDnd
    ]
  )
  const hoverRef = useDriverHover(deps)
  return (
    <div ref={hoverRef} className='flex min-h-full flex-col'>
      <EditorCanvas
        collection={collection}
        bundle={shown}
        layout={layout}
        record={record}
        stateKey={stateKey}
        roleId={roleId}
        design={design}
        apply={apply}
        whenIdle={whenIdle}
      />
    </div>
  )
}

/** Overlay mode (record page): which layout this is and which records get it (spec §7.4). */
function EditingBanner({
  collection,
  name,
  row,
  layoutId,
  rows,
  fields,
  onDone
}: {
  collection: string
  layoutId: number
  name: string
  row: OverviewRow | undefined
  rows: OverviewRow[]
  fields: DescribeField[]
  onDone: (anchor?: HTMLElement) => void
}) {
  const choices = useRuleChoiceLabels(collection, fields, rows)
  const { data: count } = useApproxRecordCount(collection, row, rows)
  // Live usage (#2597): people and records that used this form today.
  const usedToday = usageTodayText(useLayoutUsageToday(layoutId).data)
  const segs: Segment[] = !row
    ? []
    : row.section === 'forms' && (row.reason.kind === 'default' || row.reason.kind === 'fallback')
      ? [{ text: 'used by every record no rule catches' }]
      : purposeSegments(row, fields, choices)
  if (segs.length > 0 && typeof count === 'number')
    segs.push({ text: ` (≈ ${count.toLocaleString()} ${count === 1 ? 'record' : 'records'})` })
  if (usedToday) segs.push({ text: segs.length > 0 ? `; ${usedToday}` : usedToday })
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
        onClick={(e) => onDone(e.currentTarget)}
        className='inline-flex h-7 shrink-0 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90'
      >
        Done
      </button>
    </div>
  )
}

/** Canvas | Table | States | Roles: the form itself, every placement as an
 *  editable row (#2602), or one of the matrices (#2644 field × state, #2645
 *  role × section). */
type EditorView = 'canvas' | 'table' | 'states' | 'roles'

function ViewToggle({ view, onView }: { view: EditorView; onView: (v: EditorView) => void }) {
  const opt = (v: EditorView, label: string, Icon: typeof LayoutGrid, tip: string) => (
    <button
      type='button'
      aria-pressed={view === v}
      aria-label={label}
      data-editor-view={v}
      data-tip={tip}
      onClick={() => onView(v)}
      className={cn(segOption(view === v), 'inline-flex items-center justify-center gap-1')}
    >
      <Icon className='h-3.5 w-3.5 shrink-0' />
      {/* Icons only once the bar is under 1400 px (EditorTopBar's container rules). */}
      <span data-tb-xwide=''>{label}</span>
    </button>
  )
  return (
    <fieldset
      aria-label='Show the form as'
      className={cn('m-0 min-w-0 shrink-0 border-0', segTrack(4))}
    >
      {opt('canvas', 'Canvas', LayoutGrid, 'The form as people see it')}
      {opt('table', 'Table', Table2, 'Every field as a row: label, section, width, rules')}
      {opt(
        'states',
        'States',
        Grid3x3,
        'Every field by workflow state: editable, read-only, required'
      )}
      {opt('roles', 'Roles', Users, 'Every section by role: can edit, read-only, hidden')}
    </fieldset>
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
  portalContainer,
  onDirtyChange
}: LayoutEditorProps) {
  const host = useLayoutEditorHost()
  const [currentId, setCurrentId] = useState(layoutId)
  useEffect(() => setCurrentId(layoutId), [layoutId])
  const onSaved = useSavedRefresh(collection)
  // Record / Stop (#2663) sees every apply; the draft saves as before.
  const { draft, recorder } = useMacroRecorder(useLayoutDraft(currentId, { onSaved }))
  const bundle = draft.bundle

  const [left, setLeft] = useState<'layouts' | 'add' | 'usage'>('layouts')
  const [panel, setPanel] = useState<'inspector' | 'settings' | 'checks' | 'ask'>('inspector')
  // Ask about this form (#2695 #2676): the thread outlives a jump to another panel.
  const [askThread, setAskThread] = useAskThread()
  const [askPending, setAskPending] = useState<string | null>(null)
  // Several fields can be selected (Shift / ⌘-click); the last one is `selected`.
  const [selection, setSelection] = useState<DesignTarget[]>([])
  const selected = selection.length > 0 ? selection[selection.length - 1] : null
  const [view, setView] = useState<EditorView>('canvas')
  const [showHidden, setShowHidden] = useState(false)
  // Fill-rate hints on the canvas (#2588), the Usage lens: off unless turned on
  // (Usage tab, or Tools → Show how full each field is).
  const [showFill, setShowFill] = useShowFillRates()
  const { data: fill } = useFieldFillRates(collection, showFill)
  const fillRate = useMemo(
    () =>
      showFill && fill && fill.total > 0
        ? (field: string) => fill.pct.get(field) ?? null
        : undefined,
    [showFill, fill]
  )
  const [preview, setPreview] = useState<PreviewAs>({
    record: previewRecordId ? { id: previewRecordId, label: `#${previewRecordId}` } : null,
    roleId: null
  })

  const { data: overview } = useLayoutOverview(collection)
  const { data: fields = [] } = useOverviewFields(collection)
  const row = overview?.rows.find((r) => r.layout_id === currentId)
  const parentId =
    bundle?.layout.parent_layout_id != null ? Number(bundle.layout.parent_layout_id) : null
  const { data: parent = null } = useLayoutBundle(parentId)
  const { data: record = null } = usePreviewRecord(collection, preview.record?.id ?? null)
  // The canvas layout, for the preview modes' What if (its visibility conditions).
  const canvasLayout = useMemo(
    () => (bundle ? bundleToActiveLayout(bundle, parent).active : null),
    [bundle, parent]
  )
  const lint = useLayoutLint(collection, bundle, parent)
  // History compare / Review changes on the canvas (#2591); who changed each section (#2611).
  const { data: savedBundle } = useLayoutBundle(currentId)
  const compareState = useCanvasCompare(bundle, savedBundle ?? null, draft.unsavedCount, currentId)
  const { data: lastChanges } = useSectionChanges(currentId, bundle != null)
  // AI tools' findings pinned on the canvas (#2685 #2690).
  const [aiPins, setAiPins] = useState<AiPin[]>([])
  // One merged function per pane marks function, so the canvas memo holds.
  const withAiMarks = useMemo(() => {
    const ai = pinsToMarks(aiPins)
    const cache = new WeakMap<object, ReturnType<typeof mergeMarks>>()
    return (m: Parameters<typeof mergeMarks>[0]) => {
      if (!m || !ai) return mergeMarks(m, ai)
      const hit = cache.get(m)
      if (hit) return hit
      const merged = mergeMarks(m, ai)
      cache.set(m, merged)
      return merged
    }
  }, [aiPins])

  // The Rules view (#2632 #2640 #2633): rule tags and default ghosts on the canvas.
  const [rulesOn, setRulesOn] = useRulesView()
  const explain = useCanvasExplain(collection, canvasLayout, rulesOn)
  const ghosts = useDefaultGhosts(collection, canvasLayout, rulesOn && !preview.record)

  // Required change note (#2654): the server's copy decides (turning it off asks too).
  const { data: serverBundle } = useLayoutBundle(currentId)
  // Edit freeze (#2717): until its date every save asks for an override note.
  const freeze = activeFreeze(serverBundle?.layout?.conditions ?? bundle?.layout?.conditions)
  const notePolicy =
    changeNotePolicyOf(serverBundle?.layout) ??
    changeNotePolicyOf(bundle?.layout) ??
    (freeze ? 'note' : null)
  const [note, setNote] = useState<ChangeNoteValue>({ reason: '', ticket: '' })
  // Where the change-note Save popover sits; null = closed.
  const [noteAnchor, setNoteAnchor] = useState<HTMLElement | null>(null)
  const noteRef = useRef(note)
  noteRef.current = note
  const saveNow = useCallback(async () => {
    const meta = notePolicy
      ? {
          ...changeNoteMeta(noteRef.current),
          ...(freeze ? { freeze_override: noteRef.current.reason.trim() } : {})
        }
      : undefined
    await draft.save(meta)
    const ok = draft.unsavedOps().length === 0
    if (ok && meta) setNote((n) => ({ ...n, reason: '' }))
    return ok
  }, [draft.save, draft.unsavedOps, notePolicy, freeze])
  // Save (button, ⌘S): straight away, or ask for the reason first.
  const requestSave = useCallback(() => {
    if (!notePolicy) return draft.save()
    if (draft.unsavedOps().length > 0)
      setNoteAnchor(
        bodyRef.current?.querySelector<HTMLElement>('[data-editor-save]') ??
          bodyRef.current?.querySelector<HTMLElement>('[data-editor-topbar]') ??
          null
      )
    return Promise.resolve()
  }, [notePolicy, draft.save, draft.unsavedOps])
  // Every save needs a reason: nothing may save on its own.
  useEffect(() => {
    if (notePolicy && draft.autosave) draft.setAutosave(false)
  }, [notePolicy, draft.autosave, draft.setAutosave])
  const barDraft = notePolicy ? { ...draft, save: requestSave, setAutosave: undefined } : draft

  useUndoKeys(notePolicy ? { ...draft, save: requestSave } : draft)
  useLeaveGuard(draft)

  // Unsaved changes: anything that leaves asks first, beside what asked.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [leaveAsk, setLeaveAsk] = useState<LeaveRequest | null>(null)
  const dirtyRef = useRef(draft.dirty)
  dirtyRef.current = draft.dirty
  const guard = useCallback((what: string, go: () => void, anchor?: HTMLElement | null) => {
    if (!dirtyRef.current) return go()
    const fallback =
      bodyRef.current?.querySelector<HTMLElement>('[data-editor-save]') ??
      bodyRef.current?.querySelector<HTMLElement>('[data-editor-topbar]') ??
      null
    setLeaveAsk({ what, go, anchor: anchor ?? fallback })
  }, [])
  const confirmSave = saveNow
  useLinkGuard(draft.dirty, (go, anchor) => guard('leave this page', go, anchor))
  useEffect(() => {
    onDirtyChange?.(draft.dirty)
  }, [draft.dirty, onDirtyChange])
  // Closed by something no confirm could stop (a route change): the changes stay
  // with this layout's draft and come back when it is opened again.
  // Read live: Discard and the close it allows land in one render.
  const unsavedOpsRef = useRef(draft.unsavedOps)
  unsavedOpsRef.current = draft.unsavedOps
  useEffect(
    () => () => {
      if (unsavedOpsRef.current().length > 0)
        toast.warning('Unsaved form changes kept — open the form again to save or discard them')
    },
    []
  )

  // Leaving sends typed text now; once the queue drains, the layouts lists
  // refresh for real (saves while editing only marked most of them stale).
  const invalidateLayouts = useInvalidateLayouts(collection)
  const leaveNow = useCallback(() => {
    const saved = draft.whenIdle()
    void saved.then(() => invalidateLayouts())
    onBack(saved)
  }, [draft.whenIdle, invalidateLayouts, onBack])
  const leave = useCallback(
    (anchor?: HTMLElement | null) =>
      guard(mode === 'overlay' ? 'go back to the record' : 'leave this form', leaveNow, anchor),
    [guard, leaveNow, mode]
  )

  // Undo, redo or another writer removed what was selected: it is not any more.
  useEffect(() => {
    if (!bundle || selection.length === 0) return
    const kept = selection.filter((t) => targetExists(t, bundle, parent))
    if (kept.length !== selection.length) setSelection(kept)
  }, [selection, bundle, parent])

  const overlay = mode === 'overlay'
  // Where the overlay mounts: resolved from a marker where it is declared.
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null)
  const dragging = useRef(false)
  const onDragActive = useCallback((on: boolean) => {
    dragging.current = on
  }, [])
  const dialogRef = useOverlayDialog(overlay && marker != null, () => leave(), dragging)

  const onSelect = useCallback((t: DesignTarget, opts?: SelectOptions) => {
    setSelection((cur) => nextSelection(cur, t, opts))
    setPanel('inspector')
  }, [])
  const onMoved = useCallback((t: DesignTarget) => setSelection([t]), [])

  // Entry tools: the tab order overlay (#2708) and the canvas theme preview (#2727).
  const tabOrder = useTabOrderEditor(bundle, draft.apply)
  const canvasSelect = useMemo(() => tabOrder.intercept(onSelect), [tabOrder.intercept, onSelect])
  const [previewDark, setPreviewDark] = useState(false)
  const appDark = useAppIsDark()
  const entryApi = useMemo(
    () => ({
      tabOrderActive: tabOrder.active,
      startTabOrder: () => {
        setView('canvas')
        tabOrder.start()
      }
    }),
    [tabOrder.active, tabOrder.start]
  )

  // A rule tag clicked: open what causes it (#2632) — the field's inspector
  // tab, the section, or the pipeline / field rules page (asks first when
  // there are unsaved changes).
  const openSource = useCallback(
    (source: OpenSource, t: DesignTarget) => {
      if (source.kind === 'group') return onSelect({ kind: 'group', key: source.key })
      if (source.kind === 'tab') {
        onSelect(t)
        if (t.kind === 'field' || t.kind === 'header') requestInspectorTab(t.field, source.tab)
        return
      }
      if (source.kind === 'pipeline')
        return guard('open the pipeline', () =>
          host.navigate(`/pipelines/${encodeURIComponent(source.id)}`)
        )
      guard('open the field rules', () =>
        host.navigate(`/data-model/${encodeURIComponent(collection)}?tab=rules`)
      )
    },
    [onSelect, guard, host, collection]
  )
  const ruleMarks = useMemo(() => {
    // Yes/no and multi-pick inputs show no placeholder: their ghost is a tag.
    const ghostTags = new Map<string, string>()
    for (const [f, g] of ghosts)
      if (g.type === 'boolean' || g.text.endsWith(' linked')) ghostTags.set(f, g.text)
    return explainMarks(explain, { chips: rulesOn, ghostTags, open: openSource })
  }, [explain, rulesOn, ghosts, openSource])
  const ghost = useMemo(
    () => (ghosts.size > 0 ? (f: string) => ghosts.get(f)?.text ?? null : undefined),
    [ghosts]
  )
  const showField = useCallback(
    (field: string) => {
      const p = bundle?.placements.find((x) => x.field === field)
      if (!p) return
      const t: DesignTarget =
        p.group_key === HEADER_GROUP_KEY
          ? { kind: 'header', field }
          : { kind: 'field', field, group_key: p.group_key }
      onSelect(t)
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-layout-editor] [data-design-target="${CSS.escape(targetKey(t))}"]`)
          ?.scrollIntoView?.({ block: 'center' })
      )
    },
    [bundle, onSelect]
  )
  useAltArrowKeys(bundle, selection, draft.apply, dragging, onMoved)

  // Who else is here and what they selected (#2651).
  const peers = useLayoutPresence(currentId, selected ? targetKey(selected) : null)
  const peerMap = useMemo(() => peersByTarget(peers), [peers])
  const peersOf = useCallback(
    (t: DesignTarget): DesignPeer[] =>
      (peerMap.get(targetKey(t)) ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        outline: p.tone.outline,
        chip: p.tone.chip
      })),
    [peerMap]
  )
  // Dots on what unsaved changes touched (#2629).
  const dirtyKeys = useMemo(() => unsavedKeys(draft.unsavedSteps), [draft.unsavedSteps])
  const unsavedOf = useCallback((t: DesignTarget) => dirtyKeys.has(targetKey(t)), [dirtyKeys])
  const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null)
  // Select a node on the canvas and bring it into view (unsaved list, a peer's avatar).
  const jumpTo = useCallback((t: DesignTarget) => {
    setView('canvas')
    setSelection([t])
    setPanel('inspector')
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-layout-editor] [data-design-target="${CSS.escape(targetKey(t))}"]`
      )
      el?.scrollIntoView?.({ block: 'center' })
      el?.focus({ preventScroll: true })
    })
  }, [])
  // A staged draft (#2589): kept on the server for its author, and offered back here after a
  // crash, a closed tab or another browser (#2653).
  const me = useMyUserId()
  const stagedQ = useStagedDraft(currentId)
  const stagedWriter = useStagedWriter()
  const staged = useMemo(
    () => ({
      settled: stagedQ.isFetched || stagedQ.isError,
      draft: stagedQ.data?.data ?? null,
      available: stagedQ.data?.available ?? !stagedQ.isError,
      writer: stagedWriter
    }),
    [stagedQ.isFetched, stagedQ.isError, stagedQ.data, stagedWriter]
  )
  const recovery = useDraftRecovery(draft, currentId, me, staged)

  // Form settings' "Preview as role" and the top bar's role are one choice.
  const onPreviewRoleChange = useCallback(
    (roleId: string | null) => setPreview((p) => (p.roleId === roleId ? p : { ...p, roleId })),
    []
  )

  const openLayout = (id: number) => {
    setPanel('inspector')
    if (id === currentId) return
    // The rail row (or inspector link) that asked has focus; the confirm sits beside it.
    const active = document.activeElement
    const anchor =
      active instanceof HTMLElement && bodyRef.current?.contains(active) ? active : null
    guard(
      'open another form',
      () => {
        draft.flush()
        setSelection([])
        setCurrentId(id)
        onLayoutChange?.(id)
      },
      anchor
    )
  }

  // #2584: a section dropped on a layout in the rail is copied there.
  const copyToLayout = useRailCopy(collection, bundle, overview?.rows ?? [], openLayout)
  // Find a setting (#2676): open its panel, select what it applies to, flash it.
  const jumpSetting = useCallback(
    (entry: SettingEntry) =>
      bundle
        ? jumpToSetting(entry, {
            bundle,
            selection,
            select: (t) => {
              setSelection([t])
              setPanel('inspector')
            },
            openSettings: () => setPanel('settings'),
            openAddPanel: () => setLeft('add'),
            root: bodyRef.current
          })
        : Promise.resolve({ ok: false as const, message: 'The form is still loading' }),
    [bundle, selection]
  )
  const openLayoutRef = useRef(openLayout)
  openLayoutRef.current = openLayout
  const onAskCite = useCallback(
    (c: AskCite) => {
      if (c.kind === 'record')
        setPreview((p) => ({ ...p, record: { id: c.id, label: `#${c.id}` } }))
      else if (c.kind === 'layout') openLayoutRef.current(c.id)
      else {
        const p = bundle?.placements.find((x) => x.field === c.field)
        if (!p) return toast.info(`${c.label} is not on this form`)
        const t: DesignTarget = { kind: 'field', field: p.field, group_key: p.group_key }
        onSelect(t)
        requestAnimationFrame(() =>
          bodyRef.current
            ?.querySelector<HTMLElement>(`[data-design-target="${CSS.escape(targetKey(t))}"]`)
            ?.scrollIntoView?.({ block: 'center' })
        )
      }
    },
    [bundle, onSelect]
  )

  const layoutName = String(bundle?.layout.name ?? row?.name ?? '')
  const layoutType = String(bundle?.layout.layout_type ?? row?.layout_type ?? 'grouped')
  // Forms and read views lay fields out on the 12-column grid: the placements
  // table and auto-arrange are theirs (table and PDF layouts have their own canvases).
  const arrangeable = layoutType !== 'table' && layoutType !== 'file'
  // Find, outline, breadcrumb, shortcut sheet, compact canvas, expand / collapse all.
  const nav = useEditorNav({
    bodyRef,
    bundle,
    parent,
    fields,
    onSelect,
    showHidden,
    setShowHidden,
    canvasShown: !(arrangeable && view === 'table')
  })
  const outlineShown = nav.outlineOpen && !!bundle && arrangeable
  const warning = host.warning ?? overview?.warning ?? null

  // Overlay mode is a modal dialog over the record page.
  const dialogProps = overlay
    ? {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': `Edit form ${layoutName}`,
        tabIndex: -1
      }
    : {}
  const body: ReactNode = (
    <div
      ref={(el) => {
        bodyRef.current = el
        if (overlay) dialogRef.current = el
      }}
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
        draft={barDraft}
        preview={preview}
        onPreview={setPreview}
        showHidden={showHidden}
        onShowHidden={setShowHidden}
        onBack={leave}
        backLabel={overlay ? 'Back to record' : 'Forms'}
        onShowOnCanvas={compareState.showVersion}
        onReviewChanges={compareState.toggleReview}
        reviewing={compareState.compare?.kind === 'unsaved'}
        onOpenUnsaved={setListAnchor}
        pendingTip={stagedTip(recovery.sync)}
        presence={
          <>
            <PresenceAvatars
              peers={peers}
              describe={(key) => {
                const t = targetFromKey(key)
                return t && bundle && targetExists(t, bundle, parent)
                  ? describeTarget(t, bundle, fields)
                  : null
              }}
              onJump={(key) => {
                const t = targetFromKey(key)
                if (t) jumpTo(t)
              }}
            />
            <StagedByOthers others={stagedQ.data?.others ?? []} />
          </>
        }
        onSelectField={(field) =>
          onSelect({
            kind: 'field',
            field,
            group_key: bundle?.placements.find((p) => p.field === field)?.group_key ?? null
          })
        }
        view={
          bundle && arrangeable ? (
            <>
              <ViewToggle view={view} onView={setView} />
              <RulesToggle on={rulesOn} onChange={setRulesOn} />
            </>
          ) : null
        }
        tools={
          <>
            {bundle && arrangeable && <AutoArrangeButton bundle={bundle} apply={draft.apply} />}
            {bundle && <FindTool find={nav.find} />}
            {bundle && arrangeable && (
              <FindReplaceButton bundle={bundle} apply={draft.apply} collection={collection} />
            )}
            {bundle && arrangeable && (
              <OutputsButton bundle={bundle} apply={draft.apply} collection={collection} />
            )}
            <MenuSeparator />
            {bundle && (
              <OutlineTool
                outline={
                  arrangeable
                    ? {
                        open: nav.outlineOpen,
                        onToggle: () => nav.setOutlineOpen(!nav.outlineOpen)
                      }
                    : null
                }
              />
            )}
            {bundle && (
              <ViewTools
                view={
                  arrangeable && view === 'canvas'
                    ? {
                        compact: nav.compact,
                        onCompact: nav.setCompact,
                        onExpandAll: nav.expandAll,
                        onCollapseAll: nav.collapseAll
                      }
                    : null
                }
              />
            )}
            {bundle && arrangeable && (
              <ToolButton
                label='Show how full each field is'
                icon={<Percent className='h-3.5 w-3.5' />}
                hint='The share of records with a value, on each field'
                checked={showFill}
                onClick={() => setShowFill(!showFill)}
                data={{ 'data-editor-fill-toggle': '' }}
              />
            )}
            {bundle && arrangeable && (
              <ToolButton
                label='Set the tab order'
                icon={<ListOrdered className='h-3.5 w-3.5' />}
                hint='Click fields in the order Tab should visit them'
                checked={tabOrder.active}
                onClick={() => (tabOrder.active ? tabOrder.cancel() : entryApi.startTabOrder())}
                data={{ 'data-editor-tab-order-toggle': '' }}
              />
            )}
            {bundle && arrangeable && (
              <ThemePreviewTool
                on={previewDark}
                onChange={setPreviewDark}
                appDark={appDark}
                disabled={view !== 'canvas'}
              />
            )}
            <MenuSeparator />
            <BulkChangesButton
              collection={collection}
              layoutId={currentId}
              dirty={draft.dirty}
              recorder={recorder}
            />
            <FormMapButton bundle={bundle} collection={collection} />
            <MenuSeparator />
            {bundle && <ShortcutsTool shortcuts={nav.shortcuts} />}
          </>
        }
        ai={
          <>
            {bundle && arrangeable && (
              <AiFormsButton
                collection={collection}
                layoutId={currentId}
                draft={draft}
                onOpenLayout={openLayout}
              />
            )}
            {bundle && (
              <AiToolsButton
                collection={collection}
                layoutId={currentId}
                bundle={bundle}
                apply={draft.apply}
                previewRecordShown={preview.record != null}
                onPins={setAiPins}
                onSelect={onSelect}
              />
            )}
            <MenuSeparator />
            {bundle && host.isAdmin && (
              <AskButton
                active={panel === 'ask'}
                onClick={() => setPanel((p) => (p === 'ask' ? 'inspector' : 'ask'))}
              />
            )}
            <CommandPalette collection={collection} layoutId={currentId} draft={draft} />
            {bundle && <ProposalsButton layoutId={currentId} draft={draft} />}
          </>
        }
        testing={
          bundle ? (
            <TestingButton
              collection={collection}
              layoutId={currentId}
              bundle={bundle}
              parent={parent}
              apply={draft.apply}
              dirty={draft.dirty}
              fields={fields}
            />
          ) : null
        }
        beforeSave={
          bundle ? (
            <ImpactButton
              collection={collection}
              layoutId={currentId}
              bundle={bundle}
              parent={parent}
              apply={draft.apply}
              dirty={draft.dirty}
              fields={fields}
            />
          ) : null
        }
        previewExtra={
          <PreviewModes
            collection={collection}
            value={preview}
            onChange={setPreview}
            layout={canvasLayout}
            fields={fields}
          />
        }
        problems={
          bundle && (
            <LintButton
              findings={lint.findings}
              active={panel === 'checks'}
              onClick={() => setPanel((p) => (p === 'checks' ? 'inspector' : 'checks'))}
            />
          )
        }
        more={
          <FormMoreMenu
            collection={collection}
            bundle={bundle}
            previewRecord={preview.record}
            onOpenLayout={openLayout}
          />
        }
      />
      {overlay && (
        <EditingBanner
          collection={collection}
          layoutId={currentId}
          name={layoutName}
          row={row}
          rows={overview?.rows ?? []}
          fields={fields}
          onDone={leave}
        />
      )}
      {draft.status === 'conflict' && draft.dirty && (
        <div
          role='alert'
          data-unsaved-conflict=''
          className={cn(
            'flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-[12.5px]',
            amberStrip
          )}
        >
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          <p className='m-0 min-w-0 flex-1'>
            {draft.error ?? 'Someone else saved this form'}. Save again to try once more, or reload
            their version.
          </p>
          <button
            type='button'
            data-unsaved-reload=''
            onClick={draft.discard}
            className='inline-flex h-7 shrink-0 items-center rounded-md border border-amber-300 px-2.5 text-[12px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'
          >
            Reload (discard my {unsavedText(draft.unsavedCount)})
          </button>
        </div>
      )}
      <DroppedBanner labels={draft.dropped} onDismiss={draft.clearDropped} />
      <RecoveryBanner
        state={recovery.state}
        onRecover={recovery.recover}
        onDismiss={recovery.dismiss}
      />
      {warning && (
        <div
          role='note'
          className={cn(
            'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[12.5px]',
            amberStrip
          )}
        >
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          {warning}
        </div>
      )}
      {freeze && (
        <div
          role='note'
          data-editor-frozen={freeze.until}
          className={cn(
            'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[12.5px]',
            amberStrip
          )}
        >
          <Lock className='h-3.5 w-3.5 shrink-0' />
          {frozenSaveIntro(freeze)}
        </div>
      )}
      <RuleLoopsBanner explain={explain} onShow={showField} />
      {/* Drag and drop spans the whole body: Add panel rows drag onto the canvas. */}
      <LayoutDndProvider
        bundle={bundle}
        apply={draft.apply}
        onDragActive={onDragActive}
        onDropOnLayout={copyToLayout}
      >
        <div className='flex min-h-0 flex-1 overflow-hidden'>
          {/* The outline takes the left panel's place while it is open: three side
            panels at once left the canvas ~330px wide at 1440. Hidden, not unmounted,
            so the Add / Usage tab and its scroll survive. */}
          <aside
            className={cn(
              'flex w-[260px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card',
              outlineShown && 'hidden'
            )}
          >
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
                Forms
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
              <button
                type='button'
                role='tab'
                aria-selected={left === 'usage'}
                data-editor-tab='usage'
                className={leftTab(left === 'usage')}
                onClick={() => setLeft('usage')}
                disabled={!bundle}
                data-tip='How this form is used and where it slows people down'
              >
                <BarChart3 className='h-3.5 w-3.5' />
                Usage
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
              ) : left === 'usage' && bundle ? (
                <UsagePanel
                  bundle={bundle}
                  collection={collection}
                  fields={fields}
                  apply={draft.apply}
                  showFill={showFill}
                  onShowFill={setShowFill}
                  onOpenLayout={openLayout}
                />
              ) : (
                <LayoutsRail
                  collection={collection}
                  currentId={currentId}
                  onOpen={openLayout}
                  settingsOpen={panel === 'settings'}
                  onSettings={() => setPanel('settings')}
                  dropTargets
                />
              )}
            </div>
          </aside>
          {outlineShown && bundle && (
            <aside
              data-editor-outline-panel=''
              className='flex w-[260px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'
            >
              <OutlinePanel
                bundle={bundle}
                nodes={nav.nodes}
                selection={selection}
                onPick={nav.selectAndReveal}
                onMoved={onMoved}
                apply={draft.apply}
                onClose={() => nav.setOutlineOpen(false)}
              />
            </aside>
          )}
          <main className='min-w-0 flex-1 overflow-y-auto'>
            {view === 'canvas' && <TabOrderBar editor={tabOrder} />}
            {compareState.compare && (view === 'canvas' || !arrangeable) && (
              <CompareBanner compare={compareState.compare} onClose={compareState.close} />
            )}
            {bundle && arrangeable && view === 'states' ? (
              <FieldStateMatrix
                bundle={bundle}
                parent={parent}
                collection={collection}
                apply={draft.apply}
                onSelect={onSelect}
              />
            ) : bundle && arrangeable && view === 'roles' ? (
              <RoleSectionMatrix
                bundle={bundle}
                parent={parent}
                apply={draft.apply}
                onSelect={onSelect}
              />
            ) : bundle && arrangeable && view === 'table' ? (
              <PlacementsTable
                bundle={bundle}
                collection={collection}
                apply={draft.apply}
                flush={draft.flush}
                selection={selection}
                onSelect={onSelect}
                onSelection={setSelection}
              />
            ) : bundle ? (
              <div
                data-canvas-density={nav.compact && arrangeable ? 'compact' : 'normal'}
                // Compact (#2627): editor-only zoom; the record page is unchanged.
                style={nav.compact && arrangeable ? { zoom: COMPACT_ZOOM } : undefined}
                className={cn(
                  'min-h-full',
                  previewThemeClass(previewDark, appDark),
                  previewDark && !appDark && 'bg-background text-foreground'
                )}
              >
                <PreviewPanes
                  collection={collection}
                  bundle={bundle}
                  parent={parent}
                  preview={preview}
                  onPreview={setPreview}
                  record={record}
                  fields={fields}
                  renderPane={(pane) => (
                    <Canvas
                      collection={collection}
                      bundle={bundle}
                      parent={parent}
                      roleId={pane.roleId}
                      stateKey={pane.stateKey}
                      marks={withAiMarks(pane.marks)}
                      overlay={tabOrder.overlay(pane.overlay)}
                      ruleMarks={ruleMarks}
                      ghost={ghost}
                      deps={explain.deps}
                      noDnd={pane.noDnd}
                      record={pane.record}
                      selected={selected}
                      selection={selection}
                      onSelect={canvasSelect}
                      showHidden={showHidden}
                      fold={nav.fold}
                      reveal={nav.reveal}
                      apply={draft.apply}
                      whenIdle={draft.whenIdle}
                      fillRate={fillRate}
                      unsaved={unsavedOf}
                      peers={peersOf}
                      compare={compareState.compare}
                      lastChanges={compareState.compare ? undefined : lastChanges}
                    />
                  )}
                />
              </div>
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
            className='flex w-[344px] shrink-0 flex-col overflow-hidden border-l border-slate-200 bg-white dark:border-border dark:bg-card'
          >
            {bundle &&
              (panel === 'ask' ? (
                <AskPanel
                  layoutId={currentId}
                  layoutName={layoutName}
                  kind={layoutKindOf(bundle.layout)}
                  bundle={bundle}
                  thread={askThread}
                  setThread={setAskThread}
                  pending={askPending}
                  onPendingTaken={() => setAskPending(null)}
                  jump={jumpSetting}
                  onCite={onAskCite}
                  recordId={preview.record?.id ?? null}
                />
              ) : panel === 'checks' ? (
                <LintPanel
                  findings={lint.findings}
                  health={lint.health}
                  ready={lint.ready}
                  onSelect={(t) => setSelection([t])}
                  apply={draft.apply}
                  onOpenAiReview={host.aiReviewSlot ? () => setPanel('settings') : undefined}
                />
              ) : panel === 'settings' ? (
                <FormSettings
                  bundle={bundle}
                  apply={draft.apply}
                  flush={draft.flush}
                  collection={collection}
                  previewRoleId={preview.roleId}
                  onPreviewRoleChange={onPreviewRoleChange}
                  onAskWhere={
                    host.isAdmin
                      ? (q) => {
                          setAskPending(q)
                          setPanel('ask')
                        }
                      : undefined
                  }
                />
              ) : selection.length > 1 ? (
                <BulkInspector
                  bundle={bundle}
                  selection={selection}
                  apply={draft.apply}
                  collection={collection}
                  onSelection={setSelection}
                />
              ) : (
                <Inspector
                  bundle={bundle}
                  target={selected}
                  apply={draft.apply}
                  flush={draft.flush}
                  collection={collection}
                  openLayout={openLayout}
                  onSelect={nav.selectAndReveal}
                />
              ))}
          </aside>
        </div>
      </LayoutDndProvider>
      <StructureActions
        bundle={bundle}
        selection={selection}
        apply={draft.apply}
        onSelection={setSelection}
        rootRef={bodyRef}
      />
      <UnsavedConfirm
        request={leaveAsk}
        count={draft.unsavedCount}
        onSave={confirmSave}
        onDiscard={draft.discard}
        onKeep={() => setLeaveAsk(null)}
        note={
          notePolicy ? (
            <ChangeNoteFields policy={notePolicy} value={note} onChange={setNote} />
          ) : undefined
        }
        canSave={changeNoteReady(notePolicy, note)}
      />
      {notePolicy && noteAnchor && (
        <ChangeNoteSave
          open
          anchor={noteAnchor}
          policy={notePolicy}
          intro={freeze ? frozenSaveIntro(freeze) : undefined}
          count={draft.unsavedCount}
          value={note}
          onChange={setNote}
          onSave={saveNow}
          onClose={() => setNoteAnchor(null)}
        />
      )}
      {listAnchor && (
        <UnsavedList
          anchor={listAnchor}
          steps={draft.unsavedSteps}
          exists={(t) => !!bundle && targetExists(t, bundle, parent)}
          describe={(t) => describeTarget(t, bundle, fields)}
          onJump={(t) => {
            setListAnchor(null)
            jumpTo(t)
          }}
          onSettings={() => {
            setListAnchor(null)
            setPanel('settings')
          }}
          onClose={() => setListAnchor(null)}
        />
      )}
    </div>
  )

  if (!overlay)
    return <EntryEditorContext.Provider value={entryApi}>{body}</EntryEditorContext.Provider>
  // Fixed under the page outlet would be offset by its transform: portal out —
  // into the hosting modal when there is one (a body portal would sit under
  // its pointer/scroll lock), else body.
  const container = portalContainer ?? (marker ? (modalHostOf(marker) ?? document.body) : null)
  return (
    <>
      <span ref={setMarker} hidden data-layout-editor-marker='' />
      <EntryEditorContext.Provider value={entryApi}>
        {container && createPortal(body, container)}
      </EntryEditorContext.Provider>
    </>
  )
}

/** "Frozen until 15 Dec 2026: go-live. Saving asks for an override note." (#2717) */
function frozenSaveIntro(f: LayoutFreeze): string {
  const why = f.reason.trim() ? `: ${f.reason.trim()}` : ''
  return `Frozen until ${dayWords(f.until)}${why}. Saving asks for an override note, kept in History.`
}
