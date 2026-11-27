import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { fetchHubApps, type HubApp, hubKeys } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, SectionCard, ToneChip } from '../hub-parts'
import {
  createNotifyRoute,
  deleteNotifyRoute,
  fetchNotifyRoutes,
  type NotifyEventKey,
  type NotifyRoute,
  outputKeys,
  testNotifyRoute,
  updateNotifyRoute
} from './outputs-api'
import {
  fetchProviderTypes,
  fetchResources,
  type HubResource,
  providerKeys,
  providerToast,
  resourceName
} from './providers-api'

/**
 * Notify routes (Connections tab, administrators): Hub events — deploys, incidents, approvals,
 * drift, failed backups, expiring certificates — sent out through a resource that can send
 * (a Slack channel, a Teams webhook, a PagerDuty service). A route covers every app or one app.
 * Sends never hold the run that raised the event; each route shows its last send or failure.
 */
export function NotifyRoutesCard() {
  const qc = useQueryClient()
  const routes = useQuery({ queryKey: outputKeys.notifyRoutes(), queryFn: fetchNotifyRoutes })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const resources = useQuery({
    queryKey: providerKeys.resources({}),
    queryFn: () => fetchResources({})
  })
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const [adding, setAdding] = useState(false)
  // Sending types only (a Slack channel, a Teams webhook): never a database of the same provider.
  const sendingTypes = new Map(
    (types.data?.providers ?? [])
      .filter((p) => p.notify)
      .flatMap((p) => p.types.filter((t) => t.sends).map((t) => [t.key, t.label] as const))
  )
  const senderRows = (resources.data ?? []).filter(
    (r) => sendingTypes.has(r.type) && !!r.external_id && !r.deleted_at
  )
  const refresh = () => void qc.invalidateQueries({ queryKey: outputKeys.notifyRoutes() })
  const resourceOf = (id: number) => (resources.data ?? []).find((r) => r.id === id) ?? null
  const appName = (id: number | null) =>
    id == null ? null : ((apps.data ?? []).find((a) => a.id === id)?.name ?? `App ${id}`)

  return (
    <SectionCard
      title='Notify routes'
      description='Send Hub events to a channel outside the Hub — a Slack channel, a Teams webhook, a pager. The Hub’s own notices still reach people inside it.'
      actions={
        !adding && (
          <button
            type='button'
            className={ghostButton}
            disabled={senderRows.length === 0}
            data-tip={
              senderRows.length === 0
                ? 'Add a resource that can send (a Slack channel, a Teams webhook…) first'
                : undefined
            }
            onClick={() => setAdding(true)}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> New route
          </button>
        )
      }
    >
      {routes.isPending ? (
        <div className='space-y-1.5 px-4 py-3'>
          <Skeleton className='h-8 w-full' />
          <Skeleton className='h-8 w-3/4' />
        </div>
      ) : routes.isError ? (
        <div className='px-4 py-3'>
          <QueryErrorState
            error={routes.error}
            what='the notify routes'
            onRetry={() => void routes.refetch()}
          />
        </div>
      ) : (
        <>
          {routes.data.routes.length === 0 && !adding ? (
            <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
              No routes yet.{' '}
              {senderRows.length === 0
                ? 'Once a sending resource exists (a Slack channel, a Teams webhook…), route events to it here.'
                : 'Pick which events go to which sending resource.'}
            </p>
          ) : (
            <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {routes.data.routes.map((r) => (
                <RouteLine
                  key={r.id}
                  route={r}
                  eventLabel={(k) => routes.data.events.find((e) => e.key === k)?.label ?? k}
                  sender={resourceOf(r.resource_id)}
                  appName={appName(r.app_id)}
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
          {adding && (
            <RouteForm
              events={routes.data.events}
              senders={senderRows}
              typeLabel={(t) => sendingTypes.get(t) ?? t}
              apps={apps.data ?? []}
              onCancel={() => setAdding(false)}
              onSaved={() => {
                setAdding(false)
                refresh()
              }}
            />
          )}
        </>
      )}
    </SectionCard>
  )
}

function RouteLine({
  route: r,
  eventLabel,
  sender,
  appName,
  onChanged
}: {
  route: NotifyRoute
  eventLabel: (k: NotifyEventKey) => string
  sender: HubResource | null
  appName: string | null
  onChanged: () => void
}) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateNotifyRoute(r.id, { enabled }),
    onSuccess: onChanged,
    onError: (e) => providerToast(e, 'Could not change the route')
  })
  const remove = useMutation({
    mutationFn: () => deleteNotifyRoute(r.id),
    onSuccess: onChanged,
    onError: (e) => providerToast(e, 'Could not delete the route')
  })
  const test = useMutation({
    mutationFn: () => testNotifyRoute(r.id),
    onSuccess: (out) => {
      if (out.ok) toast.success('Test message sent')
      else toast.error('The test message was not sent', { description: out.error })
      onChanged()
    },
    onError: (e) => providerToast(e, 'Could not send the test message')
  })
  const title = r.name || (sender ? resourceName(sender) : `Resource ${r.resource_id}`)
  return (
    <li className='flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2.5'>
      <div className='min-w-0 flex-[1_1_260px]'>
        <p className='m-0 flex flex-wrap items-baseline gap-x-1.5'>
          <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            {title}
          </span>
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            {r.scope === 'hub' ? 'Every app' : appName}
            {sender && r.name ? ` · ${resourceName(sender)}` : ''}
          </span>
        </p>
        <p className='m-0 mt-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
          {r.events.map(eventLabel).join(', ')}
        </p>
        {r.last_error && (
          <p className='m-0 mt-0.5 text-[11.5px] text-red-700 dark:text-red-300'>
            Last send failed{r.last_error_at ? ` ${formatRelative(r.last_error_at)}` : ''}:{' '}
            {r.last_error}
          </p>
        )}
      </div>
      <div className='flex flex-wrap items-center gap-1'>
        {r.last_sent_at && !r.last_error ? (
          <ToneChip tone='ok' compact tip={formatDateTime(r.last_sent_at)}>
            Sent {formatRelative(r.last_sent_at)}
          </ToneChip>
        ) : r.last_error ? (
          <ToneChip tone='down' compact tip={r.last_error}>
            Failing
          </ToneChip>
        ) : (
          <ToneChip tone='neutral' compact tip='Nothing sent through it yet'>
            Not used yet
          </ToneChip>
        )}
        <button
          type='button'
          className={ghostButton}
          disabled={test.isPending || !r.enabled}
          data-tip={r.enabled ? 'Send one test message now' : 'Turn the route on to test it'}
          onClick={() => test.mutate()}
        >
          <Send className='h-3.5 w-3.5' aria-hidden /> {test.isPending ? 'Sending…' : 'Test'}
        </button>
        <span className='inline-flex h-8 items-center gap-1.5 px-1.5'>
          <Switch
            checked={r.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(v) => toggle.mutate(v)}
            aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${title}`}
          />
          <span className='text-[11.5px] text-slate-600 dark:text-slate-300'>
            {r.enabled ? 'On' : 'Off'}
          </span>
        </span>
        <ConfirmButton
          title={`Delete the route ${title}`}
          confirmLabel='Delete?'
          className={cn(dangerGhost, 'px-2')}
          armedClassName={dangerArmed}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          <Trash2 className='h-3.5 w-3.5' aria-hidden />
          <span className='sr-only'>Delete</span>
        </ConfirmButton>
      </div>
    </li>
  )
}

function RouteForm({
  events,
  senders,
  typeLabel,
  apps,
  onCancel,
  onSaved
}: {
  events: Array<{ key: NotifyEventKey; label: string }>
  senders: HubResource[]
  typeLabel: (type: string) => string
  apps: HubApp[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [resourceId, setResourceId] = useState(senders[0] ? String(senders[0].id) : '')
  const [scope, setScope] = useState<'hub' | string>('hub')
  const [picked, setPicked] = useState<Set<NotifyEventKey>>(
    new Set<NotifyEventKey>(['deploy.failed', 'incident.opened'])
  )
  const [name, setName] = useState('')
  const save = useMutation({
    mutationFn: () =>
      createNotifyRoute({
        name: name.trim() || null,
        scope: scope === 'hub' ? 'hub' : 'app',
        app_id: scope === 'hub' ? null : Number(scope),
        events: [...picked],
        resource_id: Number(resourceId)
      }),
    onSuccess: () => {
      toast.success('Route saved')
      onSaved()
    },
    onError: (e) => providerToast(e, 'Could not save the route')
  })
  const flip = (k: NotifyEventKey, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s)
      if (on) n.add(k)
      else n.delete(k)
      return n
    })
  return (
    <form
      className='space-y-3 border-t border-slate-200 px-4 py-3 dark:border-border'
      onSubmit={(e) => {
        e.preventDefault()
        if (resourceId && picked.size) save.mutate()
      }}
    >
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
        <Field id='notify-route-sender' label='Send through'>
          <SimpleSelect
            value={resourceId}
            onChange={setResourceId}
            ariaLabel='Send through'
            className='h-8 text-[13px]'
            options={senders.map((r) => ({
              value: String(r.id),
              label: `${resourceName(r)} · ${typeLabel(r.type)}`
            }))}
          />
        </Field>
        <Field id='notify-route-scope' label='For'>
          <SimpleSelect
            value={scope}
            onChange={setScope}
            ariaLabel='For'
            className='h-8 text-[13px]'
            options={[
              { value: 'hub', label: 'Every app' },
              ...apps.map((a) => ({ value: String(a.id), label: a.name || a.key }))
            ]}
          />
        </Field>
        <Field id='notify-route-name' label='Label' hint='Optional, e.g. “#ops alerts”.'>
          <Input
            id='notify-route-name'
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className='h-8 text-[13px]'
          />
        </Field>
      </div>
      <fieldset className='m-0 min-w-0 border-0 p-0'>
        <legend className='mb-1.5 p-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Events
        </legend>
        <div className='grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3'>
          {events.map((ev) => {
            const id = `notify-route-ev-${ev.key.replace('.', '-')}`
            return (
              <label
                key={ev.key}
                htmlFor={id}
                className='flex min-h-7 cursor-pointer items-center gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'
              >
                <Checkbox
                  id={id}
                  checked={picked.has(ev.key)}
                  onCheckedChange={(v) => flip(ev.key, v === true)}
                />
                {ev.label}
              </label>
            )
          })}
        </div>
      </fieldset>
      <div className='flex items-center justify-end gap-1'>
        <button type='button' className={ghostButton} onClick={onCancel}>
          Cancel
        </button>
        <Button
          type='submit'
          size='sm'
          className='h-8'
          disabled={!resourceId || picked.size === 0 || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save route'}
        </Button>
      </div>
    </form>
  )
}
