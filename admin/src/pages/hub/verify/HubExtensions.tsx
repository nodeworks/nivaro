import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { HubEnvTag, ProductionGuard } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { type ChecklistState, PreDeployChecklist } from '../changes/PreDeployChecklist'
import { EnvWindowGate } from '../changes/WindowGate'
import { hubError, hubToast } from '../hub-api'
import { Field, ghostButton, SectionCard } from '../hub-parts'
import {
  type AppMatrix,
  type CellState,
  type ExtensionCell,
  type ExtensionPlan,
  type ExtensionPromotion,
  extensionChecklistVersion,
  fetchExtensions,
  planExtension,
  promoteExtension,
  refreshExtensions,
  STATE_WORDS,
  shortPin,
  verifyKeys,
  WINDOW_CODES
} from './verify-api'

/**
 * Extensions (Apps hub tab): which extension each environment runs — the version and build its
 * app reports, the image the Hub pins there — and which environments are behind the one before
 * them. Administrators promote one extension on its own (Docker: pin + Apply now; GitLab: the
 * pin file is committed).
 */

const STATE_TONE: Record<CellState, string> = {
  behind:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  missing:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  ahead:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  same: 'border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-slate-300',
  first:
    'border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-slate-300',
  unknown:
    'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
}

const SOURCE_WORDS: Record<string, string> = {
  docker: 'Docker pin',
  gitlab: 'GitLab pin file',
  shared: 'Shared deployment'
}

interface Target {
  appId: number
  envId: number
  extId: string
}

export default function HubExtensions() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const qc = useQueryClient()
  const q = useQuery({ queryKey: verifyKeys.extensions(), queryFn: fetchExtensions })
  const [target, setTarget] = useState<Target | null>(null)
  const refresh = useMutation({
    mutationFn: () => refreshExtensions(),
    onSuccess: (r) => {
      toast.success(
        r.background
          ? 'Reading every environment — this tab updates when it is done'
          : r.read === 1
            ? 'Read 1 environment'
            : `Read ${r.read ?? 0} environments`
      )
      void qc.invalidateQueries({ queryKey: verifyKeys.extensions() })
    },
    onError: (e) => hubToast(e, 'The extensions could not be read')
  })
  const behind = q.data?.apps.reduce(
    (n, a) => n + a.extensions.reduce((m, x) => m + x.behind, 0),
    0
  )
  return (
    <div className='flex-1 space-y-5 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
      <div className='flex flex-wrap items-center gap-3'>
        <p className='m-0 max-w-[90ch] flex-1 text-[12px] text-slate-600 dark:text-slate-300'>
          Read over each environment’s link every 30 minutes.{' '}
          {behind ? (
            <span className='font-medium text-amber-800 dark:text-amber-300'>
              {behind === 1 ? '1 environment is' : `${behind} environments are`} behind the one
              before them.
            </span>
          ) : q.data ? (
            'No environment is behind the one before it.'
          ) : null}
        </p>
        {isAdmin && (
          <Button
            size='sm'
            variant='outline'
            className='ml-auto h-8'
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={cn('mr-1.5 h-3.5 w-3.5', refresh.isPending && 'animate-spin')}
              aria-hidden
            />
            {refresh.isPending ? 'Reading…' : 'Read now'}
          </Button>
        )}
      </div>
      {q.isPending ? (
        <Skeleton className='h-40 w-full' />
      ) : q.isError ? (
        <QueryErrorState error={q.error} what='the extensions' onRetry={() => void q.refetch()} />
      ) : q.data.apps.length === 0 ? (
        <p className='m-0 text-[13px] text-slate-500 dark:text-muted-foreground'>No apps yet.</p>
      ) : (
        <>
          {q.data.apps.map((m) => (
            <AppCard
              key={m.app.id}
              m={m}
              isAdmin={isAdmin}
              target={target?.appId === m.app.id ? target : null}
              onPromote={(envId, extId) => setTarget({ appId: m.app.id, envId, extId })}
              onClose={() => setTarget(null)}
            />
          ))}
          <HistoryCard rows={q.data.promotions} apps={q.data.apps} />
        </>
      )}
    </div>
  )
}

function Cell({
  c,
  canPromote,
  onPromote
}: {
  c: ExtensionCell | null
  canPromote: boolean
  onPromote: () => void
}) {
  if (!c)
    return <span className='text-[12px] text-slate-400 dark:text-muted-foreground'>Not read</span>
  const pin = shortPin(c.pin)
  return (
    <div className='space-y-1'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='text-[13px] font-medium tabular-nums text-slate-800 dark:text-foreground'>
          {c.status === 'absent' ? 'Not loaded' : (c.version ?? c.build?.slice(0, 10) ?? '—')}
        </span>
        <span
          className={cn(
            'rounded-full border px-1.5 py-px text-[10.5px] font-medium',
            STATE_TONE[c.state]
          )}
        >
          {STATE_WORDS[c.state]}
        </span>
      </div>
      {c.version && c.build && (
        <p className='m-0 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {c.build.slice(0, 12)}
        </p>
      )}
      {pin && (
        <p
          className='m-0 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'
          data-tip={`${SOURCE_WORDS[c.pin_source ?? ''] ?? 'Pin'}: ${c.pin}`}
        >
          {pin}
        </p>
      )}
      {canPromote && (c.state === 'behind' || c.state === 'missing') && (
        <button type='button' className={cn(ghostButton, 'h-7 px-2')} onClick={onPromote}>
          <ArrowUpRight className='h-3.5 w-3.5' aria-hidden /> Promote…
        </button>
      )}
    </div>
  )
}

function AppCard({
  m,
  isAdmin,
  target,
  onPromote,
  onClose
}: {
  m: AppMatrix
  isAdmin: boolean
  target: Target | null
  onPromote: (envId: number, extId: string) => void
  onClose: () => void
}) {
  const behind = m.extensions.reduce((n, x) => n + x.behind, 0)
  return (
    <SectionCard
      title={m.app.name || m.app.key}
      description={
        m.extensions.length === 0
          ? 'No extensions reported or listed for this app.'
          : behind
            ? `${behind === 1 ? '1 extension' : `${behind} extensions`} behind or missing on an environment`
            : 'Every environment runs what the one before it runs.'
      }
    >
      {m.extensions.length > 0 && (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[34rem] text-left text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                <th className='px-4 py-2 font-medium'>Extension</th>
                {m.environments.map((e) => (
                  <th key={e.id} className='px-4 py-2 font-medium'>
                    <span className='inline-flex items-center gap-1.5'>
                      {e.key}
                      <HubEnvTag envKey={e.key} />
                      {e.production && e.key.toLowerCase() !== 'production' && (
                        <span className='font-normal'>· production</span>
                      )}
                      {e.on_shared && <span className='font-normal'>· shared</span>}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.extensions.map((x) => (
                <tr
                  key={x.id}
                  className='border-b border-slate-100 align-top last:border-0 dark:border-border'
                >
                  <th
                    scope='row'
                    className='whitespace-nowrap px-4 py-3 font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'
                  >
                    {x.id}
                  </th>
                  {m.environments.map((e, i) => (
                    <td key={e.id} className='px-4 py-3'>
                      <Cell
                        c={x.cells[i]}
                        canPromote={isAdmin && !e.on_shared}
                        onPromote={() => onPromote(e.id, x.id)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target && (
        <PromotePanel
          key={`${target.envId}:${target.extId}`}
          m={m}
          target={target}
          onClose={onClose}
        />
      )}
    </SectionCard>
  )
}

function PromotePanel({
  m,
  target,
  onClose
}: {
  m: AppMatrix
  target: Target
  onClose: () => void
}) {
  const qc = useQueryClient()
  const env = m.environments.find((e) => e.id === target.envId)
  const i = m.environments.findIndex((e) => e.id === target.envId)
  const sources = m.environments.filter((e) => e.id !== target.envId)
  const [fromEnv, setFromEnv] = useState(String(m.environments[i - 1]?.id ?? sources[0]?.id ?? ''))
  const [confirm, setConfirm] = useState('')
  /** An administrator's emergency start outside the deploy window: the typed reason. */
  const [outsideReason, setOutsideReason] = useState<string | null>(null)
  const [checklist, setChecklist] = useState<ChecklistState>({
    required: false,
    ready: true,
    runId: null
  })
  const plan = useQuery({
    queryKey: [
      ...verifyKeys.extensions(),
      'plan',
      target.envId,
      target.extId,
      fromEnv,
      !!outsideReason
    ],
    queryFn: () =>
      planExtension(target.envId, target.extId, {
        from_env_id: fromEnv ? Number(fromEnv) : null,
        ...(outsideReason ? { outside_window_reason: outsideReason } : {})
      }),
    retry: false
  })
  const go = useMutation({
    mutationFn: () =>
      promoteExtension(target.envId, target.extId, {
        from_env_id: fromEnv ? Number(fromEnv) : null,
        confirm,
        ...(checklist.runId != null ? { checklist_run_id: checklist.runId } : {}),
        ...(outsideReason ? { outside_window_reason: outsideReason } : {})
      }),
    onSuccess: (r) => {
      toast.success(
        r.via === 'docker'
          ? `Deploying ${target.extId} to ${env?.key} (deploy #${r.deploy_id})`
          : `Pin committed for ${target.extId} on ${env?.key}; watching its pipeline (deploy #${r.deploy_id})`
      )
      void qc.invalidateQueries({ queryKey: verifyKeys.extensions() })
      onClose()
    },
    onError: (e) => hubToast(e, 'The extension could not be promoted')
  })
  const p: ExtensionPlan | undefined = plan.data
  // Window refusals are said by the deploy-window notice above (with its override).
  const listed = (p?.blockers ?? []).filter((b) => !WINDOW_CODES.has(b.code))
  const checklistBlocks = checklist.required && !checklist.ready
  const ready = !!p && p.blockers.length === 0 && !checklistBlocks && confirm.trim() === env?.key
  return (
    <div className='border-t border-slate-200 bg-slate-50 px-4 py-4 dark:border-border dark:bg-muted/40'>
      <ProductionGuard envKey={env?.key} what='extension promote'>
        <div className='space-y-3'>
          <h4 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            Promote <span className='font-mono'>{target.extId}</span> into {env?.key}
          </h4>
          <div className='grid gap-3 sm:grid-cols-2'>
            <Field id='ext-from' label='Take it from'>
              <SimpleSelect
                value={fromEnv}
                onChange={(v) => {
                  setFromEnv(v)
                  setConfirm('')
                }}
                options={sources.map((e) => ({ value: String(e.id), label: e.key }))}
                ariaLabel='Take it from'
                className='h-8 bg-white text-left text-[13px] dark:bg-background'
                triggerProps={{ id: 'ext-from' }}
              />
            </Field>
            <Field id='ext-confirm' label={`Type ${env?.key ?? ''} to confirm`}>
              <Input
                id='ext-confirm'
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete='off'
                spellCheck={false}
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          </div>
          {plan.isPending ? (
            <Skeleton className='h-12 w-full' />
          ) : plan.isError ? (
            <p className='m-0 text-[12px] text-red-700 dark:text-red-400'>
              {hubError(plan.error, 'The plan could not be read').title}
            </p>
          ) : p ? (
            <dl className='m-0 grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[8rem_minmax(0,1fr)]'>
              <dt className='text-slate-500 dark:text-muted-foreground'>How</dt>
              <dd className='m-0 text-slate-800 dark:text-foreground'>
                {p.via === 'docker'
                  ? 'Writes the pin inside the promotion lock and runs Apply now (a normal Hub deploy); a failed deploy puts the old pin back.'
                  : p.via === 'gitlab'
                    ? 'Commits the extension’s pin file to the deploy branch, records an extension deploy and watches the repository’s pipeline like a promotion.'
                    : '—'}
              </dd>
              <dt className='text-slate-500 dark:text-muted-foreground'>Now</dt>
              <dd className='m-0 break-all font-mono text-slate-700 dark:text-slate-300'>
                {p.current_pin ?? 'No pin'}
              </dd>
              <dt className='text-slate-500 dark:text-muted-foreground'>Becomes</dt>
              <dd className='m-0 break-all font-mono text-slate-900 dark:text-foreground'>
                {p.to_pin ?? '—'}
              </dd>
            </dl>
          ) : null}
          <EnvWindowGate envId={target.envId} what='extension' onReason={setOutsideReason} />
          {listed.length > 0 && (
            <ul className='m-0 list-disc space-y-1 pl-5 text-[12px] text-amber-900 dark:text-amber-200'>
              {listed.map((b) => (
                <li key={b.code}>{b.text}</li>
              ))}
            </ul>
          )}
          {p?.to_pin && (
            <PreDeployChecklist
              target={{ kind: 'environment', envId: target.envId }}
              action='extension_promote'
              version={extensionChecklistVersion(target.extId, p.to_pin)}
              onState={setChecklist}
            />
          )}
          <div className='flex flex-wrap justify-end gap-2'>
            <button type='button' className={ghostButton} onClick={onClose}>
              Cancel
            </button>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white'
              disabled={!ready || go.isPending}
              onClick={() => go.mutate()}
            >
              {go.isPending ? 'Promoting…' : 'Promote extension'}
            </Button>
          </div>
        </div>
      </ProductionGuard>
    </div>
  )
}

const PROMO_WORDS: Record<string, string> = {
  starting: 'Starting',
  deploying: 'Deploying',
  done: 'Deployed',
  failed: 'Failed',
  committed: 'Pin committed'
}

function HistoryCard({ rows, apps }: { rows: ExtensionPromotion[]; apps: AppMatrix[] }) {
  const envKey = (id: number | null) =>
    id == null
      ? null
      : (apps.flatMap((a) => a.environments).find((e) => e.id === id)?.key ?? `#${id}`)
  return (
    <SectionCard title='Promoted on their own' description='The newest 30 extension promotions.'>
      {rows.length === 0 ? (
        <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
          None yet. Promote… appears on an environment that is behind.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {rows.map((r) => (
            <li key={r.id} className='flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5'>
              <span className='font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
                {r.extension_id}
              </span>
              <span className='text-[12px] text-slate-600 dark:text-slate-300'>
                {envKey(r.from_environment_id) ? `${envKey(r.from_environment_id)} → ` : ''}
                {envKey(r.environment_id)}
              </span>
              <span
                className={cn(
                  'text-[11px] font-medium',
                  r.status === 'failed'
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-slate-500 dark:text-muted-foreground'
                )}
              >
                {PROMO_WORDS[r.status] ?? r.status}
                {r.commit_sha ? ` · ${r.commit_sha.slice(0, 10)}` : ''}
                {r.error ? ` — ${r.error}` : ''}
              </span>
              <span
                className='ml-auto text-[12px] text-slate-500 dark:text-muted-foreground'
                data-tip={formatDateTime(r.created_at ?? '')}
              >
                {formatRelative(r.created_at ?? '')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
