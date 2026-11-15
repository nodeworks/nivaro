import {
  forgetPickerBadgeRules,
  type PickerBadge,
  PickerBadgeList,
  type PickerBadgeTone,
  queryKeys,
  toastError
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Tags, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

/**
 * Status badges in pickers (rt6 #12) — `browser_config.picker_badges` on the collection:
 * which short marks ("On hold", "Closed", "Over budget", "Inactive", "Hidden from pickers")
 * a record of this collection carries in every dropdown and chip that offers it. The server
 * judges them as the viewer (api routes/picker-badges.ts); this card only edits the setting.
 */

type Op = 'is_true' | 'is_false' | 'eq' | 'neq' | 'gt' | 'lt' | 'gt_field'
interface When {
  states?: string[]
  terminal?: boolean
  hold?: boolean
  hidden?: boolean
  field?: string
  op?: Op | 'in'
  value?: unknown
  other?: string
}
interface Rule {
  key?: string
  label: string
  tone: PickerBadgeTone
  when: When
}
interface Setting {
  mode: 'auto' | 'custom' | 'off'
  rules: Rule[]
}
interface Setup {
  setting: Setting
  automatic: Rule[]
  states: Array<{ key: string; label: string; is_terminal: boolean }>
  fields: Array<{ field: string; type: string | null }>
}

const fieldName = (f: string) => titleCase(f.replace(/_id$/, ''))

type CondKind = 'terminal' | 'hold' | 'states' | 'hidden' | 'field'

const condOf = (w: When): CondKind =>
  w.hidden ? 'hidden' : w.terminal ? 'terminal' : w.hold ? 'hold' : w.states ? 'states' : 'field'

const TONES: Array<{ value: PickerBadgeTone; label: string }> = [
  { value: 'neutral', label: 'Grey — a fact' },
  { value: 'amber', label: 'Amber — needs a look' },
  { value: 'red', label: 'Red — a problem' },
  { value: 'muted', label: 'Outline — set aside' }
]

const OPS: Array<{ value: Op; label: string }> = [
  { value: 'is_true', label: 'is Yes' },
  { value: 'is_false', label: 'is No' },
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'is not' },
  { value: 'gt', label: 'is more than' },
  { value: 'lt', label: 'is less than' },
  { value: 'gt_field', label: 'is more than field' }
]

function conditionWords(w: When, states: Setup['states'], fieldName: (f: string) => string) {
  if (w.hidden) return 'Hidden from pickers by an admin'
  if (w.terminal) return 'In a final pipeline step'
  if (w.hold) return 'In a step named hold, paused or suspended'
  if (w.states)
    return `In step ${w.states.map((k) => states.find((s) => s.key === k)?.label ?? k).join(', ')}`
  if (!w.field) return ''
  const op = OPS.find((o) => o.value === w.op)?.label ?? 'is Yes'
  const tail =
    w.op === 'gt_field'
      ? ` ${fieldName(w.other ?? '')}`
      : w.op === 'is_true' || w.op === 'is_false' || !w.op
        ? ''
        : ` ${String(w.value ?? '')}`
  return `${fieldName(w.field)} ${op}${tail}`
}

const storageOf = (s: Setting): Record<string, unknown> | null =>
  s.mode === 'auto'
    ? null
    : s.mode === 'off'
      ? { mode: 'off' }
      : {
          mode: 'custom',
          rules: s.rules
            .filter((r) => r.label.trim())
            .map((r) => ({ label: r.label.trim(), tone: r.tone, when: r.when }))
        }

export function PickerBadgesCard({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const id = useId()
  const { data: col } = useQuery({
    queryKey: queryKeys.collectionMeta(tableName),
    queryFn: () =>
      api
        .get<{ data: { browser_config?: Record<string, unknown> | null } }>(
          `/collections/${tableName}`
        )
        .then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })
  const setup = useQuery({
    queryKey: ['picker-badges-setup', tableName],
    queryFn: () =>
      api.get<{ data: Setup }>(`/picker-badges/${tableName}/setup`).then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 60_000
  })
  const saved: Setting = setup.data?.setting ?? { mode: 'auto', rules: [] }
  const savedKey = JSON.stringify(storageOf(saved))
  const [draft, setDraft] = useState<Setting | null>(null)
  useEffect(() => {
    if (draft && JSON.stringify(storageOf(draft)) === savedKey) setDraft(null)
  }, [savedKey, draft])
  const value = draft ?? saved
  const dirty = draft != null && JSON.stringify(storageOf(draft)) !== savedKey

  const states = setup.data?.states ?? []
  const fields = useMemo(() => setup.data?.fields ?? [], [setup.data])
  const fieldOptions = useMemo(
    () =>
      fields
        .filter((f) => f.field !== 'id')
        .map((f) => ({ value: f.field, label: fieldName(f.field) })),
    [fields]
  )
  const shown: Rule[] = value.mode === 'auto' ? (setup.data?.automatic ?? []) : value.rules

  const save = useMutation({
    mutationFn: async () => {
      const bc = { ...(col?.browser_config ?? {}) } as Record<string, unknown>
      const stored = storageOf(value)
      if (stored) bc.picker_badges = stored
      else delete bc.picker_badges
      await api.patch(`/collections/${tableName}`, {
        browser_config: Object.keys(bc).length ? bc : null
      })
    },
    onSuccess: () => {
      forgetPickerBadgeRules(tableName)
      void qc.invalidateQueries({ queryKey: queryKeys.collectionMeta(tableName) })
      void qc.invalidateQueries({ queryKey: ['picker-badges-setup', tableName] })
      toast.success('Picker badges saved')
    },
    onError: (e) => toastError(e, 'Could not save the picker badges')
  })

  const setMode = (mode: Setting['mode']) =>
    setDraft({
      mode,
      rules:
        mode === 'custom' && value.rules.length === 0
          ? (setup.data?.automatic ?? []).map((r) => ({ ...r }))
          : value.rules
    })
  const setRule = (i: number, next: Rule) =>
    setDraft({ ...value, rules: value.rules.map((r, j) => (j === i ? next : r)) })
  const removeRule = (i: number) =>
    setDraft({ ...value, rules: value.rules.filter((_, j) => j !== i) })
  const addRule = () =>
    setDraft({
      ...value,
      rules: [
        ...value.rules,
        {
          label: 'Over budget',
          tone: 'red',
          when: fieldOptions[0] ? { field: fieldOptions[0].value, op: 'is_true' } : { hidden: true }
        }
      ]
    })

  const condOptions: Array<{ value: CondKind; label: string }> = [
    ...(states.length
      ? ([
          { value: 'terminal', label: 'Final pipeline step' },
          { value: 'hold', label: 'Step named hold / paused' },
          { value: 'states', label: 'Pipeline step is…' }
        ] as const)
      : []),
    { value: 'field', label: 'A field…' },
    { value: 'hidden', label: 'Hidden from pickers' }
  ]
  const whenFor = (k: CondKind, prev: When): When =>
    k === 'terminal'
      ? { terminal: true }
      : k === 'hold'
        ? { hold: true }
        : k === 'hidden'
          ? { hidden: true }
          : k === 'states'
            ? { states: states[0] ? [states[0].key] : [] }
            : {
                field: prev.field ?? fieldOptions[0]?.value,
                op: prev.op && prev.op !== 'in' ? prev.op : 'is_true'
              }

  return (
    <section
      aria-labelledby={`pb-title-${id}`}
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-picker-badges-card={value.mode}
    >
      <div className='flex flex-wrap items-start justify-between gap-3 px-4 pt-3'>
        <div className='min-w-0 flex-1'>
          <h3
            id={`pb-title-${id}`}
            className='flex items-center gap-1.5 text-[13px] font-medium text-slate-800 dark:text-foreground'
          >
            <Tags className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' aria-hidden />
            Status badges in pickers
          </h3>
          <p className='mt-0.5 max-w-[68ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
            Short marks beside a record wherever a dropdown offers it or a field shows it — so
            nobody picks a closed or inactive one by mistake. Each person sees only what they may
            read.
          </p>
        </div>
        <div
          role='radiogroup'
          aria-label='Badge source'
          className='inline-flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'
        >
          {(
            [
              ['auto', 'Automatic'],
              ['custom', 'Custom'],
              ['off', 'Off']
            ] as const
          ).map(([m, label]) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control button
            <button
              key={m}
              type='button'
              role='radio'
              aria-checked={value.mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                value.mode === m
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-inset ring-slate-200 dark:bg-white/[0.1] dark:text-foreground dark:shadow-none dark:ring-white/15'
                  : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className='px-4 pb-3 pt-3'>
        {value.mode === 'off' ? (
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            No badges for this collection.
          </p>
        ) : value.mode === 'auto' ? (
          <>
            <p className='mb-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Worked out from this collection’s pipeline and its yes/no fields:
            </p>
            <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
              {shown.map((r) => (
                <li
                  key={r.key ?? r.label}
                  className='flex items-center gap-3 px-3 py-1.5 text-[12px] text-slate-600 dark:text-slate-300'
                >
                  <span className='w-[140px] shrink-0'>
                    <PickerBadgeList
                      badges={[
                        { key: r.key ?? r.label, label: r.label, tone: r.tone } as PickerBadge
                      ]}
                    />
                  </span>
                  <span className='min-w-0 truncate'>
                    {conditionWords(r.when, states, fieldName)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className='space-y-2'>
            {value.rules.length === 0 && (
              <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                No badges yet — add one.
              </p>
            )}
            {value.rules.map((r, i) => {
              const kind = condOf(r.when)
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                  key={i}
                  data-picker-badge-rule={i}
                  className='flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50/60 p-2 dark:border-border dark:bg-muted/30'
                >
                  <Input
                    value={r.label}
                    onChange={(e) => setRule(i, { ...r, label: e.target.value.slice(0, 40) })}
                    aria-label='Badge text'
                    placeholder='Badge text'
                    className='h-8 w-[140px] text-[12px]'
                  />
                  <span className='flex w-[150px] shrink-0 items-center'>
                    <PickerBadgeList
                      badges={
                        r.label.trim()
                          ? [
                              {
                                key: r.when.hidden ? 'hidden' : `p${i}`,
                                label: r.label.trim(),
                                tone: r.tone
                              }
                            ]
                          : []
                      }
                    />
                  </span>
                  <SimpleSelect
                    value={r.tone}
                    onChange={(v) => setRule(i, { ...r, tone: v as PickerBadgeTone })}
                    options={TONES}
                    ariaLabel='Badge colour'
                    className='h-8 w-[200px] text-[12px] [&>span]:block [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left gap-2'
                  />
                  <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                    when
                  </span>
                  <SimpleSelect
                    value={kind}
                    onChange={(v) => setRule(i, { ...r, when: whenFor(v as CondKind, r.when) })}
                    options={condOptions.map((o) => ({ value: o.value, label: o.label }))}
                    ariaLabel='Badge condition'
                    className='h-8 w-[210px] text-[12px] [&>span]:block [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left gap-2'
                  />
                  {kind === 'states' && (
                    <SimpleSelect
                      value={r.when.states?.[0] ?? ''}
                      onChange={(v) => setRule(i, { ...r, when: { states: [v] } })}
                      options={states.map((s) => ({ value: s.key, label: s.label }))}
                      ariaLabel='Pipeline step'
                      className='h-8 w-[170px] text-[12px] [&>span]:block [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left gap-2'
                    />
                  )}
                  {kind === 'field' && (
                    <>
                      <SimpleSelect
                        value={r.when.field ?? ''}
                        onChange={(v) => setRule(i, { ...r, when: { ...r.when, field: v } })}
                        options={fieldOptions}
                        ariaLabel='Field'
                        triggerProps={{ 'data-tip': fieldName(r.when.field ?? '') }}
                        className='h-8 w-[160px] text-[12px] [&>span]:block [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left gap-2'
                      />
                      <SimpleSelect
                        value={(r.when.op as Op) ?? 'is_true'}
                        onChange={(v) =>
                          setRule(i, { ...r, when: { field: r.when.field, op: v as Op } })
                        }
                        options={OPS}
                        ariaLabel='Test'
                        className='h-8 w-[160px] text-[12px] [&>span]:block [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left gap-2'
                      />
                      {r.when.op === 'gt_field' ? (
                        <SimpleSelect
                          value={r.when.other ?? ''}
                          onChange={(v) => setRule(i, { ...r, when: { ...r.when, other: v } })}
                          options={fieldOptions}
                          ariaLabel='Compared with'
                          triggerProps={{ 'data-tip': fieldName(r.when.other ?? '') }}
                          className='h-8 w-[160px] text-[12px] [&>span]:block [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left gap-2'
                        />
                      ) : r.when.op && r.when.op !== 'is_true' && r.when.op !== 'is_false' ? (
                        <Input
                          value={String(r.when.value ?? '')}
                          onChange={(e) =>
                            setRule(i, {
                              ...r,
                              when: {
                                ...r.when,
                                value:
                                  (r.when.op === 'gt' || r.when.op === 'lt') &&
                                  e.target.value.trim() !== '' &&
                                  Number.isFinite(Number(e.target.value))
                                    ? Number(e.target.value)
                                    : e.target.value
                              }
                            })
                          }
                          aria-label='Value'
                          placeholder='Value'
                          className='h-8 w-[120px] text-[12px]'
                        />
                      ) : null}
                    </>
                  )}
                  <span className='ml-auto flex items-center'>
                    <button
                      type='button'
                      aria-label='Remove badge'
                      onClick={() => removeRule(i)}
                      className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-white/[0.06]'
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  </span>
                </div>
              )
            })}
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-7 text-[12px]'
              onClick={addRule}
              disabled={value.rules.length >= 12}
            >
              <Plus className='mr-1 h-3.5 w-3.5' /> Add a badge
            </Button>
          </div>
        )}
      </div>
      {dirty && (
        <div className='flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-border dark:bg-muted/30'>
          <Button type='button' variant='ghost' size='sm' onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button
            type='button'
            size='sm'
            className='bg-nvr-cyan text-white hover:bg-nvr-cyan-dark'
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </section>
  )
}
