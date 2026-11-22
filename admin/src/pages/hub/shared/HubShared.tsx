import {
  ConfirmButton,
  type ErrorDescription,
  ErrorNotice,
  isRawErrorText,
  QueryErrorState
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, Layers, Pencil, Plus, RefreshCw } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { HUB_MASK } from '../hub-api'
import { CopyButton, dangerArmed, dangerGhost, ghostButton, SectionCard } from '../hub-parts'
import { SharedDeploymentForm } from './SharedDeploymentForm'
import { SharedTokenReveal } from './SharedTokenReveal'
import { SharedUpgradePanel } from './SharedUpgradePanel'
import {
  deleteShared,
  extensionDrift,
  fetchShared,
  fetchSharedList,
  fetchSharedStatus,
  holdsLatest,
  linkProblem,
  MODE_WORDS,
  redisUrlStored,
  rotateSharedToken,
  SCHEMA_TONE,
  SCHEMA_WORDS,
  type SharedDeployment,
  type SharedDetail,
  type SharedLinkStatus,
  type SharedListRow,
  type SharedNote,
  type SharedRotated,
  STATUS_WORDS,
  schemaOf,
  sharedError,
  sharedKeys,
  TONE,
  type Tone,
  WARNING_COPY,
  WIRE_TONE,
  WIRE_WORDS
} from './shared-api'

/**
 * Shared deployments (Apps hub tab, administrators): one process — a Docker stack the Hub runs,
 * or one run elsewhere — serving many apps, each with its own database. The list on the left;
 * on the right the picked deployment: its token (shown once, then masked), the settings to run
 * it yourself, the apps it serves with their migration state, the replicas the Hub has seen and
 * whether each holds the latest list, warnings, and for a Docker deployment the upgrade panel.
 */
export default function HubShared() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin) return <AdminsOnly />
  return <SharedAdmin />
}

function AdminsOnly() {
  return (
    <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
      <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
        Only administrators manage shared deployments.
      </p>
    </div>
  )
}

const status = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status

/** A token shown this once, for one deployment (never stored anywhere else). */
interface Reveal {
  id: number
  token: string
  envBlock: string | null
  rotated?: Pick<SharedRotated, 'previous_token_valid_until' | 'reapply' | 'reapply_reason'>
}

function SharedAdmin() {
  const list = useQuery({ queryKey: sharedKeys.list(), queryFn: fetchSharedList })
  const [params, setParams] = useSearchParams()
  const pickedId = Number(params.get('shared')) || null
  const creating = params.get('new') === '1'
  const [reveal, setReveal] = useState<Reveal | null>(null)
  // Once means once: leaving the deployment it was shown for drops the token for good. (After a
  // create the URL reaches the new id a moment after the token arrives: wait until it was shown.)
  const shownAt = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal) {
      shownAt.current = null
      return
    }
    if (pickedId === reveal.id) shownAt.current = reveal.id
    else if (shownAt.current === reveal.id) setReveal(null)
  }, [reveal, pickedId])
  const [editing, setEditing] = useState<number | null>(null)
  const show = (next: { shared?: number | null; create?: boolean }) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      out.delete('shared')
      out.delete('new')
      if (next.shared) out.set('shared', String(next.shared))
      if (next.create) out.set('new', '1')
      return out
    })
  if (status(list.error) === 403) return <AdminsOnly />
  const detailOpen = creating || pickedId != null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white md:flex md:w-[300px] md:border-r dark:border-border dark:bg-card',
          detailOpen ? 'hidden' : 'flex'
        )}
      >
        <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
          <p className='m-0 flex-1 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
            Shared deployments
          </p>
          <button
            type='button'
            className={cn(ghostButton, creating && 'bg-accent')}
            onClick={() => show({ create: true })}
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> New
          </button>
        </div>
        {list.isPending ? (
          <div className='space-y-2 p-3'>
            {[0, 1].map((i) => (
              <Skeleton key={i} className='h-14 w-full' />
            ))}
          </div>
        ) : list.isError ? (
          <QueryErrorState
            error={list.error}
            what='the shared deployments'
            onRetry={() => void list.refetch()}
            className='m-3'
          />
        ) : list.data.length === 0 ? (
          <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            No shared deployments yet. Add one to serve several apps from one process.
          </p>
        ) : (
          <ul aria-label='Shared deployments' className='m-0 list-none space-y-0.5 p-2'>
            {list.data.map((row) => (
              <ListRow
                key={row.id}
                row={row}
                active={row.id === pickedId && !creating}
                onClick={() => {
                  setEditing(null)
                  show({ shared: row.id })
                }}
              />
            ))}
          </ul>
        )}
      </aside>

      <div
        className={cn(
          'min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          detailOpen ? 'block' : 'hidden md:block'
        )}
      >
        {detailOpen && (
          <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
            <button type='button' className={ghostButton} onClick={() => show({})}>
              <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All shared deployments
            </button>
          </div>
        )}
        {creating ? (
          <SharedDeploymentForm
            key='new'
            shared={null}
            onCreated={(c) => {
              setReveal({ id: c.row.id, token: c.token, envBlock: c.env_block })
              show({ shared: c.row.id })
            }}
            onCancel={() => show({})}
          />
        ) : pickedId != null ? (
          <SharedDetailView
            key={pickedId}
            id={pickedId}
            editing={editing === pickedId}
            onEdit={(on) => setEditing(on ? pickedId : null)}
            reveal={reveal?.id === pickedId ? reveal : null}
            onReveal={setReveal}
            onRevealDone={() => setReveal(null)}
            onDeleted={() => show({})}
          />
        ) : (
          <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <Layers className='h-5 w-5 text-slate-400 dark:text-muted-foreground' aria-hidden />
            </div>
            <p className='mt-3 mb-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
              Pick a shared deployment
            </p>
            <p className='m-0 mt-1 max-w-[46ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              One process serving many apps, each with its own database. Pick one to see the apps it
              serves, its replicas and its token, or add a new one.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Chip({ tone, children, tip }: { tone: Tone; children: ReactNode; tip?: string }) {
  return (
    <span
      data-tip={tip}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium',
        TONE[tone]
      )}
    >
      {children}
    </span>
  )
}

function ListRow({
  row,
  active,
  onClick
}: {
  row: SharedListRow
  active: boolean
  onClick: () => void
}) {
  const mode = MODE_WORDS[row.mode]
  return (
    <li>
      <button
        type='button'
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
          active ? 'bg-accent' : 'hover:bg-muted'
        )}
      >
        <span className='flex items-center gap-1.5'>
          <span className='min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {row.name}
          </span>
          {row.status === 'retired' && <Chip tone='quiet'>Retired</Chip>}
        </span>
        <span className='mt-0.5 block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {row.key}
        </span>
        <span className='mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
          <Chip tone='quiet' tip={mode.tip}>
            {mode.label}
          </Chip>
          <span className={row.version_pin ? 'font-mono' : undefined}>
            {row.version_pin ?? 'No version yet'}
          </span>
          <span>{row.apps === 1 ? '1 app' : `${row.apps} apps`}</span>
          <span
            data-tip={
              row.live_replicas === null
                ? 'The Hub could not read which processes it has seen'
                : 'Processes that asked for their list in the last 2 minutes'
            }
          >
            {row.live_replicas === null ? 'Replicas unknown' : `${row.live_replicas} live`}
          </span>
        </span>
      </button>
    </li>
  )
}

// ─── Detail ──────────────────────────────────────────────────────────────────────────────────

function SharedDetailView({
  id,
  editing,
  onEdit,
  reveal,
  onReveal,
  onRevealDone,
  onDeleted
}: {
  id: number
  editing: boolean
  onEdit: (on: boolean) => void
  reveal: Reveal | null
  onReveal: (r: Reveal) => void
  onRevealDone: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: sharedKeys.detail(id), queryFn: () => fetchShared(id) })
  const link = useQuery({
    queryKey: sharedKeys.status(id),
    queryFn: () => fetchSharedStatus(id),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const remove = useMutation({
    mutationFn: () => deleteShared(id),
    onSuccess: (r) => {
      setFailure(null)
      void qc.invalidateQueries({ queryKey: sharedKeys.list() })
      if (r.outcome === 'retired') {
        void qc.invalidateQueries({ queryKey: sharedKeys.detail(id) })
        toast.success('Retired: it has served apps, so its history is kept')
      } else {
        toast.success('Shared deployment deleted')
        onDeleted()
      }
    },
    onError: (e) => setFailure(sharedError(e, 'Could not delete the shared deployment'))
  })

  if (q.isPending)
    return (
      <div className='space-y-3 p-4 sm:p-6'>
        <Skeleton className='h-8 w-64' />
        <Skeleton className='h-28 w-full' />
        <Skeleton className='h-28 w-full' />
      </div>
    )
  if (q.isError)
    return (
      <QueryErrorState
        error={q.error}
        what='this shared deployment'
        onRetry={() => void q.refetch()}
        className='m-4'
      />
    )
  const d = q.data
  const row = d.row
  if (editing)
    return (
      <SharedDeploymentForm
        key={`edit-${row.id}`}
        shared={row}
        secrets={d.secrets}
        onSaved={() => onEdit(false)}
        onCancel={() => onEdit(false)}
      />
    )
  const retired = row.status === 'retired'
  const mode = MODE_WORDS[row.mode]

  return (
    <div className='space-y-4 p-4 sm:p-6'>
      <header className='flex flex-wrap items-start gap-3'>
        <div className='min-w-0 flex-[1_1_280px]'>
          <h2 className='m-0 truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            {row.name}
          </h2>
          <p className='m-0 mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            <span className='font-mono'>{row.key}</span>
            <Chip tone='quiet' tip={mode.tip}>
              {mode.label}
            </Chip>
            <Chip tone={retired ? 'quiet' : row.status === 'upgrading' ? 'busy' : 'ok'}>
              {STATUS_WORDS[row.status] ?? row.status}
            </Chip>
          </p>
        </div>
        {!retired && (
          <div className='flex flex-wrap items-center gap-1'>
            <button type='button' className={ghostButton} onClick={() => onEdit(true)}>
              <Pencil className='h-3.5 w-3.5' aria-hidden /> Edit
            </button>
            <ConfirmButton
              onConfirm={() => remove.mutate()}
              title='Delete'
              confirmLabel='Delete now?'
              disabled={remove.isPending}
              className={dangerGhost}
              armedClassName={cn(dangerGhost, dangerArmed)}
            >
              Delete
            </ConfirmButton>
          </div>
        )}
      </header>
      {failure && <ErrorNotice description={failure} />}
      {retired && (
        <p className='m-0 rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'>
          Retired: it keeps its history, but it serves no apps and can no longer be changed.
        </p>
      )}

      <MetaGrid detail={d} link={link.data} />

      <TokenCard
        row={row}
        detail={d}
        retired={retired}
        reveal={reveal}
        onReveal={onReveal}
        onRevealDone={onRevealDone}
      />

      {d.env_block && <RunItYourself block={d.env_block} />}

      <LinkCard
        link={link}
        onCheck={async () => {
          const fresh = await fetchSharedStatus(id, true)
          qc.setQueryData(sharedKeys.status(id), fresh)
        }}
      />

      <Warnings notes={warningsOf(d, link.data)} />

      <AppsCard detail={d} link={link.data} />

      <ReplicasCard detail={d} />

      {row.mode === 'docker' && !retired && <SharedUpgradePanel shared={row} />}
    </div>
  )
}

/** A card with an accessible name (a landmark screen readers can jump to). */
function Region({ label, children }: { label: string; children: ReactNode }) {
  return <section aria-label={label}>{children}</section>
}

/** A pin in a few words: a version as is, an image digest by its last characters. */
const pinWords = (pin: string) => (pin.includes('@sha256:') ? `digest …${pin.slice(-8)}` : pin)

function MetaGrid({ detail, link }: { detail: SharedDetail; link: SharedLinkStatus | undefined }) {
  const row = detail.row
  const pool = detail.apps.reduce((n, a) => n + (a.pool_max ?? 5), 0)
  const cells: { label: string; value: ReactNode; mono?: boolean }[] = [
    {
      label: 'Version',
      value: row.version_pin ?? (link?.state === 'ok' ? link.version : 'No version yet'),
      mono: true
    },
    { label: 'Link address', value: row.link_url, mono: true },
    { label: 'Host pattern', value: row.host_pattern ?? 'None', mono: !!row.host_pattern },
    {
      label: 'Connections',
      value: `${pool} of ${row.pool_budget}`
    },
    {
      label: 'Extensions',
      value: row.extensions.length
        ? row.extensions
            .map((x) => (row.extension_pins[x] ? `${x} (${pinWords(row.extension_pins[x])})` : x))
            .join(', ')
        : 'None',
      mono: row.extensions.length > 0
    },
    ...(row.mode === 'docker'
      ? [
          { label: 'Stack', value: row.stack ?? row.key, mono: true },
          {
            label: 'Redis',
            value:
              row.settings?.redis === 'external'
                ? redisUrlStored(detail.secrets)
                  ? 'External · address stored'
                  : 'External · no address yet'
                : 'Bundled'
          }
        ]
      : []),
    {
      label: 'Last seen',
      value: row.last_seen_at ? formatRelative(row.last_seen_at) : 'Not yet'
    },
    { label: 'Added', value: row.created_at ? formatDateTime(row.created_at) : '—' }
  ]
  return (
    <dl className='m-0 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-4 dark:border-border dark:bg-border'>
      {cells.map((c) => (
        <div key={c.label} className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
          <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{c.label}</dt>
          <dd
            className={cn(
              'm-0 mt-0.5 truncate text-[13px] text-slate-900 dark:text-foreground',
              c.mono && 'font-mono text-[12px]'
            )}
          >
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function TokenCard({
  row,
  detail,
  retired,
  reveal,
  onReveal,
  onRevealDone
}: {
  row: SharedDeployment
  detail: SharedDetail
  retired: boolean
  reveal: Reveal | null
  onReveal: (r: Reveal) => void
  onRevealDone: () => void
}) {
  const qc = useQueryClient()
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const rotate = useMutation({
    mutationFn: () => rotateSharedToken(row.id),
    // The answer holds the token: never kept in the mutation cache.
    gcTime: 0,
    onSuccess: (r) => {
      setFailure(null)
      onReveal({
        id: row.id,
        token: r.token,
        envBlock: r.env_block,
        rotated: {
          previous_token_valid_until: r.previous_token_valid_until,
          reapply: r.reapply,
          reapply_reason: r.reapply_reason
        }
      })
      void qc.invalidateQueries({ queryKey: sharedKeys.detail(row.id) })
      void qc.invalidateQueries({ queryKey: sharedKeys.status(row.id) })
    },
    onError: (e) => setFailure(sharedError(e, 'Could not rotate the token'))
  })
  return (
    <Region label='Deployment token'>
      <SectionCard
        title='Deployment token'
        description='The deployment and the Hub both use it: the deployment to read its list of apps, the Hub to call the deployment.'
        actions={
          !retired && !reveal ? (
            <ConfirmButton
              onConfirm={() => rotate.mutate()}
              title='Rotate token'
              confirmLabel='Rotate now?'
              disabled={rotate.isPending}
              className={ghostButton}
              armedClassName={cn(
                ghostButton,
                'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-950'
              )}
            >
              <RefreshCw className='h-3.5 w-3.5' aria-hidden /> Rotate
            </ConfirmButton>
          ) : null
        }
      >
        <div className='space-y-2 px-4 py-3'>
          {reveal ? (
            <SharedTokenReveal
              token={reveal.token}
              envBlock={reveal.envBlock}
              rotated={reveal.rotated}
              version={row.version_pin}
              onDone={onRevealDone}
            />
          ) : (
            <p className='m-0 flex items-center gap-2 text-[13px] text-slate-900 dark:text-foreground'>
              {row.token ? (
                <code className='font-mono'>{HUB_MASK}</code>
              ) : (
                <span className='text-slate-500 dark:text-muted-foreground'>No token stored</span>
              )}
            </p>
          )}
          {detail.previous_token_valid_until && !reveal && (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              The previous token keeps working until{' '}
              {formatDateTime(detail.previous_token_valid_until)}.
            </p>
          )}
          {failure && <ErrorNotice description={failure} />}
        </div>
      </SectionCard>
    </Region>
  )
}

function RunItYourself({ block }: { block: string }) {
  return (
    <Region label='Run it yourself'>
      <SectionCard
        title='Run it yourself'
        description='Set these on every process of the deployment. The token is the one shown when it was made or last rotated.'
        actions={<CopyButton value={block} label='Copy the settings' />}
      >
        <pre className='m-0 overflow-x-auto px-4 py-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-slate-800 dark:text-slate-200'>
          {block}
        </pre>
      </SectionCard>
    </Region>
  )
}

function LinkCard({
  link,
  onCheck
}: {
  link: { data?: SharedLinkStatus; isPending: boolean; isError: boolean; error: unknown }
  onCheck: () => Promise<void>
}) {
  const [checking, setChecking] = useState(false)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const check = async () => {
    setChecking(true)
    try {
      await onCheck()
      setFailure(null)
    } catch (e) {
      setFailure(sharedError(e, 'Could not check the deployment'))
    } finally {
      setChecking(false)
    }
  }
  const s = link.data
  return (
    <SectionCard
      title='Deployment link'
      description='What the deployment itself answers when the Hub calls it.'
      actions={
        <button type='button' className={ghostButton} disabled={checking} onClick={check}>
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden /> Check
          now
        </button>
      }
    >
      <div className='space-y-2 px-4 py-3 text-[12px]'>
        {link.isPending ? (
          <Skeleton className='h-5 w-64' />
        ) : link.isError ? (
          <ErrorNotice description={sharedError(link.error, 'Could not check the deployment')} />
        ) : s?.state === 'ok' ? (
          <p className='m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-700 dark:text-slate-300'>
            <Chip tone='ok'>Answering</Chip>
            <span>
              Version <span className='font-mono'>{s.version}</span>
            </span>
            <span>
              · {s.registry.count === 1 ? '1 app' : `${s.registry.count} apps`} in its list
            </span>
            <span className='text-slate-500 dark:text-muted-foreground'>
              · checked {formatRelative(s.checked_at)}
            </span>
          </p>
        ) : s ? (
          <div className='space-y-0.5'>
            <p className='m-0 flex items-center gap-2 font-medium text-red-700 dark:text-red-300'>
              <Chip tone='bad'>Not answering</Chip>
              {linkProblem(s.code).title}
            </p>
            {linkProblem(s.code).hint && (
              <p className='m-0 text-slate-600 dark:text-slate-300'>{linkProblem(s.code).hint}</p>
            )}
          </div>
        ) : null}
        {failure && <ErrorNotice description={failure} />}
      </div>
    </SectionCard>
  )
}

/** The detail's own warnings plus what the link answer shows (loaded extensions, its list). */
export function warningsOf(d: SharedDetail, link: SharedLinkStatus | undefined): SharedNote[] {
  const out: SharedNote[] = [...d.warnings]
  if (link?.state === 'ok') {
    const drift = extensionDrift(d.row.extensions, link.extensions)
    if (drift.missing.length || drift.extra.length) {
      const parts: string[] = []
      if (drift.missing.length) parts.push(`not loaded: ${drift.missing.join(', ')}`)
      if (drift.extra.length) parts.push(`loaded but not listed: ${drift.extra.join(', ')}`)
      out.push({ code: 'EXTENSIONS_DIFFER', text: parts.join('; ') })
    }
    if (link.registry.stale) out.push({ code: 'REGISTRY_STALE', text: '' })
    if (link.registry.dropped.length)
      out.push({
        code: 'APPS_DROPPED',
        text: link.registry.dropped.map((x) => `${x.id}: ${x.why}`).join('; ')
      })
  }
  return out
}

function Warnings({ notes }: { notes: SharedNote[] }) {
  if (notes.length === 0) return null
  return (
    <ul aria-label='Warnings' className='m-0 list-none space-y-1.5 p-0'>
      {notes.map((n, i) => {
        const c = WARNING_COPY[n.code]
        const detail = c && n.text && !isRawErrorText(n.text) ? n.text : null
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no id and a code may repeat
            key={`${i}-${n.code}`}
            className='flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40'
          >
            <AlertTriangle
              className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300'
              aria-hidden
            />
            <div className='min-w-0 text-[12px]'>
              <p className='m-0 font-medium text-amber-900 dark:text-amber-200'>
                {c?.title ?? n.text}
              </p>
              {detail && (
                <p className='m-0 mt-0.5 break-words font-mono text-[11.5px] text-amber-900/90 dark:text-amber-200/90'>
                  {detail}
                </p>
              )}
              {c?.hint && (
                <p className='m-0 mt-0.5 text-amber-900/80 dark:text-amber-200/80'>{c.hint}</p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function AppsCard({ detail, link }: { detail: SharedDetail; link: SharedLinkStatus | undefined }) {
  return (
    <SectionCard
      title='Apps'
      description='Every environment this deployment serves, with the state of its database on this version.'
    >
      {detail.apps.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No apps yet. Place a new environment here from its app's page.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table aria-label='Apps on this deployment' className='w-full text-[12px]'>
            <thead className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              <tr>
                <th className='px-4 py-1.5 font-medium'>App</th>
                <th className='px-3 py-1.5 font-medium'>Tenant id</th>
                <th className='px-3 py-1.5 font-medium'>Status</th>
                <th className='px-3 py-1.5 font-medium'>Database</th>
                <th className='px-3 py-1.5 text-right font-medium'>Pool max</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {detail.apps.map((a) => {
                const schema = schemaOf(link, a.tenant_id)
                return (
                  <tr key={a.env_id}>
                    <td className='px-4 py-1.5 text-slate-900 dark:text-foreground'>
                      {a.app_name}{' '}
                      <span className='text-slate-400 dark:text-muted-foreground'>/</span>{' '}
                      <span className='font-mono'>{a.env_key}</span>
                      {!a.placed_here && (
                        <span className='ml-1.5 text-[11px] text-sky-700 dark:text-sky-300'>
                          moving
                        </span>
                      )}
                    </td>
                    <td className='px-3 py-1.5 font-mono text-slate-600 dark:text-slate-300'>
                      {a.tenant_id}
                    </td>
                    <td className='px-3 py-1.5'>
                      <Chip tone={WIRE_TONE[a.status] ?? 'quiet'}>
                        {WIRE_WORDS[a.status] ?? a.status}
                      </Chip>
                    </td>
                    <td className='px-3 py-1.5'>
                      {schema ? (
                        <Chip
                          tone={SCHEMA_TONE[schema.state] ?? 'quiet'}
                          tip={
                            schema.error && !isRawErrorText(schema.error)
                              ? schema.error
                              : schema.state === 'failed'
                                ? "The deployment's status names the error"
                                : undefined
                          }
                        >
                          {SCHEMA_WORDS[schema.state] ?? schema.state}
                        </Chip>
                      ) : (
                        <span className='text-slate-400 dark:text-muted-foreground'>—</span>
                      )}
                    </td>
                    <td className='px-3 py-1.5 text-right font-mono text-slate-700 dark:text-slate-300'>
                      {a.pool_max ?? (
                        <span
                          data-tip='The default'
                          className='text-slate-400 dark:text-muted-foreground'
                        >
                          5
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

function ReplicasCard({ detail }: { detail: SharedDetail }) {
  const sightings = detail.sightings
  return (
    <SectionCard
      title='Replicas'
      description='Processes of this deployment that asked the Hub for their list in the last 2 minutes.'
    >
      {sightings === null ? (
        <p className='m-0 px-4 py-3 text-[12px] text-amber-800 dark:text-amber-300'>
          Unknown: the Hub could not read which processes it has seen.
        </p>
      ) : sightings.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No process asked for its list in the last 2 minutes.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table aria-label='Replicas' className='w-full text-[12px]'>
            <thead className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              <tr>
                <th className='px-4 py-1.5 font-medium'>Instance</th>
                <th className='px-3 py-1.5 font-medium'>Version</th>
                <th className='px-3 py-1.5 font-medium'>Holds the latest list</th>
                <th className='px-3 py-1.5 font-medium'>Seen</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {sightings.map((s) => {
                const holds = holdsLatest(s, detail.list_etag)
                return (
                  <tr key={s.instance}>
                    <td className='px-4 py-1.5 font-mono text-slate-900 dark:text-foreground'>
                      {s.instance}
                    </td>
                    <td className='px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300'>
                      {s.version ?? '—'}
                    </td>
                    <td className='px-3 py-1.5'>
                      {holds === null ? (
                        <span className='text-slate-500 dark:text-muted-foreground'>Unknown</span>
                      ) : holds ? (
                        <Chip tone='ok'>Yes</Chip>
                      ) : (
                        <Chip tone='warn' tip='It still serves an older list of apps'>
                          No
                        </Chip>
                      )}
                    </td>
                    <td className='px-3 py-1.5 text-slate-500 dark:text-muted-foreground'>
                      {formatRelative(s.at)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}
