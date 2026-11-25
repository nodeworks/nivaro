import { ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { fetchStackSettings, stackKeys } from './docker/stack-api'
import { hubError, hubToast } from './hub-api'
import { SectionCard } from './hub-parts'

/**
 * App owner self-service (services/hub/owner-access.ts): what the signed-in person may deploy on
 * each environment of an app, the admin's "owners may deploy production" switch, and the
 * read-only stack settings an owner may open on a non-production environment. The server
 * enforces every rule; the page only hides what would be refused.
 */

export interface AppAccess {
  admin: boolean
  owner: boolean
  owners_deploy_production: boolean
  environments: Array<{
    id: number
    key: string
    production: boolean
    deploy: boolean
    /** The admin's flag: true / false / null = worked out by the Hub. */
    production_flag?: boolean | null
    archived?: boolean
    /** NIVARO_ENVIRONMENT as the environment's hub link last reported it. */
    reported?: string | null
  }>
}

export const ownerAccessKey = (appId: number) => ['hub-app-access', appId] as const

export function useAppAccess(appId: number, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ownerAccessKey(appId),
    queryFn: () =>
      api.get<{ data: AppAccess }>(`/hub/apps/${appId}/access`).then((r) => r.data.data)
  })
}

/** Whether the caller may deploy (promote, restart, apply) here. Unknown yet = allowed (the
 *  server still refuses); known production without the switch = not for an owner. */
export function mayDeploy(access: AppAccess | undefined, envId: number): boolean {
  if (!access) return true
  return access.environments.find((e) => e.id === envId)?.deploy !== false
}

const list = (xs: string[]) => xs.join(', ')

/** What the card says owners may do (the server's production rule, in words). */
function ownerWords(rest: string[], prod: string[]): string {
  const where = rest.length
    ? `Owners promote, roll back, restart and apply on ${list(rest)}.`
    : 'This app has no environment before production.'
  return `${where} Production${prod.length ? ` (${list(prod)})` : ''} is deployed by Hub administrators unless owners are allowed below.`
}

/** Admins: the app's switch. Owners: what it says, in a line. */
export function OwnerPolicyCard({ appId, isAdmin }: { appId: number; isAdmin: boolean }) {
  const qc = useQueryClient()
  const access = useAppAccess(appId)
  const save = useMutation({
    mutationFn: (v: boolean) =>
      api.put(`/hub/apps/${appId}/owner-policy`, { owners_deploy_production: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ownerAccessKey(appId) }),
    onError: (err) => hubToast(err, 'Could not save')
  })
  const flag = useMutation({
    mutationFn: (v: { envId: number; production: boolean | null }) =>
      api.put(`/hub/environments/${v.envId}/production`, { production: v.production }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ownerAccessKey(appId) }),
    onError: (err) => hubToast(err, 'Could not save')
  })
  if (access.isPending) return <Skeleton className='h-20 w-full' />
  if (access.isError)
    return (
      <QueryErrorState
        error={access.error}
        what='who may deploy'
        onRetry={() => void access.refetch()}
      />
    )
  const live = access.data.environments.filter((e) => !e.archived)
  const prod = live.filter((e) => e.production).map((e) => e.key)
  const rest = live.filter((e) => !e.production).map((e) => e.key)
  const on = access.data.owners_deploy_production
  return (
    <SectionCard title='What owners may do' description={ownerWords(rest, prod)}>
      <div className='flex items-center gap-3 px-4 py-3'>
        {isAdmin ? (
          <>
            <Switch
              id={`owners-prod-${appId}`}
              checked={on}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate(v)}
            />
            <label
              htmlFor={`owners-prod-${appId}`}
              className='text-[12px] text-slate-700 dark:text-slate-200'
            >
              Owners may deploy production too
            </label>
          </>
        ) : (
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            {on
              ? 'You may deploy production on this app too.'
              : 'Production is deployed by Hub administrators.'}
          </p>
        )}
      </div>
      {isAdmin && live.length > 0 && (
        <ul className='m-0 list-none divide-y divide-slate-100 border-t border-slate-100 p-0 dark:divide-border dark:border-border'>
          {live.map((e) => (
            <li key={e.id} className='flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2'>
              <span className='min-w-0 flex-[1_1_160px]'>
                <span className='block font-mono text-[12px] text-slate-800 dark:text-foreground'>
                  {e.key}
                </span>
                <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {whyWords(e)}
                </span>
              </span>
              <fieldset
                aria-label={`Is ${e.key} production`}
                className='m-0 inline-flex overflow-hidden rounded-md border border-slate-200 p-0 dark:border-border'
              >
                {(
                  [
                    [null, 'Auto'],
                    [true, 'Production'],
                    [false, 'Not production']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    type='button'
                    aria-pressed={(e.production_flag ?? null) === value}
                    disabled={flag.isPending}
                    onClick={() => flag.mutate({ envId: e.id, production: value })}
                    className={cn(
                      'h-7 px-2.5 text-[12px] font-medium disabled:opacity-60',
                      (e.production_flag ?? null) === value
                        ? 'bg-nvr-cyan text-white'
                        : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

const PROD_KEY = /(^|[-_.])(prod|production|prd|live)([-_.]|\d|$)/i

/** Why an environment is (not) production, in words (the server's rule; the server decides). */
function whyWords(e: AppAccess['environments'][number]): string {
  if (!e.production)
    return e.production_flag === false ? 'Not production (set here)' : 'Not production'
  if (e.production_flag === true) return 'Production (set here)'
  if (PROD_KEY.test(e.key)) return 'Production (its name)'
  if (e.reported === 'production') return 'Production (the app says so)'
  return 'Production (after production, or last in the chain)'
}

/** Stack settings, read-only (owners on a non-production environment): secrets stay masked. */
export function StackSettingsView({ envId }: { envId: number }) {
  const q = useQuery({
    queryKey: stackKeys.settings(envId),
    queryFn: () => fetchStackSettings(envId)
  })
  if (q.isPending) return <Skeleton className='h-16 w-full' />
  if (q.isError)
    return (
      <ErrorNotice
        description={hubError(q.error, 'Could not read the stack settings')}
        onRetry={() => void q.refetch()}
      />
    )
  const s = q.data
  // [label, value, code?]: setting names and values are code; the fixed fields are words.
  const rows: Array<[string, string, boolean]> = [
    ['Size', s.size, false],
    ['Redis', s.redis === 'bundled' ? 'In the stack' : 'External', false],
    ['Published port', s.publish_port == null ? 'None' : String(s.publish_port), false],
    ...Object.entries(s.extension_pins ?? {}).map(([k, v]): [string, string, boolean] => [
      `Extension ${k}`,
      v,
      false
    ]),
    ...Object.entries(s.settings).map(([k, v]): [string, string, boolean] => [
      k,
      v === '' ? '(empty)' : v,
      true
    ]),
    ...Object.keys(s.secrets).map((k): [string, string, boolean] => [k, '', true])
  ]
  return (
    <dl className='m-0 grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]'>
      {rows.map(([k, v, code]) => (
        <div key={k} className='contents'>
          <dt
            className={cn(
              'truncate text-slate-500 dark:text-muted-foreground',
              code && 'font-mono'
            )}
          >
            {k}
          </dt>
          <dd
            className={cn(
              'm-0 break-all text-slate-800 dark:text-slate-200',
              code && v && 'font-mono'
            )}
          >
            {v || <span className='text-slate-500 dark:text-muted-foreground'>Set, hidden</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
