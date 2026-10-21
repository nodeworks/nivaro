import type { LayoutReviewContext } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Layout review (#1920) + apply a finding (#1964) — the layout editor's
 * settings rail. Findings come from POST /ai-design/layouts/:id/review (rules
 * first, the model only for labels + help text). Apply writes the fix through
 * the server, which captures a layout version first; Undo restores it.
 *
 * Restructure change sets (#2587): a crowded step or section also carries a
 * whole split (several new steps + the moves) previewed as a list and applied
 * through the editor's draft as ONE batch — one undo step in the top bar.
 */

type LayoutFix =
  | { type: 'expand_section'; group_id: number }
  | { type: 'move_field'; field: string; to_group_key: string }
  | { type: 'help_text'; field: string; text: string }
  | { type: 'label'; field: string; text: string }
  | { type: 'show_field'; field: string }

type LayoutOp = Parameters<LayoutReviewContext['apply']>[0][number]

interface LayoutChangeSet {
  kind: 'split'
  title: string
  steps: string[]
  ops: LayoutOp[]
  parts: number
  source: 'rules' | 'ai'
}

interface LayoutFinding {
  id: string
  kind: string
  severity: 'warn' | 'info'
  source: 'rules' | 'ai'
  field: string | null
  field_label: string | null
  group: { id: number | null; key: string | null; label: string } | null
  message: string
  suggestion: string
  fix: LayoutFix | null
  change_set?: LayoutChangeSet
}

interface ReviewResult {
  findings: LayoutFinding[]
  ai_used: boolean
  ai_error: string | null
  ai_configured: boolean
}

const errOf = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const FIX_VERB: Record<LayoutFix['type'], string> = {
  expand_section: 'Open section',
  move_field: 'Move field',
  help_text: 'Add help text',
  label: 'Rename',
  show_field: 'Show field'
}

export function LayoutReviewSection({
  layoutId,
  ctx
}: {
  layoutId: number
  /** The editor's draft: change sets apply through it (one undo step). */
  ctx?: LayoutReviewContext
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<ReviewResult | null>(null)
  // finding id → the version that undoes it
  const [applied, setApplied] = useState<Record<string, number | null>>({})
  // Undo restores the version captured before a fix, so only the newest
  // applied fix offers it (an older one would also roll back the later ones).
  const [lastApplied, setLastApplied] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // finding id whose change set preview is open / finding ids whose change set was applied
  const [openSet, setOpenSet] = useState<string | null>(null)
  const [appliedSets, setAppliedSets] = useState<Set<string>>(new Set())

  const applyChangeSet = (f: LayoutFinding, cs: LayoutChangeSet) => {
    if (!ctx) return
    const problem = ctx.check(cs.ops)
    if (problem) {
      toast.error(`The form changed since the review (${problem}) — review again`)
      return
    }
    const where = f.group?.label ? `"${f.group.label}"` : 'the section'
    ctx.apply(cs.ops, { label: `${cs.title.replace(/^Split/, `Split ${where}`)}` })
    setAppliedSets((s) => new Set(s).add(f.id))
    setOpenSet(null)
    toast.success(`${cs.title} — Undo in the top bar reverses the whole change`)
  }

  const review = useMutation({
    mutationFn: (ai: boolean) =>
      api
        .post<{ data: ReviewResult }>(`/ai-design/layouts/${layoutId}/review`, { ai })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      setResult(data)
      setApplied({})
      setLastApplied(null)
      setDrafts({})
      setOpenSet(null)
      setAppliedSets(new Set())
    },
    onError: (e) => toast.error(errOf(e, 'Review failed'))
  })

  const refreshLayout = () => {
    qc.invalidateQueries({ queryKey: ['layout-versions', layoutId] })
    qc.invalidateQueries({ queryKey: ['collection-layouts'] })
    qc.invalidateQueries() // assignments/groups queries key variously — same as Version history restore
  }

  const apply = useMutation({
    mutationFn: ({ fix }: { finding: LayoutFinding; fix: LayoutFix }) =>
      api
        .post<{ data: { applied: string; undo_version_id: number | null } }>(
          `/ai-design/layouts/${layoutId}/apply`,
          { fix }
        )
        .then((r) => r.data.data),
    onSuccess: (data, { finding }) => {
      setApplied((m) => ({ ...m, [finding.id]: data.undo_version_id }))
      setLastApplied(finding.id)
      toast.success(`Applied: ${data.applied}`)
      refreshLayout()
    },
    onError: (e) => toast.error(errOf(e, 'Could not apply the suggestion'))
  })

  const undo = useMutation({
    mutationFn: ({ versionId }: { findingId: string; versionId: number }) =>
      api.post(`/collection-layouts/${layoutId}/versions/${versionId}/restore`),
    onSuccess: (_d, { findingId }) => {
      setApplied((m) => {
        const next = { ...m }
        delete next[findingId]
        return next
      })
      setLastApplied(null)
      toast.success('Change undone')
      refreshLayout()
    },
    onError: () => toast.error('Undo failed — use Version history')
  })

  const fixFor = (f: LayoutFinding): LayoutFix | null => {
    if (!f.fix) return null
    const draft = drafts[f.id]
    if (draft !== undefined && (f.fix.type === 'help_text' || f.fix.type === 'label'))
      return { ...f.fix, text: draft }
    return f.fix
  }

  const findings = result?.findings ?? []
  const warns = findings.filter((f) => f.severity === 'warn').length

  return (
    <div className='border-t border-slate-200 pt-2 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between text-[11px] font-medium text-slate-600 dark:text-slate-300'
      >
        <span className='flex items-center gap-1'>
          <Sparkles className='h-3 w-3 text-nvr-cyan' /> Review this layout
        </span>
        <span className='text-slate-400'>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className='mt-2 space-y-2' data-ai-layout-review>
          <p className='text-[10.5px] text-slate-500'>
            Checks step and section size, required fields that are hidden or collapsed, missing help
            text and unclear labels. Every applied fix can be undone here or from Version history.
          </p>
          <div className='flex gap-1.5'>
            <button
              type='button'
              disabled={review.isPending}
              onClick={() => review.mutate(true)}
              className='rounded bg-nvr-cyan px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50'
            >
              {review.isPending ? 'Reviewing…' : result ? 'Review again' : 'Review'}
            </button>
            {result && !result.ai_configured && (
              <span className='self-center text-[10.5px] text-slate-400'>
                AI not set up — rule checks only
              </span>
            )}
          </div>
          {result?.ai_error && (
            <p className='text-[10.5px] text-amber-600'>
              The AI pass failed ({result.ai_error}) — showing rule checks only.
            </p>
          )}
          {result && findings.length === 0 && (
            <p className='text-[11px] text-emerald-600'>No problems found.</p>
          )}
          {findings.length > 0 && (
            <p className='text-[10.5px] text-slate-500'>
              {findings.length} finding{findings.length === 1 ? '' : 's'}
              {warns ? ` · ${warns} to fix` : ''}
            </p>
          )}
          <div className='max-h-[420px] space-y-1.5 overflow-y-auto'>
            {findings.map((f) => {
              const cs = f.change_set
              const setDone = appliedSets.has(f.id)
              const fix = setDone ? null : fixFor(f)
              const done = f.id in applied
              const editable = f.fix?.type === 'help_text' || f.fix?.type === 'label'
              return (
                <div
                  key={f.id}
                  className={cn(
                    'rounded border px-2 py-1.5 text-[11px]',
                    f.severity === 'warn'
                      ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20'
                      : 'border-slate-200 bg-white dark:border-border dark:bg-card'
                  )}
                >
                  <p className='text-slate-700 dark:text-slate-200'>{f.message}</p>
                  <p className='mt-0.5 text-slate-500'>
                    {f.suggestion}
                    {f.source === 'ai' && <span className='ml-1 text-nvr-cyan'>· AI</span>}
                  </p>
                  {editable && !done && (
                    <input
                      value={drafts[f.id] ?? (f.fix as { text: string }).text}
                      onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                      className='mt-1 w-full rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] dark:border-border dark:bg-background'
                      aria-label='Suggested text'
                    />
                  )}
                  {cs && (
                    <div className='mt-1' data-change-set={cs.kind}>
                      {setDone ? (
                        <span className='text-emerald-600 dark:text-emerald-400'>
                          Applied as one change — Undo in the top bar reverses it
                        </span>
                      ) : openSet === f.id ? (
                        <div className='space-y-1.5 rounded border border-slate-200 bg-white p-1.5 dark:border-border dark:bg-background'>
                          <p className='font-medium text-slate-700 dark:text-slate-200'>
                            {cs.title}
                            {cs.source === 'ai' && <span className='ml-1 text-nvr-cyan'>· AI</span>}
                          </p>
                          <ol className='list-decimal space-y-0.5 pl-4 text-slate-600 dark:text-slate-300'>
                            {cs.steps.map((s, i) => (
                              <li key={`${i}:${s}`}>{s}</li>
                            ))}
                          </ol>
                          {ctx ? (
                            <div className='flex items-center gap-2'>
                              <button
                                type='button'
                                onClick={() => applyChangeSet(f, cs)}
                                data-change-set-apply=''
                                className='rounded bg-nvr-cyan px-1.5 py-0.5 font-medium text-white'
                              >
                                Apply all
                              </button>
                              <button
                                type='button'
                                onClick={() => setOpenSet(null)}
                                className='text-slate-500 underline'
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <p className='text-slate-500'>Open the layout editor to apply this.</p>
                          )}
                        </div>
                      ) : (
                        <button
                          type='button'
                          onClick={() => setOpenSet(f.id)}
                          data-change-set-open=''
                          className='rounded border border-slate-300 px-1.5 py-0.5 font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
                        >
                          {cs.title}…
                        </button>
                      )}
                    </div>
                  )}
                  {fix && (
                    <div className='mt-1 flex items-center gap-2'>
                      {done ? (
                        <>
                          <span className='text-emerald-600'>Applied</span>
                          {applied[f.id] != null && lastApplied === f.id && (
                            <button
                              type='button'
                              disabled={undo.isPending}
                              onClick={() =>
                                undo.mutate({ findingId: f.id, versionId: applied[f.id] as number })
                              }
                              className='flex items-center gap-0.5 text-slate-500 underline disabled:opacity-50'
                            >
                              <Undo2 className='h-3 w-3' /> Undo
                            </button>
                          )}
                        </>
                      ) : (
                        <button
                          type='button'
                          disabled={apply.isPending}
                          onClick={() => apply.mutate({ finding: f, fix })}
                          className='rounded border border-slate-300 px-1.5 py-0.5 font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
                        >
                          {FIX_VERB[fix.type]}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
