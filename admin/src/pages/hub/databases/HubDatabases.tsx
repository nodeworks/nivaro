import { type ErrorDescription, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Cloud, Database, Plus, Server } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { countLabel, ghostButton, ListPaneHeader, listPaneClass } from '../hub-parts'
import { LinkedChange } from '../providers/ChangeView'
import { ProviderHome } from '../providers/ProviderHome'
import { fetchResources, providerKeys } from '../providers/providers-api'
import { resourceLabel } from '../providers/ResourcePickers'
import { AdoptDatabaseForm, DatabaseDetail, DbStatusChip, environmentWords } from './DatabaseDetail'
import { DbServerForm } from './DbServerForm'
import {
  createSqliteDatabase,
  dbError,
  dbKeys,
  ENGINE_LABEL,
  linkWords,
  MODE_LABEL,
  useDatabases,
  useDbServers
} from './db-api'

/**
 * Databases (Hub tab, administrators): the database servers the Hub knows, the databases
 * recorded on them and which app environment uses each. Owners reach their own database only
 * from the app's creation panel, never from here.
 */
const DATA = ['data']

export default function HubDatabases() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin) return <AdminsOnly />
  return <DatabasesAdmin />
}

/**
 * An app owner's Databases: the databases and caches their apps hold at providers, with state,
 * drift and cost. The Hub's own servers and records are for administrators; an owner reaches
 * their app's database from the app's page.
 */
function AdminsOnly() {
  return (
    <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
      <div className='space-y-4 p-4 sm:p-6'>
        <LinkedChange isAdmin={false} />
        <p className='m-0 max-w-[72ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          Only administrators manage database servers and the Hub’s own database records. What your
          apps hold at a provider is below; your app’s database is on the app’s page.
        </p>
        <ProviderHome groups={DATA} isAdmin={false} idPrefix='hub-home-data' />
      </div>
    </div>
  )
}

const status = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status

function DatabasesAdmin() {
  const servers = useDbServers()
  const dbs = useDatabases()
  // Linked servers say what they are ("Neon branch main"); a failed read just leaves the chip off.
  const linked = useQuery({
    queryKey: providerKeys.resources({}),
    queryFn: () => fetchResources({}),
    enabled: !!servers.data?.some((s) => s.resource_id != null)
  })
  const linkOf = (s: { resource_id?: number | null }) => {
    const r = s.resource_id == null ? null : linked.data?.find((x) => x.id === s.resource_id)
    return r && !r.deleted_at ? linkWords(r.type, resourceLabel(r)) : null
  }
  const [params, setParams] = useSearchParams()
  const serverId = Number(params.get('server')) || null
  const dbId = Number(params.get('db')) || null
  const creating = params.get('new') // 'server' | 'adopt' | 'sqlite'
  // The provider half (Neon, RDS, Azure SQL…): the right side while nothing is picked; on a
  // phone, where the two sides take turns, its own row opens it.
  const atProviders = params.get('at') === 'providers'
  const show = (next: {
    server?: number | null
    db?: number | null
    create?: 'server' | 'adopt' | 'sqlite'
    providers?: boolean
  }) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      out.delete('server')
      out.delete('db')
      out.delete('new')
      out.delete('at')
      if (next.providers) out.set('at', 'providers')
      if (next.server) out.set('server', String(next.server))
      if (next.db) out.set('db', String(next.db))
      if (next.create) out.set('new', next.create)
      return out
    })
  if (status(servers.error) === 403 || status(dbs.error) === 403) return <AdminsOnly />

  const currentServer = servers.data?.find((s) => s.id === serverId) ?? null
  const picked = !!creating || currentServer != null || dbId != null
  const detailOpen = picked || atProviders

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside className={cn(listPaneClass, detailOpen ? 'hidden' : 'flex')}>
        <div className='border-b border-slate-200 p-2 md:hidden dark:border-border'>
          <Row active={false} onClick={() => show({ providers: true })}>
            <span className='flex items-center gap-1.5 text-[13px] font-medium text-slate-900 dark:text-foreground'>
              <Cloud
                className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
                aria-hidden
              />
              At providers
            </span>
            <span className='mt-0.5 block text-[11px] text-slate-500 dark:text-muted-foreground'>
              Neon, RDS, Azure SQL and caches, with their accounts
            </span>
          </Row>
        </div>
        <ListHeader
          label={countLabel(servers.data?.length, 'server', 'servers')}
          action='New server'
          active={creating === 'server'}
          onAction={() => show({ create: 'server' })}
        />
        {servers.isPending ? (
          <ListSkeleton />
        ) : servers.isError ? (
          <QueryErrorState
            error={servers.error}
            what='the servers'
            onRetry={() => void servers.refetch()}
            className='m-3'
          />
        ) : servers.data.length === 0 ? (
          <Empty>No database servers yet. Add one so apps can get a database.</Empty>
        ) : (
          <ul className='m-0 list-none space-y-0.5 p-2'>
            {servers.data.map((s) => (
              <Row
                key={s.id}
                active={s.id === serverId && !creating}
                onClick={() => show({ server: s.id })}
              >
                <span className='flex items-center gap-1.5 truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  <Server
                    className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
                    aria-hidden
                  />
                  <span className='truncate'>{s.name}</span>
                </span>
                <span className='mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {ENGINE_LABEL[s.engine]}
                  <span className='rounded-full border border-slate-200 px-1.5 py-px text-[10px] dark:border-border'>
                    {MODE_LABEL[s.provision_mode]}
                  </span>
                  {linkOf(s) && <span className='truncate'>{linkOf(s)}</span>}
                </span>
              </Row>
            ))}
          </ul>
        )}

        <ListHeader
          label={countLabel(dbs.data?.length, 'database', 'databases')}
          action='Adopt'
          actionLabel='Adopt a database'
          active={creating === 'adopt'}
          onAction={() => show({ create: 'adopt' })}
          extra={{
            action: 'SQLite',
            actionLabel: 'New SQLite database',
            active: creating === 'sqlite',
            onAction: () => show({ create: 'sqlite' })
          }}
        />
        {dbs.isPending ? (
          <ListSkeleton />
        ) : dbs.isError ? (
          <QueryErrorState
            error={dbs.error}
            what='the databases'
            onRetry={() => void dbs.refetch()}
            className='m-3'
          />
        ) : dbs.data.length === 0 ? (
          <Empty>No databases recorded yet.</Empty>
        ) : (
          <ul className='m-0 list-none space-y-0.5 p-2'>
            {dbs.data.map((d) => (
              <Row
                key={d.id}
                active={d.id === dbId && !creating}
                onClick={() => show({ db: d.id })}
              >
                <span className='flex items-center gap-1.5 text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  <Database
                    className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
                    aria-hidden
                  />
                  <span className='truncate font-mono'>{d.database_name}</span>
                </span>
                <span className='mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {ENGINE_LABEL[d.engine]}
                  <DbStatusChip status={d.status} />
                  <span>{environmentWords(d)}</span>
                </span>
              </Row>
            ))}
          </ul>
        )}
      </aside>

      <div
        className={cn(
          'relative min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          detailOpen ? 'block' : 'hidden md:block'
        )}
      >
        {detailOpen && (
          <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
            <button type='button' className={ghostButton} onClick={() => show({})}>
              <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All databases
            </button>
          </div>
        )}
        {creating === 'server' ? (
          <DbServerForm
            key='new'
            server={null}
            onSaved={(id) => show({ server: id })}
            onCancel={() => show({})}
          />
        ) : creating === 'adopt' ? (
          <AdoptDatabaseForm onAdopted={(id) => show({ db: id })} onCancel={() => show({})} />
        ) : creating === 'sqlite' ? (
          <SqliteDatabaseForm onMade={(id) => show({ db: id })} onCancel={() => show({})} />
        ) : currentServer ? (
          <DbServerForm
            key={currentServer.id}
            server={currentServer}
            onSaved={() => {}}
            onCancel={() => show({})}
            onDeleted={() => show({})}
          />
        ) : dbId ? (
          <DatabaseDetail key={dbId} id={dbId} onDeleted={() => show({})} />
        ) : (
          <div className='space-y-4 p-4 sm:p-6'>
            <LinkedChange isAdmin />
            <p className='m-0 max-w-[72ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
              Pick a server or a database on the left: servers are where new apps get their
              database, and a database shows its last check. Databases and caches held at a provider
              are below, with the accounts they are in.
            </p>
            <ProviderHome groups={DATA} isAdmin idPrefix='hub-home-data' />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 0.3.215: record a SQLite app's database. Nothing to fill in: the record names the file
 * (app.sqlite) a shared deployment of size small keeps in the app's own folder of its volume.
 */
function SqliteDatabaseForm({
  onMade,
  onCancel
}: {
  onMade: (id: number) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const make = useMutation({
    mutationFn: createSqliteDatabase,
    onSuccess: (d) => {
      setFailure(null)
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onMade(d.id)
    },
    onError: (err) => setFailure(dbError(err, 'Could not record the SQLite database'))
  })
  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[760px] space-y-5'>
        <div>
          <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            New SQLite database
          </h2>
          <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            For a small app on a shared deployment, without a database server. The deployment keeps
            the app's database as one file in the app's own folder of its volume.
          </p>
        </div>
        <ul className='m-0 list-disc space-y-1.5 rounded-lg border border-slate-200 bg-white py-3 pr-4 pl-8 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
          <li>
            Only a Docker shared deployment of size small (one process, 0.3.215 or later) serves it:
            SQLite allows one writer process. That deployment then stays small while the app is on
            it.
          </li>
          <li>Use it by placing a new environment on that deployment and picking this record.</li>
          <li>
            A move carries the file: into a small shared deployment, or out to a Docker stack of
            size small. The old home is frozen while it is copied and checked.
          </li>
        </ul>
        {failure != null && <ErrorNotice description={failure} />}
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={make.isPending}
            onClick={() => make.mutate()}
          >
            {make.isPending ? 'Recording…' : 'Record a SQLite database'}
          </Button>
          <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

interface HeaderAction {
  action: string
  /** The full name screen readers and the tooltip give a short label. */
  actionLabel?: string
  active: boolean
  onAction: () => void
}

function ListHeader({
  label,
  extra,
  ...main
}: HeaderAction & { label: string; extra?: HeaderAction }) {
  return (
    <ListPaneHeader
      className='border-t first:border-t-0'
      label={label}
      actions={[main, ...(extra ? [extra] : [])].map((a) => (
        <button
          key={a.action}
          type='button'
          aria-label={a.actionLabel}
          data-tip={a.actionLabel}
          aria-pressed={a.active}
          className={cn(ghostButton, a.active && 'bg-accent')}
          onClick={a.onAction}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> {a.action}
        </button>
      ))}
    />
  )
}

function Row({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
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
        {children}
      </button>
    </li>
  )
}

const ListSkeleton = () => (
  <div className='space-y-2 p-3'>
    {[0, 1].map((i) => (
      <Skeleton key={i} className='h-12 w-full' />
    ))}
  </div>
)

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
    {children}
  </p>
)
