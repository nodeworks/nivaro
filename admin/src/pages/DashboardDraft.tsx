import { userErrorMessage } from '@nivaro/shared'
import { useMutation } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, History, LayoutDashboard, Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { WidgetFigure, type WidgetFigureData } from '@/components/widget-figure'
import { api } from '@/lib/api'

/**
 * Draft a dashboard from a description (#2736). The draft is an AI plan with one
 * "create dashboard" step: widgets on collections and saved queries the person can read,
 * placed on the dashboard grid and previewed with their own access. Nothing is saved until
 * they create it; the draft (and what became of it) stays in AI plan history.
 */

interface PreviewWidget {
  type: string
  title: string
  collection: string | null
  field: string | null
  col: number
  row: number
  width: number
  height: number
  data?: WidgetFigureData | null
  error?: string
}

interface PlanStep {
  id: string
  state: { status: string; result?: Record<string, unknown> | null; error?: string | null }
}

interface PlanView {
  plan_id: string
  title: string
  status: string
  steps: PlanStep[]
}

interface DraftResponse {
  plan: PlanView
  preview: { name: string; status: string; widgets: PreviewWidget[] }
  dropped: Array<{ title: string; reason: string }>
}

const EXAMPLES = [
  "For invoice reviewers: what's waiting, how old, by vendor",
  'Open work by status, and what was created this month',
  'The newest records and their totals'
]

const errorOf = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const TYPE_LABEL: Record<string, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  latest: 'Latest',
  bar_chart: 'Per day',
  line_chart: 'Per day',
  ai_query: 'Breakdown'
}

/** Wait for the plan to finish, then hand back the dashboard it made. */
async function waitForDashboard(planId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const plan = (await api.get<{ data: PlanView }>(`/ai/plans/${planId}`)).data.data
    const step = plan.steps[0]
    const id = step?.state.result?.dashboard_id
    if (plan.status === 'executed' && typeof id === 'string') return id
    if (plan.status === 'failed' || step?.state.status === 'failed')
      throw new Error(step?.state.error || 'The dashboard could not be created')
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Still creating — check AI plan history in a moment')
}

function PreviewSkeleton() {
  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4' aria-hidden>
      {[1, 1, 2, 2, 2, 1, 1].map((w, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder
          key={i}
          className='rounded-xl lg:[grid-column:span_var(--w)]'
          style={{ '--w': w, height: w === 2 ? 248 : 116 } as React.CSSProperties}
        />
      ))}
    </div>
  )
}

function PreviewCard({ w }: { w: PreviewWidget }) {
  return (
    <div
      className='flex min-h-[116px] flex-col rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card lg:[grid-column:span_var(--w)] lg:[grid-row:span_var(--h)]'
      style={{ '--w': Math.min(4, w.width), '--h': w.height } as React.CSSProperties}
      data-draft-widget={w.type}
    >
      <div className='mb-3 flex items-start justify-between gap-2'>
        <div className='min-w-0'>
          <p className='truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            {w.title}
          </p>
          {w.collection && (
            <p className='truncate font-mono text-[11px] text-slate-500 dark:text-slate-400'>
              {w.collection}
            </p>
          )}
        </div>
        <span className='shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:border-border dark:text-slate-300'>
          {TYPE_LABEL[w.type] ?? w.type}
        </span>
      </div>
      <div className='flex flex-1 items-center justify-center'>
        {w.error ? (
          <p className='flex items-center gap-1.5 text-[12px] text-rose-600 dark:text-rose-300'>
            <AlertCircle className='h-3.5 w-3.5' /> {w.error}
          </p>
        ) : (
          <WidgetFigure type={w.type} data={w.data ?? null} />
        )}
      </div>
    </div>
  )
}

export function DashboardDraftPage() {
  const navigate = useNavigate()
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState<DraftResponse | null>(null)

  const make = useMutation({
    mutationFn: (text: string) => {
      // Drafting again discards the draft on screen (it would only expire otherwise).
      if (draft) void api.post(`/ai/plans/${draft.plan.plan_id}/cancel`).catch(() => {})
      return api
        .post<{ data: DraftResponse }>('/ai/dashboard-drafts', { description: text })
        .then((r) => r.data.data)
    },
    onSuccess: (d) => setDraft(d)
  })

  const create = useMutation({
    mutationFn: async (planId: string) => {
      await api.post(`/ai/plans/${planId}/run`, { mode: 'all' })
      return waitForDashboard(planId)
    },
    onSuccess: (id) => {
      toast.success('Dashboard created')
      navigate(`/dashboards/${id}`)
    },
    onError: (err) => toast.error(userErrorMessage(err, 'Could not create it'))
  })

  const discard = useMutation({
    mutationFn: (planId: string) => api.post(`/ai/plans/${planId}/cancel`),
    onSettled: () => setDraft(null)
  })

  const busy = make.isPending || create.isPending
  const widgets = draft?.preview.widgets ?? []

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Button size='sm' variant='ghost' asChild>
            <Link to='/dashboards' aria-label='Back to dashboards'>
              <ArrowLeft className='h-3.5 w-3.5' />
            </Link>
          </Button>
          <div className='min-w-0'>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Draft a dashboard
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Describe who it is for and what they need to see. The draft uses only data you can
              read, and nothing is saved until you create it.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row'>
        <aside className='shrink-0 space-y-4 overflow-y-auto border-b border-slate-200 bg-white p-5 dark:border-border dark:bg-card md:w-[360px] md:border-b-0 md:border-r'>
          <div className='space-y-1.5'>
            <label
              htmlFor='draft-description'
              className='text-[12px] font-medium text-slate-700 dark:text-slate-200'
            >
              What should it show?
            </label>
            <Textarea
              id='draft-description'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && description.trim() && !busy)
                  make.mutate(description.trim())
              }}
              rows={5}
              maxLength={2000}
              placeholder='A dashboard for invoice reviewers: what is waiting, how old, by vendor'
              className='resize-none text-[13px]'
              disabled={busy}
            />
          </div>
          <div className='flex flex-wrap gap-1.5'>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type='button'
                disabled={busy}
                onClick={() => setDescription(ex)}
                className='rounded-full border border-slate-200 px-2.5 py-1 text-left text-[11.5px] text-slate-600 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-300'
              >
                {ex}
              </button>
            ))}
          </div>
          <Button
            className='w-full bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!description.trim() || busy}
            onClick={() => make.mutate(description.trim())}
            data-draft-make
          >
            {make.isPending ? (
              <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
            ) : (
              <Sparkles className='mr-1.5 h-3.5 w-3.5' />
            )}
            {draft ? 'Draft again' : 'Draft it'}
          </Button>
          {make.isError && (
            <p className='flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-300'>
              <AlertCircle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              {errorOf(make.error, 'Could not draft the dashboard')}
            </p>
          )}
          <p className='border-t border-slate-100 pt-3 text-[11.5px] leading-relaxed text-slate-500 dark:border-border dark:text-slate-400'>
            Each widget keeps its query, so once created it shows every viewer their own figures.
            Drafts appear in{' '}
            <Link
              to='/ai-plans'
              className='inline-flex items-center gap-0.5 font-medium text-slate-700 underline decoration-dotted underline-offset-2 dark:text-slate-200'
            >
              <History className='h-3 w-3' />
              AI plan history
            </Link>{' '}
            and expire after an hour.
          </p>
        </aside>

        <section className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          {make.isPending ? (
            <div className='space-y-3'>
              <p className='flex items-center gap-2 text-[12.5px] text-slate-500 dark:text-slate-400'>
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
                Choosing widgets and computing them with your access…
              </p>
              <PreviewSkeleton />
            </div>
          ) : draft ? (
            <div className='space-y-4'>
              <div className='flex flex-wrap items-center gap-3'>
                <div className='min-w-0 flex-1'>
                  <h2 className='truncate text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
                    {draft.preview.name}
                  </h2>
                  <p className='text-[12px] text-slate-500 dark:text-slate-400'>
                    Preview with your access · {widgets.length} widget
                    {widgets.length === 1 ? '' : 's'} · not saved yet
                  </p>
                </div>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={busy || discard.isPending}
                  onClick={() => discard.mutate(draft.plan.plan_id)}
                >
                  Discard
                </Button>
                <Button
                  size='sm'
                  className='bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                  disabled={busy}
                  onClick={() => create.mutate(draft.plan.plan_id)}
                  data-draft-create
                >
                  {create.isPending ? (
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <LayoutDashboard className='mr-1.5 h-3.5 w-3.5' />
                  )}
                  Create dashboard
                </Button>
              </div>
              {draft.dropped.length > 0 && (
                <div className='rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/15 dark:text-amber-200'>
                  <p className='font-medium'>
                    Left out {draft.dropped.length} widget{draft.dropped.length === 1 ? '' : 's'}{' '}
                    that could not be built from what you can read:
                  </p>
                  <ul className='mt-1 space-y-0.5'>
                    {draft.dropped.map((d, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: server order
                      <li key={i}>
                        {d.title} — {d.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                {[...widgets]
                  .sort((a, b) => a.row - b.row || a.col - b.col)
                  .map((w, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview order
                    <PreviewCard key={i} w={w} />
                  ))}
              </div>
            </div>
          ) : (
            <div className='flex h-full min-h-[280px] flex-col items-start justify-center gap-2 text-left'>
              <LayoutDashboard className='h-6 w-6 text-slate-400' />
              <p className='text-[13.5px] font-medium text-slate-700 dark:text-slate-200'>
                The preview appears here
              </p>
              <p className='max-w-[60ch] text-[12.5px] text-slate-500 dark:text-slate-400'>
                Counts, totals, the newest records and breakdowns — drawn from collections and saved
                queries you can read, laid out on the dashboard grid and computed as you see them.
                Change the description and draft again until it is right.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
