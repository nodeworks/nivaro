import { ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type HubEnvironment, hubError, hubKeys, hubToast } from '../hub-api'
import { dangerGhost, ghostButton, StatusChip } from '../hub-parts'
import { StackSettingsEditor } from './StackSettingsEditor'
import {
  checkStackName,
  fetchStack,
  type RemoveResult,
  refusalOf,
  removedCount,
  removeStack,
  restartStack,
  STACK_STATE_WORDS,
  type StackInfo,
  type StackState,
  shortDigest,
  stackKeys
} from './stack-api'

/**
 * Nivaro Hub (phase 4) — one Docker environment's stack: state, services, names to request
 * (manual DNS), Restart, and for Hub admins the settings and Remove. Renders nothing for an
 * environment not deployed through a Docker driver.
 */

const TONE: Record<StackState, 'ok' | 'degraded' | 'checking'> = {
  converged: 'ok',
  updating: 'checking',
  rolled_back: 'degraded',
  paused: 'degraded',
  degraded: 'degraded'
}

/** What the panel says when there is no stack status to show, by the stack read's `agent`. */
export function agentWords(agent: string): string | null {
  if (agent === 'ok') return null
  if (agent === 'STACK_OWNER_MISMATCH') return 'This stack belongs to another environment'
  if (agent === 'NO_STACK_NAME') return 'No stack name is set for this environment'
  return 'Agent not answering'
}

const copyLines = (lines: string[]) => {
  const text = lines.join('\n')
  if (!navigator.clipboard) {
    toast.error('Select it and copy by hand')
    return
  }
  void navigator.clipboard.writeText(text).then(
    () => toast.success('Copied'),
    () => toast.error('Select it and copy by hand')
  )
}

const rowText = 'text-[12px] text-slate-700 dark:text-slate-300'

/** Polling pace: none for a non-Docker environment, fast while updating, slow otherwise. */
export function stackRefetchInterval(q: {
  state: { error: unknown; data?: { status?: { state?: string } | null } }
}): number | false {
  if (q.state.error && refusalOf(q.state.error).code === 'NOT_DOCKER') return false
  return q.state.data?.status?.state === 'updating' ? 5000 : 30000
}

export function HubStackPanel({
  env,
  appId,
  isAdmin,
  layout,
  idPrefix = ''
}: {
  env: HubEnvironment
  appId: number
  isAdmin: boolean
  /** Unique per mount: '-m' for the phone card (the table and the card both mount a panel). */
  idPrefix?: string
  /** 'row' wraps the panel in a full-width table row (the desktop table). */
  layout: 'row' | 'card'
}) {
  const qc = useQueryClient()
  const stack = useQuery({
    queryKey: stackKeys.stack(env.id),
    queryFn: () => fetchStack(env.id),
    retry: false,
    refetchInterval: stackRefetchInterval
  })
  if (stack.isPending) return null
  const refusal = stack.isError ? refusalOf(stack.error) : null
  // Not a Docker environment: no panel.
  if (refusal?.code === 'NOT_DOCKER') return null
  // An owner whose read failed without a code (Hub unreachable) gets a short notice, not a gap.
  if (refusal && !refusal.code && !isAdmin) {
    return (
      <p role='status' className='m-0 mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        The stack status is not available right now.
      </p>
    )
  }
  const body = (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      {stack.isError ? (
        <ErrorNotice
          description={hubError(stack.error, 'Could not read the stack')}
          onRetry={() => void stack.refetch()}
        />
      ) : (
        <StackBody
          env={env}
          appId={appId}
          isAdmin={isAdmin}
          idPrefix={idPrefix}
          info={stack.data}
          refresh={() => {
            void qc.invalidateQueries({ queryKey: stackKeys.stack(env.id) })
            void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
          }}
        />
      )}
    </div>
  )
  return layout === 'row' ? (
    <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
      <td colSpan={6} className='px-4 pb-3'>
        {body}
      </td>
    </tr>
  ) : (
    <div className='mt-2'>{body}</div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='space-y-1.5'>
      <h5 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>{title}</h5>
      {children}
    </div>
  )
}

function StackBody({
  env,
  appId,
  isAdmin,
  idPrefix,
  info,
  refresh
}: {
  env: HubEnvironment
  appId: number
  isAdmin: boolean
  idPrefix: string
  info: StackInfo
  refresh: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const s = info.status
  const words = agentWords(info.agent)
  const state = s?.state
  const digest = shortDigest(s?.image ?? null)

  return (
    <>
      <div className='flex flex-wrap items-center gap-2'>
        <h4 className='m-0 text-[12px] font-semibold text-slate-800 dark:text-foreground'>
          Docker stack
        </h4>
        <span className='font-mono text-[12px] text-slate-600 dark:text-slate-300'>
          {info.stack_name ?? '—'}
        </span>
        {state ? (
          <StatusChip state={TONE[state]} label={STACK_STATE_WORDS[state]} glyph />
        ) : (
          <StatusChip
            state={info.agent === 'ok' ? 'checking' : 'failed'}
            label={words ?? 'No stack yet'}
            glyph
          />
        )}
        {digest && (
          <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
            {digest}
          </span>
        )}
        {s?.published_port != null && (
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            port {s.published_port}
          </span>
        )}
      </div>

      {state === 'rolled_back' && (
        <p className='m-0 text-[12px] text-amber-700 dark:text-amber-400'>
          Docker rolled the stack back to the version before, because the new one could not start.
          Read the service messages, fix it, then deploy again.
        </p>
      )}
      {words && info.agent !== 'ok' && !s && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>{words}.</p>
      )}

      {s && s.services.length > 0 && (
        <>
          <div className='hidden overflow-x-auto sm:block'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:border-border dark:text-muted-foreground'>
                  <th className='py-1.5 pr-3 font-medium'>Role</th>
                  <th className='py-1.5 pr-3 font-medium'>Replicas</th>
                  <th className='py-1.5 pr-3 font-medium'>Update</th>
                  <th className='py-1.5 font-medium'>Message</th>
                </tr>
              </thead>
              <tbody>
                {s.services.map((v) => (
                  <tr
                    key={v.name}
                    className='border-b border-slate-100 last:border-0 dark:border-border'
                  >
                    <td className='py-1.5 pr-3 font-mono'>{v.role}</td>
                    <td className='py-1.5 pr-3 tabular-nums'>
                      {v.replicas.running}/{v.replicas.desired}
                    </td>
                    <td className='py-1.5 pr-3'>{v.update.replace(/_/g, ' ')}</td>
                    <td className='py-1.5 text-slate-500 dark:text-muted-foreground'>
                      {v.message ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className='m-0 list-none space-y-1.5 p-0 sm:hidden'>
            {s.services.map((v) => (
              <li
                key={v.name}
                className='rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
              >
                <p className='m-0 flex items-center gap-2 text-[12px]'>
                  <span className='font-mono font-medium'>{v.role}</span>
                  <span className='tabular-nums'>
                    {v.replicas.running}/{v.replicas.desired}
                  </span>
                  <span className='text-slate-500 dark:text-muted-foreground'>
                    {v.update.replace(/_/g, ' ')}
                  </span>
                </p>
                {v.message && (
                  <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {v.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {info.name_request && info.name_request.length > 0 && (
        <NameRequest
          env={env}
          appId={appId}
          lines={info.name_request}
          isAdmin={isAdmin}
          refresh={refresh}
        />
      )}

      <RestartRow env={env} idPrefix={idPrefix} refresh={refresh} />

      {isAdmin && (
        <>
          <Section title='Settings'>
            {settingsOpen ? (
              <>
                <StackSettingsEditor env={env} appId={appId} idPrefix={idPrefix} />
                <button
                  type='button'
                  className={ghostButton}
                  onClick={() => setSettingsOpen(false)}
                >
                  Hide settings
                </button>
              </>
            ) : (
              <button type='button' className={ghostButton} onClick={() => setSettingsOpen(true)}>
                Edit settings
              </button>
            )}
          </Section>
          <RemoveRow env={env} idPrefix={idPrefix} stackName={info.stack_name} refresh={refresh} />
        </>
      )}
    </>
  )
}

function NameRequest({
  env,
  appId,
  lines,
  isAdmin,
  refresh
}: {
  env: HubEnvironment
  appId: number
  lines: string[]
  isAdmin: boolean
  refresh: () => void
}) {
  const qc = useQueryClient()
  const check = useMutation({
    mutationFn: () => checkStackName(env.id),
    onSuccess: (r) => {
      if (r.state === 'serving') toast.success('The name serves — the environment is active')
      else toast('The name does not serve yet')
      void qc.invalidateQueries({ queryKey: hubKeys.app(appId) })
      refresh()
    },
    onError: (err) => hubToast(err, 'Could not check the name')
  })
  const canCheck = isAdmin || env.status === 'waiting_for_name'
  return (
    <Section title='Names to request'>
      <pre className='m-0 whitespace-pre-wrap break-words rounded-md bg-slate-50 p-2 font-mono text-[11px] dark:bg-muted'>
        {lines.join('\n')}
      </pre>
      <div className='flex items-center gap-2'>
        <button
          type='button'
          className={ghostButton}
          data-tip='Copy the request'
          onClick={() => copyLines(lines)}
        >
          <Copy className='h-3.5 w-3.5' aria-hidden /> Copy
        </button>
        {canCheck && (
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? 'Checking…' : 'Check name'}
          </Button>
        )}
      </div>
    </Section>
  )
}

function RestartRow({
  env,
  idPrefix,
  refresh
}: {
  env: HubEnvironment
  idPrefix: string
  refresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const restart = useMutation({
    mutationFn: () => restartStack(env.id, typed),
    onSuccess: () => {
      toast.success(`Restarting ${env.key}`)
      setOpen(false)
      setTyped('')
      refresh()
    },
    onError: (err) => hubToast(err, `Could not restart ${env.key}`)
  })
  if (!open)
    return (
      <button type='button' className={ghostButton} onClick={() => setOpen(true)}>
        Restart
      </button>
    )
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <label htmlFor={`hub-restart-${env.id}${idPrefix}`} className={rowText}>
        Type <span className='font-mono'>{env.key}</span> to restart:
      </label>
      <Input
        id={`hub-restart-${env.id}${idPrefix}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete='off'
        spellCheck={false}
        className='h-8 w-40 font-mono text-[12px]'
      />
      <Button
        size='sm'
        className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
        disabled={typed !== env.key || restart.isPending}
        onClick={() => restart.mutate()}
      >
        {restart.isPending ? 'Restarting…' : 'Restart now'}
      </Button>
      <button type='button' className={ghostButton} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  )
}

function RemoveRow({
  env,
  idPrefix,
  stackName,
  refresh
}: {
  env: HubEnvironment
  idPrefix: string
  stackName: string | null
  refresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [volumes, setVolumes] = useState(false)
  const [typedVol, setTypedVol] = useState('')
  const [result, setResult] = useState<RemoveResult | null>(null)
  const name = stackName ?? ''
  const phrase = `delete ${name} data`
  const ready = name !== '' && typed === name && (!volumes || typedVol === phrase)
  const remove = useMutation({
    mutationFn: () => removeStack(env.id, name, volumes),
    onSuccess: (r) => {
      setResult(r)
      setOpen(false)
      setTyped('')
      setTypedVol('')
      setVolumes(false)
      refresh()
    },
    onError: (err) => hubToast(err, `Could not remove ${name}`)
  })
  const removed = result && typeof result.removed === 'object' ? result.removed : null
  const counts = removed
    ? (['services', 'secrets', 'networks', 'volumes'] as const)
        .map((k) => `${removedCount(removed[k])} ${k}`)
        .join(', ')
    : null
  return (
    <Section title='Remove stack'>
      {result && (
        <p role='status' className={`m-0 ${rowText}`}>
          {result.already_absent || result.removed === false
            ? 'The stack was already gone. The environment is suspended.'
            : `Removed ${counts}. The environment is suspended.`}
        </p>
      )}
      {!open ? (
        <button
          type='button'
          className={dangerGhost}
          disabled={!name}
          onClick={() => setOpen(true)}
        >
          Remove stack…
        </button>
      ) : (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <label htmlFor={`hub-remove-${env.id}${idPrefix}`} className={rowText}>
              Type <span className='font-mono'>{name}</span> to remove it:
            </label>
            <Input
              id={`hub-remove-${env.id}${idPrefix}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete='off'
              spellCheck={false}
              className='h-8 w-48 font-mono text-[12px]'
            />
          </div>
          <label className={`flex items-center gap-2 ${rowText}`}>
            <input
              type='checkbox'
              checked={volumes}
              onChange={(e) => setVolumes(e.target.checked)}
            />
            Also delete the stack's data volumes
          </label>
          {volumes && (
            <div className='flex flex-wrap items-center gap-2'>
              <label htmlFor={`hub-remove-vol-${env.id}${idPrefix}`} className={rowText}>
                Type <span className='font-mono'>{phrase}</span>:
              </label>
              <Input
                id={`hub-remove-vol-${env.id}${idPrefix}`}
                value={typedVol}
                onChange={(e) => setTypedVol(e.target.value)}
                autoComplete='off'
                spellCheck={false}
                className='h-8 w-64 font-mono text-[12px]'
              />
            </div>
          )}
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              variant='destructive'
              className='h-8'
              disabled={!ready || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Removing…' : 'Remove stack'}
            </Button>
            <button type='button' className={ghostButton} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Section>
  )
}
