import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { dangerArmed, ghostButton, SectionCard } from '../hub-parts'
import { rotateSigningKey, signinKeys, useSigninOverview, useSigninSettings } from './signin-api'

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  } catch {
    toast.error('Could not copy', { description: 'Select the text and copy it by hand.' })
  }
}

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-2'>
      <span className='w-full text-[11px] font-medium text-slate-500 sm:w-48 dark:text-muted-foreground'>
        {label}
      </span>
      <code className='min-w-0 flex-1 break-all rounded bg-slate-100 px-1.5 py-1 font-mono text-[12px] text-slate-800 dark:bg-muted dark:text-slate-200'>
        {value}
      </code>
      <button
        type='button'
        className={ghostButton}
        aria-label={`Copy ${label}`}
        onClick={() => void copyText(value)}
      >
        <Copy className='h-3.5 w-3.5' aria-hidden /> Copy
      </button>
    </div>
  )
}

/**
 * Sign-in (Apps hub tab): the Hub's issuer, the value every app sets as HUB_IDP_AUDIENCE, the
 * signing keys (administrators rotate them) and, per app, its mode and clients.
 */
export default function HubSignin() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const settings = useSigninSettings()
  const overview = useSigninOverview()

  return (
    <div className='flex-1 space-y-5 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
      <SectionCard
        title='Sign in through the Hub'
        description='Apps in Via the Hub mode send people here; the Hub signs them in with Microsoft and hands them back.'
      >
        <div className='space-y-3 p-4'>
          {settings.isPending ? (
            <Skeleton className='h-16 w-full' />
          ) : settings.isError ? (
            <QueryErrorState
              error={settings.error}
              what='the sign-in settings'
              onRetry={() => void settings.refetch()}
            />
          ) : (
            <>
              <CopyValue label='Issuer' value={settings.data.issuer} />
              {settings.data.idp_audience && (
                <CopyValue
                  label='Set on each app as HUB_IDP_AUDIENCE'
                  value={settings.data.idp_audience}
                />
              )}
            </>
          )}
          <p className='m-0 rounded-md bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:bg-muted dark:text-slate-300'>
            What happens when the Hub is down: people already signed in to an app stay signed in.
            Nobody new can sign in to an app in Via the Hub mode until the Hub is back, so keep one
            administrator who can switch an app to Direct.
          </p>
        </div>
      </SectionCard>

      {isAdmin && settings.data && <KeysCard keys={settings.data.keys ?? []} />}

      <SectionCard title='Apps' description='Sign-in mode and clients, app by app.'>
        {overview.isPending ? (
          <Skeleton className='m-4 h-24' />
        ) : overview.isError ? (
          <QueryErrorState
            error={overview.error}
            what='the apps'
            onRetry={() => void overview.refetch()}
            className='m-4'
          />
        ) : overview.data.length === 0 ? (
          <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No apps yet.
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-left text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  <th className='px-4 py-2 font-medium'>App</th>
                  <th className='px-4 py-2 font-medium'>Mode</th>
                  <th className='px-4 py-2 font-medium'>Environments</th>
                  <th className='px-4 py-2 font-medium'>People, 30 days</th>
                </tr>
              </thead>
              <tbody>
                {overview.data.map((a) => (
                  <tr
                    key={a.id}
                    className='border-b border-slate-100 align-top last:border-0 dark:border-border'
                  >
                    <td className='break-words px-4 py-2.5 font-medium text-slate-800 dark:text-foreground'>
                      {a.name}
                    </td>
                    <td className='px-4 py-2.5'>
                      <span
                        className={
                          a.signin_mode === 'hub'
                            ? 'rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[11px] font-medium text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-300'
                            : 'rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
                        }
                      >
                        {a.signin_mode === 'hub' ? 'Via the Hub' : 'Direct'}
                      </span>
                    </td>
                    <td className='px-4 py-2.5'>
                      <div className='flex flex-wrap gap-1.5'>
                        {a.environments.map((e) => (
                          <span
                            key={e.id}
                            className='rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700 dark:border-border dark:text-slate-300'
                          >
                            {e.key}:{' '}
                            {e.has_client ? (e.active ? 'client' : 'client off') : 'no client'}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className='px-4 py-2.5 tabular-nums text-slate-700 dark:text-slate-300'>
                      {a.signins_30d}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className='m-0 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          Open an app under Apps to switch its mode or create its sign-in clients.
        </p>
      </SectionCard>
    </div>
  )
}

function KeysCard({
  keys
}: {
  keys: Array<{ kid: string; created_at: string; retired_at: string | null; active: boolean }>
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const rotate = async () => {
    setBusy(true)
    try {
      await rotateSigningKey()
      void qc.invalidateQueries({ queryKey: signinKeys.settings() })
    } catch (err) {
      hubToast(err, 'Could not rotate the signing key')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SectionCard
      title='Signing keys'
      description='The Hub signs sign-in tokens with the active key. A rotated key stays published until its tokens expire.'
      actions={
        <ConfirmButton
          title='Rotate signing key'
          confirmLabel='Rotate the key?'
          className={ghostButton}
          armedClassName={dangerArmed}
          disabled={busy}
          onConfirm={() => void rotate()}
        >
          <KeyRound className='h-3.5 w-3.5' aria-hidden /> Rotate
        </ConfirmButton>
      }
    >
      <div className='overflow-x-auto'>
        <table className='w-full text-left text-[12px]'>
          <thead>
            <tr className='border-b border-slate-200 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              <th className='px-4 py-2 font-medium'>Key id</th>
              <th className='px-4 py-2 font-medium'>Created</th>
              <th className='px-4 py-2 font-medium'>State</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr
                key={k.kid}
                className='border-b border-slate-100 last:border-0 dark:border-border'
              >
                <td className='break-all px-4 py-2 font-mono text-[11px]'>{k.kid}</td>
                <td className='whitespace-nowrap px-4 py-2 text-slate-600 dark:text-slate-300'>
                  {formatDateTime(k.created_at)}
                </td>
                <td className='px-4 py-2'>{k.active ? 'Active' : 'Retired'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}
