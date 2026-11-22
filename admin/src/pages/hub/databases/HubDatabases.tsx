import { QueryErrorState } from '@nivaro/shared'
import { ChevronLeft, Database, Plus, Server } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { ghostButton } from '../hub-parts'
import { AdoptDatabaseForm, DatabaseDetail, DbStatusChip, environmentWords } from './DatabaseDetail'
import { DbServerForm } from './DbServerForm'
import { ENGINE_LABEL, MODE_LABEL, useDatabases, useDbServers } from './db-api'

/**
 * Databases (Hub tab, administrators): the database servers the Hub knows, the databases
 * recorded on them and which app environment uses each. Owners reach their own database only
 * from the app's creation panel, never from here.
 */
export default function HubDatabases() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin) return <AdminsOnly />
  return <DatabasesAdmin />
}

function AdminsOnly() {
  return (
    <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
      <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
        Only administrators manage database servers and databases.
      </p>
    </div>
  )
}

const status = (e: unknown) => (e as { response?: { status?: number } } | null)?.response?.status

function DatabasesAdmin() {
  const servers = useDbServers()
  const dbs = useDatabases()
  const [params, setParams] = useSearchParams()
  const serverId = Number(params.get('server')) || null
  const dbId = Number(params.get('db')) || null
  const creating = params.get('new') // 'server' | 'adopt'
  const show = (next: {
    server?: number | null
    db?: number | null
    create?: 'server' | 'adopt'
  }) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      out.delete('server')
      out.delete('db')
      out.delete('new')
      if (next.server) out.set('server', String(next.server))
      if (next.db) out.set('db', String(next.db))
      if (next.create) out.set('new', next.create)
      return out
    })
  if (status(servers.error) === 403 || status(dbs.error) === 403) return <AdminsOnly />

  const currentServer = servers.data?.find((s) => s.id === serverId) ?? null
  const detailOpen = !!creating || currentServer != null || dbId != null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside
        className={cn(
          'w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white md:flex md:w-[300px] md:border-r dark:border-border dark:bg-card',
          detailOpen ? 'hidden' : 'flex'
        )}
      >
        <ListHeader
          label='Servers'
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
                </span>
              </Row>
            ))}
          </ul>
        )}

        <ListHeader
          label='Databases'
          action='Adopt a database'
          active={creating === 'adopt'}
          onAction={() => show({ create: 'adopt' })}
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
          'min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
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
          <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <Database className='h-5 w-5 text-slate-400 dark:text-muted-foreground' aria-hidden />
            </div>
            <p className='mt-3 mb-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
              Pick a server or a database
            </p>
            <p className='m-0 mt-1 max-w-[44ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              Servers are where new apps get their database. A database shows its last check and,
              while a DBA is making it, the checklist to hand over.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function ListHeader({
  label,
  action,
  active,
  onAction
}: {
  label: string
  action: string
  active: boolean
  onAction: () => void
}) {
  return (
    <div className='flex items-center gap-2 border-y border-slate-200 px-3 py-2 first:border-t-0 dark:border-border'>
      <p className='m-0 flex-1 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
      </p>
      <button type='button' className={cn(ghostButton, active && 'bg-accent')} onClick={onAction}>
        <Plus className='h-3.5 w-3.5' aria-hidden /> {action}
      </button>
    </div>
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
