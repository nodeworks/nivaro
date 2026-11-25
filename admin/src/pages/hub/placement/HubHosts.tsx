import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatFileSize } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard } from '../hub-parts'
import {
  createRegion,
  deleteRegion,
  fetchPlacementMap,
  type Host,
  moveToHostPath,
  type PlacementMap,
  placeEnvironment,
  placementKeys,
  type Region,
  STACK_NAME_RE,
  setHostRegion,
  stackNameFor,
  updateRegion
} from './placement-api'

/**
 * Hosts (Apps hub tab, idea 48): the Docker hosts the Hub deploys to, grouped in regions, and
 * what runs on each. An environment with no placement is run on a host from here; one that runs
 * already moves to another host through its Move panel (a move between two stacks), never here.
 */
export default function HubHosts() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const map = useQuery({
    queryKey: placementKeys.map(),
    queryFn: fetchPlacementMap,
    enabled: isAdmin
  })
  const [adding, setAdding] = useState(false)

  if (!isAdmin)
    return (
      <div className='p-6 text-[13px] text-slate-600 dark:text-muted-foreground'>
        Hosts are for Hub administrators.
      </div>
    )

  const data = map.data
  const regions = data?.regions ?? []
  const hostCount = (data?.ungrouped.length ?? 0) + regions.reduce((n, r) => n + r.hosts.length, 0)

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description='A host is a Docker driver (one Hub agent and its swarm). Group hosts in regions to see where each app runs and to price them for chargeback.'
        actions={
          <button
            type='button'
            className={ghostButton}
            onClick={() => setAdding(true)}
            disabled={adding}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> New region
          </button>
        }
      />
      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          {adding && <RegionForm onDone={() => setAdding(false)} />}
          {map.isPending ? (
            <Skeleton className='h-48 w-full' />
          ) : map.isError ? (
            <QueryErrorState
              error={map.error}
              what='the hosts'
              onRetry={() => void map.refetch()}
            />
          ) : data ? (
            <>
              {hostCount === 0 && (
                <p className='m-0 rounded-lg border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  No Docker hosts yet. Add a Docker driver on the Drivers tab: each one is a host.
                </p>
              )}
              {regions.map((r) => (
                <RegionCard key={r.id} region={r} regions={regions} />
              ))}
              {data.ungrouped.length > 0 && (
                <SectionCard
                  title={regions.length ? 'Hosts in no region' : 'Hosts'}
                  description={
                    regions.length
                      ? 'Pick a region for each, so its apps are priced with that region’s factor.'
                      : 'Make a region to group them (a data centre, a cloud region, a rack).'
                  }
                >
                  <HostList hosts={data.ungrouped} regions={regions} />
                </SectionCard>
              )}
              {data.unplaced.length > 0 && <UnplacedCard data={data} />}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function useRefresh() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: placementKeys.all })
}

const pctText = (n: number | null) => (n == null ? '—' : `${Math.round(n)}%`)

function RegionCard({
  region,
  regions
}: {
  region: Region & { hosts: Host[] }
  regions: Region[]
}) {
  const [editing, setEditing] = useState(false)
  const refresh = useRefresh()
  const remove = useMutation({
    mutationFn: () => deleteRegion(region.id),
    onSuccess: () => {
      toast.success(`Region ${region.name} deleted; its hosts stay`)
      void refresh()
    },
    onError: (err) => hubToast(err, 'Could not delete the region')
  })
  if (editing) return <RegionForm region={region} onDone={() => setEditing(false)} />
  return (
    <SectionCard
      title={region.name}
      description={
        <>
          <span className='font-mono'>{region.key}</span>
          {' · '}
          {region.cost_percent === 100
            ? 'Priced at the rates as set'
            : `Priced at ${region.cost_percent}% of the rates`}
          {region.note ? ` · ${region.note}` : ''}
        </>
      }
      actions={
        <>
          <button type='button' className={ghostButton} onClick={() => setEditing(true)}>
            <Pencil className='h-3.5 w-3.5' aria-hidden /> Edit
          </button>
          <ConfirmButton
            title='Delete region'
            confirmLabel='Delete this region?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        </>
      }
    >
      {region.hosts.length ? (
        <HostList hosts={region.hosts} regions={regions} />
      ) : (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No host in this region yet. Pick it on a host below.
        </p>
      )}
    </SectionCard>
  )
}

function RegionForm({ region, onDone }: { region?: Region; onDone: () => void }) {
  const [key, setKey] = useState(region?.key ?? '')
  const [name, setName] = useState(region?.name ?? '')
  const [pct, setPct] = useState(String(region?.cost_percent ?? 100))
  const [note, setNote] = useState(region?.note ?? '')
  const refresh = useRefresh()
  const n = Number(pct)
  const pctBad = !Number.isInteger(n) || n < 1 || n > 1000
  const keyBad = !region && !/^[a-z][a-z0-9-]{1,40}$/.test(key)
  const save = useMutation({
    mutationFn: () =>
      region
        ? updateRegion(region.id, { name: name.trim(), note: note.trim() || null, cost_percent: n })
        : createRegion({ key, name: name.trim(), note: note.trim(), cost_percent: n }),
    onSuccess: () => {
      toast.success(region ? 'Region saved' : 'Region made')
      void refresh()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the region')
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!keyBad && !pctBad && name.trim()) save.mutate()
  }
  const id = region ? `region-${region.id}` : 'region-new'
  return (
    <SectionCard title={region ? `Edit ${region.name}` : 'New region'}>
      <form onSubmit={submit} className='grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4'>
        <Field
          id={`${id}-key`}
          label='Key'
          hint={region ? 'A region keeps its key.' : 'Lower-case letters, digits, dashes.'}
          error={key && keyBad ? 'Start with a letter; 2–41 characters.' : null}
        >
          <Input
            id={`${id}-key`}
            value={key}
            disabled={!!region}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            placeholder='eu-west'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field id={`${id}-name`} label='Name'>
          <Input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='EU West'
            className='h-8 text-[13px]'
          />
        </Field>
        <Field
          id={`${id}-pct`}
          label='Cost factor (%)'
          hint='100 = the chargeback rates as set.'
          error={pctBad ? 'A whole number, 1–1000.' : null}
        >
          <Input
            id={`${id}-pct`}
            inputMode='numeric'
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            className='h-8 text-[13px] tabular-nums'
          />
        </Field>
        <Field id={`${id}-note`} label='Note'>
          <Input
            id={`${id}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Frankfurt, rack 4'
            className='h-8 text-[13px]'
          />
        </Field>
        <div className='flex gap-2 sm:col-span-2 lg:col-span-4'>
          <Button
            type='submit'
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={save.isPending || keyBad || pctBad || !name.trim()}
          >
            {save.isPending ? 'Saving…' : region ? 'Save' : 'Make region'}
          </Button>
          <button type='button' className={ghostButton} onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </SectionCard>
  )
}

function HostList({ hosts, regions }: { hosts: Host[]; regions: Region[] }) {
  return (
    <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
      {hosts.map((h) => (
        <HostRow key={h.driver_id} host={h} regions={regions} />
      ))}
    </ul>
  )
}

function HostRow({ host, regions }: { host: Host; regions: Region[] }) {
  const refresh = useRefresh()
  const [labelOpen, setLabelOpen] = useState(false)
  const [label, setLabel] = useState(host.label ?? '')
  const save = useMutation({
    mutationFn: (v: { region: number | null; label: string | null }) =>
      setHostRegion(host.driver_id, v.region, v.label),
    onSuccess: () => {
      setLabelOpen(false)
      void refresh()
    },
    onError: (err) => hubToast(err, 'Could not change the host')
  })
  const f = host.figures
  return (
    <li className='grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] lg:items-start'>
      <div className='min-w-0'>
        <p className='m-0 flex min-w-0 items-center gap-2 text-[13px] font-medium text-slate-900 dark:text-foreground'>
          <Server className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
          <span className='truncate'>{host.name}</span>
          {host.label && (
            <span className='truncate text-[12px] font-normal text-slate-500 dark:text-muted-foreground'>
              {host.label}
            </span>
          )}
        </p>
        <p className='m-0 mt-1 text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {f.sampled_at
            ? `CPU ${pctText(f.cpu_pct)} of a core · memory ${f.memory_mb == null ? '—' : formatFileSize(f.memory_mb * 1024 * 1024)} · files ${f.storage_bytes == null ? '—' : formatFileSize(f.storage_bytes)}`
            : 'No capacity sample in the last 2 hours'}
        </p>
      </div>
      <div className='min-w-0'>
        {host.environments.length === 0 && host.shared.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing runs here yet.
          </p>
        ) : (
          <ul className='m-0 flex list-none flex-col gap-1 p-0'>
            {host.environments.map((e) => (
              <li key={e.env_id} className='flex min-w-0 items-center gap-2 text-[12px]'>
                <Link
                  to={`/hub?app=${e.app_id}`}
                  className='min-w-0 truncate font-medium text-slate-800 hover:underline dark:text-foreground'
                >
                  {e.app_name} · {e.env_key}
                </Link>
                <HubEnvTag envKey={e.env_key} />
                {e.stack && (
                  <span className='truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {e.stack}
                  </span>
                )}
                <Link
                  to={moveToHostPath(e.app_id, e.env_id, host.driver_id)}
                  data-tip='Plan a move of this environment to another host'
                  className={cn(ghostButton, 'ml-auto h-6 px-1.5 text-[11.5px]')}
                >
                  <ArrowRightLeft className='h-3 w-3' aria-hidden /> Move…
                </Link>
              </li>
            ))}
            {host.shared.map((s) => (
              <li key={`s${s.id}`} className='flex min-w-0 items-center gap-2 text-[12px]'>
                <Link
                  to={`/hub/shared?shared=${s.id}`}
                  className='min-w-0 truncate font-medium text-slate-800 hover:underline dark:text-foreground'
                >
                  Shared {s.key}
                </Link>
                <span className='text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                  {s.apps} {s.apps === 1 ? 'app' : 'apps'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        <SimpleSelect
          value={host.region_id == null ? '' : String(host.region_id)}
          onChange={(v) => save.mutate({ region: v ? Number(v) : null, label: host.label })}
          options={[
            { value: '', label: 'No region' },
            ...regions.map((r) => ({ value: String(r.id), label: r.name }))
          ]}
          ariaLabel={`Region of ${host.name}`}
          disabled={save.isPending || (regions.length === 0 && host.region_id == null)}
          className='h-8 w-[150px] text-left text-[12px]'
        />
        {labelOpen ? (
          <form
            className='flex items-center gap-1'
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate({ region: host.region_id, label: label.trim() || null })
            }}
          >
            <Input
              aria-label={`Label of ${host.name}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='rack 4'
              className='h-8 w-[130px] text-[12px]'
              disabled={host.region_id == null}
            />
            <button type='submit' className={ghostButton} disabled={save.isPending}>
              Save
            </button>
          </form>
        ) : (
          host.region_id != null && (
            <button
              type='button'
              className={ghostButton}
              onClick={() => setLabelOpen(true)}
              aria-label={`Edit the label of ${host.name}`}
            >
              <Pencil className='h-3.5 w-3.5' aria-hidden /> Label
            </button>
          )
        )}
      </div>
    </li>
  )
}

function UnplacedCard({ data }: { data: PlacementMap }) {
  const hosts = [
    ...data.regions.flatMap((r) => r.hosts.map((h) => ({ h, region: r.name }))),
    ...data.ungrouped.map((h) => ({ h, region: null }))
  ]
  return (
    <SectionCard
      title='Not running anywhere yet'
      description='Environments with no placement. Pick the host each one runs on; deploy it after with Apply now on its row.'
    >
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {data.unplaced.map((e) => (
          <UnplacedRow key={e.env_id} env={e} hosts={hosts} />
        ))}
      </ul>
    </SectionCard>
  )
}

function UnplacedRow({
  env,
  hosts
}: {
  env: PlacementMap['unplaced'][number]
  hosts: Array<{ h: Host; region: string | null }>
}) {
  const refresh = useRefresh()
  const [driver, setDriver] = useState('')
  const [stack, setStack] = useState(() => stackNameFor(env.app_key, env.env_key))
  const stackBad = !STACK_NAME_RE.test(stack)
  const place = useMutation({
    mutationFn: () => placeEnvironment(env.env_id, Number(driver), stack),
    onSuccess: () => {
      toast.success(
        `${env.app_name} · ${env.env_key} runs on the host now. Deploy it with Apply now.`
      )
      void refresh()
    },
    onError: (err) => hubToast(err, 'Could not place the environment')
  })
  return (
    <li className='flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3'>
      <Link
        to={`/hub?app=${env.app_id}`}
        className='min-w-0 flex-[1_1_200px] truncate text-[13px] font-medium text-slate-800 hover:underline dark:text-foreground'
      >
        {env.app_name} · {env.env_key}
      </Link>
      <SimpleSelect
        value={driver}
        onChange={setDriver}
        options={[
          { value: '', label: 'Pick a host' },
          ...hosts.map(({ h, region }) => ({
            value: String(h.driver_id),
            label: region ? `${h.name} · ${region}` : h.name
          }))
        ]}
        ariaLabel={`Host for ${env.app_name} ${env.env_key}`}
        className='h-8 w-[200px] text-left text-[12px]'
      />
      <Input
        aria-label='Stack name'
        aria-invalid={stackBad}
        value={stack}
        onChange={(e) => setStack(e.target.value.toLowerCase())}
        className={cn('h-8 w-[180px] font-mono text-[12px]', stackBad && 'border-red-500')}
      />
      <Button
        type='button'
        size='sm'
        className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
        disabled={!driver || stackBad || place.isPending}
        onClick={() => place.mutate()}
      >
        {place.isPending ? 'Placing…' : 'Run here'}
      </Button>
    </li>
  )
}
