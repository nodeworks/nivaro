import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { hubKeys, hubToast } from '../hub-api'
import { dangerArmed, ghostButton, SectionCard, smallButton } from '../hub-parts'
import {
  createEnvClient,
  type EnvLines,
  envLinesText,
  rotateEnvSecret,
  setAppMode,
  setClientActive,
  signinKeys,
  useEnvClient,
  useSigninOverview
} from './signin-api'

type Mode = 'direct' | 'hub'

/** One minted secret with the lines an app sets; lives only in the panel's state. */
interface Minted {
  secret: string
  lines: EnvLines
  clientId: string
}

/**
 * An app's sign-in: the Direct / Via the Hub switch, then one block per environment (create the
 * client, see its redirect addresses, rotate the secret). Owners and administrators.
 */
export function HubAppSigninCard({
  app,
  envs
}: {
  app: { id: number; name: string; signin_mode: string }
  envs: Array<{ id: number; key: string }>
}) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<Mode>(app.signin_mode === 'hub' ? 'hub' : 'direct')
  const [busy, setBusy] = useState(false)
  const overview = useSigninOverview()
  const noClients =
    overview.data?.find((a) => a.id === app.id)?.environments.some((e) => e.has_client) === false
  useEffect(() => setMode(app.signin_mode === 'hub' ? 'hub' : 'direct'), [app.signin_mode])

  const change = async (next: Mode) => {
    if (next === mode || busy) return
    setBusy(true)
    try {
      await setAppMode(app.id, next)
      setMode(next)
      void qc.invalidateQueries({ queryKey: hubKeys.app(app.id) })
      void qc.invalidateQueries({ queryKey: hubKeys.apps() })
      void qc.invalidateQueries({ queryKey: signinKeys.overview() })
    } catch (err) {
      hubToast(err, 'Could not change the sign-in mode')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      title='Sign-in'
      description={
        mode === 'hub'
          ? 'People sign in to this app through the Hub.'
          : 'People sign in to this app directly with Microsoft.'
      }
      actions={
        <fieldset
          aria-label='Sign-in mode'
          className='m-0 inline-flex overflow-hidden rounded-md border border-slate-200 p-0 dark:border-border'
        >
          {(
            [
              ['direct', 'Direct'],
              ['hub', 'Via the Hub']
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type='button'
              aria-pressed={mode === value}
              disabled={busy}
              onClick={() => void change(value)}
              className={cn(
                'h-8 px-3 text-[12px] font-medium disabled:opacity-60',
                mode === value
                  ? 'bg-nvr-cyan text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
      }
    >
      {mode === 'hub' && noClients && (
        <p className='m-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'>
          No environment has a sign-in client yet, so nobody can sign in through the Hub. Create one
          for each environment below.
        </p>
      )}
      {envs.length === 0 ? (
        <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Add an environment first.
        </p>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {envs.map((env) => (
            <li key={env.id} className='px-4 py-3'>
              <HubEnvSigninPanel env={env} mode={mode} />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

export function HubEnvSigninPanel({ env, mode }: { env: { id: number; key: string }; mode: Mode }) {
  const qc = useQueryClient()
  const read = useEnvClient(env.id)
  const [minted, setMinted] = useState<Minted | null>(null)
  const [busy, setBusy] = useState(false)
  // The secret is cleared when the panel closes (unmount) and never leaves this state.
  useEffect(() => () => setMinted(null), [])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: signinKeys.env(env.id) })
    void qc.invalidateQueries({ queryKey: signinKeys.overview() })
  }

  const create = async () => {
    setBusy(true)
    try {
      const made = await createEnvClient(env.id)
      setMinted({ secret: made.client_secret, lines: made.env_lines, clientId: made.client_id })
      refresh()
    } catch (err) {
      hubToast(err, 'Could not create the sign-in client')
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      const secret = await rotateEnvSecret(env.id)
      const lines = read.data?.env_lines
      if (lines) setMinted({ secret, lines, clientId: lines.HUB_CLIENT_ID ?? '' })
      refresh()
    } catch (err) {
      hubToast(err, 'Could not rotate the secret')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (active: boolean) => {
    setBusy(true)
    try {
      await setClientActive(env.id, active)
      refresh()
    } catch (err) {
      hubToast(err, 'Could not change the sign-in client')
    } finally {
      setBusy(false)
    }
  }

  if (read.isPending) return <Skeleton className='h-16 w-full' />
  if (read.isError)
    return (
      <QueryErrorState
        error={read.error}
        what='the sign-in client'
        onRetry={() => void read.refetch()}
      />
    )

  const { client, redirect_uris } = read.data
  const uris = client?.redirect_uris ?? redirect_uris

  return (
    <div className='min-w-0 space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
          {env.key}
        </span>
        {client ? (
          <>
            <code className='break-all rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-slate-300'>
              {client.client_id}
            </code>
            <span className='ml-auto flex items-center gap-2'>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  client.active
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
                )}
              >
                {client.active ? 'On' : 'Off'}
              </span>
              {client.active ? (
                <ConfirmButton
                  title={`Turn off sign-in client in ${env.key}`}
                  confirmLabel={`Turn off? Sign-ins in ${env.key} stop at once`}
                  className={ghostButton}
                  armedClassName={dangerArmed}
                  disabled={busy}
                  onConfirm={() => void toggle(false)}
                >
                  Turn off
                </ConfirmButton>
              ) : (
                <button
                  type='button'
                  className={ghostButton}
                  disabled={busy}
                  aria-label={`Turn on sign-in client in ${env.key}`}
                  onClick={() => void toggle(true)}
                >
                  Turn on
                </button>
              )}
            </span>
            <ConfirmButton
              title='Rotate secret'
              confirmLabel='Rotate the secret?'
              className={ghostButton}
              armedClassName={dangerArmed}
              disabled={busy}
              onConfirm={() => void rotate()}
            >
              <KeyRound className='h-3.5 w-3.5' aria-hidden /> Rotate secret
            </ConfirmButton>
          </>
        ) : (
          <Button
            size='sm'
            className='ml-auto h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={busy}
            onClick={() => void create()}
          >
            Create sign-in client
          </Button>
        )}
      </div>

      {minted && <OneTimeSecret minted={minted} onClose={() => setMinted(null)} />}

      <div>
        <p className='m-0 text-[11px] font-medium text-slate-700 dark:text-foreground'>
          {mode === 'direct'
            ? "Register these in the app's Entra app registration"
            : 'Redirect addresses for this client'}
        </p>
        {uris.length === 0 ? (
          <p className='m-0 mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
            None yet — the environment needs an https address.
          </p>
        ) : (
          <ul className='m-0 mt-1 list-none space-y-1 p-0'>
            {uris.map((u) => (
              <li
                key={u}
                className='break-all rounded bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-slate-300'
              >
                {u}
              </li>
            ))}
          </ul>
        )}
        <p className='m-0 mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Change the environment's addresses to change these.
        </p>
      </div>
    </div>
  )
}

/** The env lines and the secret, once. Component state only — never cached, stored or in a URL. */
function OneTimeSecret({ minted, onClose }: { minted: Minted; onClose: () => void }) {
  const text = envLinesText(minted.lines, minted.secret)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied')
    } catch {
      toast.error('Could not copy', { description: 'Select the lines and copy them by hand.' })
    }
  }
  return (
    <div
      role='status'
      className='rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/40'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <p className='m-0 flex-1 text-[12px] font-medium text-amber-900 dark:text-amber-200'>
          This secret is shown once. Copy these lines into the app's settings now.
        </p>
        <button type='button' className={ghostButton} onClick={() => void copy()}>
          <Copy className='h-3.5 w-3.5' aria-hidden /> Copy
        </button>
        <button type='button' aria-label='Close' className={smallButton} onClick={onClose}>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      <pre
        data-testid='hub-env-lines'
        className='m-0 mt-2 whitespace-pre-wrap break-all font-mono text-[11px] text-slate-800 dark:text-slate-200'
      >
        {text}
      </pre>
    </div>
  )
}
