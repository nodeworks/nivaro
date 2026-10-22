import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { SimpleSelect } from '@/components/ui/simple-select'
import { cn } from '@/lib/utils'
import {
  type CatalogFault,
  type ChaosStatus,
  chaosKeys,
  errText,
  type FaultTarget,
  fetchStatus,
  type HypothesisRule,
  type PreflightCheck,
  preflightOf,
  startRun
} from './api'
import { PreflightPanel } from './PreflightPanel'

/**
 * The minimal start form (#2843): target, strength within the catalog's caps, duration, the
 * hypothesis from the fault's defaults, a note. Kept small on purpose — the experiment builder
 * (#2844) replaces this component; the Faults tab only passes it `fault` and `onClose`.
 */

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] tabular-nums text-slate-900 placeholder:text-slate-400 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground'
const labelCls = 'text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground'

const TARGET_LABEL: Record<FaultTarget['kind'], string> = {
  all: 'Everything',
  route: 'Routes matching',
  table: 'One table',
  user: 'One person',
  share: 'A share of traffic',
  node: 'One replica',
  room: 'One socket room'
}

const OPS: HypothesisRule['op'][] = ['<', '<=', '>', '>=']

/** `route:/api/items/orders*` → {kind, value}; null when the fault cannot take that kind. */
export function linkedTarget(
  raw: string | null,
  fault: Pick<CatalogFault, 'targets'>
): { kind: FaultTarget['kind']; value: string } | null {
  if (!raw) return null
  const cut = raw.indexOf(':')
  const kind = (cut < 0 ? raw : raw.slice(0, cut)) as FaultTarget['kind']
  const value = cut < 0 ? '' : raw.slice(cut + 1, cut + 301)
  if (!fault.targets.includes(kind) || (kind !== 'all' && !value)) return null
  return { kind, value }
}

export function StartForm({ fault, onClose }: { fault: CatalogFault; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: status } = useQuery<ChaosStatus>({
    queryKey: chaosKeys.status,
    queryFn: fetchStatus
  })
  // #2851 ?fault=<key>&target=<kind>[:<value>] (Traffic Map "Inject fault here") aims the form.
  const [search] = useSearchParams()
  const linked =
    search.get('fault') === fault.key ? linkedTarget(search.get('target'), fault) : null
  const [kind, setKind] = useState<FaultTarget['kind']>(linked?.kind ?? fault.targets[0] ?? 'all')
  const [targetValue, setTargetValue] = useState(linked?.value ?? '')
  const [params, setParams] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      Object.entries(fault.params).map(([k, s]) => [
        k,
        s.type === 'boolean' ? s.default : String(s.default ?? '')
      ])
    )
  )
  const [seconds, setSeconds] = useState(String(fault.default_seconds))
  const [rules, setRules] = useState<HypothesisRule[]>(fault.hypothesis_defaults)
  const [note, setNote] = useState('')
  const [override, setOverride] = useState(false)
  const [serverChecks, setServerChecks] = useState<PreflightCheck[] | null>(null)
  const [preflightOk, setPreflightOk] = useState<boolean | null>(null)
  const [overridable, setOverridable] = useState(false)

  const target = useMemo<FaultTarget>(() => {
    switch (kind) {
      case 'route':
        return { kind, pattern: targetValue }
      case 'table':
        return { kind, table: targetValue }
      case 'user':
        return { kind, user_id: targetValue }
      case 'share':
        return { kind, share_pct: Number(targetValue) || 10 }
      case 'node':
        return { kind, node: targetValue || status?.nodes[0] || '' }
      case 'room':
        return { kind, room: targetValue }
      default:
        return { kind: 'all' }
    }
  }, [kind, targetValue, status])

  const secondsN = Math.min(
    fault.max_seconds,
    Math.max(5, Number(seconds) || fault.default_seconds)
  )

  const start = useMutation({
    mutationFn: () =>
      startRun({
        fault_key: fault.key,
        target,
        params: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [
            k,
            typeof v === 'boolean' ? v : v === '' ? '' : Number.isNaN(Number(v)) ? v : Number(v)
          ])
        ),
        seconds: secondsN,
        hypothesis: rules,
        override: override ? { working_hours: true } : null,
        note: note || null
      }),
    onSuccess: ({ run }) => {
      toast.success(`${fault.label} armed for ${secondsN}s`)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      navigate(`/chaos?tab=runs&run=${run.id}`)
    },
    onError: (e) => {
      const checks = preflightOf(e)
      if (checks) {
        setServerChecks(checks)
        toast.error('Pre-flight refused the run')
      } else toast.error(errText(e, 'The run could not start'))
    }
  })

  const needsValue = kind !== 'all'
  const canRun =
    (!needsValue || targetValue.trim() !== '' || kind === 'node') &&
    (preflightOk !== false || (override && overridable))

  return (
    <div className='grid gap-5 border-t border-slate-200 bg-slate-50 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_300px] dark:border-border dark:bg-muted/30'>
      <form
        className='min-w-0 space-y-4'
        onSubmit={(e) => {
          e.preventDefault()
          if (canRun) start.mutate()
        }}
      >
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='block space-y-1'>
            <span className={labelCls}>Target</span>
            <SimpleSelect
              value={kind}
              onChange={(v) => {
                setKind(v as FaultTarget['kind'])
                setTargetValue('')
              }}
              options={fault.targets.map((t) => ({ value: t, label: TARGET_LABEL[t] }))}
              ariaLabel='Target'
              className='h-8 text-[12.5px]'
            />
          </div>
          {kind === 'node' ? (
            <div className='block space-y-1'>
              <span className={labelCls}>Replica</span>
              <SimpleSelect
                value={targetValue || status?.nodes[0] || ''}
                onChange={setTargetValue}
                options={(status?.nodes ?? []).map((n) => ({ value: n, label: n }))}
                ariaLabel='Replica'
                className='h-8 font-mono text-[11.5px]'
              />
            </div>
          ) : needsValue ? (
            <label className='block space-y-1'>
              <span className={labelCls}>
                {kind === 'route'
                  ? 'Path or pattern'
                  : kind === 'table'
                    ? 'Table'
                    : kind === 'user'
                      ? 'User id'
                      : kind === 'share'
                        ? 'Share (%)'
                        : 'Room'}
              </span>
              <input
                className={cn(inputCls, kind !== 'share' && 'font-mono text-[11.5px]')}
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder={
                  kind === 'route'
                    ? '/api/items/*'
                    : kind === 'table'
                      ? 'articles'
                      : kind === 'user'
                        ? '00000000-0000-…'
                        : kind === 'share'
                          ? '10'
                          : 'collection:articles'
                }
                type={kind === 'share' ? 'number' : 'text'}
                min={kind === 'share' ? 1 : undefined}
                max={kind === 'share' ? 100 : undefined}
              />
            </label>
          ) : null}
        </div>

        {Object.keys(fault.params).length > 0 && (
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
            {Object.entries(fault.params).map(([key, spec]) => (
              <div key={key} className='block space-y-1'>
                <span className={labelCls}>
                  {spec.label}
                  {spec.type === 'number' && (
                    <span className='ml-1 font-normal text-slate-400 dark:text-muted-foreground/70'>
                      {spec.min}–{spec.max}
                      {spec.unit ? ` ${spec.unit}` : ''}
                    </span>
                  )}
                </span>
                {spec.type === 'number' ? (
                  <input
                    type='number'
                    className={inputCls}
                    min={spec.min}
                    max={spec.max}
                    step={spec.step ?? 1}
                    value={String(params[key] ?? '')}
                    onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))}
                  />
                ) : spec.type === 'enum' ? (
                  <SimpleSelect
                    value={String(params[key] ?? spec.default)}
                    onChange={(v) => setParams((p) => ({ ...p, [key]: v }))}
                    options={spec.options.map((o) => ({ value: o, label: o }))}
                    ariaLabel={spec.label}
                    className='h-8 text-[12.5px]'
                  />
                ) : spec.type === 'boolean' ? (
                  <span className='flex h-8 items-center gap-2 text-[12.5px]'>
                    <input
                      type='checkbox'
                      className='h-3.5 w-3.5 accent-nvr-cyan'
                      checked={params[key] === true}
                      onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                    On
                  </span>
                ) : (
                  <input
                    className={inputCls}
                    value={String(params[key] ?? '')}
                    maxLength={spec.max_length}
                    onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className='grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]'>
          <label className='block space-y-1'>
            <span className={labelCls}>
              Duration
              <span className='ml-1 font-normal text-slate-400 dark:text-muted-foreground/70'>
                5–{fault.max_seconds} s
              </span>
            </span>
            <input
              type='number'
              className={inputCls}
              min={5}
              max={fault.max_seconds}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </label>
          <label className='block space-y-1'>
            <span className={labelCls}>Note</span>
            <input
              className={inputCls}
              value={note}
              maxLength={500}
              placeholder='Why this drill, what to watch'
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>

        <fieldset className='space-y-2'>
          <legend className={labelCls}>What should stay true</legend>
          {rules.length === 0 && (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              No limits: the run records what happened and never aborts on its own.
            </p>
          )}
          {rules.map((r, i) => (
            <div key={`${r.sampler}-${i}`} className='flex flex-wrap items-center gap-2'>
              <input
                className={cn(inputCls, 'w-44 font-mono text-[11.5px]')}
                value={r.sampler}
                aria-label='Sampler'
                onChange={(e) =>
                  setRules((rs) =>
                    rs.map((x, j) => (j === i ? { ...x, sampler: e.target.value } : x))
                  )
                }
              />
              <SimpleSelect
                value={r.op}
                onChange={(v) =>
                  setRules((rs) =>
                    rs.map((x, j) => (j === i ? { ...x, op: v as HypothesisRule['op'] } : x))
                  )
                }
                options={OPS.map((o) => ({ value: o, label: o }))}
                ariaLabel='Comparison'
                className='h-8 w-16 text-[12.5px]'
              />
              <input
                type='number'
                className={cn(inputCls, 'w-24')}
                value={r.limit}
                aria-label='Limit'
                onChange={(e) =>
                  setRules((rs) =>
                    rs.map((x, j) => (j === i ? { ...x, limit: Number(e.target.value) } : x))
                  )
                }
              />
              <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>±</span>
              <input
                type='number'
                className={cn(inputCls, 'w-20')}
                value={r.tolerance ?? 0}
                aria-label='Tolerance'
                onChange={(e) =>
                  setRules((rs) =>
                    rs.map((x, j) => (j === i ? { ...x, tolerance: Number(e.target.value) } : x))
                  )
                }
              />
              <button
                type='button'
                aria-label='Remove this limit'
                onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                className='rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-foreground'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          ))}
          <button
            type='button'
            onClick={() =>
              setRules((rs) => [
                ...rs,
                { sampler: 'http.p95_ms', op: '<', limit: 2000, tolerance: 200 }
              ])
            }
            className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
          >
            <Plus className='h-3.5 w-3.5' /> Add a limit
          </button>
        </fieldset>

        <div className='flex flex-wrap items-center gap-2 pt-1'>
          <button
            type='submit'
            disabled={!canRun || start.isPending}
            className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-background'
          >
            <Play className='h-3.5 w-3.5' aria-hidden />
            Run for {secondsN}s
          </button>
          <button
            type='button'
            onClick={onClose}
            className='inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-foreground'
          >
            Cancel
          </button>
          {overridable && (
            <label className='ml-auto flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
              <input
                type='checkbox'
                className='h-3.5 w-3.5 accent-nvr-cyan'
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
              />
              Run outside working hours (recorded on the run)
            </label>
          )}
        </div>
      </form>
      <PreflightPanel
        serverChecks={serverChecks}
        onResult={(ok, checks) => {
          setPreflightOk(ok)
          setOverridable(
            checks.some((c) => !c.ok && c.overridable) && checks.every((c) => c.ok || c.overridable)
          )
        }}
      />
    </div>
  )
}
