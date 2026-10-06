import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'

/**
 * Team suggestions (#745): owner-group cells whose direct member set recurs
 * across several cells. Each suggestion previews first (dry run) and only a
 * second, explicit click creates the team, links it to the cells and removes
 * the replaced direct member rows — the server backs those rows up first.
 */

interface Suggestion {
  key: string
  members: Array<{ id: string; name: string; status: string | null; redacted: boolean }>
  cells: Array<{
    group_id: string
    group_name: string | null
    template_name: string | null
    state_label: string | null
  }>
  cell_count: number
  rows_replaced: number
  suggested_name: string
  existing_team: { id: number; name: string; slug: string } | null
}

interface ApplyPlan {
  dry_run: boolean
  team: { action: 'create' | 'link'; id: number | null; name: string; slug: string | null }
  cells: string[]
  skipped: Array<{ group_id: string; reason: string }>
  rows_removed: number
  backup_table: string | null
}

export function TeamSuggestionsPanel({ onApplied }: { onApplied: (teamId: number) => void }) {
  const client = useNivaroClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['team-suggestions'],
    queryFn: () =>
      client.request<{ data: Suggestion[] }>(get('/user-groups/suggestions')).then((r) => r.data),
    staleTime: 60_000
  })

  return (
    <div className='p-6' data-team-suggestions>
      <div className='flex items-start gap-3'>
        <Sparkles className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' />
        <div>
          <h2 className='text-[15px] font-semibold text-slate-800 dark:text-foreground'>
            Suggested teams
          </h2>
          <p className='mt-0.5 max-w-[72ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            The same people typed into owner-matrix cells again and again. Turning a recurring set
            into a team keeps ownership exactly as it is today — the team is linked to every cell
            and its roster replaces the individual entries — but the next roster change is one edit
            instead of one per cell.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className='mt-5 space-y-3'>
          <Skeleton className='h-20 w-full' />
          <Skeleton className='h-20 w-full' />
        </div>
      ) : isError ? (
        <p className='mt-5 text-[12.5px] text-rose-600 dark:text-rose-400'>
          Could not load suggestions.
        </p>
      ) : (data ?? []).length === 0 ? (
        <p className='mt-5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          No set of two or more people repeats across three or more cells that are not already
          linked to a team.
        </p>
      ) : (
        <div className='mt-5 space-y-3'>
          {(data ?? []).map((s) => (
            <SuggestionCard key={s.key} s={s} onApplied={onApplied} />
          ))}
        </div>
      )}
    </div>
  )
}

function SuggestionCard({ s, onApplied }: { s: Suggestion; onApplied: (id: number) => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [name, setName] = useState(s.existing_team ? s.existing_team.name : s.suggested_name)
  const [showCells, setShowCells] = useState(false)
  const [plan, setPlan] = useState<ApplyPlan | null>(null)
  const body = (execute: boolean) => ({
    members: s.members.map((m) => m.id),
    group_ids: s.cells.map((c) => c.group_id),
    name: name.trim(),
    existing_team_id: s.existing_team?.id ?? null,
    execute
  })
  const preview = useMutation({
    mutationFn: () =>
      client
        .request<{ data: ApplyPlan }>(post('/user-groups/suggestions/apply', body(false)))
        .then((r) => r.data),
    onSuccess: (p) => setPlan(p),
    onError: (e) => toast.error((e as Error).message || 'Preview failed')
  })
  const apply = useMutation({
    mutationFn: () =>
      client
        .request<{ data: ApplyPlan }>(post('/user-groups/suggestions/apply', body(true)))
        .then((r) => r.data),
    onSuccess: (p) => {
      toast.success(
        `${p.team.action === 'create' ? 'Created' : 'Linked'} ${p.team.name} on ${p.cells.length} cell${p.cells.length === 1 ? '' : 's'}`
      )
      void qc.invalidateQueries({ queryKey: ['team-suggestions'] })
      void qc.invalidateQueries({ queryKey: ['user-groups'] })
      void qc.invalidateQueries({ queryKey: ['user-groups-teams'] })
      void qc.invalidateQueries({ queryKey: ['owner-groups'] })
      if (p.team.id != null) onApplied(p.team.id)
    },
    onError: (e) => toast.error((e as Error).message || 'Could not apply')
  })
  const templates = [...new Set(s.cells.map((c) => c.template_name ?? 'Template'))]
  const inactive = s.members.filter((m) => m.redacted || (m.status && m.status !== 'active'))

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      data-team-suggestion={s.key}
    >
      <p className='text-[13px] text-slate-800 dark:text-foreground'>
        <span className='font-semibold tabular-nums'>{s.cell_count}</span> cells share the same{' '}
        <span className='font-semibold tabular-nums'>{s.members.length}</span> people
        <span className='text-slate-400'> · {templates.join(', ')}</span>
      </p>
      <div className='mt-2 flex flex-wrap gap-1.5'>
        {s.members.map((m) => {
          const off = m.redacted || (m.status != null && m.status !== 'active')
          return (
            <span
              key={m.id}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11.5px]',
                off
                  ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'
                  : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
              )}
            >
              {m.name}
              {off ? ' · inactive' : ''}
            </span>
          )
        })}
      </div>
      {inactive.length > 0 && (
        <p className='mt-1.5 text-[11.5px] text-rose-600 dark:text-rose-400'>
          {inactive.length} of them can no longer act — remove them from the team after creating it,
          or fix the cells first.
        </p>
      )}

      <button
        type='button'
        onClick={() => setShowCells((v) => !v)}
        className='mt-2 text-[11.5px] text-slate-500 underline-offset-2 hover:underline dark:text-muted-foreground'
      >
        {showCells ? 'Hide' : 'Show'} the {s.cell_count} cells
      </button>
      {showCells && (
        <ul className='mt-1.5 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-slate-100 p-2 text-[11.5px] text-slate-600 dark:border-border/60 dark:text-muted-foreground'>
          {s.cells.map((c) => (
            <li key={c.group_id}>
              <span className='text-slate-400'>{c.template_name} ›</span> {c.state_label ?? '?'}
              {c.group_name ? <span className='text-slate-400'> · {c.group_name}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className='mt-3 flex flex-wrap items-center gap-2'>
        {s.existing_team ? (
          <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>
            The team <span className='font-medium'>{s.existing_team.name}</span> already has exactly
            these members — it will be linked instead of creating a new one.
          </span>
        ) : (
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setPlan(null)
            }}
            className='h-8 w-64 text-[12.5px]'
            placeholder='Team name'
            aria-label='Team name'
            data-team-suggestion-name
          />
        )}
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          disabled={preview.isPending || (!s.existing_team && !name.trim())}
          onClick={() => preview.mutate()}
          data-team-suggestion-preview
        >
          {preview.isPending ? 'Checking…' : 'Preview'}
        </Button>
      </div>

      {plan && (
        <div
          className='mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-[12px] dark:border-border dark:bg-muted/30'
          data-team-suggestion-plan
        >
          <p className='text-slate-700 dark:text-foreground'>
            {plan.team.action === 'create' ? (
              <>
                Create <span className='font-semibold'>{plan.team.name}</span> (@{plan.team.slug})
                with {s.members.length} members,
              </>
            ) : (
              <>
                Link <span className='font-semibold'>{plan.team.name}</span>
              </>
            )}{' '}
            on <span className='font-semibold tabular-nums'>{plan.cells.length}</span> cell
            {plan.cells.length === 1 ? '' : 's'}, and remove{' '}
            <span className='font-semibold tabular-nums'>{plan.rows_removed}</span> individual
            entries they replace. The removed entries are backed up first.
          </p>
          {plan.skipped.length > 0 && (
            <p className='mt-1 text-amber-700 dark:text-amber-400'>
              {plan.skipped.length} cell{plan.skipped.length === 1 ? '' : 's'} left alone:{' '}
              {[...new Set(plan.skipped.map((x) => x.reason))].join('; ')}.
            </p>
          )}
          <div className='mt-2 flex gap-2'>
            <Button
              size='sm'
              className='h-8 text-[12.5px]'
              disabled={apply.isPending || plan.cells.length === 0}
              onClick={() => apply.mutate()}
              data-team-suggestion-apply
            >
              {apply.isPending
                ? 'Applying…'
                : plan.team.action === 'create'
                  ? `Create team and link ${plan.cells.length} cells`
                  : `Link ${plan.cells.length} cells`}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-8 text-[12.5px]'
              onClick={() => setPlan(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
