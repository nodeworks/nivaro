import { ChevronLeft, Eye, History, Redo2, Save, Undo2, UserRound, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { useRelationOptions } from '../../hooks/useRelationOptions'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { HistoryPanel } from './HistoryPanel'
import type { DescribeField } from './overview/describe-conditions'
import { useDisplayTemplate, useRoleNames, useRuleChoiceLabels } from './overview/overview-api'
import { Pill, purposeSegments, rowPill, Sentence, TYPE_USE } from './overview/purpose'
import type { OverviewRow } from './overview/types'
import { unsavedText } from './UnsavedConfirm'
import type { PreviewDevice } from './preview/preview-model'
import type { LayoutDraft } from './useLayoutDraft'

// The editor's top bar: which layout this is and when it is used, Preview as,
// Show hidden, History, Undo / Redo, Autosave, the one save status and Save.

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
}

const iconBtn =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
const btn =
  'inline-flex h-8 max-w-[220px] items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const labelCls = 'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'

function StatusChip({
  draft
}: {
  draft: Pick<LayoutDraft, 'status' | 'error'> & Partial<Pick<LayoutDraft, 'unsavedCount'>>
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
  return (
    <span
      role='status'
      data-save-status={status}
      data-unsaved={unsaved}
      data-tip={
        (status === 'error' || status === 'conflict') && error
          ? error
          : pendingOnly
            ? 'Only you see these changes until you save (⌘S)'
            : undefined
      }
      className={cn(
        'inline-flex max-w-[260px] items-center truncate whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold',
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
      {text}
    </span>
  )
}

/** The top bar's small on/off switches (Show hidden, Autosave). */
function BarSwitch({
  icon,
  label,
  tip,
  on,
  onChange,
  data
}: {
  icon?: ReactNode
  label: string
  tip: string
  on: boolean
  onChange: (on: boolean) => void
  data?: Record<string, string>
}) {
  return (
    <label
      className='inline-flex h-8 cursor-pointer items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'
      data-tip={tip}
    >
      {icon}
      {label}
      <button
        type='button'
        role='switch'
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        {...data}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          on ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-border'
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
            on ? 'translate-x-3.5' : 'translate-x-0.5'
          )}
        />
      </button>
    </label>
  )
}

function PreviewAsButton({
  collection,
  value,
  onChange,
  extra
}: {
  collection: string
  value: PreviewAs
  onChange: (v: PreviewAs) => void
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
  const roleName = roles.find((r) => r.id === value.roleId)?.name ?? null
  const compareName = roles.find((r) => r.id === value.compareRoleId)?.name ?? null
  const summary =
    [
      value.record?.label,
      compareName && roleName ? `${roleName} | ${compareName}` : roleName,
      value.state?.label,
      value.values && Object.keys(value.values).length > 0 ? 'What if' : null,
      value.device && value.device !== 'desktop'
        ? value.device === 'phone'
          ? 'Phone'
          : 'Tablet'
        : null,
      value.who ? 'Who sees' : null
    ]
      .filter(Boolean)
      .join(' · ') || 'No record'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className='hidden text-[12px] text-slate-500 lg:inline dark:text-muted-foreground'>
        Preview as
      </span>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={btn}
          aria-label='Preview as'
          data-tip='Show the form with a real record’s values, as a role sees it'
        >
          <UserRound className='h-3.5 w-3.5 shrink-0' />
          <span className='truncate'>{summary}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='max-h-[min(80vh,640px)] w-[320px] overflow-y-auto overscroll-contain p-3'
      >
        <p className={labelCls}>Record</p>
        {value.record ? (
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
                    onChange({ ...value, record: { id: String(o.id), label: o.label } })
                  }
                  className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
                >
                  {o.label}
                </button>
              ))}
              {!loading && options.length === 0 && (
                <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No records match.
                </p>
              )}
            </div>
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
  backLabel = 'Layouts',
  tools,
  previewExtra
}: {
  collection: string
  layoutId: number
  layoutName: string
  layoutType: string
  row: OverviewRow | undefined
  fields: DescribeField[]
  draft: Pick<
    LayoutDraft,
    'status' | 'error' | 'undo' | 'redo' | 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'
  > &
    Partial<Pick<LayoutDraft, 'autosave' | 'setAutosave' | 'unsavedCount' | 'save' | 'discard'>>
  preview: PreviewAs
  onPreview: (v: PreviewAs) => void
  showHidden: boolean
  onShowHidden: (v: boolean) => void
  /** Leave; `anchor` is the back button (an unsaved-changes confirm sits beside it). */
  onBack: (anchor?: HTMLElement) => void
  /** What the back button returns to ("Layouts", or the record in overlay mode). */
  backLabel?: string
  /** Editing tools the host adds after Undo / Redo (view toggle, auto-arrange). */
  tools?: ReactNode
  /** More preview modes inside the Preview as popover. */
  previewExtra?: ReactNode
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const unsaved = draft.unsavedCount ?? 0
  const pill = row ? rowPill(row) : null
  const rowList = useMemo(() => (row ? [row] : []), [row])
  const choices = useRuleChoiceLabels(collection, fields, rowList)
  const segs = row
    ? purposeSegments(row, fields, choices)
    : TYPE_USE[layoutType]
      ? [{ text: TYPE_USE[layoutType] }]
      : []

  return (
    <header
      data-editor-topbar=''
      className='flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
    >
      <button
        type='button'
        onClick={(e) => onBack(e.currentTarget)}
        className='inline-flex h-8 items-center gap-0.5 rounded-md pl-1 pr-2 text-[12px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      >
        <ChevronLeft className='h-4 w-4' />
        {backLabel}
      </button>
      <div className='flex min-w-0 flex-1 items-center gap-2'>
        <h2 className='truncate text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          {layoutName}
        </h2>
        {pill && <Pill tone={pill.tone}>{pill.text}</Pill>}
        {segs.length > 0 && (
          <span className='hidden min-w-0 truncate text-[12px] text-slate-500 md:inline dark:text-muted-foreground'>
            · <Sentence segs={segs} muted />
          </span>
        )}
      </div>
      <div className='flex items-center gap-0.5'>
        <button
          type='button'
          aria-label='Undo'
          className={iconBtn}
          disabled={!draft.canUndo}
          onClick={draft.undo}
          data-tip={draft.undoLabel ? `Undo ${draft.undoLabel} (⌘Z)` : 'Undo (⌘Z)'}
        >
          <Undo2 className='h-4 w-4' />
        </button>
        <button
          type='button'
          aria-label='Redo'
          className={iconBtn}
          disabled={!draft.canRedo}
          onClick={draft.redo}
          data-tip={draft.redoLabel ? `Redo ${draft.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)'}
        >
          <Redo2 className='h-4 w-4' />
        </button>
      </div>
      {tools}
      <PreviewAsButton
        collection={collection}
        value={preview}
        onChange={onPreview}
        extra={previewExtra}
      />
      <BarSwitch
        icon={<Eye className='h-3.5 w-3.5' />}
        label='Show hidden'
        tip='Show fields and sections the preview would hide, faintly, so you can select them'
        on={showHidden}
        onChange={onShowHidden}
      />
      <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
        <PopoverTrigger asChild>
          <button type='button' className={btn} aria-label='History'>
            <History className='h-3.5 w-3.5' />
            History
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          className='max-h-[min(70vh,560px)] w-[400px] overflow-y-auto overscroll-contain p-0'
        >
          {historyOpen && (
            <HistoryPanel
              layoutId={layoutId}
              onRestored={() => setHistoryOpen(false)}
              unsavedCount={unsaved}
              onDiscardUnsaved={draft.discard}
            />
          )}
        </PopoverContent>
      </Popover>
      {draft.setAutosave && (
        <BarSwitch
          label='Autosave'
          tip={
            draft.autosave
              ? 'Every change saves as you make it, until you close the editor'
              : 'Off: changes wait for Save. On: every change saves as you make it, until you close the editor'
          }
          on={!!draft.autosave}
          onChange={draft.setAutosave}
          data={{ 'data-autosave-switch': '' }}
        />
      )}
      <StatusChip draft={draft} />
      {draft.save && !draft.autosave && (
        <button
          type='button'
          data-editor-save=''
          disabled={unsaved === 0}
          onClick={() => void draft.save?.()}
          data-tip={unsaved > 0 ? `Save ${unsavedText(unsaved)} (⌘S)` : 'Nothing to save'}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-opacity disabled:pointer-events-none disabled:opacity-40',
            unsaved > 0
              ? 'bg-nvr-cyan text-white hover:opacity-90'
              : 'border border-slate-200 text-slate-700 dark:border-border dark:text-foreground'
          )}
        >
          <Save className='h-3.5 w-3.5' />
          Save
        </button>
      )}
    </header>
  )
}
