import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Play, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  type Catalog,
  type CatalogFault,
  type ChaosStatus,
  chaosKeys,
  errText,
  fetchCatalog,
  fetchPreflight,
  fetchStatus,
  type Preflight,
  type PreflightCheck,
  preflightOf,
  startRun
} from '../api'
import { builderKeys, type ChaosPreset, fetchCaps, runPreset } from './api'
import {
  clampDraft,
  type DraftSpec,
  draftIssues,
  formatSeconds,
  initialDraft,
  mapNodeFor,
  paramWords,
  runBody,
  type SpecLike,
  STEPS,
  type StepId,
  targetWords
} from './model'
import { SavePresetPopover } from './SavePresetPopover'
import {
  AbortStep,
  BlastStep,
  DurationStep,
  FaultStep,
  HypothesisStep,
  inputCls,
  labelCls,
  PreflightStep,
  StrengthStep,
  TargetStep,
  useSamplerChoices
} from './steps'

/**
 * The experiment builder (#2844): a stepped form — fault, target, strength, duration, what
 * stays true, abort limits, blast radius, pre-flight — with a summary that reads the run back
 * in words, "Save as preset", and a two-click Run ("Run", then "Confirm — arms … for …").
 *
 * Mounted inline under a fault row (Faults tab, via StartForm) and as the Builder tab (deep
 * links from presets, the Traffic Map, the matrix and Ask AI). Never a modal.
 */

const CONFIRM_MS = 8000

export interface ExperimentBuilderProps {
  fault: CatalogFault
  /** A preset the draft started from: its spec is the base, Run records it on the run. */
  preset?: ChaosPreset | null
  /** A deep-link spec layered over the preset (or the fault's defaults). */
  initial?: SpecLike | null
  onClose?: () => void
  /** Tab = full page width; inline = under a fault row. */
  variant?: 'inline' | 'tab'
}

export function ExperimentBuilder({
  fault: initialFault,
  preset = null,
  initial = null,
  onClose,
  variant = 'inline'
}: ExperimentBuilderProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: catalog } = useQuery<Catalog>({
    queryKey: chaosKeys.catalog,
    queryFn: fetchCatalog
  })
  const { data: status } = useQuery<ChaosStatus>({
    queryKey: chaosKeys.status,
    queryFn: fetchStatus
  })
  const { data: caps = null } = useQuery({
    queryKey: builderKeys.caps,
    queryFn: fetchCaps,
    staleTime: 60_000,
    retry: false
  })
  const { data: preflight } = useQuery<Preflight>({
    queryKey: chaosKeys.preflight,
    queryFn: fetchPreflight,
    refetchInterval: 15_000,
    retry: false
  })
  const nodes = status?.nodes ?? []
  const faults = catalog?.faults ?? [initialFault]

  const [faultKey, setFaultKey] = useState(initialFault.key)
  const fault = faults.find((f) => f.key === faultKey) ?? initialFault
  const [draft, setDraft] = useState<DraftSpec>(() =>
    initialDraft(initialFault, [preset?.spec, initial], nodes, caps)
  )
  const [step, setStep] = useState<StepId>(initial || preset ? 'target' : 'fault')
  const [serverChecks, setServerChecks] = useState<PreflightCheck[] | null>(null)
  const [override, setOverride] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Caps (#2862) can arrive after the first render: pull the draft back inside them.
  useEffect(() => {
    if (caps) setDraft((d) => clampDraft(d, fault, caps))
  }, [caps, fault])
  // A replica list that arrives late fills an empty replica target.
  useEffect(() => {
    if (nodes[0])
      setDraft((d) =>
        d.target.kind === 'node' && !d.target.node
          ? { ...d, target: { kind: 'node', node: nodes[0] } }
          : d
      )
  }, [nodes[0]])
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    []
  )

  const set = (fn: (d: DraftSpec) => DraftSpec) => {
    setConfirming(false)
    setDraft((d) => fn(d))
  }
  const pickFault = (key: string) => {
    const f = faults.find((x) => x.key === key)
    if (!f || key === faultKey) return
    setFaultKey(key)
    setConfirming(false)
    setDraft(initialDraft(f, [], nodes, caps))
  }

  const issues = draftIssues(draft, fault, caps)
  const blocking = Object.values(issues).filter(Boolean) as string[]
  const checks = serverChecks ?? preflight?.checks ?? []
  const failing = checks.filter((c) => !c.ok)
  const overridable = failing.length > 0 && failing.every((c) => c.overridable)
  const preflightOk = preflight ? failing.length === 0 || (overridable && override) : null
  const allowed = status?.allowed ?? true
  const canRun = allowed && blocking.length === 0 && preflightOk === true

  const why = !allowed
    ? (status?.reason ?? 'Faults cannot be armed on this instance.')
    : blocking[0]
      ? blocking[0]
      : preflightOk === null
        ? 'Waiting for the pre-flight checks…'
        : preflightOk === false
          ? `Pre-flight: ${failing.map((c) => c.label).join(', ')}.`
          : null

  const run = useMutation({
    mutationFn: () => {
      const body = { ...runBody(draft), override: override ? { working_hours: true } : null }
      return preset ? runPreset(preset.key, body) : startRun(body)
    },
    onSuccess: ({ run: r }) => {
      toast.success(`${fault.label} armed for ${formatSeconds(draft.seconds)}`)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      navigate(`/chaos?tab=runs&run=${r.id}`)
    },
    onError: (e) => {
      setConfirming(false)
      const refused = preflightOf(e)
      if (refused) {
        setServerChecks(refused)
        setStep('preflight')
        toast.error('Pre-flight refused the run')
      } else toast.error(errText(e, 'The run could not start'))
    }
  })

  const startConfirm = () => {
    if (!canRun) return
    setConfirming(true)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_MS)
  }

  const go = (id: StepId) => {
    setStep(id)
    requestAnimationFrame(() => bodyRef.current?.focus({ preventScroll: true }))
  }
  const idx = STEPS.findIndex((s) => s.id === step)

  const summary = useStepSummaries(fault, draft, preflightOk, failing.length)

  return (
    <section
      aria-label={`Experiment: ${fault.label}`}
      className={cn(
        'grid min-w-0 lg:grid-cols-[200px_minmax(0,1fr)_300px]',
        variant === 'inline'
          ? 'border-t border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/30'
          : 'overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      )}
    >
      {/* Step rail: a column on wide screens, a scrolling row on narrow ones. */}
      <nav
        aria-label='Steps'
        className='min-w-0 border-b border-slate-200 lg:border-b-0 lg:border-r dark:border-border'
      >
        <ol className='flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-2 lg:py-3 [&::-webkit-scrollbar]:hidden'>
          {STEPS.map((s, i) => {
            const on = s.id === step
            const issue = issues[s.id]
            const done = i < idx && !issue
            return (
              <li key={s.id} className='shrink-0'>
                <button
                  type='button'
                  aria-current={on ? 'step' : undefined}
                  onClick={() => go(s.id)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                    on
                      ? 'bg-white text-slate-900 ring-1 ring-slate-200 dark:bg-card dark:text-foreground dark:ring-border'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold tabular-nums',
                      issue
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                        : done
                          ? 'bg-nvr-cyan/15 text-slate-800 dark:text-nvr-cyan'
                          : on
                            ? 'bg-nvr-cyan text-white'
                            : 'bg-slate-200 text-slate-600 dark:bg-muted dark:text-muted-foreground'
                    )}
                  >
                    {done ? <Check className='h-3 w-3' /> : i + 1}
                  </span>
                  <span className='min-w-0'>
                    <span className='block whitespace-nowrap text-[12.5px] font-medium'>
                      {s.label}
                    </span>
                    <span className='hidden max-w-[150px] truncate text-[11.5px] text-slate-500 lg:block dark:text-muted-foreground'>
                      {issue ? (
                        <span className='text-amber-700 dark:text-amber-400'>Needs a value</span>
                      ) : (
                        summary[s.id]
                      )}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      {/* The current step. */}
      <div className='flex min-w-0 flex-col'>
        <div
          ref={bodyRef}
          tabIndex={-1}
          className='flex-1 px-4 py-4 outline-none sm:px-5 animate-in fade-in duration-150 motion-reduce:animate-none'
          key={step}
        >
          {step === 'fault' && (
            <FaultStep fault={fault} faults={faults} caps={caps} onPick={pickFault} />
          )}
          {step === 'target' && (
            <TargetStep fault={fault} draft={draft} set={set} caps={caps} nodes={nodes} />
          )}
          {step === 'strength' && (
            <StrengthStep fault={fault} draft={draft} set={set} caps={caps} />
          )}
          {step === 'duration' && (
            <DurationStep fault={fault} draft={draft} set={set} caps={caps} />
          )}
          {step === 'hypothesis' && (
            <HypothesisStep fault={fault} draft={draft} set={set} caps={caps} />
          )}
          {step === 'abort' && <AbortStep fault={fault} draft={draft} set={set} caps={caps} />}
          {step === 'blast' && <BlastStep fault={fault} draft={draft} />}
          {step === 'preflight' && <PreflightStep serverChecks={serverChecks} />}
          {issues[step] && (
            <p className='mt-4 flex items-center gap-1.5 text-[12.5px] text-amber-800 dark:text-amber-300'>
              <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden />
              {issues[step]}
            </p>
          )}
        </div>
        <div className='flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5 sm:px-5 dark:border-border'>
          <button
            type='button'
            disabled={idx === 0}
            onClick={() => go(STEPS[idx - 1].id)}
            className='inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12.5px] font-medium text-slate-600 hover:bg-slate-100 disabled:invisible dark:text-muted-foreground dark:hover:bg-muted'
          >
            <ChevronLeft className='h-3.5 w-3.5' aria-hidden />
            {idx > 0 ? STEPS[idx - 1].label : 'Back'}
          </button>
          {idx < STEPS.length - 1 && (
            <button
              type='button'
              onClick={() => go(STEPS[idx + 1].id)}
              className='inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-800 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
            >
              {STEPS[idx + 1].label}
              <ChevronRight className='h-3.5 w-3.5' aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* The run in words, the note, Save as preset and Run. */}
      <aside
        aria-label='This run'
        className='min-w-0 border-t border-slate-200 px-4 py-4 lg:border-l lg:border-t-0 dark:border-border'
      >
        <div className='mb-2 flex items-center justify-between gap-2'>
          <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            This run
          </h3>
          {preset && (
            <span
              className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'
              data-tip={preset.key}
            >
              from {preset.label}
            </span>
          )}
        </div>
        <dl className='space-y-1.5 text-[12.5px]'>
          {STEPS.filter((s) => s.id !== 'fault').map((s) => (
            <div key={s.id} className='grid grid-cols-[92px_minmax(0,1fr)] gap-2'>
              <dt className='text-slate-500 dark:text-muted-foreground'>{s.label}</dt>
              <dd className='min-w-0'>
                <button
                  type='button'
                  onClick={() => go(s.id)}
                  className={cn(
                    'max-w-full text-left text-slate-800 [overflow-wrap:anywhere] hover:underline dark:text-foreground/90',
                    issues[s.id] && 'text-amber-800 dark:text-amber-300'
                  )}
                >
                  {issues[s.id] ? 'Needs a value' : summary[s.id]}
                </button>
              </dd>
            </div>
          ))}
        </dl>

        <label className='mt-4 block space-y-1'>
          <span className={labelCls}>Note</span>
          <input
            className={cn(inputCls, 'w-full')}
            value={draft.note}
            maxLength={500}
            placeholder='Why this drill, what to watch'
            onChange={(e) => {
              const note = e.target.value
              setDraft((d) => ({ ...d, note }))
            }}
          />
        </label>

        {overridable && (
          <label className='mt-3 flex items-start gap-2 text-[12px] text-slate-700 dark:text-foreground/90'>
            <input
              type='checkbox'
              className='mt-0.5 h-3.5 w-3.5 accent-nvr-cyan'
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            Run outside working hours (recorded on the run)
          </label>
        )}

        <div className='mt-4 space-y-2'>
          {confirming ? (
            <div className='space-y-2'>
              <button
                type='button'
                // biome-ignore lint/a11y/noAutofocus: the control appears on an explicit click
                autoFocus
                disabled={run.isPending}
                onClick={() => run.mutate()}
                className='inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:focus-visible:ring-offset-background'
              >
                <Zap className='h-3.5 w-3.5 shrink-0' aria-hidden />
                <span className='text-left'>
                  Confirm — arms {fault.label} on {targetWords(draft.target)} for {draft.seconds}s
                </span>
              </button>
              <button
                type='button'
                onClick={() => setConfirming(false)}
                className='inline-flex h-8 w-full items-center justify-center gap-1 rounded-md text-[12.5px] font-medium text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
              >
                <X className='h-3.5 w-3.5' aria-hidden /> Not yet
              </button>
            </div>
          ) : (
            <div className='flex flex-wrap items-center gap-2'>
              <button
                type='button'
                disabled={!canRun}
                onClick={startConfirm}
                className='inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-background'
              >
                <Play className='h-3.5 w-3.5' aria-hidden />
                Run
              </button>
              <SavePresetPopover
                fault={fault}
                draft={draft}
                preset={preset}
                disabled={blocking.length > 0}
              />
            </div>
          )}
          {why && !confirming && (
            <p role='status' className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {why}
            </p>
          )}
          {onClose && (
            <button
              type='button'
              onClick={onClose}
              className='text-[12px] text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-muted-foreground dark:hover:text-foreground'
            >
              Close the builder
            </button>
          )}
        </div>
      </aside>
    </section>
  )
}

/** One short line per step for the rail and the summary. */
function useStepSummaries(
  fault: CatalogFault,
  d: DraftSpec,
  preflightOk: boolean | null,
  failing: number
): Record<StepId, string> {
  const samplers = useSamplerChoices()
  return useMemo(() => {
    const label = (k: string) => samplers.find((s) => s.key === k)?.label ?? k
    const node = mapNodeFor(fault, d.params)
    return {
      fault: fault.label,
      target: targetWords(d.target),
      strength: paramWords(fault, d.params) || 'fully on',
      duration: formatSeconds(d.seconds),
      hypothesis: d.hypothesis.length
        ? d.hypothesis.map((r) => `${label(r.sampler)} ${r.op} ${r.limit}`).join('; ')
        : 'none — records only',
      abort: d.hypothesis.length
        ? `${d.hypothesis.length} line${d.hypothesis.length === 1 ? '' : 's'}, 3 breaches in a row`
        : 'only at the end',
      blast: node ? `estimate for ${node}` : 'no estimate',
      preflight:
        preflightOk === null
          ? 'checking…'
          : preflightOk
            ? 'clear'
            : `${failing} check${failing === 1 ? '' : 's'} failing`
    }
  }, [fault, d, samplers, preflightOk, failing])
}
