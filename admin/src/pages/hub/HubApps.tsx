import { QueryErrorState, useOverflowTip } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { AppWindow, ChevronLeft, Plus } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { HubCreateApp } from './create/HubCreateApp'
import { HubAdoptForm } from './HubAdoptForm'
import { EnvStatusDot, HubAppDetail } from './HubAppDetail'
import { fetchHubApps, type HubApp, hubKeys, useHubApp } from './hub-api'
import { ghostButton } from './hub-parts'

/**
 * Apps (Hub tab): master-detail. The list names each app with its environments coloured by
 * live status; the right side is the picked app (`?app=<id>`) or the adopt form (`?adopt=1`).
 * Below md the two sides take turns, so a phone sees one at a time.
 */
export default function HubApps() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const selected = Number(params.get('app')) || null
  const adopting = isAdmin && params.get('adopt') === '1'
  const creating = isAdmin && params.get('create') === '1'

  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })

  const show = (next: { app?: number | null; adopt?: boolean; create?: boolean }) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete('app')
        out.delete('adopt')
        out.delete('create')
        if (next.app) out.set('app', String(next.app))
        if (next.adopt) out.set('adopt', '1')
        if (next.create) out.set('create', '1')
        return out
      },
      { replace: false }
    )

  const detailOpen = adopting || creating || selected != null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside
          className={cn(
            'w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white md:flex md:w-[272px] md:border-r dark:border-border dark:bg-card',
            detailOpen ? 'hidden' : 'flex'
          )}
        >
          <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-border'>
            <p className='m-0 flex-1 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
              {apps.data
                ? `${apps.data.length} ${apps.data.length === 1 ? 'app' : 'apps'}`
                : 'Apps'}
            </p>
            {isAdmin && (
              <button
                type='button'
                className={cn(ghostButton, creating && 'bg-accent')}
                onClick={() => show({ create: true })}
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> Create app
              </button>
            )}
            {isAdmin && (
              <button
                type='button'
                className={cn(ghostButton, adopting && 'bg-accent')}
                onClick={() => show({ adopt: true })}
              >
                <Plus className='h-3.5 w-3.5' aria-hidden /> Adopt app
              </button>
            )}
          </div>
          {apps.isPending ? (
            <div className='space-y-2 p-3'>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className='h-14 w-full' />
              ))}
            </div>
          ) : apps.isError ? (
            <QueryErrorState
              error={apps.error}
              what='the apps'
              onRetry={() => void apps.refetch()}
              className='m-3'
            />
          ) : apps.data.length === 0 ? (
            <div className='px-4 py-8 text-center'>
              <p className='m-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
                No apps yet
              </p>
              <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                {isAdmin
                  ? 'Adopt an app that already runs to see its environments and deploys here.'
                  : 'Apps you own show up here.'}
              </p>
            </div>
          ) : (
            <ul className='m-0 list-none space-y-0.5 p-2'>
              {apps.data.map((a) => (
                <li key={a.id}>
                  <AppListItem
                    app={a}
                    active={a.id === selected && !adopting && !creating}
                    onSelect={() => show({ app: a.id })}
                  />
                </li>
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
                <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All apps
              </button>
            </div>
          )}
          {creating ? (
            <HubCreateApp onDone={(id) => show({ app: id })} onCancel={() => show({})} />
          ) : adopting ? (
            <HubAdoptForm onDone={(id) => show({ app: id })} onCancel={() => show({})} />
          ) : selected != null ? (
            <HubAppDetail
              key={selected}
              appId={selected}
              isAdmin={isAdmin}
              userId={user?.id ?? null}
              onDeleted={() => show({})}
            />
          ) : (
            <NoAppSelected isAdmin={isAdmin} onAdopt={() => show({ adopt: true })} />
          )}
        </div>
      </div>
    </div>
  )
}

function AppListItem({
  app,
  active,
  onSelect
}: {
  app: HubApp
  active: boolean
  onSelect: () => void
}) {
  const full = useHubApp(app.id)
  const nameTip = useOverflowTip<HTMLSpanElement>(app.name)
  const envs = [...(full.data?.environments ?? [])].sort(
    (a, b) => a.position - b.position || a.id - b.id
  )
  return (
    <button
      type='button'
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        active ? 'bg-accent' : 'hover:bg-muted'
      )}
    >
      <div className='flex items-baseline gap-2'>
        <span
          ref={nameTip}
          className='line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-medium text-slate-900 sm:line-clamp-1 dark:text-foreground'
        >
          {app.name}
        </span>
        <code className='shrink-0 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {app.key}
        </code>
      </div>
      {envs.length > 0 && (
        <div className='mt-1.5 flex flex-wrap gap-1'>
          {envs.map((e) => (
            <EnvStatusDot key={e.id} env={e} />
          ))}
        </div>
      )}
    </button>
  )
}

function NoAppSelected({ isAdmin, onAdopt }: { isAdmin: boolean; onAdopt: () => void }) {
  return (
    <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <AppWindow className='h-5 w-5 text-slate-400 dark:text-muted-foreground' aria-hidden />
      </div>
      <p className='mt-3 text-[13px] font-medium text-slate-700 dark:text-foreground'>
        Pick an app
      </p>
      {isAdmin && (
        <button
          type='button'
          onClick={onAdopt}
          className='mt-1 text-[12px] text-nvr-navy hover:underline dark:text-nvr-cyan'
        >
          Or adopt one that already runs
        </button>
      )}
    </div>
  )
}
