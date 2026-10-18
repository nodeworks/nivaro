/**
 * #2221 — "Deploy now?": current load against its normal for this hour, heavy jobs and imports
 * running, open incidents, and a recommendation to deploy now or wait, with the reason. The same
 * check on the map (header button) and on the Release card (admin Environments). The verdict is
 * worked out on the server by fixed rules — no AI call.
 */
import { useQuery } from '@tanstack/react-query'
import { Rocket } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { BTN } from '../shared'
import type { Level } from './score'
import { fmtNum, LEVEL_TEXT, ToneChip } from './ui'

export interface DeployCheck {
  verdict: 'go' | 'wait'
  reasons: string[]
  sentence: string
  learning: boolean
  at: string
  facts: {
    load: { rpm: number; usual: number | null; score: { level: Level } }
    heavy: string[]
    running: string[]
    imports: number
    incidents: string[]
    quiet: { label: string; rpm: number } | null
  }
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function useDeployCheck(enabled = true) {
  return useQuery({
    queryKey: ['traffic-map', 'deploy-check'],
    queryFn: async () => {
      const res = await api.get('/traffic-map/deploy-check', { params: { tz: tz() } })
      return (res.data as { data: DeployCheck }).data
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false
  })
}

/** The check as a block: verdict, sentence, every reason, and the facts it read. */
export function DeployCheckSummary({ className }: { className?: string }) {
  const q = useDeployCheck()
  if (q.isError) return null
  const c = q.data
  return (
    <div
      className={cn('grid gap-1.5 text-[12px] text-[var(--tm-fg)]', className)}
      data-tm-deploy-check={c?.verdict ?? 'loading'}
    >
      {!c ? (
        <div
          aria-hidden='true'
          className='h-8 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
        />
      ) : (
        <>
          <div className='flex flex-wrap items-baseline gap-2'>
            <ToneChip tone={c.verdict === 'go' ? 'good' : 'warn'} id='tm-deploy-verdict'>
              {c.verdict === 'go' ? 'Deploy now' : 'Wait'}
            </ToneChip>
            <span className='min-w-0 text-[var(--tm-fg-2)]'>{c.sentence}</span>
          </div>
          {c.reasons.length > 1 && (
            <ul className='grid list-disc gap-0.5 pl-5 text-[11.5px] text-[var(--tm-fg-2)]'>
              {c.reasons.slice(1).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Load {fmtNum(c.facts.load.rpm)}/min
            {c.facts.load.usual != null
              ? ` (usually ${fmtNum(c.facts.load.usual)}, ${LEVEL_TEXT[c.facts.load.score.level]})`
              : ' (no normal yet)'}{' '}
            · {c.facts.heavy.length + c.facts.running.length} job
            {c.facts.heavy.length + c.facts.running.length === 1 ? '' : 's'} running ·{' '}
            {c.facts.imports} import{c.facts.imports === 1 ? '' : 's'} · {c.facts.incidents.length}{' '}
            open incident{c.facts.incidents.length === 1 ? '' : 's'}
          </p>
        </>
      )}
    </div>
  )
}

function DeployCheckButton() {
  const q = useDeployCheck()
  if (q.isError) return null
  const verdict = q.data?.verdict
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-deploy-check'
          data-tip={q.data?.sentence ?? 'Is now a good time to deploy?'}
          className={BTN}
        >
          <Rocket className='h-3.5 w-3.5' aria-hidden='true' />
          Deploy now?
          {verdict && (
            <span
              aria-hidden='true'
              className='inline-block h-[7px] w-[7px] rounded-full'
              style={{ background: verdict === 'go' ? 'var(--tm-create)' : 'var(--tm-update)' }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='traffic-map w-[340px] p-3'>
        <h3 className='mb-1.5 text-[12.5px] font-semibold'>Deploy now?</h3>
        <DeployCheckSummary />
      </PopoverContent>
    </Popover>
  )
}

register(toolbarItems, {
  id: 'deploy-check',
  order: 30,
  slot: 'actions',
  Component: DeployCheckButton
})
