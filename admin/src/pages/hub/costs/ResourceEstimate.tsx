import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ghostButton } from '../hub-parts'
import type { FieldSpec } from '../providers/providers-api'
import { CostFigure, EstimateStrip } from './CostFigure'
import { type ProviderEstimateBody, trafficWords, withoutSecrets } from './cost-api'
import { useProviderEstimate } from './use-costs'

/**
 * The running estimate under a provider resource's create / change form: asked 400 ms after the
 * last edit (secrets never leave the form: a set secret is sent as "set"), the last figure kept
 * while the next one loads. Data out (GB a month) is prefilled from what the Hub measured for
 * the app; the person may type their own figure, and the strip says which one it used.
 */
export function ResourceEstimate({
  connectionId,
  type,
  fields,
  payload,
  resourceId,
  appId,
  environmentId,
  ready
}: {
  connectionId: number
  type: string
  fields: FieldSpec[]
  /** The form's fields as the plan would send them (create: all; change: the changed ones). */
  payload: Record<string, unknown>
  resourceId?: number
  appId?: number
  environmentId?: number
  /** false = the form has nothing to price yet (a change with nothing changed). */
  ready: boolean
}) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [typed, setTyped] = useState('')
  const gb = typed.trim() === '' ? null : Number(typed)
  const gbBad = gb != null && (!Number.isFinite(gb) || gb < 0 || gb > 10_000_000)
  const body: ProviderEstimateBody | null = ready
    ? {
        connection_id: connectionId,
        ...(resourceId != null ? { resource_id: resourceId } : { type }),
        desired: withoutSecrets(fields, payload),
        ...(appId != null ? { app_id: appId } : {}),
        ...(environmentId != null ? { environment_id: environmentId } : {}),
        ...(gb != null && !gbBad ? { egress_gb_month: gb } : {})
      }
    : null
  const q = useProviderEstimate(body)
  const e = q.data ?? null
  const traffic = e?.traffic ?? null
  const shownGb = gb != null && !gbBad ? gb : (traffic?.egressGbMonth ?? 0)
  const source = trafficWords(traffic, gb != null && !gbBad)
  const inputId = `${id}-egress`
  if (!ready && !e) return null
  return (
    <EstimateStrip
      aside={
        editing ? (
          <span className='inline-flex items-center gap-1.5'>
            <label htmlFor={inputId} className='text-[11.5px] text-slate-600 dark:text-slate-300'>
              Data out, GB a month
            </label>
            <Input
              id={inputId}
              inputMode='decimal'
              value={typed}
              placeholder={traffic ? String(traffic.egressGbMonth) : '0'}
              onChange={(ev) => setTyped(ev.target.value)}
              aria-invalid={gbBad || undefined}
              className={cn(
                'h-7 w-24 bg-white font-mono text-[12px] tabular-nums dark:bg-background',
                gbBad && 'border-red-400 dark:border-red-500'
              )}
            />
            <button
              type='button'
              className={cn(ghostButton, 'h-7 px-2')}
              onClick={() => {
                if (gbBad) setTyped('')
                setEditing(false)
              }}
            >
              Done
            </button>
          </span>
        ) : (
          <span className='inline-flex flex-wrap items-center gap-x-1 text-[11.5px] text-slate-600 dark:text-slate-300'>
            <span className='tabular-nums'>
              Data out:{' '}
              {shownGb > 0 ? (
                <>
                  {shownGb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB a month{' '}
                  <span className='text-slate-500 dark:text-muted-foreground'>({source})</span>
                </>
              ) : gb != null ? (
                'none (you entered 0)'
              ) : (
                'none assumed'
              )}
            </span>
            <button
              type='button'
              className={cn(ghostButton, 'h-6 px-1.5 text-[11.5px]')}
              onClick={() => setEditing(true)}
            >
              {gb != null ? 'Change' : 'Set'}
            </button>
            {gb != null && (
              <button
                type='button'
                className={cn(ghostButton, 'h-6 px-1.5 text-[11.5px]')}
                onClick={() => setTyped('')}
              >
                Reset
              </button>
            )}
          </span>
        )
      }
    >
      {q.isError && !e ? (
        <span className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          No estimate (the Hub could not work it out just now)
        </span>
      ) : (
        <CostFigure
          estimate={e}
          before={resourceId != null ? (e?.before ?? null) : null}
          loading={q.isFetching}
          label='this estimate'
        />
      )}
    </EstimateStrip>
  )
}
