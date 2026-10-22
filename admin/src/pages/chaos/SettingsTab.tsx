import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type Catalog, chaosKeys, errText, fetchCatalog } from './api'
import {
  type ChaosEnvCaps,
  type ChaosSettingsView,
  fetchChaosSettings,
  fetchOperator,
  type OperatorView,
  opsKeys,
  patchChaosSettings
} from './ops-api'
import { FaultChecklist, NumberBox, Row, SaveBar, Section } from './ops-controls'

/**
 * Settings (#2862): who may run faults besides administrators, and how far a run may reach on
 * THIS instance. The server enforces the limits in the run start path whatever any form sends;
 * this page only says what they are. Administrators only — an operator cannot widen their reach.
 */

interface Role {
  id: string
  name: string
  admin_access?: boolean
}

const NO_CAPS: ChaosEnvCaps = {
  allowed_faults: '*',
  max_share_pct: null,
  max_latency_ms: null,
  max_seconds: null,
  max_replicas: null
}

interface Draft {
  operator_roles: string[]
  caps: ChaosEnvCaps
}

function draftOf(v: ChaosSettingsView): Draft {
  return {
    operator_roles: v.settings.operator_roles,
    caps: v.settings.environments[v.instance] ?? v.effective_caps ?? NO_CAPS
  }
}

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)

export function SettingsTab() {
  const { data: me } = useQuery<OperatorView>({
    queryKey: opsKeys.operator,
    queryFn: fetchOperator
  })
  if (me && !me.admin && me.caps) return <OperatorLimits instance={me.instance} caps={me.caps} />
  if (me && !me.admin)
    return (
      <div className='flex flex-1 items-center justify-center p-8'>
        <div className='flex max-w-[48ch] items-start gap-3 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          <Lock className='mt-0.5 h-4 w-4 shrink-0' aria-hidden />
          <p>
            Only administrators change who may run faults and how far a run may reach. You can run
            drills within the limits they set.
          </p>
        </div>
      </div>
    )
  return <SettingsForm />
}

/**
 * What an operator sees: the same limits, read-only, from GET /chaos/operator (the settings
 * route itself is for administrators). Fault names come from the catalog everyone reads.
 */
function OperatorLimits({ instance, caps }: { instance: string; caps: ChaosEnvCaps }) {
  const { data: catalog } = useQuery<Catalog>({
    queryKey: chaosKeys.catalog,
    queryFn: fetchCatalog
  })
  const label = new Map((catalog?.faults ?? []).map((f) => [f.key, f.label]))
  const limit = (v: number | null, unit: string) =>
    v == null ? (
      <span className='text-slate-500 dark:text-muted-foreground'>No limit</span>
    ) : (
      <span className='tabular-nums'>
        {v}
        {unit.startsWith('%') ? '' : ' '}
        {unit}
      </span>
    )
  return (
    <div className='flex-1 overflow-y-auto px-4 py-5 sm:p-6'>
      <div className='space-y-4 pb-6'>
        <p className='flex max-w-[75ch] items-start gap-2 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          <Lock className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          You run drills here as a chaos operator. These limits hold every run you start; only
          administrators change them.
        </p>
        <Section
          title='Limits on this instance'
          help='Numbers over a limit are lowered to it when a run starts; a fault off the list is refused.'
          aside={
            <span className='inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-[11.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              Instance
              <span className='font-mono text-[11px] text-slate-800 dark:text-foreground'>
                {instance}
              </span>
            </span>
          }
        >
          <Row label='Faults allowed'>
            {caps.allowed_faults === '*' ? (
              <span className='text-[12.5px] text-slate-800 dark:text-foreground'>
                Every fault in the catalog
              </span>
            ) : caps.allowed_faults.length === 0 ? (
              <span className='text-[12.5px] text-amber-800 dark:text-amber-300'>
                None: every run here is refused.
              </span>
            ) : (
              <ul className='flex flex-wrap gap-1.5'>
                {caps.allowed_faults.map((k) => (
                  <li
                    key={k}
                    className='rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[12.5px] text-slate-800 dark:border-border dark:bg-muted dark:text-foreground'
                  >
                    {label.get(k) ?? k}
                  </li>
                ))}
              </ul>
            )}
          </Row>
          {(
            [
              ['Share of traffic', caps.max_share_pct, '% at most'],
              ['Added delay', caps.max_latency_ms, 'ms at most'],
              ['Run length', caps.max_seconds, 'seconds at most'],
              ['Replicas', caps.max_replicas, 'at most']
            ] as const
          ).map(([name, v, unit]) => (
            <Row key={name} label={name}>
              <span className='text-[12.5px] text-slate-800 dark:text-foreground'>
                {limit(v, unit)}
              </span>
            </Row>
          ))}
        </Section>
      </div>
    </div>
  )
}

function SettingsForm() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<ChaosSettingsView>({
    queryKey: opsKeys.settings,
    queryFn: fetchChaosSettings
  })
  const { data: roles = [] } = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data ?? [])
  })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (data) setDraft(draftOf(data))
  }, [data])

  const save = useMutation({
    mutationFn: (d: Draft) =>
      patchChaosSettings({
        operator_roles: d.operator_roles,
        environments: { [data?.instance ?? 'default']: d.caps }
      }),
    onSuccess: (v) => {
      qc.setQueryData(opsKeys.settings, v)
      void qc.invalidateQueries({ queryKey: opsKeys.operator })
      setError(null)
      toast.success('Chaos settings saved')
    },
    onError: (e) => setError(errText(e, 'The settings were not saved'))
  })

  if (isLoading || (!draft && !isError))
    return (
      <div className='flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:p-6'>
        {[0, 1].map((i) => (
          <div
            key={i}
            className='space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
          >
            <Skeleton className='h-4 w-48' />
            <Skeleton className='h-3.5 w-full max-w-[60ch]' />
            <Skeleton className='h-8 w-64' />
          </div>
        ))}
      </div>
    )
  if (isError || !data || !draft)
    return (
      <p className='p-6 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
        The chaos settings did not load. Reload the page to try again.
      </p>
    )

  const dirty = !same(draft, draftOf(data))
  const setCaps = (patch: Partial<ChaosEnvCaps>) =>
    setDraft({ ...draft, caps: { ...draft.caps, ...patch } })
  const own = !!data.settings.environments[data.instance]
  const onlySome = draft.caps.allowed_faults !== '*'

  return (
    <div className='flex-1 overflow-y-auto px-4 pt-5 sm:px-6 sm:pt-6'>
      <div className='space-y-4 pb-6'>
        <Section
          title='Who may run faults'
          help='Administrators always can. Members of these roles may also start, stop and record drills on this instance, within the limits below.'
        >
          <Row
            label='Chaos operators'
            help='Pick roles, not people. Only administrators change this list.'
          >
            <OperatorRoles
              roles={roles}
              value={draft.operator_roles}
              onChange={(operator_roles) => setDraft({ ...draft, operator_roles })}
            />
          </Row>
        </Section>

        <Section
          title='Limits on this instance'
          help='Every run started here — from the builder, a game day, Chaos Monkey or a script — is held to these. Numbers over a limit are lowered to it and the run records what was lowered; a fault off the list is refused. Empty means no limit beyond the fault’s own.'
          aside={
            <span className='inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-[11.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              Instance
              <span className='font-mono text-[11px] text-slate-800 dark:text-foreground'>
                {data.instance}
              </span>
            </span>
          }
        >
          {!own && data.settings.environments.default && (
            <p className='px-4 py-2.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
              This instance follows the default limits until you save its own.
            </p>
          )}
          <Row
            label='Faults allowed'
            help={
              onlySome
                ? 'Only the ticked faults may be armed here.'
                : 'Every fault in the catalog may be armed here.'
            }
          >
            <div className='space-y-2.5'>
              <fieldset
                aria-label='Faults allowed'
                className='m-0 inline-flex min-w-0 rounded-md border border-slate-200 p-0.5 dark:border-border'
              >
                {[
                  { on: !onlySome, label: 'Every fault', value: '*' as const },
                  {
                    on: onlySome,
                    label: 'Only these',
                    value: data.candidates.map((c) => c.key)
                  }
                ].map((o) => (
                  <button
                    key={o.label}
                    type='button'
                    aria-pressed={o.on}
                    onClick={() => !o.on && setCaps({ allowed_faults: o.value })}
                    className={cn(
                      'h-7 rounded px-3 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                      o.on
                        ? 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan'
                        : 'text-slate-600 hover:bg-slate-50 dark:text-muted-foreground dark:hover:bg-muted'
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </fieldset>
              {onlySome && (
                <FaultChecklist
                  candidates={data.candidates}
                  value={draft.caps.allowed_faults as string[]}
                  onChange={(keys) => setCaps({ allowed_faults: keys })}
                />
              )}
              {onlySome && (draft.caps.allowed_faults as string[]).length === 0 && (
                <p className='text-[12px] text-amber-800 dark:text-amber-300'>
                  Nothing ticked: every run on this instance will be refused.
                </p>
              )}
            </div>
          </Row>
          <Row
            label='Share of traffic'
            htmlFor='cap-share'
            help='Every run reaches at most this share of the calls it targets. Broad route patterns like /api/* are refused under it.'
          >
            <NumberBox
              id='cap-share'
              value={draft.caps.max_share_pct}
              onChange={(v) => setCaps({ max_share_pct: v })}
              unit='% at most'
              min={1}
              max={100}
            />
          </Row>
          <Row
            label='Added delay'
            htmlFor='cap-latency'
            help='The most any slowness fault may add to one call.'
          >
            <NumberBox
              id='cap-latency'
              value={draft.caps.max_latency_ms}
              onChange={(v) => setCaps({ max_latency_ms: v })}
              unit='ms at most'
              min={0}
            />
          </Row>
          <Row label='Run length' htmlFor='cap-seconds' help='Never shorter than 5 seconds.'>
            <NumberBox
              id='cap-seconds'
              value={draft.caps.max_seconds}
              onChange={(v) => setCaps({ max_seconds: v })}
              unit='seconds at most'
              min={5}
            />
          </Row>
          <Row
            label='Replicas'
            htmlFor='cap-replicas'
            help='A run that would reach more is narrowed to this replica, or refused when the fault cannot aim at one.'
          >
            <NumberBox
              id='cap-replicas'
              value={draft.caps.max_replicas}
              onChange={(v) => setCaps({ max_replicas: v })}
              unit='at most'
              min={1}
            />
          </Row>
        </Section>
      </div>
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        error={error}
        onSave={() => save.mutate(draft)}
        onDiscard={() => {
          setDraft(draftOf(data))
          setError(null)
        }}
      />
    </div>
  )
}

/** Role chips + an anchored searchable picker (no native select). */
function OperatorRoles({
  roles,
  value,
  onChange
}: {
  roles: Role[]
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const byId = useMemo(() => new Map(roles.map((r) => [r.id.toLowerCase(), r])), [roles])
  // Administrators already may; offering their roles would only add noise.
  const pickable = roles
    .filter((r) => !r.admin_access && !value.includes(r.id.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {value.length === 0 && (
        <span className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Administrators only
        </span>
      )}
      {value.map((id) => (
        <span
          key={id}
          className='inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 py-0.5 pl-2 pr-1 text-[12.5px] text-slate-800 dark:border-border dark:bg-muted dark:text-foreground'
        >
          {byId.get(id)?.name ?? 'Unknown role'}
          <button
            type='button'
            aria-label={`Remove ${byId.get(id)?.name ?? 'role'}`}
            onClick={() => onChange(value.filter((x) => x !== id))}
            className='rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-background dark:hover:text-foreground'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[12.5px] text-slate-600 hover:border-nvr-cyan hover:text-nvr-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-muted-foreground dark:hover:text-nvr-cyan'
          >
            <Plus className='h-3.5 w-3.5' aria-hidden />
            Add role
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-64 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search roles…' className='h-9 text-[12.5px]' />
            <CommandList>
              <CommandEmpty className='py-4 text-center text-[12px]'>No other roles</CommandEmpty>
              {pickable.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.name}
                  onSelect={() => {
                    onChange([...value, r.id.toLowerCase()])
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  {r.name}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
