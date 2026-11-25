import { ErrorNotice, toastError, useUnsavedWork } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { hubError } from '../hub-api'
import { dangerGhost, ghostButton, SectionCard } from '../hub-parts'
import {
  type FleetRow,
  type FleetRule,
  type FleetRuleKind,
  type FleetSettings,
  fetchFleetSettings,
  fleetKeys,
  RULE_KIND_LABEL,
  saveFleetSettings
} from './fleet-api'

/**
 * Admin card under the fleet table: the version drift rules (evaluated every 15 minutes; owners
 * and Hub admins are told once when one opens), the monthly SLO targets (a default and per
 * environment) and the monthly report switch. Saved as one PUT, logged.
 */

const UNIT: Record<FleetRuleKind, string> = {
  behind_newest: 'releases',
  pair_apart: 'releases',
  stale_deploy: 'days'
}

function newRule(rules: FleetRule[]): FleetRule {
  let i = rules.length + 1
  while (rules.some((r) => r.id === `rule-${i}`)) i++
  return {
    id: `rule-${i}`,
    kind: 'behind_newest',
    enabled: true,
    n: 5,
    env_keys: [],
    from_key: null,
    to_key: null
  }
}

const keyList = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function FleetSettingsCard({ rows }: { rows: FleetRow[] }) {
  const qc = useQueryClient()
  const stored = useQuery({ queryKey: fleetKeys.settings(), queryFn: fetchFleetSettings })
  const [draft, setDraft] = useState<FleetSettings | null>(null)
  useEffect(() => {
    if (stored.data && draft === null) setDraft(stored.data)
  }, [stored.data, draft])

  const save = useMutation({
    mutationFn: saveFleetSettings,
    onSuccess: (s) => {
      qc.setQueryData(fleetKeys.settings(), s)
      setDraft(s)
      void qc.invalidateQueries({ queryKey: fleetKeys.fleet() })
      toast.success('Fleet rules and targets saved')
    },
    onError: (e) => toastError(e, 'Could not save the fleet rules')
  })

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(stored.data)
  useUnsavedWork(dirty, 'Fleet rules and targets')

  if (stored.isError)
    return (
      <ErrorNotice
        description={hubError(stored.error, 'Could not load the fleet rules')}
        onRetry={() => void stored.refetch()}
      />
    )
  if (!draft) return null

  const setRule = (i: number, patch: Partial<FleetRule>) =>
    setDraft({ ...draft, rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const setTarget = (envId: number, v: string) => {
    const targets = { ...draft.slo.targets }
    if (v.trim() === '') delete targets[String(envId)]
    else targets[String(envId)] = Number(v)
    setDraft({ ...draft, slo: { ...draft.slo, targets } })
  }

  return (
    <SectionCard
      title='Alert rules and uptime targets'
      description='Rules run every 15 minutes; when one starts firing, the app’s owners and every Hub administrator are told once. Targets are the share of probes a month that must answer.'
      actions={
        <>
          {dirty && (
            <button
              type='button'
              className={ghostButton}
              onClick={() => setDraft(stored.data ?? null)}
            >
              Undo changes
            </button>
          )}
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(draft)}
          >
            Save
          </Button>
        </>
      }
    >
      <div className='space-y-5 p-4'>
        <section className='space-y-2'>
          <h4 className='m-0 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
            Version drift rules
          </h4>
          {draft.rules.length === 0 && (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              No rules: no drift alerts.
            </p>
          )}
          {draft.rules.map((r, i) => (
            <div
              key={r.id}
              className='flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-2 dark:border-border'
            >
              <Switch
                checked={r.enabled}
                onCheckedChange={(v) => setRule(i, { enabled: v })}
                aria-label={`Rule ${i + 1} (${RULE_KIND_LABEL[r.kind]}) on`}
              />
              <SimpleSelect
                value={r.kind}
                onChange={(v) => setRule(i, { kind: v as FleetRuleKind })}
                ariaLabel='Rule kind'
                className='h-8 w-[210px] text-[12px]'
                options={(Object.keys(RULE_KIND_LABEL) as FleetRuleKind[]).map((k) => ({
                  value: k,
                  label: RULE_KIND_LABEL[k]
                }))}
              />
              <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                {r.kind === 'pair_apart' ? 'more than' : 'at least'}
              </span>
              <Input
                type='number'
                min={1}
                value={r.n}
                onChange={(e) => setRule(i, { n: Number(e.target.value) })}
                aria-label={`Rule ${i + 1} threshold in ${UNIT[r.kind]}`}
                className='h-8 w-[80px] text-[13px]'
              />
              <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                {UNIT[r.kind]}
              </span>
              {r.kind === 'pair_apart' ? (
                <>
                  <Input
                    value={r.from_key ?? ''}
                    onChange={(e) => setRule(i, { from_key: e.target.value.trim() || null })}
                    placeholder='staging'
                    aria-label='First environment key'
                    className='h-8 w-[120px] font-mono text-[12px]'
                  />
                  <span className='text-[12px] text-slate-500'>vs</span>
                  <Input
                    value={r.to_key ?? ''}
                    onChange={(e) => setRule(i, { to_key: e.target.value.trim() || null })}
                    placeholder='production'
                    aria-label='Second environment key'
                    className='h-8 w-[120px] font-mono text-[12px]'
                  />
                </>
              ) : (
                <Input
                  value={r.env_keys.join(', ')}
                  onChange={(e) => setRule(i, { env_keys: keyList(e.target.value) })}
                  placeholder='All environments'
                  aria-label={`Rule ${i + 1}: only these environment keys, comma separated`}
                  className='h-8 w-[180px] font-mono text-[12px] placeholder:font-sans'
                />
              )}
              <button
                type='button'
                className={cn(dangerGhost, 'ml-auto')}
                aria-label={`Remove rule ${i + 1}`}
                onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}
              >
                <Trash2 className='h-3.5 w-3.5' aria-hidden />
              </button>
            </div>
          ))}
          <button
            type='button'
            className={ghostButton}
            onClick={() => setDraft({ ...draft, rules: [...draft.rules, newRule(draft.rules)] })}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> Add rule
          </button>
        </section>

        <section className='space-y-2'>
          <h4 className='m-0 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
            Uptime targets
          </h4>
          <div className='flex flex-wrap items-center gap-2 text-[12px] text-slate-700 dark:text-foreground'>
            Default monthly target
            <Input
              type='number'
              step='0.01'
              min={50}
              max={100}
              value={draft.slo.default_target}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  slo: { ...draft.slo, default_target: Number(e.target.value) }
                })
              }
              aria-label='Default monthly target'
              className='h-8 w-[100px] text-[13px]'
            />
            %
          </div>
          <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-3'>
            {rows.map((r) => (
              <div
                key={r.environment_id}
                className='flex items-center gap-2 text-[12px] text-slate-700 dark:text-foreground'
              >
                <span className='w-[150px] min-w-0 truncate'>
                  {r.app_key}/{r.env_key}
                </span>
                <Input
                  type='number'
                  step='0.01'
                  min={50}
                  max={100}
                  value={draft.slo.targets[String(r.environment_id)] ?? ''}
                  placeholder={String(draft.slo.default_target)}
                  onChange={(e) => setTarget(r.environment_id, e.target.value)}
                  aria-label={`Target for ${r.app_key} ${r.env_key}`}
                  className='h-8 w-[100px] text-[13px]'
                />
              </div>
            ))}
          </div>
        </section>

        <div className='flex items-center gap-2 text-[12px] text-slate-700 dark:text-foreground'>
          <Switch
            id='hub-fleet-report'
            checked={draft.report_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, report_enabled: v })}
          />
          <label htmlFor='hub-fleet-report'>
            Send the monthly uptime report on the 1st (owners get their app, administrators the
            whole fleet, in-app and by email)
          </label>
        </div>
      </div>
    </SectionCard>
  )
}
