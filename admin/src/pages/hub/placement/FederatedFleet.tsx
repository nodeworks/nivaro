import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Network, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime } from '@/lib/utils'
import { HUB_MASK, hubToast } from '../hub-api'
import {
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  SecretInput,
  SectionCard,
  StatusChip
} from '../hub-parts'
import {
  checkPeer,
  createPeer,
  deletePeer,
  type FederatedRow,
  fetchFederatedFleet,
  fetchPeers,
  type Peer,
  type PeerFleet,
  peerLink,
  placementKeys,
  updatePeer
} from './placement-api'

/**
 * Other Hubs (Fleet tab, idea 50): apps of other Nivaro Hubs, read only, each tagged with the Hub
 * it comes from. This Hub reads them with an API key of that Hub (hub:read only) and never acts
 * there. Every field is the server's rebuilt copy (plain text, numbers, dates) and React escapes
 * it; the only link is the other Hub's own stored address + `/hub?app=<id>`.
 */
export function FederatedFleet() {
  const qc = useQueryClient()
  const peers = useQuery({ queryKey: placementKeys.peers(), queryFn: fetchPeers })
  const fleet = useQuery({
    queryKey: placementKeys.fleet(),
    queryFn: () => fetchFederatedFleet(false),
    enabled: (peers.data?.length ?? 0) > 0,
    staleTime: 60_000
  })
  const [managing, setManaging] = useState(false)
  const refresh = useMutation({
    mutationFn: () => fetchFederatedFleet(true),
    onSuccess: (d) => qc.setQueryData(placementKeys.fleet(), d),
    onError: (err) => hubToast(err, 'Could not read the other Hubs')
  })

  const list = peers.data ?? []
  return (
    <SectionCard
      title='Other Hubs'
      description='Apps other Nivaro Hubs look after, read only. Nothing here acts on another Hub.'
      actions={
        <>
          {list.length > 0 && (
            <button
              type='button'
              className={ghostButton}
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')}
                aria-hidden
              />
              {refresh.isPending ? 'Reading…' : 'Read now'}
            </button>
          )}
          <button
            type='button'
            className={ghostButton}
            aria-expanded={managing}
            onClick={() => setManaging((v) => !v)}
          >
            <Network className='h-3.5 w-3.5' aria-hidden />
            {managing ? 'Done' : list.length ? 'Manage Hubs' : 'Add a Hub'}
          </button>
        </>
      }
    >
      {managing && <PeerManager peers={list} />}
      {peers.isPending ? (
        <Skeleton className='m-4 h-16' />
      ) : peers.isError ? (
        <div className='p-4'>
          <QueryErrorState
            error={peers.error}
            what='the other Hubs'
            onRetry={() => void peers.refetch()}
          />
        </div>
      ) : list.length === 0 ? (
        !managing && (
          <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No other Hub yet. Add one with an API key made on it that has the hub:read scope.
          </p>
        )
      ) : fleet.isPending ? (
        <Skeleton className='m-4 h-24' />
      ) : fleet.isError ? (
        <div className='p-4'>
          <QueryErrorState
            error={fleet.error}
            what='the other Hubs’ apps'
            onRetry={() => void fleet.refetch()}
          />
        </div>
      ) : (
        <div className='divide-y divide-slate-100 dark:divide-border'>
          {(fleet.data ?? []).map((p) => (
            <PeerBlock key={p.peer_id} p={p} />
          ))}
          {(fleet.data ?? []).length === 0 && (
            <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Every other Hub is paused.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  )
}

const stateChip = (r: FederatedRow) =>
  r.state === 'ok' ||
  r.state === 'degraded' ||
  r.state === 'unreachable' ||
  r.state === 'link_refused'
    ? r.state
    : null

function PeerBlock({ p }: { p: PeerFleet }) {
  return (
    <div className='px-4 py-3'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
        <span className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:border-border dark:bg-muted dark:text-foreground'>
          <Network className='h-3 w-3' aria-hidden />
          {p.name}
        </span>
        <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {(p.base_url ?? '').replace(/^https?:\/\//, '')}
        </span>
        <span className='text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
          {p.version ? `runs ${p.version}` : ''}
          {p.fetched_at ? ` · read ${formatDateTime(p.fetched_at)}` : ''}
        </span>
      </div>
      {!p.ok && (
        <p role='status' className='m-0 mt-2 text-[12px] text-amber-800 dark:text-amber-300'>
          {p.stale ? 'Showing the last answer. ' : ''}
          {p.error_text ?? 'The other Hub could not be read.'}
        </p>
      )}
      {p.rows.length > 0 ? (
        <div className='mt-2 overflow-x-auto'>
          <table className='w-full min-w-[720px] text-[12px]'>
            <thead className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
              <tr>
                <th className='py-1.5 pr-3 font-medium'>App / environment</th>
                <th className='py-1.5 pr-3 font-medium'>Version</th>
                <th className='py-1.5 pr-3 font-medium'>Health</th>
                <th className='py-1.5 pr-3 text-right font-medium'>Uptime 30 d</th>
                <th className='py-1.5 pr-3 text-right font-medium'>Open issues</th>
                <th className='py-1.5 pr-3 font-medium'>Placement</th>
                <th className='py-1.5 font-medium'>
                  <span className='sr-only'>Open on that Hub</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => {
                const href = peerLink(p.link_base, r.path)
                const chip = stateChip(r)
                return (
                  <tr
                    key={r.environment_id}
                    className='border-t border-slate-100 dark:border-border'
                  >
                    <td className='max-w-[280px] py-1.5 pr-3'>
                      <span className='block truncate font-medium text-slate-800 dark:text-foreground'>
                        {r.app_name} / {r.env_key}
                      </span>
                      {r.host && (
                        <span className='block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {r.host}
                        </span>
                      )}
                    </td>
                    <td className='py-1.5 pr-3 tabular-nums text-slate-700 dark:text-foreground'>
                      <span className='font-mono'>{r.version ?? '—'}</span>
                      {r.behind ? (
                        <span className='ml-1 text-slate-500 dark:text-muted-foreground'>
                          {r.behind} behind
                        </span>
                      ) : null}
                    </td>
                    <td className='py-1.5 pr-3'>
                      {chip ? (
                        <StatusChip state={chip} compact glyph />
                      ) : (
                        <span className='text-slate-400'>—</span>
                      )}
                    </td>
                    <td className='py-1.5 pr-3 text-right tabular-nums'>
                      {r.uptime_30d == null ? '—' : `${r.uptime_30d}%`}
                    </td>
                    <td className='py-1.5 pr-3 text-right tabular-nums'>{r.open_issues ?? '—'}</td>
                    <td className='py-1.5 pr-3 text-slate-600 dark:text-muted-foreground'>
                      {r.placement === 'shared'
                        ? 'Shared'
                        : r.placement === 'dedicated'
                          ? 'Dedicated'
                          : r.placement === 'none'
                            ? 'Not placed'
                            : '—'}
                    </td>
                    <td className='py-1.5 text-right'>
                      {href && (
                        <a
                          href={href}
                          target='_blank'
                          rel='noopener noreferrer'
                          aria-label={`Open ${r.app_name} on ${p.name}`}
                          data-tip={`Open on ${p.name}`}
                          className='inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted'
                        >
                          <ExternalLink className='h-3.5 w-3.5' aria-hidden />
                        </a>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        p.ok && (
          <p className='m-0 mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
            The key sees no app on that Hub.
          </p>
        )
      )}
    </div>
  )
}

function PeerManager({ peers }: { peers: Peer[] }) {
  const [adding, setAdding] = useState(peers.length === 0)
  return (
    <div className='border-b border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-border dark:bg-muted/30'>
      <p className='m-0 mb-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
        On the other Hub, make an API key with the hub:read scope only (a key that can change it is
        refused). This Hub keeps it sealed and only ever reads two things with it: which Hub
        answers, and its fleet.
      </p>
      <ul className='m-0 list-none divide-y divide-slate-200 border-y border-slate-200 p-0 dark:divide-border dark:border-border'>
        {peers.map((p) => (
          <PeerRow key={p.id} peer={p} />
        ))}
      </ul>
      {adding ? (
        <PeerForm onDone={() => setAdding(false)} />
      ) : (
        <button type='button' className={cn(ghostButton, 'mt-2')} onClick={() => setAdding(true)}>
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add a Hub
        </button>
      )}
    </div>
  )
}

function useRefreshPeers() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: placementKeys.peers() })
    void qc.invalidateQueries({ queryKey: placementKeys.fleet() })
  }
}

function PeerRow({ peer }: { peer: Peer }) {
  const refresh = useRefreshPeers()
  const [editing, setEditing] = useState(false)
  const check = useMutation({
    mutationFn: () => checkPeer(peer.id),
    onSuccess: (d) => {
      if (d.fleet.ok) toast.success(`${peer.name} answered: ${d.fleet.rows.length} environments`)
      else toast.error(d.fleet.error_text ?? `${peer.name} could not be read`)
      refresh()
    },
    onError: (err) => hubToast(err, `Could not read ${peer.name}`)
  })
  const toggle = useMutation({
    mutationFn: () => updatePeer(peer.id, { enabled: !peer.enabled }),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not change the Hub')
  })
  const remove = useMutation({
    mutationFn: () => deletePeer(peer.id),
    onSuccess: refresh,
    onError: (err) => hubToast(err, 'Could not remove the Hub')
  })
  if (editing)
    return (
      <li>
        <PeerForm peer={peer} onDone={() => setEditing(false)} />
      </li>
    )
  return (
    <li className='flex flex-wrap items-center gap-x-3 gap-y-1 py-2'>
      <span className='min-w-0 flex-[1_1_220px]'>
        <span className='block truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {peer.name}
          {!peer.enabled && (
            <span className='ml-2 text-[11px] font-normal text-slate-500'>paused</span>
          )}
        </span>
        <span className='block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {peer.base_url}
        </span>
        <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
          {peer.last_error
            ? `Last read failed (${peer.last_error.replace(/_/g, ' ').toLowerCase()})`
            : peer.last_ok_at
              ? `Last read ${formatDateTime(peer.last_ok_at)} · ${peer.last_count ?? 0} environments`
              : 'Not read yet'}
        </span>
      </span>
      <span className='flex flex-wrap items-center gap-1'>
        <button
          type='button'
          className={ghostButton}
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', check.isPending && 'animate-spin')} aria-hidden />
          Check
        </button>
        <button
          type='button'
          className={ghostButton}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {peer.enabled ? 'Pause' : 'Resume'}
        </button>
        <button type='button' className={ghostButton} onClick={() => setEditing(true)}>
          <Pencil className='h-3.5 w-3.5' aria-hidden /> Edit
        </button>
        <ConfirmButton
          title='Remove this Hub'
          confirmLabel='Remove?'
          className={dangerGhost}
          armedClassName={dangerArmed}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          <Trash2 className='h-3.5 w-3.5' aria-hidden /> Remove
        </ConfirmButton>
      </span>
    </li>
  )
}

function PeerForm({ peer, onDone }: { peer?: Peer; onDone: () => void }) {
  const refresh = useRefreshPeers()
  const [name, setName] = useState(peer?.name ?? '')
  const [url, setUrl] = useState(peer?.base_url ?? '')
  const [token, setToken] = useState(peer ? HUB_MASK : '')
  const urlBad = !/^https?:\/\/[^/\s?#]+\/?$/i.test(url.trim())
  const urlChanged = !!peer && url.trim().replace(/\/$/, '') !== peer.base_url
  const tokenMissing = (!peer || urlChanged) && (token === '' || token === HUB_MASK)
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        base_url: url.trim(),
        ...(token !== HUB_MASK ? { token } : {})
      }
      return peer ? updatePeer(peer.id, body) : createPeer(body as Required<typeof body>)
    },
    onSuccess: () => {
      toast.success(peer ? 'Hub saved' : 'Hub added: its key reads only')
      refresh()
      onDone()
    },
    onError: (err) => hubToast(err, peer ? 'Could not save the Hub' : 'Could not add the Hub')
  })
  const id = peer ? `peer-${peer.id}` : 'peer-new'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!urlBad && !tokenMissing && name.trim()) save.mutate()
  }
  return (
    <form onSubmit={submit} className='grid gap-3 py-3 sm:grid-cols-3'>
      <Field id={`${id}-name`} label='Name'>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='EU Hub'
          className='h-8 text-[13px]'
        />
      </Field>
      <Field
        id={`${id}-url`}
        label='Address'
        hint='Its https origin, no path.'
        error={url && urlBad ? 'An origin like https://hub.example.com' : null}
      >
        <Input
          id={`${id}-url`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder='https://hub.example.com'
          className='h-8 font-mono text-[13px]'
        />
      </Field>
      <Field
        id={`${id}-token`}
        label='API key (hub:read)'
        hint={
          urlChanged
            ? 'A new address needs the key again.'
            : peer
              ? 'Leave it to keep the stored key.'
              : 'Made on the other Hub. Never shown again.'
        }
      >
        <SecretInput
          id={`${id}-token`}
          value={token}
          onChange={setToken}
          stored={!!peer?.token && !urlChanged}
          placeholder='nvk_…'
        />
      </Field>
      <div className='flex gap-2 sm:col-span-3'>
        <Button
          type='submit'
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={save.isPending || urlBad || tokenMissing || !name.trim()}
        >
          {save.isPending ? 'Checking the key…' : peer ? 'Save' : 'Add Hub'}
        </Button>
        <button type='button' className={ghostButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
