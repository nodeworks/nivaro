import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  HelpCircle,
  Loader2,
  Sparkles,
  Wand2
} from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useApiFetchConfig, useOptionalNivaroClient } from '../../context'
import { type AskRelationInput, askPickerNarrowing } from '../../lib/autofill-ask-filter'
import { pollProposal } from '../../lib/autofill-poll'
import { cn } from '../../lib/utils'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

/**
 * "Fill from a document" — a person drops a statement of work, a quote, a
 * spreadsheet on a NEW record and reviews what the model read out of it
 * before any of it lands in the form. Server contract: POST /ai/extract-record
 * (background=1) answers a proposal id; GET /ai/extract-record/result/:id
 * carries the DocumentProposal (values + confidence + the sentence each came
 * from) once the run lands. This dialog is the review. Nothing is written
 * until Apply, and Apply only stages — the record still needs Create.
 *
 * The run always goes through the background path so the same proposal id
 * serves three doors: this button, a list's "New from document…" (which
 * opens the form on `?autofill=<id>`), and "tell me when it's ready" (the
 * notification opens the same form on the same id).
 */

export type AskInput =
  | AskRelationInput
  | { type: 'choices'; choices: Array<{ value: string; text: string }> }
  | { type: 'boolean' }
  | { type: 'number' }
  | { type: 'date' }
  | { type: 'text' }

export type DocumentProposal = {
  id: string
  request_id?: string | null
  collection: string
  layout_id?: number | null
  summary: string
  fields: Array<{
    field: string
    label: string
    value: unknown
    display: string | null
    confidence: number
    source: string | null
    derived?: { by: 'field_rule' | 'cross_record_defaults'; from: string } | null
  }>
  children: Array<{
    alias: string
    label: string
    collection: string
    lines: Array<{
      values: Record<string, unknown>
      display: Record<string, string>
      confidence: number
      source: string | null
    }>
  }>
  m2m: Array<{
    alias: string
    label: string
    items: Array<{ id: string | number; label: string; confidence: number }>
  }>
  asks: Array<{
    field: string
    label: string
    reason: string
    candidate?: {
      value: unknown
      display: string | null
      confidence: number
      source: string | null
    } | null
    input?: AskInput | null
  }>
  warnings: string[]
  prefill: {
    values: Record<string, unknown>
    lines_by_alias: Record<string, Array<{ values: Record<string, unknown> }>>
    m2m: Record<string, Array<string | number>>
    file_id: string | null
    attach_alias: string | null
  }
  document: {
    name: string
    method: string
    pages: number | null
    truncated: boolean
    chars: number
  }
  model: string
  rounds: number
  latency_ms?: number
  condensed?: { chunks: number; excerpt_chars: number } | null
  hints_used?: string[]
}

export type DocumentApplySelection = {
  values: Record<string, unknown>
  lines_by_alias: Record<string, Array<{ values: Record<string, unknown> }>>
  m2m: Record<string, Array<string | number>>
  file_id: string | null
  summary: string
  document_name: string
  proposal_id: string
}

type Config = { enabled: boolean; accept: string[] }

const WAIT_HINTS = [
  'Reading the document…',
  'Finding the parties, dates and amounts…',
  'Looking up vendors, people and categories…',
  'Building the lines…',
  'Checking the numbers…'
]

type ApiCfg = {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}

/** Upload a document and start the extraction. Answers the proposal id at
 *  once; the run continues on the server. A list's "New from document…" uses
 *  this then opens the new-record form on `?autofill=<id>`. */
export async function startDocumentExtraction(
  cfg: ApiCfg,
  file: File,
  collection: string,
  opts: { layoutId?: number | null; notify?: boolean } = {}
): Promise<string> {
  const form = new FormData()
  form.append('collection', collection)
  form.append('background', '1')
  if (opts.layoutId != null) form.append('layout_id', String(opts.layoutId))
  form.append('file', file, file.name)
  const res = await fetch(`${cfg.apiBase}/ai/extract-record`, {
    method: 'POST',
    headers: cfg.authHeaders,
    credentials: cfg.credentials,
    body: form
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error || `Document autofill failed (${res.status})`)
  const id = String(json?.data?.proposal_id ?? '')
  if (!id) throw new Error('The server did not return a proposal id')
  if (opts.notify) {
    await fetch(`${cfg.apiBase}/ai/extract-record/${id}/notify`, {
      method: 'POST',
      headers: cfg.authHeaders,
      credentials: cfg.credentials
    }).catch(() => {})
  }
  return id
}

/** Is the feature on for this collection (and this person)? */
export function useDocumentAutofillConfig(collection: string | null) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  return useQuery<Config>({
    queryKey: ['ai-extract-config', collection],
    enabled: !!collection,
    queryFn: async () => {
      const res = await fetch(
        `${apiBase}/ai/extract-record/config/${encodeURIComponent(collection ?? '')}`,
        { headers: authHeaders, credentials }
      )
      if (!res.ok) return { enabled: false, accept: [] }
      const json = await res.json()
      return (json.data ?? { enabled: false, accept: [] }) as Config
    },
    staleTime: 5 * 60_000
  })
}

function ConfidencePill({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const tone =
    value >= 0.85
      ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
      : value >= 0.6
        ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
        : 'bg-rose-50 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200'
  return (
    <span
      data-autofill-confidence={pct}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] font-medium tabular-nums',
        tone
      )}
      title={`${pct}% confidence`}
    >
      {pct}%
    </span>
  )
}

function valueText(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const s = String(v)
  return s.length > 240 ? `${s.slice(0, 240)}…` : s
}

/** An ask answered in place (#704): the input the field's type calls for.
 *  A relation ask narrows by the field's own cascades and option filter over
 *  what the proposal is keeping (`draft`) — a project ask offers the projects
 *  of the proposed zone / project type, not every project. */
function AskAnswer({
  ask,
  value,
  onChange,
  draft,
  labelOf
}: {
  ask: DocumentProposal['asks'][number]
  value: unknown
  onChange: (v: unknown) => void
  draft: Record<string, unknown>
  labelOf: (field: string) => string
}) {
  const client = useOptionalNivaroClient()
  const input = ask.input
  const base =
    'h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-background'
  if (!input) return null
  if (input.type === 'relation') {
    if (!client) return null
    const narrowing = askPickerNarrowing(input, draft, labelOf)
    return (
      <div
        className='w-64'
        data-autofill-ask-input='relation'
        data-autofill-ask-narrowed={narrowing.narrowedBy.keys.join(',') || undefined}
      >
        <RelationCombobox
          collection={input.collection}
          value={value ?? null}
          onChange={onChange}
          extraFilter={narrowing.extraFilter}
          narrowedBy={narrowing.narrowedBy.labels.length ? narrowing.narrowedBy : undefined}
          disabled={!!narrowing.requiredParent}
          placeholder={
            narrowing.requiredParent
              ? `Pick ${labelOf(narrowing.requiredParent).toLowerCase()} first`
              : `Pick ${ask.label.toLowerCase()}…`
          }
        />
      </div>
    )
  }
  if (input.type === 'choices')
    return (
      <select
        className={base}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value || null)}
        data-autofill-ask-input='choices'
      >
        <option value=''>Choose…</option>
        {input.choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.text}
          </option>
        ))}
      </select>
    )
  if (input.type === 'boolean')
    return (
      <select
        className={base}
        value={value == null ? '' : value ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
        data-autofill-ask-input='boolean'
      >
        <option value=''>Choose…</option>
        <option value='true'>Yes</option>
        <option value='false'>No</option>
      </select>
    )
  return (
    <input
      type={input.type === 'number' ? 'number' : input.type === 'date' ? 'date' : 'text'}
      className={cn(base, 'w-48')}
      value={value == null ? '' : String(value)}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === '' ? null : input.type === 'number' ? Number(v) : v)
      }}
      placeholder={ask.label}
      data-autofill-ask-input={input.type}
    />
  )
}

export function DocumentAutofillButton({
  collection,
  onApply,
  className,
  layoutId,
  initialProposalId,
  label,
  onProposalConsumed
}: {
  collection: string
  onApply: (selection: DocumentApplySelection, proposal: DocumentProposal) => void | Promise<void>
  className?: string
  /** Restrict the proposal to this layout's fields (an addendum layout). */
  layoutId?: number | null
  /** Open straight onto a stored proposal (`?autofill=<id>` from a list or a notification). */
  initialProposalId?: string | null
  label?: string
  /** The initial proposal was shown — the host can drop `?autofill=` from the URL. */
  onProposalConsumed?: () => void
}) {
  const apiCfg = useApiFetchConfig()
  const { apiBase, authHeaders, credentials } = apiCfg
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pollId, setPollId] = useState<string | null>(null)
  /** 'Tell me when it's ready': the waiting dialog folds into a floating chip
   *  that keeps polling; a landed proposal turns it into a Review button. */
  const [minimized, setMinimized] = useState(false)
  const [hint, setHint] = useState(0)
  const [proposal, setProposal] = useState<DocumentProposal | null>(null)
  const [fieldOn, setFieldOn] = useState<Set<string>>(new Set())
  const [childOn, setChildOn] = useState<Set<string>>(new Set())
  const [m2mOn, setM2mOn] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [applying, setApplying] = useState(false)
  const consumedRef = useRef<string | null>(null)

  const { data: config } = useDocumentAutofillConfig(collection)

  useEffect(() => {
    if (!busy) return
    setHint(0)
    const t = setInterval(() => setHint((h) => Math.min(h + 1, WAIT_HINTS.length - 1)), 9000)
    return () => clearInterval(t)
  }, [busy])

  const showProposal = useCallback((p: DocumentProposal) => {
    setProposal(p)
    setFieldOn(new Set(p.fields.map((f) => f.field)))
    setChildOn(new Set(p.children.map((c) => c.alias)))
    setM2mOn(new Set(p.m2m.map((m) => m.alias)))
    setOpen(new Set())
    setAnswers({})
  }, [])

  // Poll a running proposal until it lands (or fails). A 202 keeps the
  // waiting dialog up; only a landed or failed run clears busy/pollId.
  useEffect(() => {
    if (!pollId) return
    return pollProposal({
      fetchResult: async () => {
        const res = await fetch(`${apiBase}/ai/extract-record/result/${pollId}`, {
          headers: authHeaders,
          credentials
        })
        const json = await res.json().catch(() => ({}))
        return { status: res.status, ok: res.ok, json }
      },
      onRunning: (name) => {
        if (name) setBusy((b) => b ?? name)
      },
      onDone: (data) => {
        showProposal(data as DocumentProposal)
        void qc.invalidateQueries({ queryKey: ['nvr-ai-autofill-analytics'] })
      },
      onError: (message) => toast.error(message),
      onSettled: () => {
        setBusy(null)
        setPollId(null)
      }
    })
  }, [pollId, apiBase, authHeaders, credentials, showProposal, qc])

  // A proposal id handed in by the URL: open it once.
  useEffect(() => {
    if (!initialProposalId || consumedRef.current === initialProposalId) return
    consumedRef.current = initialProposalId
    setBusy('the document')
    setMinimized(false)
    setPollId(initialProposalId)
    onProposalConsumed?.()
  }, [initialProposalId, onProposalConsumed])

  const lineCount = useMemo(
    () =>
      proposal?.children.reduce((n, c) => (childOn.has(c.alias) ? n + c.lines.length : n), 0) ?? 0,
    [proposal, childOn]
  )

  // What the review is keeping right now — the parent values an ask's picker
  // narrows by: checked proposed fields, checked links (id arrays), and the
  // other asks' answers on top.
  const askDraft = useMemo(() => {
    const d: Record<string, unknown> = {}
    if (!proposal) return d
    for (const f of proposal.fields) if (fieldOn.has(f.field)) d[f.field] = f.value
    for (const m of proposal.m2m)
      if (m2mOn.has(m.alias) && m.items.length) d[m.alias] = m.items.map((i) => i.id)
    for (const [k, v] of Object.entries(answers)) if (v != null && v !== '') d[k] = v
    return d
  }, [proposal, fieldOn, m2mOn, answers])
  const askLabelOf = useCallback(
    (field: string) =>
      proposal?.fields.find((f) => f.field === field)?.label ??
      proposal?.m2m.find((m) => m.alias === field)?.label ??
      proposal?.asks.find((a) => a.field === field)?.label ??
      field.replace(/_/g, ' '),
    [proposal]
  )

  if (!config?.enabled && !initialProposalId) return null

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(file.name)
    setMinimized(false)
    try {
      const id = await startDocumentExtraction(apiCfg, file, collection, { layoutId })
      setPollId(id)
    } catch (err) {
      toast.error((err as Error).message)
      setBusy(null)
    }
  }

  async function leaveRunning() {
    if (!pollId) return
    // Keep polling from here (the chip shows progress and opens the review);
    // the notification still covers leaving the page before it lands.
    setMinimized(true)
    try {
      await fetch(`${apiBase}/ai/extract-record/${pollId}/notify`, {
        method: 'POST',
        headers: authHeaders,
        credentials
      })
    } catch {
      toast.error('Could not arrange the notification')
    }
  }

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  async function apply() {
    if (!proposal) return
    setApplying(true)
    try {
      const values: Record<string, unknown> = {}
      for (const f of proposal.fields) if (fieldOn.has(f.field)) values[f.field] = f.value
      let resolved = 0
      for (const [k, v] of Object.entries(answers)) {
        if (v == null || v === '') continue
        values[k] = v
        resolved++
      }
      const lines_by_alias: DocumentApplySelection['lines_by_alias'] = {}
      for (const c of proposal.children)
        if (childOn.has(c.alias))
          lines_by_alias[c.alias] = c.lines.map((l) => ({ values: l.values }))
      const m2m: DocumentApplySelection['m2m'] = {}
      for (const m of proposal.m2m) if (m2mOn.has(m.alias)) m2m[m.alias] = m.items.map((i) => i.id)
      // The document itself always attaches when the collection has a file field.
      if (proposal.prefill.attach_alias && proposal.prefill.file_id) {
        m2m[proposal.prefill.attach_alias] = [
          ...(m2m[proposal.prefill.attach_alias] ?? []),
          proposal.prefill.file_id
        ]
      }
      // The scorecard row (#703): what was kept, what was answered.
      void fetch(`${apiBase}/ai/extract-record/${proposal.id}/apply`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        credentials,
        body: JSON.stringify({
          kept_fields: [...fieldOn],
          kept_lines: lineCount,
          resolved_asks: Object.keys(answers).filter((k) => answers[k] != null && answers[k] !== '')
        })
      }).catch(() => {})
      await onApply(
        {
          values,
          lines_by_alias,
          m2m,
          file_id: proposal.prefill.file_id,
          summary: proposal.summary,
          document_name: proposal.document.name,
          proposal_id: proposal.id
        },
        proposal
      )
      const n = Object.keys(values).length
      toast.success(
        `Filled ${n} field${n === 1 ? '' : 's'}${lineCount ? ` and ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''}${resolved ? ` (${resolved} answered by you)` : ''} from ${proposal.document.name} — review, then Create`
      )
      setProposal(null)
    } finally {
      setApplying(false)
    }
  }

  const accept = (config?.accept ?? []).join(',')
  const openAsks = proposal?.asks ?? []

  return (
    <>
      <input
        ref={fileInputRef}
        type='file'
        accept={accept}
        className='hidden'
        onChange={handleFile}
        data-autofill-file-input
      />
      {config?.enabled && (
        <button
          type='button'
          data-autofill-button
          disabled={!!busy}
          onClick={() => fileInputRef.current?.click()}
          title='Fill this record from a document — a statement of work, a quote, a spreadsheet'
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-70',
            className
          )}
        >
          {busy ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <FileText className='h-3.5 w-3.5' />
          )}
          {busy ? 'Reading…' : (label ?? 'Fill from document')}
        </button>
      )}

      {minimized &&
        (busy || proposal) &&
        createPortal(
          <button
            type='button'
            onClick={() => setMinimized(false)}
            data-autofill-chip={proposal ? 'ready' : 'reading'}
            className={cn(
              'fixed bottom-4 right-4 z-[110] flex max-w-[320px] items-center gap-2.5 rounded-full border px-3.5 py-2 text-left text-[12.5px] shadow-lg transition-colors',
              proposal
                ? 'border-nvr-cyan bg-nvr-cyan text-[#172940] hover:bg-[#00b8e0]'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#334155] dark:bg-[#1e293b] dark:text-slate-200 dark:hover:bg-[#263449]'
            )}
            title={proposal ? 'Open what the document says' : 'Show progress'}
          >
            {proposal ? (
              <Sparkles className='h-3.5 w-3.5 shrink-0' />
            ) : (
              <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-nvr-navy dark:text-nvr-cyan' />
            )}
            <span className='min-w-0'>
              <span className='block truncate font-medium'>
                {proposal ? 'Document read — review it' : `Reading ${busy}`}
              </span>
              {!proposal && (
                <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
                  {WAIT_HINTS[hint]}
                </span>
              )}
            </span>
          </button>,
          document.body
        )}

      {/* One dialog, two bodies: the waiting state (30–70s, say what it is
          doing) and the review. Two separate Radix dialogs swapping in the
          same tick sometimes left the second one unpresented. */}
      <Dialog
        open={!minimized && (!!busy || !!proposal)}
        onOpenChange={(o) => {
          if (!o && !busy && !applying) setProposal(null)
        }}
      >
        {busy && !proposal ? (
          <DialogContent className='max-w-md' data-autofill-waiting>
            <DialogHeader>
              <DialogTitle className='flex items-center gap-2 text-[15px]'>
                <Loader2 className='h-4 w-4 animate-spin text-nvr-navy dark:text-nvr-cyan' />
                Reading {busy}
              </DialogTitle>
              <DialogDescription>{WAIT_HINTS[hint]} Usually under a minute.</DialogDescription>
            </DialogHeader>
            {pollId && (
              <DialogFooter className='sm:justify-start'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={leaveRunning}
                  data-autofill-background
                >
                  Tell me when it's ready
                </Button>
                <span className='text-[11.5px] text-slate-500'>
                  Keep working — a notification opens the proposal here.
                </span>
              </DialogFooter>
            )}
          </DialogContent>
        ) : (
          <DialogContent
            className='flex max-h-[88vh] w-[880px] max-w-[96vw] flex-col gap-0 p-0'
            data-autofill-review
          >
            {proposal && (
              <>
                <DialogHeader className='border-b border-slate-200 px-5 py-4 dark:border-border'>
                  <DialogTitle className='text-[15px]'>What the document says</DialogTitle>
                  <DialogDescription className='text-[12.5px]'>
                    {proposal.summary || `Read from ${proposal.document.name}.`}{' '}
                    <span className='text-slate-400'>
                      {proposal.document.name}
                      {proposal.document.pages ? ` · ${proposal.document.pages} pages` : ''}
                      {proposal.condensed
                        ? ` · long document, ${proposal.condensed.chunks} later part${proposal.condensed.chunks === 1 ? '' : 's'} read for excerpts`
                        : proposal.document.truncated
                          ? ' · only the first part was read'
                          : ''}
                    </span>
                  </DialogDescription>
                </DialogHeader>

                <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
                  {proposal.warnings.length > 0 && (
                    <ul className='mb-4 space-y-1' data-autofill-warnings>
                      {proposal.warnings.map((w) => (
                        <li
                          key={w}
                          className='flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-900/25 dark:text-amber-100'
                        >
                          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                          {w}
                        </li>
                      ))}
                    </ul>
                  )}

                  {proposal.fields.length > 0 && (
                    <section className='mb-5'>
                      <h3 className='mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                        Fields · {fieldOn.size} of {proposal.fields.length} selected
                      </h3>
                      <ul className='divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-border dark:border-border'>
                        {proposal.fields.map((f) => {
                          const on = fieldOn.has(f.field)
                          return (
                            <li
                              key={f.field}
                              data-autofill-field={f.field}
                              data-autofill-derived={f.derived?.by ?? undefined}
                              className={cn(
                                'flex items-start gap-3 px-3 py-2',
                                !on && 'opacity-55'
                              )}
                            >
                              <input
                                type='checkbox'
                                className='mt-1 h-3.5 w-3.5 accent-[#00ceff]'
                                checked={on}
                                onChange={() => toggle(fieldOn, f.field, setFieldOn)}
                                aria-label={`Use ${f.label}`}
                              />
                              <div className='min-w-0 flex-1'>
                                <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
                                  <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                                    {f.label}
                                  </span>
                                  <span className='min-w-0 whitespace-pre-wrap break-words text-[13px] text-slate-900 dark:text-white'>
                                    {f.display ?? valueText(f.value)}
                                  </span>
                                  {f.derived && (
                                    <span
                                      className='inline-flex h-5 items-center gap-1 rounded bg-sky-50 px-1.5 text-[10.5px] font-medium text-sky-800 dark:bg-sky-900/30 dark:text-sky-200'
                                      title={f.source ?? undefined}
                                    >
                                      <Wand2 className='h-3 w-3' />
                                      {f.derived.by === 'field_rule' ? 'rule' : 'default'}
                                    </span>
                                  )}
                                </div>
                                {f.source && (
                                  <p
                                    className='mt-0.5 truncate text-[11.5px] text-slate-500 dark:text-slate-400'
                                    title={f.source}
                                  >
                                    {f.derived ? f.source : `“${f.source}”`}
                                  </p>
                                )}
                              </div>
                              {!f.derived && <ConfidencePill value={f.confidence} />}
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  )}

                  {proposal.children.map((c) => {
                    const on = childOn.has(c.alias)
                    const expanded = open.has(c.alias)
                    const cols = Object.keys(
                      c.lines.reduce<Record<string, true>>((acc, l) => {
                        for (const k of Object.keys(l.values)) acc[k] = true
                        return acc
                      }, {})
                    ).slice(0, 7)
                    return (
                      <section key={c.alias} className='mb-5' data-autofill-child={c.alias}>
                        <div className={cn('flex items-center gap-3', !on && 'opacity-55')}>
                          <input
                            type='checkbox'
                            className='h-3.5 w-3.5 accent-[#00ceff]'
                            checked={on}
                            onChange={() => toggle(childOn, c.alias, setChildOn)}
                            aria-label={`Use ${c.label}`}
                          />
                          <button
                            type='button'
                            className='flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                            onClick={() => toggle(open, c.alias, setOpen)}
                            aria-expanded={expanded}
                          >
                            {expanded ? (
                              <ChevronDown className='h-3.5 w-3.5' />
                            ) : (
                              <ChevronRight className='h-3.5 w-3.5' />
                            )}
                            {c.label} · {c.lines.length} row{c.lines.length === 1 ? '' : 's'}
                          </button>
                        </div>
                        {expanded && (
                          <div className='mt-2 overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
                            <table className='w-full text-[12px] tabular-nums'>
                              <thead className='bg-slate-50 text-[10.5px] uppercase tracking-wide text-slate-500 dark:bg-muted'>
                                <tr>
                                  {cols.map((k) => (
                                    <th key={k} className='px-2 py-1.5 text-left font-medium'>
                                      {k.replace(/_/g, ' ')}
                                    </th>
                                  ))}
                                  <th className='px-2 py-1.5 text-right font-medium'>Conf.</th>
                                </tr>
                              </thead>
                              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                                {c.lines.map((l, i) => (
                                  // biome-ignore lint/suspicious/noArrayIndexKey: proposal rows are static
                                  <tr key={i} title={l.source ?? undefined}>
                                    {cols.map((k) => (
                                      <td
                                        key={k}
                                        className='max-w-[260px] truncate px-2 py-1.5 text-slate-800 dark:text-slate-100'
                                      >
                                        {l.display[k] ?? valueText(l.values[k])}
                                      </td>
                                    ))}
                                    <td className='px-2 py-1.5 text-right'>
                                      <ConfidencePill value={l.confidence} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </section>
                    )
                  })}

                  {proposal.m2m.length > 0 && (
                    <section className='mb-5' data-autofill-m2m>
                      <h3 className='mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                        Linked
                      </h3>
                      <ul className='space-y-1.5'>
                        {proposal.m2m.map((m) => {
                          const on = m2mOn.has(m.alias)
                          return (
                            <li
                              key={m.alias}
                              className={cn(
                                'flex items-center gap-3 text-[12.5px]',
                                !on && 'opacity-55'
                              )}
                            >
                              <input
                                type='checkbox'
                                className='h-3.5 w-3.5 accent-[#00ceff]'
                                checked={on}
                                onChange={() => toggle(m2mOn, m.alias, setM2mOn)}
                                aria-label={`Use ${m.label}`}
                              />
                              <span className='font-medium text-slate-700 dark:text-slate-200'>
                                {m.label}
                              </span>
                              <span className='flex flex-wrap gap-1'>
                                {m.items.map((i) => (
                                  <span
                                    key={String(i.id)}
                                    className='rounded bg-slate-100 px-1.5 py-0.5 text-[11.5px] dark:bg-muted'
                                  >
                                    {i.label}
                                  </span>
                                ))}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  )}

                  {openAsks.length > 0 && (
                    <section data-autofill-asks>
                      <h3 className='mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                        <HelpCircle className='h-3.5 w-3.5' /> Still needs you · {openAsks.length}
                      </h3>
                      <ul className='space-y-2'>
                        {openAsks.map((a) => {
                          const answered = answers[a.field] != null && answers[a.field] !== ''
                          return (
                            <li
                              key={a.field}
                              className='rounded-md border border-slate-200 px-3 py-2 text-[12.5px] text-slate-600 dark:border-border dark:text-slate-300'
                              data-autofill-ask={a.field}
                              data-autofill-answered={answered ? 'true' : undefined}
                            >
                              <div>
                                <span className='font-medium text-slate-800 dark:text-slate-100'>
                                  {a.label}
                                </span>
                                <span className='text-slate-400'> — </span>
                                {a.reason}
                              </div>
                              <div className='mt-1.5 flex flex-wrap items-center gap-2'>
                                <AskAnswer
                                  ask={a}
                                  value={answers[a.field]}
                                  draft={askDraft}
                                  labelOf={askLabelOf}
                                  onChange={(v) =>
                                    setAnswers((prev) => ({ ...prev, [a.field]: v }))
                                  }
                                />
                                {a.candidate && (
                                  <button
                                    type='button'
                                    data-autofill-use-candidate={a.field}
                                    onClick={() =>
                                      setAnswers((prev) => ({
                                        ...prev,
                                        [a.field]: a.candidate?.value
                                      }))
                                    }
                                    className='inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-2 text-[12px] text-slate-700 hover:border-nvr-cyan hover:bg-nvr-cyan/5 dark:border-border dark:text-slate-200'
                                    title={a.candidate.source ?? undefined}
                                  >
                                    Use “{a.candidate.display ?? valueText(a.candidate.value)}”
                                    <ConfidencePill value={a.candidate.confidence} />
                                  </button>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  )}

                  {proposal.fields.length === 0 && proposal.children.length === 0 && (
                    <p className='text-[13px] text-slate-600 dark:text-slate-300'>
                      Nothing in this document maps onto a field here. Try a document that names the
                      record's parties, dates or amounts.
                    </p>
                  )}
                </div>

                <DialogFooter className='items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 dark:border-border sm:justify-between'>
                  <span className='text-[11.5px] text-slate-400'>
                    Nothing is saved until you press Create. Model {proposal.model},{' '}
                    {proposal.rounds} step{proposal.rounds === 1 ? '' : 's'}
                    {proposal.latency_ms ? ` · ${Math.round(proposal.latency_ms / 1000)}s` : ''}.
                  </span>
                  <div className='flex items-center gap-2'>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => setProposal(null)}
                      disabled={applying}
                    >
                      Cancel
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      data-autofill-apply
                      onClick={apply}
                      disabled={
                        applying ||
                        (fieldOn.size === 0 &&
                          lineCount === 0 &&
                          m2mOn.size === 0 &&
                          !Object.values(answers).some((v) => v != null && v !== ''))
                      }
                    >
                      {applying ? (
                        <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                      ) : (
                        <CheckCircle2 className='mr-1.5 h-3.5 w-3.5' />
                      )}
                      Fill {fieldOn.size} field{fieldOn.size === 1 ? '' : 's'}
                      {lineCount ? ` + ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''}
                    </Button>
                  </div>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
