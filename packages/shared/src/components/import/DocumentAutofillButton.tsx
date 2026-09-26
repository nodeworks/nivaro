import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  HelpCircle,
  Loader2
} from 'lucide-react'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig } from '../../context'
import { cn } from '../../lib/utils'
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
 * returns a DocumentProposal (values + confidence + the sentence each came
 * from); this dialog is the review. Nothing is written until Apply, and Apply
 * only stages — the record still needs Create.
 */

export type DocumentProposal = {
  collection: string
  summary: string
  fields: Array<{
    field: string
    label: string
    value: unknown
    display: string | null
    confidence: number
    source: string | null
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
  asks: Array<{ field: string; label: string; reason: string }>
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
}

export type DocumentApplySelection = {
  values: Record<string, unknown>
  lines_by_alias: Record<string, Array<{ values: Record<string, unknown> }>>
  m2m: Record<string, Array<string | number>>
  file_id: string | null
  summary: string
  document_name: string
}

type Config = { enabled: boolean; accept: string[] }

const WAIT_HINTS = [
  'Reading the document…',
  'Finding the parties, dates and amounts…',
  'Looking up vendors, people and categories…',
  'Building the lines…',
  'Checking the numbers…'
]

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

export function DocumentAutofillButton({
  collection,
  onApply,
  className
}: {
  collection: string
  onApply: (selection: DocumentApplySelection, proposal: DocumentProposal) => void | Promise<void>
  className?: string
}) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [hint, setHint] = useState(0)
  const [proposal, setProposal] = useState<DocumentProposal | null>(null)
  const [fieldOn, setFieldOn] = useState<Set<string>>(new Set())
  const [childOn, setChildOn] = useState<Set<string>>(new Set())
  const [m2mOn, setM2mOn] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

  const { data: config } = useQuery<Config>({
    queryKey: ['ai-extract-config', collection],
    queryFn: async () => {
      const res = await fetch(
        `${apiBase}/ai/extract-record/config/${encodeURIComponent(collection)}`,
        {
          headers: authHeaders,
          credentials
        }
      )
      if (!res.ok) return { enabled: false, accept: [] }
      const json = await res.json()
      return (json.data ?? { enabled: false, accept: [] }) as Config
    },
    staleTime: 5 * 60_000
  })

  useEffect(() => {
    if (!busy) return
    setHint(0)
    const t = setInterval(() => setHint((h) => Math.min(h + 1, WAIT_HINTS.length - 1)), 9000)
    return () => clearInterval(t)
  }, [busy])

  const lineCount = useMemo(
    () =>
      proposal?.children.reduce((n, c) => (childOn.has(c.alias) ? n + c.lines.length : n), 0) ?? 0,
    [proposal, childOn]
  )

  if (!config?.enabled) return null

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(file.name)
    try {
      const form = new FormData()
      form.append('collection', collection)
      form.append('file', file, file.name)
      const res = await fetch(`${apiBase}/ai/extract-record`, {
        method: 'POST',
        headers: authHeaders,
        credentials,
        body: form
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || `Document autofill failed (${res.status})`)
      const p = json.data as DocumentProposal
      setProposal(p)
      setFieldOn(new Set(p.fields.map((f) => f.field)))
      setChildOn(new Set(p.children.map((c) => c.alias)))
      setM2mOn(new Set(p.m2m.map((m) => m.alias)))
      setOpen(new Set())
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
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
      await onApply(
        {
          values,
          lines_by_alias,
          m2m,
          file_id: proposal.prefill.file_id,
          summary: proposal.summary,
          document_name: proposal.document.name
        },
        proposal
      )
      toast.success(
        `Filled ${Object.keys(values).length} field${Object.keys(values).length === 1 ? '' : 's'}${lineCount ? ` and ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''} from ${proposal.document.name} — review, then Create`
      )
      setProposal(null)
    } finally {
      setApplying(false)
    }
  }

  const accept = (config.accept ?? []).join(',')

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
        {busy ? 'Reading…' : 'Fill from document'}
      </button>

      {/* One dialog, two bodies: the waiting state (30–70s, say what it is
          doing) and the review. Two separate Radix dialogs swapping in the
          same tick sometimes left the second one unpresented. */}
      <Dialog
        open={!!busy || !!proposal}
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
                      {proposal.document.truncated ? ' · only the first part was read' : ''}
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
                                </div>
                                {f.source && (
                                  <p
                                    className='mt-0.5 truncate text-[11.5px] text-slate-500 dark:text-slate-400'
                                    title={f.source}
                                  >
                                    “{f.source}”
                                  </p>
                                )}
                              </div>
                              <ConfidencePill value={f.confidence} />
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

                  {proposal.asks.length > 0 && (
                    <section data-autofill-asks>
                      <h3 className='mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                        <HelpCircle className='h-3.5 w-3.5' /> Still needs you ·{' '}
                        {proposal.asks.length}
                      </h3>
                      <ul className='space-y-1'>
                        {proposal.asks.map((a) => (
                          <li
                            key={a.field}
                            className='text-[12.5px] text-slate-600 dark:text-slate-300'
                          >
                            <span className='font-medium text-slate-800 dark:text-slate-100'>
                              {a.label}
                            </span>
                            <span className='text-slate-400'> — </span>
                            {a.reason}
                          </li>
                        ))}
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
                    {proposal.rounds} step{proposal.rounds === 1 ? '' : 's'}.
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
                        applying || (fieldOn.size === 0 && lineCount === 0 && m2mOn.size === 0)
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
