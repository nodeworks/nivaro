import { type LayoutReviewContext, rebaseAssistOps } from '@nivaro/shared'
import { useMutation } from '@tanstack/react-query'
import { ListOrdered, ShieldAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Two AI assists beside the layout review in the editor's Form settings:
 *
 *   - Natural entry order (#2688): POST /ai-design/layouts/:id/entry-order
 *     answers, per section, the moves that make it follow the data entry
 *     flow (drivers before the fields they control). Apply / Apply all go
 *     through the editor's draft as ONE batch (one undo step).
 *   - Sensitive fields (#2689): POST /ai-design/layouts/:id/sensitive flags
 *     personal or financial fields broad roles can see and suggests hiding
 *     their section from those roles. Advice, not a security control.
 *
 * Both send the draft so a proposal fits unsaved changes; without the editor
 * (no ctx) they say to open it.
 */

type LayoutOp = Parameters<LayoutReviewContext['apply']>[0][number]

interface OrderChangeSet {
  title: string
  steps: string[]
  ops: LayoutOp[]
  group_key: string
  why: string | null
}

interface OrderResult {
  change_sets: OrderChangeSet[]
  dropped: string[]
  checked: number
}

interface SensitiveFinding {
  field: string
  label: string
  class: 'personal' | 'financial'
  message: string
  seen_by: string[]
  suggest: Array<{ id: string; name: string }>
  section: { key: string; label: string } | null
  change_set: { title: string; steps: string[]; ops: LayoutOp[] } | null
}

interface SensitiveResult {
  findings: SensitiveFinding[]
  classified: number
  dropped: number
  note: string
}

const errOf = (e: unknown, fallback: string) => {
  const r = (e as { response?: { status?: number; data?: { error?: string } } })?.response
  if (r?.status === 503) return 'AI is not set up — Settings → AI Features'
  return r?.data?.error ?? fallback
}

const primary =
  'rounded bg-nvr-cyan px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50'
const outline =
  'rounded border border-slate-300 px-1.5 py-0.5 font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
const card =
  'rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px] dark:border-border dark:bg-card'
const quiet = 'text-[10.5px] text-slate-500 dark:text-muted-foreground'

function Disclosure({
  icon,
  title,
  children
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className='border-t border-slate-200 pt-2 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between text-[11px] font-medium text-slate-600 dark:text-slate-300'
      >
        <span className='flex items-center gap-1'>
          {icon} {title}
        </span>
        <span className='text-slate-400'>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className='mt-2 space-y-2'>{children}</div>}
    </div>
  )
}

/** Applies ops through the draft after checking them against it; false when they no longer fit. */
function applyThrough(ctx: LayoutReviewContext, ops: LayoutOp[], label: string): boolean {
  const problem = ctx.check(ops)
  if (problem) {
    toast.error(`The form changed since the suggestion (${problem}) — ask again`)
    return false
  }
  ctx.apply(ops, { label })
  return true
}

function EntryOrder({ layoutId, ctx }: { layoutId: number; ctx?: LayoutReviewContext }) {
  const [result, setResult] = useState<OrderResult | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const ask = useMutation({
    mutationFn: () =>
      api
        .post<{ data: OrderResult }>(`/ai-design/layouts/${layoutId}/entry-order`, {
          bundle: ctx?.bundle
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      setResult(data)
      setDone(new Set())
    },
    onError: (e) => toast.error(errOf(e, 'Could not suggest an order'))
  })
  const open = (result?.change_sets ?? []).filter((c) => !done.has(c.group_key))
  const applySets = (sets: OrderChangeSet[]) => {
    if (!ctx || !sets.length) return
    const label =
      sets.length === 1 ? sets[0].title : `Reorder ${sets.length} sections for data entry`
    if (
      !applyThrough(
        ctx,
        sets.flatMap((c) => c.ops),
        label
      )
    )
      return
    setDone((d) => new Set([...d, ...sets.map((c) => c.group_key)]))
    toast.success(`${label} — Undo in the top bar reverses it`)
  }
  return (
    <Disclosure
      icon={<ListOrdered className='h-3 w-3 text-nvr-cyan' />}
      title='Natural entry order'
    >
      <p className={quiet}>
        Suggests an order inside each section that follows how people fill the form in (who, what,
        when, cost), with fields that drive others first.
      </p>
      <div className='flex items-center gap-1.5'>
        <button
          type='button'
          disabled={ask.isPending}
          onClick={() => ask.mutate()}
          data-ai-entry-order=''
          className={primary}
        >
          {ask.isPending ? 'Thinking…' : result ? 'Suggest again' : 'Suggest an order'}
        </button>
        {ctx && open.length > 1 && (
          <button type='button' onClick={() => applySets(open)} className={outline}>
            Apply all
          </button>
        )}
      </div>
      {result && result.change_sets.length === 0 && (
        <p className='text-[11px] text-emerald-600 dark:text-emerald-400'>
          {result.checked
            ? 'Every section already follows a natural order.'
            : 'No section has enough fields to reorder.'}
        </p>
      )}
      {result && result.dropped.length > 0 && (
        <p className={quiet}>Left out {result.dropped.join('; ')}.</p>
      )}
      <div className='max-h-[360px] space-y-1.5 overflow-y-auto'>
        {result?.change_sets.map((cs) => (
          <div key={cs.group_key} className={card} data-entry-order-set={cs.group_key}>
            <p className='font-medium text-slate-700 dark:text-slate-200'>
              {cs.title}
              <span className='ml-1 text-nvr-cyan'>· AI</span>
            </p>
            {cs.why && <p className='mt-0.5 text-slate-500'>{cs.why}</p>}
            <ol className='mt-1 list-decimal space-y-0.5 pl-4 text-slate-600 dark:text-slate-300'>
              {cs.steps.map((s, i) => (
                <li key={`${i}:${s}`}>{s}</li>
              ))}
            </ol>
            <div className='mt-1'>
              {done.has(cs.group_key) ? (
                <span className='text-emerald-600 dark:text-emerald-400'>Applied</span>
              ) : ctx ? (
                <button type='button' onClick={() => applySets([cs])} className={outline}>
                  Apply
                </button>
              ) : (
                <span className='text-slate-500'>Open the layout editor to apply this.</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Disclosure>
  )
}

function SensitiveFields({ layoutId, ctx }: { layoutId: number; ctx?: LayoutReviewContext }) {
  const [result, setResult] = useState<SensitiveResult | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const ask = useMutation({
    mutationFn: () =>
      api
        .post<{ data: SensitiveResult }>(`/ai-design/layouts/${layoutId}/sensitive`, {
          bundle: ctx?.bundle
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      setResult(data)
      setDone(new Set())
    },
    onError: (e) => toast.error(errOf(e, 'Could not check the fields'))
  })
  const apply = (f: SensitiveFinding) => {
    if (!ctx || !f.change_set) return
    // The section's role list as the draft has it now, plus the suggestion.
    const ops = rebaseAssistOps(f.change_set.ops, ctx.bundle)
    if (!applyThrough(ctx, ops, f.change_set.title)) return
    setDone((d) => new Set(d).add(f.field))
    toast.success(`${f.change_set.title} — Undo in the top bar reverses it`)
  }
  return (
    <Disclosure
      icon={<ShieldAlert className='h-3 w-3 text-nvr-cyan' />}
      title='Personal and financial fields'
    >
      <p className={quiet}>
        Finds fields that look personal or financial and warns when broad roles can see them on this
        form. Advice only — the real control is each role's field permissions.
      </p>
      <button
        type='button'
        disabled={ask.isPending}
        onClick={() => ask.mutate()}
        data-ai-sensitive=''
        className={primary}
      >
        {ask.isPending ? 'Checking…' : result ? 'Check again' : 'Check fields'}
      </button>
      {result && (
        <p className='rounded bg-slate-100 px-2 py-1 text-[10.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
          {result.note}
        </p>
      )}
      {result && result.findings.length === 0 && (
        <p className='text-[11px] text-emerald-600 dark:text-emerald-400'>
          {result.classified
            ? `${result.classified} field${result.classified === 1 ? '' : 's'} looked personal or financial; no broad role sees them here.`
            : 'No field looks personal or financial.'}
        </p>
      )}
      <div className='max-h-[360px] space-y-1.5 overflow-y-auto'>
        {result?.findings.map((f) => (
          <div
            key={f.field}
            data-sensitive-field={f.field}
            className={cn(
              card,
              'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20'
            )}
          >
            <p className='text-slate-700 dark:text-slate-200'>{f.message}</p>
            <p className='mt-0.5 text-slate-500'>Seen by: {f.seen_by.join(', ')}</p>
            {f.change_set ? (
              <div className='mt-1 space-y-1'>
                <ul className='list-disc space-y-0.5 pl-4 text-slate-600 dark:text-slate-300'>
                  {f.change_set.steps.map((s, i) => (
                    <li key={`${i}:${s}`}>{s}</li>
                  ))}
                </ul>
                {done.has(f.field) ? (
                  <span className='text-emerald-600 dark:text-emerald-400'>Applied</span>
                ) : ctx ? (
                  <button type='button' onClick={() => apply(f)} className={outline}>
                    Hide from {f.suggest.map((s) => s.name).join(', ')}
                  </button>
                ) : (
                  <span className='text-slate-500'>Open the layout editor to apply this.</span>
                )}
              </div>
            ) : (
              <p className='mt-0.5 text-slate-500'>
                {f.section
                  ? 'Every broad role that sees it also enters it or needs it for a workflow move — narrow the role’s field permissions instead.'
                  : 'It is not in a section, so the form cannot hide it per role: move it into one, or narrow the role’s field permissions.'}
              </p>
            )}
          </div>
        ))}
      </div>
    </Disclosure>
  )
}

export function LayoutAssistSection({
  layoutId,
  ctx
}: {
  layoutId: number
  ctx?: LayoutReviewContext
}) {
  return (
    <>
      <EntryOrder layoutId={layoutId} ctx={ctx} />
      <SensitiveFields layoutId={layoutId} ctx={ctx} />
    </>
  )
}
