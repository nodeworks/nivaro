/**
 * The `notebook` level (#1212): a saved investigation — its notes (saved as you type), the saved
 * stack as links (each opens its level), "Restore this stack" and what each level showed when it
 * was saved (useful once the live data has aged out).
 */
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { History, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { fmtClock, refTitle } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import {
  back,
  closeInspect,
  decodeStack,
  getInspectSnapshot,
  replaceInspect
} from '../../inspect/stack'
import { type InspectPanelProps, inspectableFor } from '../../registry/inspectables'
import { apiErrorOf, FIELD, MUTED } from './ui'

export interface InvestigationDetail {
  id: string
  title: string
  stack: string
  notes: string | null
  context: {
    levels?: Array<{ n?: number; kind?: string; title?: string; note?: string; detail?: unknown }>
  } | null
  context_bytes: number
  created_by: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
  can_edit: boolean
}

const SAVE_DELAY_MS = 800
const BTN =
  'inline-flex items-center gap-1.5 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 py-1 text-[12px] font-medium text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/** The detail query key prefix every `notebook` level of `id` reads (any anchor / window). */
function notebookKey(id: string): readonly unknown[] {
  return ['tm-inspect', 'notebook', id]
}

/**
 * PATCH the notes and write the answer into every cached detail of this notebook, so reopening
 * the level (from the list, a crumb, or the URL) shows what was saved and never re-saves the
 * pre-edit text. Without a usable answer the detail is invalidated instead.
 */
async function patchNotes(qc: QueryClient, id: string, text: string): Promise<void> {
  const res = await api.patch(`/traffic-map/investigations/${id}`, { notes: text })
  const fresh = (res?.data as { data?: InvestigationDetail | null } | undefined)?.data
  if (fresh && typeof fresh === 'object' && fresh.id === id) {
    qc.setQueriesData<InvestigationDetail>({ queryKey: notebookKey(id) }, (old) =>
      old ? { ...old, ...fresh } : old
    )
  } else {
    void qc.invalidateQueries({ queryKey: notebookKey(id) })
  }
  void qc.invalidateQueries({ queryKey: ['traffic-map', 'investigations'] })
}

/**
 * Notes saved as you type. Saves run one after another on a single promise chain, so a slow
 * earlier save can never land after — and overwrite — a later one. `initial` is the server's
 * text: when it changes underneath (a refetch, another admin's edit) and there is nothing
 * unsaved here, the editor takes it over.
 */
function useNotesAutosave(id: string, initial: string | null, enabled: boolean) {
  const qc = useQueryClient()
  const [value, setValue] = useState(initial ?? '')
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What the textarea shows. */
  const latest = useRef(value)
  /** What the server is known to hold. */
  const saved = useRef(initial ?? '')
  /** The newest text handed to the chain (in flight or queued). */
  const sent = useRef<string | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(true)

  const save = (text: string) => {
    sent.current = text
    chain.current = chain.current.then(async () => {
      if (text === saved.current) {
        if (mounted.current) setState(latest.current === text ? 'saved' : 'pending')
        return
      }
      if (mounted.current) setState('saving')
      try {
        await patchNotes(qc, id, text)
        saved.current = text
        if (!mounted.current) return
        setState(latest.current === text ? 'saved' : 'pending')
        setError(null)
      } catch (e) {
        if (!mounted.current) return
        setState('error')
        setError(apiErrorOf(e).message)
      }
    })
  }

  // take over text that changed on the server while nothing is unsaved here
  useEffect(() => {
    const server = initial ?? ''
    if (server === saved.current || latest.current !== saved.current) return
    saved.current = server
    latest.current = server
    setValue(server)
  }, [initial])

  // flush a pending edit when the level closes — unless that text is already on its way
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only flush of the latest text
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      const text = latest.current
      if (text === saved.current || text === sent.current) return
      sent.current = text
      chain.current = chain.current.then(async () => {
        if (text === saved.current) return
        try {
          await patchNotes(qc, id, text)
          saved.current = text
        } catch {
          /* the level is gone; the next open shows what the server kept */
        }
      })
    }
  }, [])

  const change = (text: string) => {
    if (!enabled) return
    setValue(text)
    latest.current = text
    setState('pending')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      save(latest.current)
    }, SAVE_DELAY_MS)
  }
  return { value, change, state, error, retry: () => save(latest.current) }
}

function SaveStatus({
  state,
  error,
  retry
}: {
  state: SaveState
  error: string | null
  retry(): void
}) {
  if (state === 'idle') return null
  if (state === 'error')
    return (
      <span
        className='text-[12px] text-[var(--tm-error-ink)]'
        data-tm-inspect-notebook-save='error'
      >
        Not saved: {error}{' '}
        <button type='button' className='underline' onClick={retry}>
          Retry
        </button>
      </span>
    )
  return (
    <span className={MUTED} data-tm-inspect-notebook-save={state}>
      {state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : 'Unsaved changes'}
    </span>
  )
}

function NotesEditor({ inv }: { inv: InvestigationDetail }) {
  const notes = useNotesAutosave(inv.id, inv.notes, inv.can_edit)
  return (
    <div className='grid gap-1'>
      <div className='flex items-center justify-between gap-2'>
        <label
          htmlFor={`nb-notes-${inv.id}`}
          className='text-[12px] font-semibold text-[var(--tm-fg-2)]'
        >
          Notes
        </label>
        <SaveStatus state={notes.state} error={notes.error} retry={notes.retry} />
      </div>
      <textarea
        id={`nb-notes-${inv.id}`}
        className={cn(FIELD, 'min-h-[140px] resize-y leading-relaxed')}
        value={notes.value}
        readOnly={!inv.can_edit}
        placeholder={
          inv.can_edit ? 'What you found, what you ruled out, what to check next…' : 'No notes'
        }
        onChange={(e) => notes.change(e.target.value)}
        data-tm-inspect-notebook-notes=''
      />
      {!inv.can_edit && (
        <p className={MUTED}>Only the admin who saved this, or another admin, can change it.</p>
      )}
    </div>
  )
}

function DeleteButton({ inv }: { inv: InvestigationDetail }) {
  const qc = useQueryClient()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      type='button'
      className={cn(BTN, armed && 'border-[var(--tm-error)] text-[var(--tm-error-ink)]')}
      disabled={busy}
      data-tm-inspect-notebook-delete={armed ? 'confirm' : ''}
      onClick={async () => {
        if (!armed) {
          setArmed(true)
          return
        }
        setBusy(true)
        try {
          await api.delete(`/traffic-map/investigations/${inv.id}`)
          void qc.invalidateQueries({ queryKey: ['traffic-map', 'investigations'] })
          toast.success(`Deleted "${inv.title}"`)
          if (getInspectSnapshot().index > 0) back()
          else closeInspect()
        } catch (e) {
          toast.error(apiErrorOf(e).message)
          setBusy(false)
          setArmed(false)
        }
      }}
    >
      <Trash2 className='h-3.5 w-3.5' aria-hidden='true' />
      {armed ? 'Click again to delete' : 'Delete'}
    </button>
  )
}

export function NotebookPanel({ inspectRef, anchor }: InspectPanelProps) {
  const q = useInspectDetail<InvestigationDetail>(inspectRef, anchor)
  if (q.isLoading) {
    return (
      <div className='grid gap-2' aria-busy='true' data-tm-inspect-notebook-loading=''>
        {[70, 90, 55, 80].map((w) => (
          <div
            key={w}
            className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    )
  }
  if (q.isError || !q.data) {
    const err = q.error ? inspectErrorOf(q.error) : null
    return (
      <p className={MUTED} data-tm-inspect-notebook-error={err?.code ?? ''}>
        {err?.status === 404
          ? 'This investigation is not here: it was deleted, it was saved on another map store, or this instance has not run migration 390 yet.'
          : `The investigation could not be loaded: ${err?.message ?? 'no data'}.`}
      </p>
    )
  }
  const inv = q.data
  const all = decodeStack(inv.stack, () => true)
  const openable = decodeStack(inv.stack)
  const ctxLevels = inv.context?.levels ?? []
  return (
    <div className='grid gap-3.5' data-tm-inspect-notebook={inv.id}>
      <header className='grid gap-0.5'>
        <h3 className='text-[14px] font-semibold text-[var(--tm-fg)]'>{inv.title}</h3>
        <p className={MUTED}>
          Saved by {inv.created_by_name ?? 'someone no longer listed'} · {when(inv.created_at)}
          {inv.updated_at !== inv.created_at ? ` · updated ${when(inv.updated_at)}` : ''}
        </p>
      </header>

      <NotesEditor key={inv.id} inv={inv} />

      <section className='grid gap-1.5'>
        <div className='flex items-center justify-between gap-2'>
          <h4 className='text-[12px] font-semibold text-[var(--tm-fg-2)]'>Saved stack</h4>
          <button
            type='button'
            className={BTN}
            disabled={openable.length === 0}
            onClick={() => replaceInspect(openable)}
            data-tm-inspect-notebook-restore={
              openable.length === all.length ? '' : `${openable.length}/${all.length}`
            }
            data-tip={
              openable.length === all.length
                ? 'Open these levels again in this panel, as they were'
                : `Only ${openable.length} of ${all.length} saved levels can open on this page; the others are skipped`
            }
          >
            <History className='h-3.5 w-3.5' aria-hidden='true' />
            {openable.length === all.length || openable.length === 0
              ? 'Restore this stack'
              : `Restore ${openable.length} of ${all.length} levels`}
          </button>
        </div>
        {openable.length > 0 && openable.length !== all.length && (
          <p className={MUTED} data-tm-inspect-notebook-restore-partial=''>
            {openable.length} of {all.length} levels can open here: nothing on this page shows the
            others, so the restored stack is shorter and starts from the first one that opens.
          </p>
        )}
        {all.length === 0 ? (
          <p className={MUTED}>The saved stack could not be read.</p>
        ) : (
          <ol className='grid gap-1' data-tm-inspect-notebook-stack=''>
            {all.map((ref, i) => (
              <li key={`${i}:${ref.kind}:${ref.id}`} className='flex min-w-0 items-baseline gap-2'>
                <span className='w-5 shrink-0 text-right tabular-nums text-[11px] text-[var(--tm-muted)]'>
                  {i + 1}
                </span>
                {inspectableFor(ref.kind) ? (
                  <InspectLink inspectRef={ref} className='text-[12.5px]' />
                ) : (
                  <span className='truncate text-[12.5px] text-[var(--tm-fg-2)]'>
                    {refTitle(ref)}{' '}
                    <span className={MUTED}>(nothing on this page opens a {ref.kind})</span>
                  </span>
                )}
                {ref.at != null && <span className={MUTED}>{fmtClock(ref.at)}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <details className='grid gap-1' data-tm-inspect-notebook-context=''>
        <summary className='cursor-pointer text-[12px] font-semibold text-[var(--tm-fg-2)]'>
          What was on screen when saved
          <span className='ml-1.5 font-normal text-[var(--tm-muted)]'>
            {inv.context_bytes > 0
              ? `${(inv.context_bytes / 1024).toFixed(1)} KB`
              : 'nothing captured'}
          </span>
        </summary>
        {ctxLevels.length === 0 ? (
          <p className={MUTED}>
            No context was captured with this investigation (it was saved without one).
          </p>
        ) : (
          <ul className='mt-1 grid gap-1'>
            {ctxLevels.map((l, i) => (
              <li key={`${l.n ?? i}`} className='text-[12px]'>
                <span className='font-medium'>
                  {l.n ?? i + 1}. {l.title ?? l.kind}
                </span>
                {l.note && <span className={cn(MUTED, 'ml-1.5')}>({l.note})</span>}
                {l.detail != null && (
                  <pre className='mt-0.5 max-h-40 overflow-auto rounded bg-[var(--tm-card-2)] p-1.5 text-[11px]'>
                    {JSON.stringify(l.detail, null, 2).slice(0, 4000)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>

      {inv.can_edit && (
        <div className='flex justify-end'>
          <DeleteButton inv={inv} />
        </div>
      )}
    </div>
  )
}
