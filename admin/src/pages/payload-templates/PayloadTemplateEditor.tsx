import { TipLayer } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Code2,
  GitBranch,
  History,
  ListChecks,
  MoreHorizontal,
  RotateCcw
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { useGoBack } from '@/lib/nav'
import { cn } from '@/lib/utils'
import type { ExternalApi } from '../ExternalApis'
import {
  bodySecretNames,
  type DraftBody,
  detailStatus,
  draftOf,
  errorMessage,
  fetchTemplate,
  formatEt,
  httpStatus,
  payloadKeys,
  publishedOf,
  sameBody,
  staleCurrent,
  type TemplateDetail,
  useDebounced,
  useExternalApis,
  usePathNames,
  usePreview,
  useRecordLabel,
  useSaveDraft,
  useTemplate,
  useTemplates
} from './api'
import { CheckRecentPanel } from './CheckRecentPanel'
import { ConflictPanel, conflictText } from './ConflictPanel'
import { DefaultPanel, useTakeDefault } from './DefaultPanel'
import { type EditorTab, EditorTabs } from './EditorTabs'
import { PayloadEditorContext, type PayloadEditorCtx } from './editor-context'
import { HistoryPanel } from './HistoryPanel'
import { PreviewPane, type PreviewView } from './PreviewPane'
import { PublishPanel } from './PublishPanel'
import {
  defaultOf,
  draftLookupsOf,
  liveLookupsOf,
  newerDefaultState,
  sameLookups,
  serverErrors
} from './panel-api'
import { OUTLINE_BTN, PRIMARY_BTN } from './panel-parts'
import { TemplateList } from './TemplateList'

/** What the preview column shows instead of the preview. */
export type EditorPanel = 'publish' | 'check' | 'history' | 'default' | 'conflict'

const AUTOSAVE_MS = 800
const PREVIEW_DEBOUNCE_MS = 300
/** Page width below which the payload list sits above the editor. */
const LIST_BESIDE_MIN = 760
/** Page width at which the preview sits beside the editor instead of under it. */
const PREVIEW_BESIDE_MIN = 1100
/** Below this page width, with the preview beside the editor, the list folds into a combobox. */
const LIST_COLUMN_MIN_WITH_PREVIEW = 1400

// ─── Small hooks ─────────────────────────────────────────────────────────────

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(Math.floor(el.getBoundingClientRect().width))
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'error'; message: string; errors: string[] }
  | { kind: 'conflict'; current: TemplateDetail }

/**
 * The editor's local draft + autosave. Edits are kept locally and PUT ~800 ms
 * after the last change with `base_rev`; saves never overlap (a change made
 * while one is in flight is sent right after it). A 409 keeps the local draft
 * and stops autosave until the person reloads or keeps their draft. Switching
 * templates or leaving the page flushes a pending save immediately.
 */
export function useDraftEditor(key: string | null, detail: TemplateDetail | undefined) {
  const save = useSaveDraft()
  // The mutation result is a new object every render; run() must stay stable.
  const saveRef = useRef(save)
  saveRef.current = save
  const [local, setLocal] = useState<{ key: string; draft: DraftBody } | null>(null)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const revs = useRef<Record<string, number>>({})
  /** The published version each template was loaded at — a publish since then is a conflict. */
  const loadedVersions = useRef<Record<string, number | null>>({})
  const pending = useRef<{ key: string; draft: DraftBody } | null>(null)
  const inFlight = useRef(false)
  const blocked = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keyRef = useRef(key)
  keyRef.current = key
  /** The save in flight, so saveNow can wait for it. */
  const current = useRef<Promise<void> | null>(null)
  /** Whether the last save attempt failed (cleared by the next success). */
  const failed = useRef(false)
  const [rev, setRev] = useState<number | null>(null)

  // The save loop lives in a ref, refreshed every render, so `run` stays stable and never calls
  // a stale closure.
  const runOnceRef = useRef<() => Promise<void>>(async () => {})
  const run = useCallback((): Promise<void> => {
    if (inFlight.current) return current.current ?? Promise.resolve()
    if (blocked.current || !pending.current) return Promise.resolve()
    const p = runOnceRef.current()
    current.current = p
    return p
  }, [])

  runOnceRef.current = async function runOnce() {
    if (!pending.current) return
    const job = pending.current
    pending.current = null
    inFlight.current = true
    if (keyRef.current === job.key) setState({ kind: 'saving' })
    // A failed save waits for "Try again" or the next edit instead of retrying in a loop.
    let waitForRetry = false
    try {
      const res = await saveRef.current.mutateAsync({
        key: job.key,
        draft: job.draft,
        base_rev: revs.current[job.key] ?? 0,
        base_published_version: loadedVersions.current[job.key] ?? null
      })
      revs.current[job.key] = res.rev
      failed.current = false
      if (keyRef.current === job.key) setRev(res.rev)
      if (keyRef.current === job.key && !pending.current)
        setState({ kind: 'saved', at: new Date().toISOString() })
    } catch (e) {
      failed.current = true
      const stale = staleCurrent(e)
      if (stale) {
        blocked.current = true
        // Keep the newest local edit queued so "Keep my draft" sends it.
        pending.current = pending.current ?? job
        if (keyRef.current === job.key) setState({ kind: 'conflict', current: stale })
      } else {
        if (!pending.current) {
          pending.current = job
          waitForRetry = true
        }
        if (keyRef.current === job.key)
          setState({
            kind: 'error',
            message: errorMessage(e, 'The draft was not saved'),
            errors: serverErrors(e)
          })
      }
    } finally {
      inFlight.current = false
      current.current = null
      if (pending.current && !blocked.current && !waitForRetry) void run()
    }
  }

  /** A draft write made outside autosave (the lookups) moved the rev to `r`. */
  const bumpRev = useCallback((k: string, r: number) => {
    revs.current[k] = r
    if (keyRef.current === k) setRev(r)
  }, [])

  /** The published version template `k` was loaded at (what draft writes are based on). */
  const getLoadedVersion = useCallback((k: string) => loadedVersions.current[k] ?? null, [])

  /** Our own publish moved the live version: later saves are not conflicts with it. */
  const markPublished = useCallback((k: string, version: number) => {
    loadedVersions.current[k] = version
  }, [])

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    void run()
  }, [run])

  /**
   * Send the waiting edit now and wait until nothing is waiting or in flight.
   * True = the draft on the server is the local draft; false = a save failed or a conflict
   * blocks saving (the state says which).
   */
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    // Bounded: each pass either finishes a save or stops on a failure.
    for (let i = 0; i < 10; i++) {
      if (blocked.current) return false
      if (inFlight.current) {
        await current.current
        continue
      }
      if (!pending.current) return !failed.current
      await run()
      if (failed.current) return false
    }
    return !pending.current && !failed.current
  }, [run])

  /** Drop the waiting edit and wait out a save in flight (the server is about to replace the draft). */
  const discardPending = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
    if (inFlight.current) await current.current
    pending.current = null
  }, [])

  /** A 409 seen by publish / convert: stop autosave and show the conflict banner. */
  const raiseConflict = useCallback((stale: TemplateDetail) => {
    blocked.current = true
    if (keyRef.current === stale.key) setState({ kind: 'conflict', current: stale })
  }, [])

  // Start from the stored draft the first time a template's row arrives.
  useEffect(() => {
    if (!detail || !key || detail.key !== key) return
    if (local?.key === key) return
    revs.current[key] = detail.draft_rev
    loadedVersions.current[key] = detail.published_version ?? null
    // A conflicted edit of another template is never sent behind the person's back.
    if (blocked.current && pending.current && pending.current.key !== key) pending.current = null
    blocked.current = false
    failed.current = false
    setRev(detail.draft_rev)
    setLocal({ key, draft: draftOf(detail) })
    setState({ kind: 'idle' })
  }, [detail, key, local?.key])

  // Leaving a template (or the page) sends what is waiting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the template changes
  useEffect(() => () => flush(), [key, flush])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current || inFlight.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const change = useCallback(
    (next: DraftBody) => {
      if (!key) return
      setLocal({ key, draft: next })
      pending.current = { key, draft: next }
      if (blocked.current) return
      setState({ kind: 'pending' })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        void run()
      }, AUTOSAVE_MS)
    },
    [key, run]
  )

  /** Conflict → drop local edits and start again from the server's row. */
  const reload = useCallback((current: TemplateDetail) => {
    pending.current = null
    blocked.current = false
    failed.current = false
    revs.current[current.key] = current.draft_rev
    loadedVersions.current[current.key] = current.published_version ?? null
    if (keyRef.current === current.key) setRev(current.draft_rev)
    setLocal({ key: current.key, draft: draftOf(current) })
    setState({ kind: 'idle' })
  }, [])

  /** Conflict → save the local draft over the newer one. */
  const keepMine = useCallback(
    (current: TemplateDetail) => {
      revs.current[current.key] = current.draft_rev
      loadedVersions.current[current.key] = current.published_version ?? null
      blocked.current = false
      if (local?.key === current.key) pending.current = { key: current.key, draft: local.draft }
      flush()
    },
    [local, flush]
  )

  const getRev = useCallback(
    () => (keyRef.current ? (revs.current[keyRef.current] ?? null) : null),
    []
  )

  const draft = local && local.key === key ? local.draft : null
  return {
    draft,
    change,
    state,
    reload,
    keepMine,
    retry: flush,
    saveNow,
    discardPending,
    raiseConflict,
    markPublished,
    bumpRev,
    getLoadedVersion,
    rev,
    getRev
  }
}

// ─── Header pieces ───────────────────────────────────────────────────────────

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.kind === 'idle' || state.kind === 'conflict') return null
  if (state.kind === 'error')
    return (
      <span className='inline-flex items-center gap-1.5 text-[11.5px] text-red-600 dark:text-red-400'>
        {state.message}
        <button
          type='button'
          onClick={onRetry}
          className='font-medium underline underline-offset-2'
        >
          Try again
        </button>
      </span>
    )
  return (
    <span
      className='text-[11.5px] text-slate-500 dark:text-muted-foreground'
      aria-live='polite'
      data-payload-save={state.kind}
    >
      {state.kind === 'saved' ? `Draft saved ${formatEt(state.at, true)}` : 'Saving draft…'}
    </span>
  )
}

function UsedByPopover({ template }: { template: TemplateDetail }) {
  const n = template.used_by.length
  const transitions = template.used_by.filter((u) => u.kind === 'transition')
  const code = template.used_by.filter((u) => u.kind === 'code')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type='button' className={OUTLINE_BTN} data-payload-used-by>
          <GitBranch className='h-3.5 w-3.5 text-slate-400' />
          {n > 0 ? `Used by ${n}` : 'Not used yet'}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[320px] p-0'>
        {n === 0 ? (
          <p className='px-3 py-3 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Nothing sends this payload yet. Pick it on an erp_submit action in a pipeline to use it.
          </p>
        ) : (
          <div className='max-h-[320px] overflow-y-auto py-1.5'>
            {transitions.length > 0 && (
              <div>
                <p className='px-3 pb-1 pt-1.5 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
                  Pipeline transitions
                </p>
                <ul>
                  {transitions.map((u) => (
                    <li key={`${u.template_id}:${u.transition_id}:${u.label}`}>
                      {u.template_id ? (
                        <Link
                          to={`/pipelines/${u.template_id}`}
                          className='flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-muted'
                        >
                          <span className='min-w-0 flex-1 truncate'>{u.label}</span>
                          <ArrowRight className='h-3 w-3 shrink-0 text-slate-400' />
                        </Link>
                      ) : (
                        <span className='block truncate px-3 py-1.5 text-[12.5px] text-slate-700 dark:text-slate-200'>
                          {u.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {code.length > 0 && (
              <div
                className={cn(transitions.length > 0 && 'mt-1 border-t pt-1 dark:border-border')}
              >
                <p className='px-3 pb-1 pt-1.5 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
                  Code pushes{template.owner ? ` (${template.owner})` : ''}
                </p>
                <ul>
                  {code.map((u) => (
                    <li
                      key={u.label}
                      className='flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-slate-700 dark:text-slate-200'
                    >
                      <Code2 className='h-3 w-3 shrink-0 text-slate-400' />
                      <span className='min-w-0 truncate'>{u.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function MoreMenu({
  template,
  onOpenPanel
}: {
  template: TemplateDetail
  onOpenPanel: (p: EditorPanel) => void
}) {
  const [open, setOpen] = useState(false)
  const item =
    'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none dark:text-slate-200'
  const pick = (p: EditorPanel) => {
    setOpen(false)
    onOpenPanel(p)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='More actions'
          className={cn(OUTLINE_BTN, 'w-8 justify-center px-0')}
          data-payload-more
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[240px] p-1'>
        <button type='button' className={item} onClick={() => pick('history')}>
          <History className='h-3.5 w-3.5 text-slate-400' />
          History
        </button>
        {template.has_default && (
          <button type='button' className={item} onClick={() => pick('default')}>
            <RotateCcw className='h-3.5 w-3.5 text-slate-400' />
            Reset to file default
          </button>
        )}
        {template.newer_default && (
          <button type='button' className={item} onClick={() => pick('default')}>
            <ArrowRight className='h-3.5 w-3.5 text-slate-400' />
            Use {template.owner ?? 'the'} default
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

const PANEL_TITLES: Record<EditorPanel, string> = {
  publish: 'Publish',
  check: 'Recent records',
  history: 'History',
  default: 'File default',
  conflict: 'Review the diff'
}

/** The preview column's place, taken by Publish / Check / History / File default / the 409 diff. */
function PanelArea({
  panel,
  template,
  draft,
  conflict,
  nothingToPublish,
  warning,
  recordId,
  onRecordChange,
  onPreview,
  onOpenPanel,
  onReload,
  onKeep,
  onClose
}: {
  panel: EditorPanel
  template: TemplateDetail
  draft: DraftBody
  conflict: TemplateDetail | null
  nothingToPublish: boolean
  warning: string | null
  recordId: string | null
  onRecordChange: (id: string) => void
  onPreview: (id: string) => void
  onOpenPanel: (p: EditorPanel) => void
  onReload: (current: TemplateDetail) => void
  onKeep: (current: TemplateDetail) => void
  onClose: () => void
}) {
  if (panel === 'publish')
    return (
      <PublishPanel
        template={template}
        draft={draft}
        nothingToPublish={nothingToPublish}
        warning={warning}
        recordId={recordId}
        onRecordChange={onRecordChange}
        onPreview={onPreview}
        onClose={onClose}
      />
    )
  if (panel === 'check')
    return <CheckRecentPanel template={template} onClose={onClose} onPreview={onPreview} />
  if (panel === 'history')
    return (
      <HistoryPanel
        template={template}
        draft={draft}
        recordId={recordId}
        onRecordChange={onRecordChange}
        onOpenDefault={() => onOpenPanel('default')}
        onClose={onClose}
      />
    )
  if (panel === 'default')
    return (
      <DefaultPanel
        template={template}
        draft={draft}
        recordId={recordId}
        onRecordChange={onRecordChange}
        onClose={onClose}
      />
    )
  if (!conflict) return null
  return (
    <ConflictPanel
      loaded={template}
      current={conflict}
      draft={draft}
      recordId={recordId}
      onRecordChange={onRecordChange}
      onReload={() => {
        onReload(conflict)
        onClose()
      }}
      onKeep={() => {
        onKeep(conflict)
        onClose()
      }}
      onClose={onClose}
    />
  )
}

// ─── States ──────────────────────────────────────────────────────────────────

function Bar({ w, h = 'h-3' }: { w: string; h?: string }) {
  return (
    <div
      className={cn(h, 'animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]')}
      style={{ width: w }}
    />
  )
}

/** The editor's shape while it loads: header, tabs, field rows — and the preview beside them. */
function MainSkeleton({ split = false }: { split?: boolean }) {
  const rows = [
    ['112px', '160px', '64px'],
    ['96px', '200px', '48px'],
    ['128px', '140px', '72px'],
    ['84px', '180px', '40px'],
    ['120px', '150px', '56px'],
    ['104px', '170px', '60px']
  ]
  return (
    <div className='flex min-h-0 flex-1 flex-col' aria-hidden data-payload-loading>
      <div className='flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3.5 dark:border-border dark:bg-card'>
        <div className='space-y-2.5'>
          <Bar w='220px' h='h-4' />
          <Bar w='300px' />
        </div>
        <div className='flex gap-2'>
          <Bar w='84px' h='h-8' />
          <Bar w='140px' h='h-8' />
          <Bar w='72px' h='h-8' />
        </div>
      </div>
      <div className={cn('flex min-h-0 flex-1', split ? 'flex-row' : 'flex-col')}>
        <div className='min-w-0 flex-1 bg-white dark:bg-card'>
          <div className='flex gap-5 border-b border-slate-200 px-5 py-3 dark:border-border'>
            <Bar w='64px' />
            <Bar w='36px' />
            <Bar w='36px' />
          </div>
          <div className='divide-y divide-slate-100 px-5 dark:divide-border/60'>
            {rows.map(([k, v, x]) => (
              <div key={k + v} className='flex items-center gap-4 py-3.5'>
                <Bar w={k} />
                <Bar w='40px' />
                <Bar w={v} h='h-6' />
                <span className='flex-1' />
                <Bar w={x} />
              </div>
            ))}
          </div>
        </div>
        {split && (
          <div className='w-[42%] min-w-[360px] max-w-[580px] shrink-0 space-y-2.5 border-l border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-background'>
            <Bar w='100%' h='h-8' />
            {['30%', '62%', '54%', '70%', '48%', '66%', '40%', '58%'].map((w, i) => (
              <div key={w} style={{ marginLeft: i === 0 ? 0 : 16 }}>
                <Bar w={w} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className='px-6 py-10'>
      <p className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>{title}</p>
      {children && (
        <div className='mt-1 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          {children}
        </div>
      )}
    </div>
  )
}

function EditWarning({ text }: { text: string }) {
  return (
    <div
      className='flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
      role='note'
      data-payload-edit-warning
    >
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
      <p>{text}</p>
    </div>
  )
}

function ConflictBanner({
  current,
  loaded,
  onReload,
  onKeep,
  onReview
}: {
  current: TemplateDetail
  loaded: TemplateDetail
  onReload: () => void
  onKeep: () => void
  onReview: () => void
}) {
  const link =
    'h-7 rounded-md px-2.5 font-medium underline underline-offset-2 hover:bg-amber-100 dark:hover:bg-amber-500/15'
  return (
    <div
      // Sticky so it stays in view when the stacked layout scrolls; opaque (amber-500/10 over
      // the page background, flattened) so rows never show through it.
      className='sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-[#292218] dark:text-amber-200'
      role='alert'
      data-payload-conflict
    >
      <p className='min-w-0 flex-1'>{conflictText(current, loaded)}</p>
      <button
        type='button'
        onClick={onReload}
        className='h-7 rounded-md border border-amber-300 bg-white px-2.5 font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:hover:bg-amber-500/15'
      >
        Reload
      </button>
      <button type='button' onClick={onKeep} className={link}>
        Keep my draft
      </button>
      <button type='button' onClick={onReview} className={link} data-payload-conflict-review>
        Review the diff
      </button>
    </div>
  )
}

/** "<owner> ships a newer default" + Use as draft (straight away when nothing would be lost). */
function NewerDefaultBanner({
  template,
  draft,
  nothingToPublish,
  onReview
}: {
  template: TemplateDetail
  draft: DraftBody
  nothingToPublish: boolean
  onReview: () => void
}) {
  const owner = template.owner ?? 'The extension'
  const { take, pending } = useTakeDefault(template)
  const def = defaultOf(template)
  const live = publishedOf(template)
  const draftLk = draftLookupsOf(template)
  const state = newerDefaultState(template, draft, nothingToPublish)
  const holdsDefault = state === 'holds'
  // Nothing unpublished and no mode switch → nothing to lose, so no extra step.
  const direct =
    !!def &&
    !!live &&
    sameBody(draft, live) &&
    sameLookups(draftLk, liveLookupsOf(template)) &&
    def.mode === draft.mode
  const use = async () => {
    if (!direct) return onReview()
    const err = await take()
    if (err) toast.error(err)
  }
  // The default is already live: nothing to say.
  if (state === 'hidden') return null
  return (
    <div
      className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-5 py-2 text-[12.5px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
      data-payload-newer-default
    >
      <p className='min-w-0 flex-1'>
        {holdsDefault
          ? `The draft holds the newer ${owner} default. Publish it to make it live.`
          : `${owner} ships a newer default`}
      </p>
      <button
        type='button'
        onClick={onReview}
        className='font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 dark:text-slate-300 dark:hover:text-foreground'
      >
        See what changed
      </button>
      {!holdsDefault && (
        <button
          type='button'
          onClick={() => void use()}
          disabled={pending}
          className={cn(OUTLINE_BTN, 'h-7 px-2.5')}
          data-payload-use-default
        >
          {pending ? 'Copying…' : 'Use as draft'}
        </button>
      )}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * `/external-apis/:id/payloads/:key?` — the full-width payload template
 * editor: this API's payloads on the left, the template's header, the editor
 * tabs, and the record preview (or a Publish / Check / History panel).
 * `:id` is the API id; an API name (older links) is replaced by its id.
 */
export function PayloadTemplateEditorPage() {
  const { id = '', key: keyParam } = useParams<{ id: string; key?: string }>()
  const key = keyParam ?? null
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [pageRef, width] = useElementWidth<HTMLDivElement>()
  const listBeside = width >= LIST_BESIDE_MIN
  const previewBeside = width >= PREVIEW_BESIDE_MIN
  // The list column only when the editor keeps its room; otherwise a combobox bar on top.
  const listColumn = listBeside && !(previewBeside && width < LIST_COLUMN_MIN_WITH_PREVIEW)

  const apisQ = useExternalApis()
  const apis = apisQ.data ?? []
  const currentApi =
    apis.find((a) => String(a.id) === id) ?? apis.find((a) => a.name === id) ?? null
  const apiId = currentApi?.id ?? null
  const goBack = useGoBack(apiId != null ? `/external-apis/${apiId}` : '/external-apis')

  // Older links name the API instead of its id.
  useEffect(() => {
    if (currentApi && String(currentApi.id) !== id)
      navigate(
        `/external-apis/${currentApi.id}/payloads${key ? `/${encodeURIComponent(key)}` : ''}`,
        {
          replace: true
        }
      )
  }, [currentApi, id, key, navigate])

  const apiRow = useQuery<ExternalApi>({
    queryKey: ['external-api', String(apiId)],
    queryFn: () =>
      api.get<{ data: ExternalApi }>(`/external-apis/${apiId}`).then((r) => r.data.data),
    enabled: apiId != null
  })
  const secretNames = useMemo(() => bodySecretNames(apiRow.data), [apiRow.data])

  const listQ = useTemplates(currentApi?.name)
  const templates = listQ.data?.data ?? []

  // No template in the URL → open the first one.
  useEffect(() => {
    if (!key && apiId != null && templates.length)
      navigate(`/external-apis/${apiId}/payloads/${encodeURIComponent(templates[0].key)}`, {
        replace: true
      })
  }, [key, apiId, templates, navigate])

  const tplQ = useTemplate(key)
  const template = tplQ.data?.data
  const warning = tplQ.data?.warning ?? listQ.data?.warning ?? null

  // A template opened under the wrong API moves to its own.
  useEffect(() => {
    if (!template || !currentApi || !template.external_api) return
    if (template.external_api === currentApi.name) return
    const own = apis.find((a) => a.name === template.external_api)
    if (own)
      navigate(`/external-apis/${own.id}/payloads/${encodeURIComponent(template.key)}`, {
        replace: true
      })
  }, [template, currentApi, apis, navigate])

  const editor = useDraftEditor(key, template)
  const previewDraft = useDebounced(
    editor.draft && key ? { key, draft: editor.draft } : null,
    PREVIEW_DEBOUNCE_MS
  )
  // Until the debounce settles on a template, render its draft as loaded (same body → same request).
  const draftForPreview =
    previewDraft && previewDraft.key === key ? previewDraft.draft : editor.draft

  const recordId = searchParams.get('record')
  const setRecordId = useCallback(
    (rid: string) =>
      setSearchParams(
        (p) => {
          const n = new URLSearchParams(p)
          n.set('record', rid)
          return n
        },
        { replace: true }
      ),
    [setSearchParams]
  )

  const [tab, setTab] = useState<EditorTab>('map')
  const [view, setView] = useState<PreviewView>('draft')
  const [panel, setPanel] = useState<EditorPanel | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per template
  useEffect(() => {
    setPanel(null)
    setView('draft')
    setTab('map')
  }, [key])

  // Same args as PreviewPane's draft render → one shared request; feeds the field map.
  const draftPreview = usePreview(key, {
    which: 'draft',
    recordId,
    draft: draftForPreview,
    enabled: !!draftForPreview
  })

  const selectTemplate = (k: string) =>
    apiId != null &&
    navigate(`/external-apis/${apiId}/payloads/${encodeURIComponent(k)}`, { replace: true })
  const switchApi = (a: ExternalApi) =>
    navigate(`/external-apis/${a.id}/payloads`, { replace: true })
  const newPayload = () => apiId != null && navigate(`/external-apis/${apiId}#new-payload`)

  // Lookups publish with the body: the same body with different lookups is still a draft.
  const bodyStatus = template ? detailStatus(template, editor.draft) : null
  const status =
    template &&
    bodyStatus === 'live' &&
    !sameLookups(draftLookupsOf(template), liveLookupsOf(template))
      ? 'draft'
      : bodyStatus
  const nothingToPublish = status === 'live'
  const conflict = editor.state.kind === 'conflict' ? editor.state.current : null
  // The diff review only makes sense while the conflict stands.
  useEffect(() => {
    if (panel === 'conflict' && !conflict) setPanel(null)
  }, [panel, conflict])

  const qc = useQueryClient()
  const { reload } = editor
  /** A server-side draft change (restore, reset, convert): make the stored draft the editor's. */
  const adoptServerDraft = useCallback(async () => {
    if (!key) return
    const fresh = await qc.fetchQuery({
      queryKey: payloadKeys.detail(key),
      queryFn: () => fetchTemplate(key),
      staleTime: 0
    })
    reload(fresh.data)
  }, [key, qc, reload])

  const saveState = editor.state
  const recordLabel = useRecordLabel(key, recordId)
  const pathNames = usePathNames(template?.collection)
  const editorCtx = useMemo<PayloadEditorCtx>(
    () => ({
      saveNow: editor.saveNow,
      discardPending: editor.discardPending,
      adoptServerDraft,
      raiseConflict: editor.raiseConflict,
      markPublished: editor.markPublished,
      bumpRev: editor.bumpRev,
      getLoadedVersion: editor.getLoadedVersion,
      conflicted: saveState.kind === 'conflict',
      saveError:
        saveState.kind === 'error'
          ? { message: saveState.message, errors: saveState.errors }
          : null,
      rev: editor.rev,
      getRev: editor.getRev,
      saving: saveState.kind === 'pending' || saveState.kind === 'saving',
      recordId,
      recordLabel,
      pathNames
    }),
    [
      editor.saveNow,
      editor.discardPending,
      editor.raiseConflict,
      editor.markPublished,
      editor.bumpRev,
      editor.getLoadedVersion,
      editor.rev,
      editor.getRev,
      adoptServerDraft,
      saveState,
      recordId,
      recordLabel,
      pathNames
    ]
  )
  const closePanel = useCallback(() => setPanel(null), [])
  const previewRecord = useCallback(
    (rid: string) => {
      setRecordId(rid)
      setView('draft')
      setPanel(null)
    },
    [setRecordId]
  )

  let main: React.ReactNode
  if (apisQ.isLoading) {
    main = <MainSkeleton split={previewBeside} />
  } else if (apisQ.isError) {
    main = <Notice title='External APIs could not load'>{errorMessage(apisQ.error)}</Notice>
  } else if (!currentApi) {
    main = (
      <Notice title={`No external API “${id}”`}>
        It may have been renamed or removed.{' '}
        <Link
          to='/external-apis'
          className='font-medium text-slate-900 underline underline-offset-2 dark:text-foreground'
        >
          All external APIs
        </Link>
      </Notice>
    )
  } else if (!key) {
    main = listQ.isLoading ? (
      <MainSkeleton split={previewBeside} />
    ) : (
      <Notice title={`No payloads on ${currentApi.name} yet`}>
        Create one from the Payloads card on the API page.
      </Notice>
    )
  } else if (tplQ.isError) {
    main =
      httpStatus(tplQ.error) === 404 ? (
        <Notice title={`No payload “${key}”`}>
          Pick one from the list, or create it on the API page.
        </Notice>
      ) : (
        <Notice title='This payload could not load'>
          {errorMessage(tplQ.error)}{' '}
          <button
            type='button'
            onClick={() => void tplQ.refetch()}
            className='font-medium underline underline-offset-2'
          >
            Try again
          </button>
        </Notice>
      )
  } else if (!template || !editor.draft) {
    main = <MainSkeleton split={previewBeside} />
  } else {
    main = (
      <div className={cn('flex flex-1 flex-col', previewBeside && 'min-h-0 overflow-hidden')}>
        <header className='shrink-0 border-b border-slate-200 bg-white px-5 py-3 dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-start gap-x-4 gap-y-2'>
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                <h1 className='min-w-0 truncate text-[16px] font-semibold tracking-[-0.005em] text-slate-900 dark:text-foreground'>
                  {template.label}
                </h1>
                {status === 'draft' ? (
                  <span
                    className='rounded bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
                    data-tip={
                      template.published_version != null
                        ? `Pushes still send live v${template.published_version} until you publish`
                        : undefined
                    }
                  >
                    Draft — not live
                  </span>
                ) : status === 'unpublished' ? (
                  <span className='rounded bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                    Not published
                  </span>
                ) : (
                  <span className='rounded bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'>
                    Live v{template.published_version}
                  </span>
                )}
                <SaveStatus state={editor.state} onRetry={editor.retry} />
              </div>
              <p className='mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                <span>{currentApi.name}</span>
                {template.endpoint_path && (
                  <>
                    <span aria-hidden>·</span>
                    <span className='break-all font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
                      {template.endpoint_path}
                    </span>
                  </>
                )}
                <span aria-hidden>·</span>
                <span>
                  one per <span className='font-mono text-[11.5px]'>{template.collection}</span>{' '}
                  record
                </span>
              </p>
            </div>
            <div className='flex shrink-0 flex-wrap items-center gap-2'>
              <UsedByPopover template={template} />
              <button
                type='button'
                onClick={() => setPanel('check')}
                aria-pressed={panel === 'check'}
                className={cn(OUTLINE_BTN, panel === 'check' && 'bg-slate-100 dark:bg-muted')}
                data-payload-check
              >
                <ListChecks className='h-3.5 w-3.5 text-slate-400' />
                Check recent records
              </button>
              <span data-tip={nothingToPublish ? 'Nothing to publish' : undefined}>
                <button
                  type='button'
                  disabled={nothingToPublish}
                  onClick={() => setPanel('publish')}
                  aria-pressed={panel === 'publish'}
                  className={
                    // While the Publish panel is open its own button is the one cyan action.
                    panel === 'publish'
                      ? cn(OUTLINE_BTN, 'bg-slate-100 dark:bg-muted')
                      : PRIMARY_BTN
                  }
                  data-payload-publish
                >
                  Publish
                </button>
              </span>
              <MoreMenu template={template} onOpenPanel={setPanel} />
            </div>
          </div>
        </header>

        {conflict && (
          <ConflictBanner
            current={conflict}
            loaded={template}
            onReload={() => {
              editor.reload(conflict)
              void tplQ.refetch()
            }}
            onKeep={() => editor.keepMine(conflict)}
            onReview={() => setPanel('conflict')}
          />
        )}
        {template.newer_default && (
          <NewerDefaultBanner
            template={template}
            draft={editor.draft}
            nothingToPublish={nothingToPublish}
            onReview={() => setPanel('default')}
          />
        )}

        <div
          className={cn(
            'flex flex-1',
            previewBeside ? 'min-h-0 flex-row overflow-hidden' : 'flex-col'
          )}
        >
          <section
            className={cn(
              'flex min-w-0 flex-col bg-white dark:bg-card',
              previewBeside ? 'min-h-0 flex-1' : 'min-h-[360px]'
            )}
            aria-label='Editor'
          >
            <EditorTabs
              tab={tab}
              onTabChange={setTab}
              template={template}
              draft={editor.draft}
              onDraftChange={editor.change}
              values={draftPreview.data?.values ?? {}}
              valuesPending={draftPreview.isFetching && !draftPreview.data}
              problems={draftPreview.data?.problems ?? []}
              secretNames={secretNames}
              secretsHref={apiId != null ? `/external-apis/${apiId}#body-secrets` : null}
            />
          </section>
          <section
            className={cn(
              'flex flex-col border-slate-200 dark:border-border',
              previewBeside
                ? 'min-h-0 w-[42%] min-w-[360px] max-w-[580px] shrink-0 border-l'
                : 'min-h-[440px] border-t'
            )}
            aria-label={panel ? PANEL_TITLES[panel] : 'Preview'}
          >
            {panel ? (
              <PanelArea
                panel={panel}
                template={template}
                draft={editor.draft}
                conflict={conflict}
                nothingToPublish={nothingToPublish}
                warning={warning}
                recordId={recordId}
                onRecordChange={setRecordId}
                onPreview={previewRecord}
                onOpenPanel={setPanel}
                onReload={(c) => {
                  editor.reload(c)
                  void tplQ.refetch()
                }}
                onKeep={(c) => editor.keepMine(c)}
                onClose={closePanel}
              />
            ) : (
              <PreviewPane
                templateKey={template.key}
                draft={draftForPreview}
                recordId={recordId}
                onRecordChange={setRecordId}
                view={view}
                onViewChange={setView}
                collection={template.collection}
                liveVersion={template.published_version}
                externalApiId={apiId}
              />
            )}
          </section>
        </div>
      </div>
    )
  }

  return (
    <div ref={pageRef} className='flex flex-1 min-h-0 flex-col' data-payload-editor>
      <TipLayer />
      {warning && <EditWarning text={warning} />}
      <div
        className={cn(
          'flex min-h-0 flex-1',
          listColumn
            ? 'overflow-hidden'
            : previewBeside
              ? 'flex-col overflow-hidden'
              : 'flex-col overflow-y-auto'
        )}
      >
        <TemplateList
          apis={apis}
          currentApi={currentApi}
          onBack={goBack}
          onSwitchApi={switchApi}
          templates={templates}
          loading={apisQ.isLoading || listQ.isLoading}
          error={listQ.isError ? errorMessage(listQ.error, 'Payloads could not load') : null}
          selectedKey={key}
          onSelect={selectTemplate}
          onNew={newPayload}
          compact={!listColumn}
        />
        <main
          className={cn(
            'flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-background',
            (listColumn || previewBeside) && 'min-h-0',
            listColumn && !previewBeside && 'overflow-y-auto',
            previewBeside && 'overflow-hidden'
          )}
        >
          <PayloadEditorContext.Provider value={editorCtx}>{main}</PayloadEditorContext.Provider>
        </main>
      </div>
    </div>
  )
}

/**
 * `/payload-templates/:key` — a link that only knows the template (config
 * search): finds the template's API and replaces itself with the editor URL.
 */
export function PayloadTemplateRedirectPage() {
  const { key = '' } = useParams<{ key: string }>()
  const navigate = useNavigate()
  const tplQ = useTemplate(key)
  const apisQ = useExternalApis()
  const apiName = tplQ.data?.data.external_api ?? null
  const target = apiName ? (apisQ.data ?? []).find((a) => a.name === apiName) : null

  useEffect(() => {
    if (target)
      navigate(`/external-apis/${target.id}/payloads/${encodeURIComponent(key)}`, { replace: true })
  }, [target, key, navigate])

  if (tplQ.isError)
    return (
      <Notice
        title={
          httpStatus(tplQ.error) === 404 ? `No payload “${key}”` : 'This payload could not load'
        }
      >
        {httpStatus(tplQ.error) === 404 ? 'It may have been deleted.' : errorMessage(tplQ.error)}
      </Notice>
    )
  if (tplQ.data && !apiName)
    return (
      <Notice title={`“${tplQ.data.data.label}” is not attached to an external API`}>
        Payloads are edited from their API's page.
      </Notice>
    )
  if (tplQ.data && apisQ.data && !target)
    return (
      <Notice title={`No external API “${apiName}”`}>
        The payload names an API that no longer exists.{' '}
        <Link
          to='/external-apis'
          className='font-medium text-slate-900 underline underline-offset-2 dark:text-foreground'
        >
          All external APIs
        </Link>
      </Notice>
    )
  return <MainSkeleton />
}
