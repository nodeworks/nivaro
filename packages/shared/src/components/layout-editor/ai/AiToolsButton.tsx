import { useQuery } from '@tanstack/react-query'
import { FileCheck2, Loader2, ScanEye, Sparkles, UserRound, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import type { DesignTarget } from '../design-context'
import { useLayoutEditorHost } from '../host'
import { withOverride } from '../inspector/model'
import { useOverviewFields, useRoleNames } from '../overview/overview-api'
import { ToolButton, useBarMenu } from '../toolbar-kit'
import { parseSaveFailure } from '../useLayoutDraft'
import {
  type AiPin,
  type AutofillCorrections,
  type CritiqueResult,
  critiquePins,
  FORM_TARGET,
  type PersonaFinding,
  type PersonaResult,
  personaPins,
  sectionTarget,
  targetFromRef
} from './ai-tools-api'
import {
  type AutofillPlan,
  checkSectionPlan,
  hasAutofillCheck,
  highlightPlan,
  placedFields,
  planApplies
} from './autofill-ops'
import { canvasRoot, captureCanvas, measureSections } from './canvas-capture'

/**
 * Three read-only AI reviews of the layout (admins), each a row of the top
 * bar's AI menu: Test as a role, Review the look, Tune from autofill.
 *
 * - Persona test (#2685): the model plays a role filling a new record and
 *   reports confusing steps, labels and fields.
 * - Visual critique (#2690): the canvas (picture + section boxes) reviewed
 *   for density, hierarchy and alignment.
 * - After autofill (#2691): fields people often correct after "Fill from
 *   document", with a highlight or a "Check these" section to apply.
 *
 * Findings pin to the canvas as marks; a click selects the node. Every fix is
 * a draft apply — one undo step, saved with the form.
 */

type Tab = 'persona' | 'critique' | 'autofill'

const quiet = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'
const primaryBtn =
  'inline-flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'
const ghostBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
const ROWS: Array<{ tab: Tab; label: string; hint: string; icon: ReactNode }> = [
  {
    tab: 'persona',
    label: 'Test as a role',
    hint: 'AI fills a new record as a role and says what confused it',
    icon: <UserRound className='h-3.5 w-3.5' />
  },
  {
    tab: 'critique',
    label: 'Review the look',
    hint: 'Density, hierarchy and alignment of the canvas',
    icon: <ScanEye className='h-3.5 w-3.5' />
  },
  {
    tab: 'autofill',
    label: 'Tune from autofill',
    hint: 'Fields people often correct after Fill from document',
    icon: <FileCheck2 className='h-3.5 w-3.5' />
  }
]

const CHIP: Record<string, string> = {
  blocking: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  high: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  confusing: 'bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200',
  medium: 'bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200',
  minor: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
  low: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
}

const FEELING_DOT: Record<string, string> = {
  clear: 'bg-emerald-500',
  unsure: 'bg-amber-400',
  stuck: 'bg-red-500'
}

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10.5px] font-medium',
        CHIP[tone] ?? CHIP.minor
      )}
    >
      {children}
    </span>
  )
}

function failureText(err: unknown, fallback: string): string {
  const f = parseSaveFailure(err, fallback)
  return f.status === 503
    ? 'AI is not set up here — set it up under Settings → AI Features.'
    : f.message
}

export function AiToolsButton({
  collection,
  layoutId,
  bundle,
  apply,
  previewRecordShown,
  onPins,
  onSelect
}: {
  collection: string
  layoutId: number
  bundle: LayoutBundle | null
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  /** A preview record is on the canvas: the critique sends no picture. */
  previewRecordShown: boolean
  onPins: (pins: AiPin[]) => void
  onSelect: (t: DesignTarget) => void
}) {
  const host = useLayoutEditorHost()
  const menu = useBarMenu()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('persona')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const { data: fields = [] } = useOverviewFields(collection)
  const labelOf = useMemo(() => {
    const m = new Map(fields.map((f) => [f.field, f.label?.trim() || titleCase(f.field)]))
    return (f: string) => m.get(f) ?? titleCase(f)
  }, [fields])

  // A different layout's pins mean nothing here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutId is the trigger
  useEffect(() => {
    onPins([])
  }, [layoutId, onPins])

  if (!host.isAdmin) return null
  const tabBtn = (t: Tab, label: string) => (
    <button
      type='button'
      role='tab'
      aria-selected={tab === t}
      data-ai-tools-tab={t}
      onClick={() => setTab(t)}
      className={cn(
        'inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium transition-colors',
        tab === t
          ? 'bg-accent text-slate-900 dark:text-foreground'
          : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
  const select = (t: DesignTarget | null) => {
    if (t) onSelect(t)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {menu ? (
        ROWS.map((r) => (
          <ToolButton
            key={r.tab}
            popover
            onOpen={() => {
              setTab(r.tab)
              setOpen(true)
            }}
            label={r.label}
            icon={r.icon}
            hint={r.hint}
            disabled={!bundle}
            data={{ 'data-ai-tools-row': r.tab }}
          />
        ))
      ) : (
        <ToolButton
          popover
          buttonRef={(el) => {
            triggerRef.current = el
          }}
          label='AI'
          ariaLabel='AI tools'
          icon={<Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />}
          tip='Test the form as a role, review its look, tune it from autofill'
          disabled={!bundle}
          data={{ 'data-ai-tools-trigger': '' }}
        />
      )}
      <PopoverContent align='end' className='w-[460px] overflow-hidden p-0' data-ai-tools=''>
        <div
          role='tablist'
          aria-label='AI tools'
          className='flex items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-border'
        >
          {tabBtn('persona', 'Test as a role')}
          {tabBtn('critique', 'Review the look')}
          {tabBtn('autofill', 'Tune from autofill')}
        </div>
        <div className='max-h-[min(65vh,520px)] overflow-y-auto overscroll-contain px-3 py-3'>
          {bundle && tab === 'persona' && (
            <PersonaTab
              layoutId={layoutId}
              bundle={bundle}
              apply={apply}
              labelOf={labelOf}
              onPins={onPins}
              select={select}
            />
          )}
          {bundle && tab === 'critique' && (
            <CritiqueTab
              layoutId={layoutId}
              bundle={bundle}
              previewRecordShown={previewRecordShown}
              editor={() =>
                (triggerRef.current ?? menu?.anchor.current)?.closest('[data-layout-editor]') ??
                null
              }
              onPins={onPins}
              select={select}
            />
          )}
          {bundle && tab === 'autofill' && (
            <AutofillTab layoutId={layoutId} bundle={bundle} apply={apply} labelOf={labelOf} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Persona test (#2685) ─────────────────────────────────────────────────────

function PersonaTab({
  layoutId,
  bundle,
  apply,
  labelOf,
  onPins,
  select
}: {
  layoutId: number
  bundle: LayoutBundle
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  labelOf: (f: string) => string
  onPins: (pins: AiPin[]) => void
  select: (t: DesignTarget | null) => void
}) {
  const client = useNivaroClient()
  const { data: roles = [] } = useRoleNames(true)
  const [roleId, setRoleId] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PersonaResult | null>(null)
  const [renamed, setRenamed] = useState<Set<string>>(new Set())

  const run = async () => {
    if (!roleId) return
    setBusy(true)
    setError(null)
    try {
      const res = await client.request<{ data: PersonaResult }>(
        post(`/ai-design/layouts/${layoutId}/persona-test`, {
          role_id: roleId,
          goal: goal.trim() || undefined
        })
      )
      setResult(res.data)
      setRenamed(new Set())
      onPins(personaPins(res.data, bundle))
    } catch (err) {
      setError(failureText(err, 'The persona test could not run'))
    } finally {
      setBusy(false)
    }
  }

  const rename = (f: PersonaFinding) => {
    const t = targetFromRef(f.target, bundle)
    if (t?.kind !== 'field' || !f.better_label) return
    const p = bundle.placements.find((x) => x.field === t.field && x.group_key === t.group_key)
    if (!p) return
    apply(
      [
        {
          op: 'update_placement',
          at: { field: p.field, group_key: p.group_key },
          patch: { overrides: withOverride(p, 'label', f.better_label) }
        }
      ],
      { label: `Rename ${labelOf(p.field)} to ${f.better_label}` }
    )
    setRenamed((s) => new Set(s).add(f.id))
  }

  const stepLabel = (key: string | null) =>
    result?.walkthrough.find((w) => w.key === key)?.label ?? null

  return (
    <div className='space-y-3' data-persona-test=''>
      <p className={quiet}>
        The AI plays someone in a role filling in a new record, step by step, and tells you where
        they would hesitate. Only the form's labels, help and structure are sent. Nothing is saved.
      </p>
      <div className='flex items-center gap-2'>
        <SimpleSelect
          value={roleId}
          onChange={setRoleId}
          ariaLabel='Role to play'
          className='h-8 flex-1 text-[12.5px]'
          options={[
            { value: '', label: 'Pick a role…' },
            ...roles.map((r) => ({ value: r.id, label: r.name }))
          ]}
        />
        <button
          type='button'
          className={primaryBtn}
          disabled={!roleId || busy}
          onClick={run}
          data-persona-run=''
        >
          {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : null}
          {busy ? 'Testing…' : result ? 'Test again' : 'Test'}
        </button>
      </div>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder='What they are trying to do (optional)'
        aria-label='Goal'
        className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
      />
      {error && <p className='text-[12.5px] text-red-700 dark:text-red-300'>{error}</p>}
      {result && (
        <div className='space-y-3'>
          {!result.ai_configured && (
            <p className='rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
              AI is not set up, so only the built-in checks ran.
            </p>
          )}
          {result.summary && (
            <p className='text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
              <span className='font-medium'>As {result.role}: </span>
              {result.summary}
            </p>
          )}
          <ol className='space-y-1' aria-label='Walkthrough'>
            {result.walkthrough.map((w, i) => {
              const note = result.steps.find((s) => s.step === w.key)
              return (
                <li key={w.key}>
                  <button
                    type='button'
                    onClick={() => select(targetFromRef(`group:${w.key}`, bundle))}
                    className='flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted'
                  >
                    <span className='mt-0.5 w-4 shrink-0 text-right font-mono text-[11px] text-slate-400'>
                      {i + 1}
                    </span>
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        note ? FEELING_DOT[note.feeling] : 'bg-slate-300 dark:bg-slate-600'
                      )}
                    />
                    <span className='min-w-0 flex-1'>
                      <span className='block text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                        {w.label}
                        <span className='ml-1.5 font-normal text-slate-500 dark:text-muted-foreground'>
                          {w.fields} {w.fields === 1 ? 'field' : 'fields'}
                          {w.required > 0 ? `, ${w.required} required` : ''}
                        </span>
                      </span>
                      {note && <span className={cn(quiet, 'block')}>{note.note}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          {result.findings.length === 0 ? (
            <p className={quiet}>Nothing would confuse {result.role} here.</p>
          ) : (
            <ul className='space-y-1.5' aria-label='What would confuse them'>
              {result.findings.map((f) => {
                const t = f.target === 'form' ? null : targetFromRef(f.target, bundle)
                const where = stepLabel(f.step)
                return (
                  <li
                    key={f.id}
                    data-persona-finding={f.target}
                    className='rounded-md border border-slate-200 px-2.5 py-2 dark:border-border'
                  >
                    <div className='flex items-start gap-2'>
                      <Chip tone={f.severity}>
                        {f.severity === 'blocking'
                          ? 'Blocks'
                          : f.severity === 'confusing'
                            ? 'Confusing'
                            : 'Minor'}
                      </Chip>
                      <button
                        type='button'
                        disabled={!t}
                        onClick={() => select(t)}
                        className='min-w-0 flex-1 text-left text-[12.5px] leading-snug text-slate-800 disabled:cursor-default dark:text-foreground'
                      >
                        {f.problem}
                        {where && (
                          <span className='ml-1 text-slate-500 dark:text-muted-foreground'>
                            · {where}
                          </span>
                        )}
                      </button>
                    </div>
                    {f.suggestion && <p className={cn(quiet, 'mt-1 pl-1')}>{f.suggestion}</p>}
                    {f.better_label && t?.kind === 'field' && (
                      <div className='mt-1.5 flex justify-end'>
                        <button
                          type='button'
                          className={ghostBtn}
                          disabled={renamed.has(f.id)}
                          onClick={() => rename(f)}
                          data-persona-rename=''
                        >
                          {renamed.has(f.id) ? 'Renamed' : `Rename to “${f.better_label}”`}
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {result.dropped.length > 0 && (
            <p className={quiet}>
              Left out {result.dropped.length} note{result.dropped.length === 1 ? '' : 's'} about
              names this form does not have: {result.dropped.join(', ')}.
            </p>
          )}
          <ClearPins onPins={onPins} />
        </div>
      )}
    </div>
  )
}

function ClearPins({ onPins }: { onPins: (pins: AiPin[]) => void }) {
  return (
    <div className='flex justify-end'>
      <button type='button' className={ghostBtn} onClick={() => onPins([])} data-ai-clear-pins=''>
        <X className='h-3.5 w-3.5' />
        Clear marks on the canvas
      </button>
    </div>
  )
}

// ── Visual critique (#2690) ──────────────────────────────────────────────────

function CritiqueTab({
  layoutId,
  bundle,
  previewRecordShown,
  editor,
  onPins,
  select
}: {
  layoutId: number
  bundle: LayoutBundle
  previewRecordShown: boolean
  editor: () => Element | null
  onPins: (pins: AiPin[]) => void
  select: (t: DesignTarget | null) => void
}) {
  const client = useNivaroClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CritiqueResult | null>(null)

  const run = async () => {
    const root = canvasRoot(editor())
    if (!root) {
      setError('Show the canvas (not the table view) first')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { canvas, sections } = measureSections(root)
      // Never a picture of a preview record's values.
      const image = previewRecordShown ? null : await captureCanvas(root)
      const res = await client.request<{ data: CritiqueResult }>(
        post(`/ai-design/layouts/${layoutId}/visual-critique`, {
          canvas,
          sections,
          image: image ?? undefined
        })
      )
      setResult(res.data)
      onPins(critiquePins(res.data, bundle))
    } catch (err) {
      setError(failureText(err, 'The review could not run'))
    } finally {
      setBusy(false)
    }
  }

  const sectionLabel = (key: string) =>
    key === FORM_TARGET
      ? 'Whole form'
      : (bundle.groups.find((g) => g.key === key)?.label ?? titleCase(key))

  return (
    <div className='space-y-3' data-visual-critique=''>
      <p className={quiet}>
        Reviews how the form looks — density, order of sections, alignment — and pins each comment
        to its section.{' '}
        {previewRecordShown
          ? 'A preview record is shown, so only the form’s structure and sizes are sent, no picture.'
          : 'A picture of the canvas is sent with typed values hidden, when the AI can read pictures.'}
      </p>
      <div className='flex justify-end'>
        <button
          type='button'
          className={primaryBtn}
          disabled={busy}
          onClick={run}
          data-critique-run=''
        >
          {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : null}
          {busy ? 'Reviewing…' : result ? 'Review again' : 'Review the look'}
        </button>
      </div>
      {error && <p className='text-[12.5px] text-red-700 dark:text-red-300'>{error}</p>}
      {result && (
        <div className='space-y-3'>
          {!result.ai_configured && (
            <p className='rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
              AI is not set up, so only the built-in checks ran.
            </p>
          )}
          {result.ai_configured && (
            <p className={quiet}>
              {result.used_image
                ? 'The AI saw a picture of the canvas.'
                : result.image_skipped === 'provider'
                  ? 'This AI provider does not read pictures; it judged the structure and sizes.'
                  : 'The AI judged the structure and sizes (no picture).'}
            </p>
          )}
          {result.summary && (
            <p className='text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
              {result.summary}
            </p>
          )}
          {result.comments.length === 0 ? (
            <p className={quiet}>No comments — the form reads well.</p>
          ) : (
            <ul className='space-y-1.5' aria-label='Comments'>
              {result.comments.map((c) => {
                const t = sectionTarget(c.section, bundle)
                return (
                  <li
                    key={c.id}
                    data-critique-comment={c.section}
                    className='rounded-md border border-slate-200 px-2.5 py-2 dark:border-border'
                  >
                    <button
                      type='button'
                      disabled={!t}
                      onClick={() => select(t)}
                      className='flex w-full items-start gap-2 text-left disabled:cursor-default'
                    >
                      <Chip tone={c.severity}>{titleCase(c.topic)}</Chip>
                      <span className='min-w-0 flex-1 text-[12.5px] leading-snug text-slate-800 dark:text-foreground'>
                        <span className='font-medium'>{sectionLabel(c.section)}: </span>
                        {c.comment}
                      </span>
                    </button>
                    {c.suggestion && <p className={cn(quiet, 'mt-1 pl-1')}>{c.suggestion}</p>}
                  </li>
                )
              })}
            </ul>
          )}
          {result.dropped.length > 0 && (
            <p className={quiet}>
              Left out comments about sections this form does not have: {result.dropped.join(', ')}.
            </p>
          )}
          <ClearPins onPins={onPins} />
        </div>
      )}
    </div>
  )
}

// ── After autofill (#2691) ───────────────────────────────────────────────────

function AutofillTab({
  layoutId,
  bundle,
  apply,
  labelOf
}: {
  layoutId: number
  bundle: LayoutBundle
  apply: (ops: LayoutOp[], opts?: { label: string }) => void
  labelOf: (f: string) => string
}) {
  const client = useNivaroClient()
  const { data, isLoading, error } = useQuery<AutofillCorrections>({
    queryKey: ['layout-editor', 'autofill-corrections', layoutId],
    queryFn: () =>
      client
        .request<{ data: AutofillCorrections }>(
          get(`/ai-design/layouts/${layoutId}/autofill-corrections`)
        )
        .then((r) => r.data),
    staleTime: 5 * 60_000
  })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [plan, setPlan] = useState<AutofillPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const rows = data?.fields ?? []
  const onForm = useMemo(
    () =>
      new Set(
        placedFields(
          bundle,
          rows.map((r) => r.field)
        )
      ),
    [bundle, rows]
  )
  // Suggested fields on this form start ticked.
  const chosen =
    picked ?? new Set(rows.filter((r) => r.suggest && onForm.has(r.field)).map((r) => r.field))
  const toggle = (f: string) => {
    const next = new Set(chosen)
    if (next.has(f)) next.delete(f)
    else next.add(f)
    setPicked(next)
    setPlan(null)
  }
  const propose = (make: () => AutofillPlan | null) => {
    const p = make()
    if (!p) {
      setPlan(null)
      setPlanError('Nothing to change for the ticked fields.')
      return
    }
    const why = planApplies(bundle, p)
    setPlanError(why)
    setPlan(why ? null : p)
  }
  const doApply = () => {
    if (!plan) return
    const why = planApplies(bundle, plan)
    if (why) {
      setPlanError(why)
      setPlan(null)
      return
    }
    apply(plan.ops, { label: plan.label })
    setPlan(null)
  }

  if (isLoading) return <p className={quiet}>Reading autofill history…</p>
  if (error)
    return (
      <p className='text-[12.5px] text-red-700 dark:text-red-300'>
        {failureText(error, 'Autofill history could not be read')}
      </p>
    )
  if (!data || data.documents === 0 || rows.length === 0)
    return (
      <p className={quiet}>
        No records were created from a document on this collection in the last {data?.days ?? 90}{' '}
        days, so there is nothing to tune yet.
      </p>
    )
  const list = [...chosen]
  return (
    <div className='space-y-3' data-autofill-tuning=''>
      <p className={quiet}>
        From {data.documents} {data.documents === 1 ? 'record' : 'records'} filled from a document
        in the last {data.days} days: how often people changed what the AI proposed. Ticked fields
        changed at least {Math.round(data.corrected_share * 100)}% of the time.
      </p>
      <ul className='space-y-0.5' aria-label='Fields people correct'>
        {rows.slice(0, 30).map((r) => {
          const here = onForm.has(r.field)
          return (
            <li key={r.field}>
              <label
                className={cn(
                  'flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px]',
                  here ? 'cursor-pointer hover:bg-muted' : 'opacity-60'
                )}
                data-tip={here ? undefined : 'Not on this form'}
              >
                <input
                  type='checkbox'
                  disabled={!here}
                  checked={here && chosen.has(r.field)}
                  onChange={() => toggle(r.field)}
                  className='h-3.5 w-3.5 accent-[#00ceff]'
                />
                <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
                  {labelOf(r.field)}
                  {hasAutofillCheck(bundle, r.field) && (
                    <span className='ml-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                      highlighted
                    </span>
                  )}
                </span>
                <span className='shrink-0 font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  changed {r.corrected} of {r.proposed}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className='flex flex-wrap items-center justify-end gap-1.5'>
        <button
          type='button'
          className={ghostBtn}
          disabled={list.length === 0}
          onClick={() => propose(() => highlightPlan(bundle, list, labelOf, false))}
        >
          Remove highlight
        </button>
        <button
          type='button'
          className={ghostBtn}
          disabled={list.length === 0}
          onClick={() => propose(() => checkSectionPlan(bundle, list, labelOf))}
          data-autofill-section=''
        >
          Add “Check these” section
        </button>
        <button
          type='button'
          className={ghostBtn}
          disabled={list.length === 0}
          onClick={() => propose(() => highlightPlan(bundle, list, labelOf))}
          data-autofill-highlight=''
        >
          Highlight after autofill
        </button>
      </div>
      {planError && <p className='text-[12.5px] text-red-700 dark:text-red-300'>{planError}</p>}
      {plan && (
        <div
          className='space-y-2 rounded-md border border-slate-200 px-2.5 py-2 dark:border-border'
          data-autofill-plan=''
        >
          <p className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>This will</p>
          <ol className='list-decimal space-y-0.5 pl-5 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
            {plan.steps.map((s, i) => (
              <li key={`${i}:${s}`}>{s}</li>
            ))}
          </ol>
          <div className='flex justify-end gap-1.5'>
            <button type='button' className={ghostBtn} onClick={() => setPlan(null)}>
              Cancel
            </button>
            <button type='button' className={primaryBtn} onClick={doApply} data-autofill-apply=''>
              {plan.steps.length > 1 ? `Apply ${plan.steps.length} changes` : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
