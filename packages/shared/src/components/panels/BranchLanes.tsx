import { Check, GitBranch, GitMerge } from 'lucide-react'
import { formatRelative, humanHours } from '../../lib/utils'
import { OwnerAvatars } from '../queue/OwnerAvatars'

/** One parallel branch of a split (#1240) — shape of `branches` on
 *  GET /pipelines/instance/:collection/:item (api services/branch-lanes.ts). */
export interface BranchLaneStateRef {
  id: string
  label: string
  color: string | null
}
export interface BranchLaneData {
  instance_id: string
  label: string
  steps: Array<{
    state: BranchLaneStateRef
    entered_at: string
    left_at: string | null
    by: string | null
  }>
  current: BranchLaneStateRef | null
  entered_at: string | null
  terminal: boolean
  finished_at: string | null
  owners?: Array<{ id: string; name: string }>
}
export interface BranchLanesData {
  split_state: BranchLaneStateRef | null
  join_state: BranchLaneStateRef | null
  split_at: string
  joined_at: string | null
  open: boolean
  lanes: BranchLaneData[]
  waiting_on: string[]
}

function sinceText(iso: string | null, until?: string | null): string | null {
  if (!iso) return null
  const end = until ? new Date(until).getTime() : Date.now()
  const ms = end - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  return humanHours(ms / 3_600_000)
}

function Node({
  color,
  filled,
  ring,
  children
}: {
  color: string
  filled: boolean
  ring?: boolean
  children?: React.ReactNode
}) {
  return (
    <span
      className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full'
      style={{
        backgroundColor: filled ? color : 'transparent',
        border: filled ? 'none' : `1.5px dashed ${color}`,
        boxShadow: ring ? `0 0 0 2px hsl(var(--card)), 0 0 0 4px ${color}` : undefined
      }}
    >
      {children}
    </span>
  )
}

/**
 * Parallel branches drawn as lanes from the split state to the join: each
 * branch's path so far, where it sits now, for how long and with whom; the
 * join says which branch it is still waiting on.
 */
export function BranchLanes({ data }: { data: BranchLanesData }) {
  if (data.lanes.length === 0) return null
  const splitColor = data.split_state?.color ?? '#94a3b8'
  const joinColor = data.join_state?.color ?? '#94a3b8'
  const waiting = data.lanes.filter((l) => data.waiting_on.includes(l.instance_id))
  return (
    <div
      className='rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-white/[0.02]'
      data-branch-lanes={data.open ? 'open' : 'joined'}
    >
      <div className='mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]'>
        <GitBranch className='h-3.5 w-3.5 text-slate-400' />
        <span className='font-medium text-slate-700 dark:text-slate-200'>
          {data.lanes.length} parallel branches
        </span>
        <span className='text-slate-500 dark:text-slate-400'>
          split {formatRelative(data.split_at)}
        </span>
        <span className='ml-auto' data-branch-join-status>
          {data.open ? (
            <span className='rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'>
              Waiting on {waiting.length} of {data.lanes.length}
            </span>
          ) : (
            <span className='rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'>
              Joined {data.joined_at ? formatRelative(data.joined_at) : ''}
            </span>
          )}
        </span>
      </div>

      <div className='flex items-stretch gap-2'>
        {/* Split */}
        <div className='flex w-20 shrink-0 flex-col items-center justify-center gap-1 text-center'>
          <Node color={splitColor} filled>
            <GitBranch className='h-3 w-3 text-white' />
          </Node>
          <span className='text-[10.5px] leading-tight text-slate-600 dark:text-slate-300'>
            {data.split_state?.label ?? 'Split'}
          </span>
        </div>

        {/* Lanes */}
        <ol className='min-w-0 flex-1 space-y-1.5 border-x-2 border-dashed border-slate-200 px-2 dark:border-border'>
          {data.lanes.map((lane) => {
            const color = lane.current?.color ?? '#94a3b8'
            // Open: how long it has sat where it is. Done: how long the
            // whole branch took, split to finish.
            const inState = lane.terminal
              ? sinceText(lane.steps[0]?.entered_at ?? data.split_at, lane.finished_at)
              : sinceText(lane.entered_at)
            return (
              <li
                key={lane.instance_id}
                className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-white px-2.5 py-1.5 dark:bg-card'
                data-branch-lane={lane.instance_id}
                data-branch-lane-state={lane.terminal ? 'done' : 'open'}
              >
                <span className='w-28 shrink-0 truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  {lane.label}
                </span>
                <span className='flex min-w-0 items-center gap-1'>
                  {lane.steps.map((step, i) => {
                    const isCurrent = i === lane.steps.length - 1
                    return (
                      <span
                        key={`${step.state.id}-${step.entered_at}`}
                        className='flex items-center'
                      >
                        {i > 0 && <span className='mx-0.5 h-px w-3 bg-slate-300 dark:bg-border' />}
                        <span
                          className='flex h-4 w-4 items-center justify-center rounded-full'
                          style={{
                            backgroundColor:
                              !isCurrent || lane.terminal
                                ? (step.state.color ?? '#94a3b8')
                                : 'transparent',
                            border: `1.5px solid ${step.state.color ?? '#94a3b8'}`
                          }}
                          data-tip={`${step.state.label} · entered ${new Date(step.entered_at).toLocaleString()}${step.by ? ` by ${step.by}` : ''}`}
                        >
                          {(!isCurrent || lane.terminal) && (
                            <Check className='h-2.5 w-2.5 text-white' strokeWidth={3} />
                          )}
                        </span>
                      </span>
                    )
                  })}
                </span>
                <span
                  className='rounded-full px-2 py-0.5 text-[11px] font-medium'
                  style={{ backgroundColor: `${color}1f`, color }}
                  data-branch-lane-current
                >
                  {lane.current?.label ?? '—'}
                </span>
                {inState && (
                  <span className='text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                    {lane.terminal ? `done in ${inState}` : `${inState} in this state`}
                  </span>
                )}
                {!lane.terminal && (
                  <span className='ml-auto'>
                    <OwnerAvatars owners={lane.owners ?? []} max={3} emptyLabel='No owners' />
                  </span>
                )}
              </li>
            )
          })}
        </ol>

        {/* Join */}
        <div
          className='flex w-24 shrink-0 flex-col items-center justify-center gap-1 text-center'
          data-branch-join
        >
          <Node color={joinColor} filled={!data.open} ring={!data.open}>
            <GitMerge className={`h-3 w-3 ${data.open ? 'text-slate-400' : 'text-white'}`} />
          </Node>
          <span className='text-[10.5px] leading-tight text-slate-600 dark:text-slate-300'>
            {data.join_state?.label ?? 'Join'}
          </span>
          {data.open && waiting.length > 0 && (
            <span className='text-[10px] leading-tight text-amber-700 dark:text-amber-300'>
              still open: {waiting.map((l) => l.label).join(', ')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
