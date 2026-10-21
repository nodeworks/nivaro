import {
  AlertTriangle,
  Check,
  CircleDashed,
  EyeOff,
  FlaskConical,
  Loader2,
  Pin,
  RefreshCw,
  Target,
  X
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { useDebounced } from '../../../hooks/useDebounced'
import { useRelationOptions } from '../../../hooks/useRelationOptions'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import type { ActiveLayoutData } from '../../item-edit/types'
import { Popover, PopoverContent } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { bundleToActiveLayout } from '../bundle-to-active'
import type { DescribeField } from '../overview/describe-conditions'
import { btnOutline, btnPrimary } from '../overview/OverviewActions'
import { useDisplayTemplate, useRoleNames } from '../overview/overview-api'
import { segOption, segTrack } from '../panel-style'
import { fieldName } from '../preview/PreviewModes'
import { drivingFields } from '../preview/preview-model'
import { useSettingsRelations } from '../settings/settings-api'
import { ToolButton } from '../toolbar-kit'
import type { ApplyOptions } from '../useLayoutDraft'
import { draftResolution, useFormRows, usePinnedLabels, useWalkAccess } from './testing-api'
import {
  DEFAULT_COST_LIMIT,
  type FormCost,
  formCost,
  MAX_PINNED,
  type PinnedRecord,
  readTesting,
  samePin,
  testingPatch,
  type WalkField,
  walkthrough
} from './testing-model'
import { type PinCheck, useRecordCheck } from './use-record-check'

// The editor's Test popover (test records #2646, new-record walkthrough #2648,
// form cost #2649) and the Save menu's What changes (#2647). Everything here
// reads; pins and the cost limit are layout settings (one undoable step each).

export interface TestingProps {
  collection: string
  layoutId: number
  /** The draft (unsaved changes included). */
  bundle: LayoutBundle
  parent: LayoutBundle | null
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  /** Unsaved changes exist (manual mode). */
  dirty: boolean
  fields: DescribeField[]
}

const labelCls = 'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'
const hintCls = 'text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'
const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const ADMIN = ''
/** Looks like a record id (a number or a uuid): offered as-is in the pin search. */
const ID_RE = /^(\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function useLabel(fields: DescribeField[]) {
  return useCallback((f: string) => fieldName(fields, f), [fields])
}

// ─── Test records (#2646) ───────────────────────────────────────────────────

function AddPin({
  collection,
  pins,
  onPin
}: {
  collection: string
  pins: PinnedRecord[]
  onPin: (pin: PinnedRecord) => void
}) {
  const client = useNivaroClient()
  const [search, setSearch] = useState('')
  const debounced = useDebounced(search, 250)
  const [record, setRecord] = useState<{ id: string; label: string } | null>(null)
  const [roleId, setRoleId] = useState(ADMIN)
  const { data: template } = useDisplayTemplate(collection, true)
  const { data: roles = [] } = useRoleNames(true)
  const { options, loading } = useRelationOptions(client, collection, {
    search: debounced,
    limit: 6,
    displayTemplate: template ?? null,
    enabled: !record && template !== undefined
  })
  const pin = record ? { item: record.id, role_id: roleId || null } : null
  const dup = !!pin && pins.some((p) => samePin(p, pin))
  return (
    <div
      data-test-records-add=''
      className='mt-3 border-t border-slate-100 pt-3 dark:border-border'
    >
      <p className={labelCls}>Pin a record</p>
      {record ? (
        <span className='inline-flex max-w-full items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-slate-800 dark:text-foreground'>
          <span className='truncate'>{record.label}</span>
          <button
            type='button'
            aria-label='Pick another record'
            onClick={() => {
              setRecord(null)
              setSearch('')
            }}
            className='text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ) : (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search records…'
            aria-label='Search records to pin'
            className={inputCls}
          />
          <div className='mt-1 max-h-[160px] overflow-y-auto overscroll-contain'>
            {/* A typed id pins directly: the label search rarely matches an id. */}
            {ID_RE.test(search.trim()) && !options.some((o) => String(o.id) === search.trim()) && (
              <button
                type='button'
                data-pin-by-id=''
                onClick={() => setRecord({ id: search.trim(), label: `#${search.trim()}` })}
                className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
              >
                Record <span className='font-mono'>#{search.trim()}</span>
              </button>
            )}
            {options.map((o) => (
              <button
                key={String(o.id)}
                type='button'
                data-option-id={String(o.id)}
                onClick={() => setRecord({ id: String(o.id), label: o.label })}
                className='block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
              >
                {o.label}
              </button>
            ))}
            {!loading && options.length === 0 && !ID_RE.test(search.trim()) && (
              <p className={cn(hintCls, 'px-2 py-1.5')}>No records match.</p>
            )}
          </div>
        </>
      )}
      <div className='mt-2 flex items-center gap-1.5'>
        <div className='min-w-0 flex-1'>
          <SimpleSelect
            value={roleId}
            onChange={setRoleId}
            ariaLabel='Test as role'
            className='h-8 text-[12.5px]'
            options={[
              { value: ADMIN, label: 'As an administrator' },
              ...roles.map((r) => ({ value: r.id, label: `As ${r.name}` }))
            ]}
          />
        </div>
        <button
          type='button'
          className={btnPrimary}
          disabled={!pin || dup || pins.length >= MAX_PINNED}
          data-tip={dup ? 'Already pinned as this role' : undefined}
          onClick={() => {
            if (!pin) return
            onPin(pin)
            setRecord(null)
            setSearch('')
          }}
        >
          <Pin className='h-3.5 w-3.5' />
          Pin
        </button>
      </div>
    </div>
  )
}

const changeTone = (kind: string) =>
  kind === 'gained' || kind === 'editable'
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-amber-700 dark:text-amber-300'

function seenLine(c: PinCheck, layoutId: number): string {
  const r = c.result
  if (r.role_missing) return 'Its role no longer exists'
  if (!r.found) return 'Record not found'
  const form = c.after.form
  if (!form) return 'Opens on no form'
  if (form.layout_id !== layoutId) return `Opens on “${form.name}”, not this form`
  const view = c.after.view ?? new Map()
  const ro = [...view.values()].filter((v) => v === 'readonly').length
  return `This form · sees ${view.size} ${view.size === 1 ? 'field' : 'fields'}${ro ? ` (${ro} read-only)` : ''}`
}

function TestRecordsTab(props: TestingProps & { open: boolean }) {
  const { collection, layoutId, bundle, parent, apply, dirty, fields, open } = props
  const cfg = readTesting(bundle.layout.conditions)
  const pins = cfg.records
  const labels = usePinnedLabels(collection, pins, open)
  const { data: roles = [] } = useRoleNames(true)
  const label = useLabel(fields)
  const { run, running, error, check } = useRecordCheck({
    layoutId,
    bundle,
    parent,
    pins,
    dirty,
    label
  })
  const save = (records: PinnedRecord[], step: string) =>
    apply(
      [
        {
          op: 'layout_update',
          patch: testingPatch(bundle.layout.conditions, { ...cfg, records })
        }
      ],
      { label: step }
    )
  const roleName = (id: string | null) =>
    id
      ? (roles.find((r) => r.id.toUpperCase() === id.toUpperCase())?.name ?? 'a removed role')
      : null
  const resultFor = (p: PinnedRecord) => run?.checks.find((c) => samePin(c.pin, p)) ?? null
  const against =
    run?.against === 'saved'
      ? 'Compared with the last save.'
      : run?.against === 'previous'
        ? 'Compared with your previous check.'
        : run
          ? 'First check: the next one shows what changed.'
          : null

  return (
    <div data-test-records=''>
      <p className={hintCls}>
        Pin up to {MAX_PINNED} records that cover this form’s important cases. After an edit,
        Re-check shows which form each one gets and what it can see.
      </p>
      {pins.length === 0 ? (
        <p className={cn(hintCls, 'mt-3')}>No test records yet.</p>
      ) : (
        <ul className='mt-2 flex flex-col gap-1.5'>
          {pins.map((p) => {
            const c = resultFor(p)
            const name = labels.get(p.item) ?? `#${p.item}`
            const as = roleName(p.role_id)
            return (
              <li
                key={`${p.item}\u0000${p.role_id ?? ''}`}
                data-test-record={p.item}
                className='rounded-md border border-slate-200 px-2.5 py-2 dark:border-border'
              >
                <div className='flex items-center gap-2'>
                  <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {name}
                  </span>
                  <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {as ? `as ${as}` : 'as admin'}
                  </span>
                  <button
                    type='button'
                    aria-label={`Unpin ${name}`}
                    onClick={() =>
                      save(
                        pins.filter((x) => !samePin(x, p)),
                        'Unpin a test record'
                      )
                    }
                    className='shrink-0 text-slate-400 hover:text-slate-700 dark:text-muted-foreground dark:hover:text-foreground'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
                {c && (
                  <div className='mt-1'>
                    <p className={hintCls}>{seenLine(c, layoutId)}</p>
                    {c.changes.length > 0 ? (
                      <ul className='mt-0.5'>
                        {c.changes.map((ch) => (
                          <li
                            key={ch.kind}
                            className={cn('text-[12px] leading-snug', changeTone(ch.kind))}
                          >
                            {ch.text[0].toUpperCase() + ch.text.slice(1)}
                          </li>
                        ))}
                      </ul>
                    ) : run?.against !== 'none' ? (
                      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                        No change
                      </p>
                    ) : null}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {pins.length > 0 && (
        <div className='mt-2.5 flex items-center gap-2'>
          <button
            type='button'
            data-test-records-check=''
            className={btnOutline}
            disabled={running}
            onClick={() => void check()}
          >
            {running ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <RefreshCw className='h-3.5 w-3.5' />
            )}
            Re-check
          </button>
          <span className={cn(hintCls, 'min-w-0')}>{error ?? against}</span>
        </div>
      )}
      {pins.length < MAX_PINNED && (
        <AddPin
          collection={collection}
          pins={pins}
          onPin={(pin) => save([...pins, pin], 'Pin a test record')}
        />
      )}
    </div>
  )
}

// ─── New-record walkthrough (#2648) ─────────────────────────────────────────

const STATUS_WORD: Record<WalkField['status'], string> = {
  fill: 'fills it in',
  prefilled: 'filled in already',
  blocked: 'cannot be filled',
  skipped: 'not asked'
}

function WalkthroughTab(props: TestingProps & { open: boolean; active: ActiveLayoutData }) {
  const { collection, layoutId, bundle, fields, open, active } = props
  const [roleId, setRoleId] = useState(ADMIN)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const { data: roles = [] } = useRoleNames(true)
  const draft = useMemo(() => draftResolution(bundle.layout), [bundle.layout])
  const access = useWalkAccess(layoutId, roleId || null, draft, open)
  const rows = useFormRows(collection, active, open)
  const drivers = useMemo(() => drivingFields(active), [active])
  const label = useLabel(fields)
  const result = useMemo(
    () =>
      access.data && rows.data
        ? walkthrough({
            layout: active,
            rows: rows.data,
            access: access.data,
            values,
            thisLayoutId: layoutId,
            label
          })
        : null,
    [access.data, rows.data, active, values, layoutId, label]
  )
  const loading = access.isLoading || rows.isLoading
  const failed = access.error || rows.error

  return (
    <div data-walkthrough=''>
      <p className={hintCls}>
        Acts out creating a record on this form, step by step, and stops where it could not be
        finished. Nothing is saved.
      </p>
      <p className={cn(labelCls, 'mt-3')}>Create as</p>
      <SimpleSelect
        value={roleId}
        onChange={setRoleId}
        ariaLabel='Create as role'
        className='h-8 text-[12.5px]'
        options={[
          { value: ADMIN, label: 'An administrator' },
          ...roles.map((r) => ({ value: r.id, label: r.name }))
        ]}
      />
      {drivers.length > 0 && (
        <div className='mt-2.5'>
          <p className={labelCls}>Values they enter</p>
          <div className='flex flex-col gap-1.5'>
            {drivers.map((d) => (
              <div key={d.field} className='flex items-center gap-2'>
                <span className='w-[110px] shrink-0 truncate text-[12px] text-slate-600 dark:text-muted-foreground'>
                  {fieldName(fields, d.field)}
                </span>
                <div className='min-w-0 flex-1'>
                  <SimpleSelect
                    value={values[d.field] == null ? '' : String(values[d.field])}
                    onChange={(v) =>
                      setValues((cur) => {
                        const next = { ...cur }
                        if (v === '') delete next[d.field]
                        else next[d.field] = v
                        return next
                      })
                    }
                    ariaLabel={`Value of ${fieldName(fields, d.field)}`}
                    className='h-7 text-[12px]'
                    options={[
                      { value: '', label: 'Left empty' },
                      ...d.values.map((v) => ({ value: v, label: v }))
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className='mt-3 border-t border-slate-100 pt-3 dark:border-border'>
        {loading ? (
          <p className={cn(hintCls, 'flex items-center gap-1.5')}>
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
            Walking through…
          </p>
        ) : failed || !result ? (
          <p className='text-[12px] text-red-700 dark:text-red-300'>
            The walkthrough could not run.
          </p>
        ) : (
          <WalkResultView result={result} />
        )}
      </div>
    </div>
  )
}

function WalkResultView({ result }: { result: ReturnType<typeof walkthrough> }) {
  const { steps, blocker, skipped, notes } = result
  const stopAt = blocker?.step ?? Number.POSITIVE_INFINITY
  return (
    <div data-walk-result={blocker ? 'blocked' : 'ok'}>
      <p
        role='status'
        className={cn(
          'flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium',
          blocker
            ? 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200'
            : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200'
        )}
      >
        {blocker ? (
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
        ) : (
          <Check className='mt-0.5 h-3.5 w-3.5 shrink-0' />
        )}
        <span>
          {blocker
            ? `Stops at ${blocker.where}: ${blocker.reason}`
            : 'The record can be finished and saved.'}
        </span>
      </p>
      {blocker?.step !== -1 && (
        <ol className='mt-2 flex flex-col gap-1'>
          {steps.map((s, i) => {
            const state = s.hidden
              ? 'hidden'
              : i === stopAt
                ? 'stop'
                : i > stopAt
                  ? 'unreached'
                  : 'ok'
            const required = s.fields
            return (
              <li key={s.key} data-walk-step={s.key} data-walk-state={state}>
                <div className='flex items-center gap-1.5 text-[12.5px]'>
                  {state === 'ok' ? (
                    <Check className='h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
                  ) : state === 'stop' ? (
                    <X className='h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' />
                  ) : state === 'hidden' ? (
                    <EyeOff className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  ) : (
                    <CircleDashed className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate font-medium',
                      state === 'unreached' || state === 'hidden'
                        ? 'text-slate-400 dark:text-muted-foreground'
                        : 'text-slate-800 dark:text-foreground'
                    )}
                  >
                    {i + 1}. {s.label}
                  </span>
                  <span className={hintCls}>
                    {s.hidden
                      ? 'hidden for these values'
                      : required.length === 0
                        ? 'nothing required'
                        : `${required.length} required`}
                  </span>
                </div>
                {required.length > 0 && state !== 'unreached' && (
                  <ul className='ml-5 mt-0.5'>
                    {required.map((f) => (
                      <li
                        key={f.field}
                        className={cn(
                          'text-[12px] leading-snug',
                          f.status === 'blocked'
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-slate-600 dark:text-muted-foreground'
                        )}
                      >
                        {f.label} — {f.status === 'blocked' ? f.reason : STATUS_WORD[f.status]}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {skipped.length > 0 && (
        <div className='mt-2.5'>
          <p className={labelCls}>Saves without</p>
          <ul>
            {skipped.map((f) => (
              <li key={f.field} className='text-[12px] text-amber-700 dark:text-amber-300'>
                {f.label} (required) — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.map((n) => (
        <p key={n} className={cn(hintCls, 'mt-2')}>
          {n}
        </p>
      ))}
    </div>
  )
}

// ─── Form cost (#2649) ──────────────────────────────────────────────────────

const KIND_WORDS: Array<[keyof FormCost['counts'], string, string]> = [
  ['picker', 'picker', 'pickers'],
  ['grid', 'inline grid', 'inline grids'],
  ['widget', 'widget', 'widgets'],
  ['panel', 'panel', 'panels'],
  ['query', 'query', 'queries']
]

export function useFormCost(
  collection: string,
  active: ActiveLayoutData,
  enabled: boolean
): FormCost | null {
  const rows = useFormRows(collection, active, enabled)
  const relations = useSettingsRelations(collection)
  return useMemo(
    () => (rows.data ? formCost({ layout: active, rows: rows.data, relations, collection }) : null),
    [rows.data, active, relations, collection]
  )
}

/** "≈ 46 requests when it opens — above the limit of 40" with the parts. */
export function CostLine({ cost, limit }: { cost: FormCost; limit: number }) {
  const over = cost.total > limit
  const parts = KIND_WORDS.filter(([k]) => cost.counts[k] > 0).map(
    ([k, one, many]) => `${cost.counts[k]} ${cost.counts[k] === 1 ? one : many}`
  )
  return (
    <div data-form-cost={cost.total} data-form-cost-over={over ? '' : undefined}>
      <p
        className={cn(
          'flex items-center gap-1.5 text-[12.5px] font-medium',
          over ? 'text-amber-700 dark:text-amber-300' : 'text-slate-800 dark:text-foreground'
        )}
      >
        {over && <AlertTriangle className='h-3.5 w-3.5 shrink-0' />}≈ {cost.total} requests when it
        opens {over ? `— above the limit of ${limit}` : `(limit ${limit})`}
      </p>
      {parts.length > 0 && <p className={hintCls}>{parts.join(' · ')}</p>}
    </div>
  )
}

function CostTab(props: TestingProps & { open: boolean; active: ActiveLayoutData }) {
  const { collection, bundle, open, active } = props
  const cost = useFormCost(collection, active, open)
  const limit = readTesting(bundle.layout.conditions).cost_limit ?? DEFAULT_COST_LIMIT
  const top = cost
    ? cost.items
        .filter((i) => i.kind !== 'base')
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 8)
    : []
  return (
    <div data-cost-tab=''>
      <p className={hintCls}>
        Counts what the form asks the server for when someone opens a record on it: pickers, inline
        grids, widgets, panels and queries. An estimate to compare forms by.
      </p>
      <div className='mt-3'>
        {cost ? (
          <CostLine cost={cost} limit={limit} />
        ) : (
          <p className={cn(hintCls, 'flex items-center gap-1.5')}>
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
            Counting…
          </p>
        )}
      </div>
      {top.length > 0 && (
        <ul className='mt-2.5 flex flex-col'>
          {top.map((i) => (
            <li
              key={i.key}
              className='flex items-center gap-2 border-t border-slate-100 py-1 text-[12px] dark:border-border'
            >
              <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-foreground'>
                {i.label}
              </span>
              <span className='shrink-0 text-slate-500 dark:text-muted-foreground'>{i.kind}</span>
              <span className='w-6 shrink-0 text-right font-mono text-slate-600 dark:text-muted-foreground'>
                {i.requests}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={cn(hintCls, 'mt-2.5')}>The limit is in Form settings → Form cost limit.</p>
    </div>
  )
}

// ─── The Test popover ───────────────────────────────────────────────────────

type Tab = 'records' | 'walk' | 'cost'
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'records', label: 'Test records' },
  { value: 'walk', label: 'New record' },
  { value: 'cost', label: 'Cost' }
]

export function TestingButton(props: TestingProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('records')
  const active = useMemo(
    () => bundleToActiveLayout(props.bundle, props.parent).active,
    [props.bundle, props.parent]
  )
  const pins = readTesting(props.bundle.layout.conditions).records.length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Test'
        icon={<FlaskConical className='h-4 w-4' />}
        tip='Test: pinned records, a new record as a role, and what the form costs to open'
        hint={
          pins > 0
            ? `${pins} pinned test ${pins === 1 ? 'record' : 'records'}, new record, cost`
            : 'Pinned records, a new record as a role, cost'
        }
        data={{ 'data-editor-testing': '' }}
        trailing={
          pins > 0 && (
            <span className='rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              {pins}
            </span>
          )
        }
      />
      <PopoverContent
        align='end'
        className='max-h-[min(80vh,640px)] w-[380px] overflow-y-auto overscroll-contain p-3'
      >
        <div role='tablist' aria-label='Test' className={segTrack(TABS.length)}>
          {TABS.map((t) => (
            <button
              key={t.value}
              type='button'
              role='tab'
              aria-selected={tab === t.value}
              data-testing-tab={t.value}
              className={segOption(tab === t.value)}
              onClick={() => setTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className='mt-3'>
          {tab === 'records' ? (
            <TestRecordsTab {...props} open={open} />
          ) : tab === 'walk' ? (
            <WalkthroughTab {...props} open={open} active={active} />
          ) : (
            <CostTab {...props} open={open} active={active} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── What changes, in the Save menu (#2647) ──────────────────────────────────────

/**
 * What saving would change for the pinned test records, and the form's cost
 * against its limit. Opens beside Save; runs the same check as Re-check.
 */
export function ImpactButton(props: TestingProps) {
  const { collection, layoutId, bundle, parent, dirty, fields } = props
  const [open, setOpen] = useState(false)
  const active = useMemo(() => bundleToActiveLayout(bundle, parent).active, [bundle, parent])
  const cfg = readTesting(bundle.layout.conditions)
  const labels = usePinnedLabels(collection, cfg.records, open)
  const label = useLabel(fields)
  const { run, running, error, check } = useRecordCheck({
    layoutId,
    bundle,
    parent,
    pins: cfg.records,
    dirty,
    label
  })
  const cost = useFormCost(collection, active, open)
  const limit = cfg.cost_limit ?? DEFAULT_COST_LIMIT
  const changed = (run?.checks ?? []).filter((c) => c.changes.length > 0)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && cfg.records.length > 0) void check()
      }}
    >
      <ToolButton
        popover
        onOpen={() => {
          setOpen(true)
          if (cfg.records.length > 0) void check()
        }}
        label='What changes'
        icon={<Target className='h-4 w-4' />}
        tip='What this save changes for the pinned test records, and what the form costs to open'
        hint='For the pinned test records, and the form’s cost'
        data={{ 'data-editor-impact': '' }}
      />
      <PopoverContent align='end' className='w-[360px] p-3'>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          What this save changes
        </p>
        <div className='mt-2' data-impact-records=''>
          {cfg.records.length === 0 ? (
            <p className={hintCls}>
              Pin test records (More → Test → Test records) to see what a save changes for them.
            </p>
          ) : running ? (
            <p className={cn(hintCls, 'flex items-center gap-1.5')}>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              Checking {cfg.records.length} test {cfg.records.length === 1 ? 'record' : 'records'}…
            </p>
          ) : error ? (
            <p className='text-[12px] text-red-700 dark:text-red-300'>{error}</p>
          ) : changed.length === 0 ? (
            <p className='text-[12px] text-emerald-700 dark:text-emerald-300'>
              No change for the {cfg.records.length} pinned test{' '}
              {cfg.records.length === 1 ? 'record' : 'records'}.
            </p>
          ) : (
            <ul className='flex flex-col gap-0.5'>
              {changed.flatMap((c) =>
                c.changes.map((ch) => (
                  <li
                    key={`${c.pin.item}\u0000${c.pin.role_id ?? ''}\u0000${ch.kind}`}
                    className={cn('text-[12px] leading-snug', changeTone(ch.kind))}
                  >
                    Record {labels.get(c.pin.item) ?? c.pin.item} {ch.text}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <div className='mt-3 border-t border-slate-100 pt-2.5 dark:border-border'>
          {cost ? (
            <CostLine cost={cost} limit={limit} />
          ) : (
            <p className={hintCls}>Counting what the form opens with…</p>
          )}
        </div>
        <p className={cn(hintCls, 'mt-2')}>Nothing is saved until you press Save.</p>
      </PopoverContent>
    </Popover>
  )
}
