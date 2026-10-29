import {
  ChevronDown,
  ChevronLeft,
  Eye,
  GitCompare,
  History,
  MoreHorizontal,
  Redo2,
  RotateCcw,
  Save,
  Sparkles,
  Undo2,
  Wrench,
  X
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { useRelationOptions } from '../../hooks/useRelationOptions'
import type { LayoutBundle } from '../../lib/layout-ops'
import { cn, titleCase } from '../../lib/utils'
import { LAYOUT_PRETEND_SCOPE, usePretendDownIds } from '../PretendDown'
import { useOverflowTip } from '../TipLayer'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { AiChangeCheck } from './ai/ChangeCheck'
import { ShareButton, WatchButton } from './collab/FormFollowShare'
import { HistoryPanel } from './HistoryPanel'
import type { DescribeField } from './overview/describe-conditions'
import { useDisplayTemplate, useRoleNames, useRuleChoiceLabels } from './overview/overview-api'
import { Pill, purposeSegments, rowPill, Sentence, TYPE_USE } from './overview/purpose'
import type { OverviewRow } from './overview/types'
import type { PreviewDevice } from './preview/preview-model'
import { SampleRecordChip, SampleRecordOffer } from './preview/SampleRecord'
import { ScheduleChange } from './ScheduleChange'
import {
  BarMenu,
  barBtn,
  barBtnOn,
  barIconBtn,
  barIconOn,
  MenuSeparator,
  ToolButton
} from './toolbar-kit'
import { unsavedText } from './UnsavedConfirm'
import type { LayoutDraft } from './useLayoutDraft'

// The editor's top bar, one row at every width (sketch A of the design
// review): ‹ Forms │ name, its use and who else is here │ Undo Redo │ the
// views and Rules │ Preview ▾ │ Tools ▾ │ AI ▾ │ Problems │ History │ ⋯ │
// the save status │ Save ▾. Everything else lives in those menus. The bar is
// a size container: below 1400 px the view toggle is icons only, below
// 1100 px the Preview summary and the Rules / Tools / AI / back labels go,
// and the form's name truncates before anything wraps.

export interface PreviewAs {
  record: { id: string; label: string } | null
  roleId: string | null
  /** Second role shown beside the first on a split canvas (#2579). */
  compareRoleId?: string | null
  /** Preview as if the record were in this pipeline state (#2599). */
  state?: { pipelineId: string; id: string; key: string; label: string } | null
  /** Canvas width (#2600). */
  device?: PreviewDevice
  /** What-if values laid over the record (#2601). */
  values?: Record<string, unknown> | null
  /** Tint fields by how many roles see them (#2580). */
  who?: boolean
  /** Made-up values the canvas shows instead of a record's (#3196); never saved. */
  sample?: Record<string, unknown> | null
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const labelCls = 'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'

/**
 * Width steps of the bar, as attribute rules the bar owns: a host stylesheet
 * loading after the shared one re-declares plain utilities (`hidden`,
 * `inline`) and would win over responsive classes (gotchas: host CSS).
 */
const BAR_CSS = `
[data-editor-topbar]{container-type:inline-size;container-name:letb}
@container letb (max-width: 1499px){[data-editor-topbar] [data-tb-sentence]{display:none}}
@container letb (max-width: 1399px){[data-editor-topbar] [data-tb-xwide]{display:none}}
@container letb (max-width: 1099px){[data-editor-topbar] [data-tb-wide],[data-editor-topbar] [data-tb-menu-label]{display:none}}
@container letb (min-width: 1100px){[data-editor-topbar] [data-tb-name]{min-width:140px}}
`

function StatusChip({
  draft,
  onOpen,
  pendingTip
}: {
  draft: Pick<LayoutDraft, 'status' | 'error'> & Partial<Pick<LayoutDraft, 'unsavedCount'>>
  /** The unsaved count opens the list of unsaved changes (#2629). */
  onOpen?: (anchor: HTMLElement) => void
  /** The tip while changes wait: where they are kept (#2589). */
  pendingTip?: string
}) {
  const { status, error } = draft
  const unsaved = draft.unsavedCount ?? 0
  const pendingOnly = unsaved > 0 && (status === 'idle' || status === 'saved')
  const text =
    status === 'saving'
      ? 'Saving…'
      : status === 'error'
        ? (error ?? 'Not saved')
        : status === 'conflict'
          ? unsaved > 0
            ? 'Not saved — someone else saved'
            : 'Reloaded — someone else saved'
          : pendingOnly
            ? unsavedText(unsaved)
            : 'Saved'
  const chip = (
    <span
      role='status'
      data-save-status={status}
      data-unsaved={unsaved}
      data-tip={
        (status === 'error' || status === 'conflict') && error
          ? error
          : pendingOnly
            ? (pendingTip ?? 'Only you see these changes until you save (⌘S)')
            : undefined
      }
      className={cn(
        'inline-flex max-w-[180px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold',
        status === 'saving' &&
          'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
        (status === 'saved' || status === 'idle') &&
          !pendingOnly &&
          'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        pendingOnly && 'bg-nvr-cyan/10 text-slate-700 dark:text-foreground',
        status === 'error' && 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
        status === 'conflict' &&
          'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
      )}
    >
      {pendingOnly && (
        <span aria-hidden className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan' />
      )}
      <span className='min-w-0 truncate'>{text}</span>
    </span>
  )
  if (!pendingOnly || !onOpen) return chip
  return (
    <button
      type='button'
      data-unsaved-list-open=''
      aria-label={`${unsavedText(unsaved)} — list them`}
      onClick={(e) => onOpen(e.currentTarget)}
      className='inline-flex rounded-full transition-opacity hover:opacity-80'
    >
      {chip}
    </button>
  )
}

/** An on/off row inside the Preview popover (Show hidden). */
function SwitchRow({
  icon,
  label,
  hint,
  on,
  onChange,
  data
}: {
  icon?: ReactNode
  label: string
  hint: string
  on: boolean
  onChange: (on: boolean) => void
  data?: Record<string, string>
}) {
  return (
    <div className='flex items-start gap-2 text-[12.5px] text-slate-700 dark:text-foreground'>
      <span className='mt-0.5 text-slate-500 dark:text-muted-foreground'>{icon}</span>
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className='font-medium'>{label}</span>
        <span className='text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          {hint}
        </span>
      </span>
      <button
        type='button'
        role='switch'
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        {...data}
        className={cn(
          'relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors',
          on ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-white/35'
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
            on ? 'translate-x-3.5' : 'translate-x-0.5'
          )}
        />
      </button>
    </div>
  )
}

function PreviewAsButton({
  collection,
  value,
  onChange,
  showHidden,
  onShowHidden,
  extra
}: {
  collection: string
  value: PreviewAs
  onChange: (v: PreviewAs) => void
  showHidden: boolean
  onShowHidden: (v: boolean) => void
  /** More preview modes, below the record and role (LayoutEditor's PreviewModes). */
  extra?: ReactNode
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search, 250)
  const { data: template } = useDisplayTemplate(collection, open)
  const { data: roles = [] } = useRoleNames(true)
  const { options, loading } = useRelationOptions(open ? client : null, collection, {
    search: debounced,
    limit: 8,
    displayTemplate: template ?? null,
    enabled: open && template !== undefined
  })
  const pretendDown = usePretendDownIds(LAYOUT_PRETEND_SCOPE).length
  const roleName = roles.find((r) => r.id === value.roleId)?.name ?? null
  const compareName = roles.find((r) => r.id === value.compareRoleId)?.name ?? null
  const summary =
    [
      value.sample ? 'Sample record' : value.record?.label,
      compareName && roleName ? `${roleName} | ${compareName}` : roleName,
      value.state?.label,
      value.values && Object.keys(value.values).length > 0 ? 'What if' : null,
      value.device && value.device !== 'desktop'
        ? value.device === 'phone'
          ? 'Phone'
          : value.device === 'all'
            ? 'All devices'
            : 'Tablet'
        : null,
      value.who ? 'Who sees' : null,
      // #2858 — pretending something is down is a preview mode too: never forgotten on screen.
      pretendDown > 0 ? `${pretendDown} down` : null
    ]
      .filter(Boolean)
      .join(' · ') || 'No record'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          // The one bar button that shrinks: its summary gives way before the
          // form's name does (the unsaved count and Save take room when changes wait).
          className={cn(barBtn, 'min-w-[110px] max-w-[260px] shrink', open && barBtnOn)}
          aria-label='Preview as'
          data-preview-as=''
          data-tip='Show the form with a real record’s values, as a role sees it'
        >
          <Eye className='h-3.5 w-3.5 shrink-0' />
          <span className='min-w-0 truncate'>
            Preview
            <span data-tb-wide=''>
              :{' '}
              <span data-preview-summary='' className='text-slate-500 dark:text-muted-foreground'>
                {summary}
              </span>
            </span>
          </span>
          {showHidden && (
            <span
              data-preview-hidden-on=''
              aria-hidden
              className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan'
            />
          )}
          <ChevronDown className='h-3 w-3 shrink-0 text-slate-500 dark:text-muted-foreground' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='max-h-[min(80vh,640px)] w-[320px] overflow-y-auto overscroll-contain p-3'
      >
        <p className={labelCls}>Record</p>
        {value.sample ? (
          <SampleRecordChip
            collection={collection}
            onSample={(sample) => onChange({ ...value, record: null, sample })}
            onClear={() => onChange({ ...value, sample: null })}
          />
        ) : value.record ? (
          <span className='inline-flex max-w-full items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-slate-800 dark:text-foreground'>
            <span className='truncate'>{value.record.label}</span>
            <button
              type='button'
              aria-label='Preview without a record'
              onClick={() => onChange({ ...value, record: null })}
              className='text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        ) : (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search records…'
              aria-label='Search records'
              className={inputCls}
            />
            <div className='mt-1 max-h-[220px] overflow-y-auto overscroll-contain'>
              {options.map((o) => (
                <button
                  key={String(o.id)}
                  type='button'
                  onClick={() =>
                    onChange({
                      ...value,
                      record: { id: String(o.id), label: o.label },
                      sample: null
                    })
                  }
                  className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
                >
                  {o.label}
                </button>
              ))}
              {!loading && options.length === 0 && debounced.trim() !== '' && (
                <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No records match.
                </p>
              )}
            </div>
            {/* #3196: made-up values, offered first when there is nothing to pick. */}
            <SampleRecordOffer
              collection={collection}
              empty={!loading && options.length === 0 && debounced.trim() === ''}
              onSample={(sample) => onChange({ ...value, record: null, sample })}
            />
          </>
        )}
        <p className={cn(labelCls, 'mt-3')}>As a role</p>
        <SimpleSelect
          value={value.roleId ?? ''}
          onChange={(v) => onChange({ ...value, roleId: v || null })}
          ariaLabel='Preview as role'
          className='h-8 text-[12.5px]'
          options={[
            { value: '', label: 'Any role' },
            ...roles.map((r) => ({ value: r.id, label: r.name }))
          ]}
        />
        <p className='mt-2 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          The form shows this record’s values, steps and rules. Nothing you do here changes the
          record.
        </p>
        <div className='mt-3 border-t border-slate-100 pt-3 dark:border-border'>
          <SwitchRow
            icon={<Eye className='h-3.5 w-3.5' />}
            label='Show hidden'
            hint='Fields and sections the preview would hide, faintly, so you can select them'
            on={showHidden}
            onChange={onShowHidden}
            data={{ 'data-show-hidden-switch': '' }}
          />
        </div>
        {extra}
      </PopoverContent>
    </Popover>
  )
}

export function EditorTopBar({
  collection,
  layoutId,
  layoutName,
  layoutType,
  row,
  fields,
  draft,
  preview,
  onPreview,
  showHidden,
  onShowHidden,
  onBack,
  backLabel = 'Forms',
  view,
  tools,
  ai,
  previewExtra,
  problems,
  more,
  presence,
  onOpenUnsaved,
  pendingTip,
  onSelectField,
  onShowOnCanvas,
  onReviewChanges,
  reviewing = false,
  testing,
  beforeSave
}: {
  collection: string
  layoutId: number
  layoutName: string
  layoutType: string
  row: OverviewRow | undefined
  fields: DescribeField[]
  draft: Pick<
    LayoutDraft,
    | 'status'
    | 'error'
    | 'undo'
    | 'redo'
    | 'canUndo'
    | 'canRedo'
    | 'undoLabel'
    | 'redoLabel'
    | 'bundle'
    | 'apply'
  > &
    Partial<
      Pick<
        LayoutDraft,
        | 'autosave'
        | 'setAutosave'
        | 'unsavedCount'
        | 'save'
        | 'discard'
        | 'unsavedOps'
        | 'session'
        | 'jump'
      >
    >
  preview: PreviewAs
  onPreview: (v: PreviewAs) => void
  showHidden: boolean
  onShowHidden: (v: boolean) => void
  /** Leave; `anchor` is the back button (an unsaved-changes confirm sits beside it). */
  onBack: (anchor?: HTMLElement) => void
  /** What the back button returns to ("Forms", or the record in overlay mode). */
  backLabel?: string
  /** The view toggle and the Rules switch, after Undo / Redo. */
  view?: ReactNode
  /** Rows of the Tools menu (ToolButton-based tools). */
  tools?: ReactNode
  /** Rows of the AI menu. */
  ai?: ReactNode
  /** More preview modes inside the Preview popover. */
  previewExtra?: ReactNode
  /** The Problems (lint) button, after AI. */
  problems?: ReactNode
  /** Rows of the ⋯ menu after Test, Share and Watch (Save as template, New form from this record, Download). */
  more?: ReactNode
  /** Who else has this layout open (#2651), after the layout's name. */
  presence?: ReactNode
  /** Opens the unsaved-changes list from the unsaved count (#2629). */
  onOpenUnsaved?: (anchor: HTMLElement) => void
  /** The status chip's tip while changes wait: where the staged draft is kept (#2589). */
  pendingTip?: string
  /** Select a field on the canvas (a preview comment's "Select this field"). */
  onSelectField?: (field: string) => void
  /** History's "Show on canvas" (#2591): compare a version with the editor's layout. */
  onShowOnCanvas?: (base: LayoutBundle, label: string) => void
  /** Save menu → "Review changes on canvas" (#2591). */
  onReviewChanges?: () => void
  reviewing?: boolean
  /** The Test row of the ⋯ menu (test records, new-record walkthrough, form cost). */
  testing?: ReactNode
  /** Save menu rows while changes wait for Save (What changes). */
  beforeSave?: ReactNode
}) {
  // A save notice links here with ?history=1 (#2655): History opens on arrival.
  const [historyOpen, setHistoryOpen] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('history') === '1'
  )
  const unsaved = draft.unsavedCount ?? 0
  const pill = row ? rowPill(row) : null
  const rowList = useMemo(() => (row ? [row] : []), [row])
  const choices = useRuleChoiceLabels(collection, fields, rowList)
  const segs = row
    ? purposeSegments(row, fields, choices)
    : TYPE_USE[layoutType]
      ? [{ text: TYPE_USE[layoutType] }]
      : []
  const manual = !!draft.save && !draft.autosave
  const waiting = manual && unsaved > 0
  // History's "Piece" (#2716) names fields as the form does.
  const fieldLabel = useCallback(
    (field: string) => fields.find((f) => f.field === field)?.label?.trim() || titleCase(field),
    [fields]
  )
  const nameRef = useOverflowTip<HTMLHeadingElement>(layoutName)

  return (
    <header
      data-editor-topbar=''
      className='flex shrink-0 flex-nowrap items-center gap-1.5 overflow-hidden border-b border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
    >
      <style>{BAR_CSS}</style>
      <button
        type='button'
        aria-label={backLabel}
        data-editor-back=''
        onClick={(e) => onBack(e.currentTarget)}
        className='inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-2 text-[12px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      >
        <ChevronLeft className='h-4 w-4' />
        <span data-tb-wide=''>{backLabel}</span>
      </button>
      <Sep />
      {/* From 1100 px the name keeps room to read (BAR_CSS): what is missing
          comes off the Preview summary instead. */}
      <div data-tb-name='' className='flex min-w-[64px] flex-1 items-center gap-2'>
        <h2
          ref={nameRef}
          className='min-w-0 truncate text-[14px] font-semibold text-slate-900 dark:text-foreground'
        >
          {layoutName}
        </h2>
        {pill && (
          <span className='shrink-0'>
            <Pill tone={pill.tone}>{pill.text}</Pill>
          </span>
        )}
        {segs.length > 0 && (
          <span
            data-tb-sentence=''
            className='min-w-0 truncate text-[12px] text-slate-500 dark:text-muted-foreground'
          >
            · <Sentence segs={segs} muted />
          </span>
        )}
        {presence}
      </div>
      <Sep />
      <div className='flex shrink-0 items-center gap-0.5'>
        <button
          type='button'
          aria-label='Undo'
          className={barIconBtn}
          disabled={!draft.canUndo}
          onClick={draft.undo}
          data-tip={draft.undoLabel ? `Undo ${draft.undoLabel} (⌘Z)` : 'Undo (⌘Z)'}
        >
          <Undo2 className='h-4 w-4' />
        </button>
        <button
          type='button'
          aria-label='Redo'
          className={barIconBtn}
          disabled={!draft.canRedo}
          onClick={draft.redo}
          data-tip={draft.redoLabel ? `Redo ${draft.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)'}
        >
          <Redo2 className='h-4 w-4' />
        </button>
      </div>
      {view && (
        <>
          <Sep />
          <div className='flex shrink-0 items-center gap-1'>{view}</div>
        </>
      )}
      <Sep />
      <PreviewAsButton
        collection={collection}
        value={preview}
        onChange={onPreview}
        showHidden={showHidden}
        onShowHidden={onShowHidden}
        extra={previewExtra}
      />
      <BarMenu
        label='Tools'
        icon={<Wrench className='h-3.5 w-3.5' />}
        tip='Arrange, find, outline, every form, form map and shortcuts'
      >
        {tools}
      </BarMenu>
      <BarMenu
        label='AI'
        icon={<Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />}
        tip='Rebuild, review and ask about this form with AI; type a change'
        width='w-[320px]'
      >
        {ai}
      </BarMenu>
      {problems}
      <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className={cn(barIconBtn, historyOpen && barIconOn)}
            aria-label='History'
            data-tip='History: saved versions, this session’s steps, restore'
            data-editor-history=''
          >
            <History className='h-4 w-4' />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          className='max-h-[min(75vh,640px)] w-[460px] overflow-y-auto overscroll-contain p-3'
        >
          {historyOpen && (
            <HistoryPanel
              layoutId={layoutId}
              onRestored={() => setHistoryOpen(false)}
              unsavedCount={unsaved}
              onDiscardUnsaved={draft.discard}
              session={draft.session}
              onJump={draft.jump}
              bundle={draft.bundle}
              onApply={(ops, label) => draft.apply(ops, { label })}
              fieldLabel={fieldLabel}
              onShowOnCanvas={
                onShowOnCanvas
                  ? (base, label) => {
                      setHistoryOpen(false)
                      onShowOnCanvas(base, label)
                    }
                  : undefined
              }
            />
          )}
        </PopoverContent>
      </Popover>
      <BarMenu
        label='More'
        icon={<MoreHorizontal className='h-4 w-4' />}
        iconOnly
        align='end'
        tip='Test, share and watch this form, templates and download'
        data={{ 'data-editor-more': '' }}
      >
        {testing}
        <MenuSeparator />
        <ShareButton layoutId={layoutId} fields={fields} onSelectField={onSelectField} />
        <WatchButton layoutId={layoutId} />
        <MenuSeparator />
        {more}
      </BarMenu>
      <Sep />
      <StatusChip draft={draft} onOpen={onOpenUnsaved} pendingTip={pendingTip} />
      {waiting && draft.discard && <DiscardButton count={unsaved} onDiscard={draft.discard} />}
      <div data-save-split='' className='flex shrink-0 items-center'>
        {manual && (
          <button
            type='button'
            data-editor-save=''
            disabled={unsaved === 0}
            onClick={() => void draft.save?.()}
            data-tip={unsaved > 0 ? `Save ${unsavedText(unsaved)} (⌘S)` : 'Nothing to save'}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-l-md px-3 text-[12.5px] font-medium transition-opacity disabled:pointer-events-none disabled:opacity-40',
              unsaved > 0
                ? 'bg-nvr-cyan text-white hover:opacity-90'
                : 'border border-slate-200 text-slate-700 dark:border-border dark:text-foreground'
            )}
          >
            <Save className='h-3.5 w-3.5' />
            Save
          </button>
        )}
        <BarMenu
          label='Save options'
          icon={<ChevronDown className='h-3.5 w-3.5' />}
          iconOnly
          align='end'
          width='w-[300px]'
          tip={manual ? 'Review, check or schedule the changes; Autosave' : 'Autosave'}
          className={cn(
            manual
              ? 'rounded-l-none border border-l-0 border-slate-200 dark:border-border'
              : 'border border-slate-200 dark:border-border'
          )}
          data={{ 'data-save-menu': '' }}
        >
          {onReviewChanges && waiting && (
            <ToolButton
              label='Review changes on canvas'
              icon={<GitCompare className='h-3.5 w-3.5' />}
              hint='Mark the unsaved changes on the form'
              checked={reviewing}
              onClick={onReviewChanges}
              data={{ 'data-editor-review': '' }}
            />
          )}
          {waiting && beforeSave}
          <AiChangeCheck layoutId={layoutId} draft={draft} />
          {draft.unsavedOps && draft.discard && waiting && (
            <ScheduleChange
              collection={collection}
              layoutId={layoutId}
              draft={{
                unsavedOps: draft.unsavedOps,
                discard: draft.discard,
                unsavedCount: unsaved
              }}
            />
          )}
          {draft.setAutosave && (
            <>
              <MenuSeparator />
              <ToolButton
                label='Autosave'
                icon={<Save className='h-3.5 w-3.5' />}
                hint={
                  draft.autosave
                    ? 'Every change saves as you make it, until you close the editor'
                    : 'Off: changes wait for Save'
                }
                checked={!!draft.autosave}
                onClick={() => draft.setAutosave?.(!draft.autosave)}
                data={{ 'data-autosave-switch': '' }}
              />
            </>
          )}
        </BarMenu>
      </div>
    </header>
  )
}

/**
 * Throws away the changes waiting for Save, right here (before, the only way out was reloading
 * and answering the "unsaved changes" prompt). Two clicks, no dialog: the first arms it
 * ("Discard 3 changes?"), the second discards; it disarms on its own after a few seconds, on
 * Escape and when focus leaves. Discarded changes cannot be brought back.
 */
export function DiscardButton({ count, onDiscard }: { count: number; onDiscard: () => void }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }, [])
  useEffect(() => disarm, [disarm])
  const label = `Discard ${unsavedText(count)}`
  return (
    <button
      type='button'
      data-editor-discard=''
      data-armed={armed ? '' : undefined}
      aria-label={armed ? `${label}? Click again to discard` : label}
      data-tip={armed ? 'Click again to discard. This cannot be undone.' : label}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setArmed(false), 4000)
          return
        }
        disarm()
        onDiscard()
      }}
      onBlur={disarm}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation()
          disarm()
        }
      }}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12.5px] font-medium transition-colors',
        armed
          ? 'bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30 dark:hover:bg-red-500/25'
          : 'text-slate-600 hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
      )}
    >
      <RotateCcw aria-hidden className='h-3.5 w-3.5' />
      {armed ? (
        <span>Discard {count === 1 ? 'it' : 'them'}?</span>
      ) : (
        <span data-tb-wide=''>Discard</span>
      )}
    </button>
  )
}

/** A thin rule between groups of the bar (wide bars only). */
function Sep() {
  // Goes with the labels below 1100 px: the gaps alone keep the groups apart.
  return (
    <span aria-hidden data-tb-wide='' className='h-5 w-px shrink-0 bg-slate-200 dark:bg-border' />
  )
}
