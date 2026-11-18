import { toastError } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, CircleCheck, Copy, KeyRound, Loader2, Radio, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import {
  type TrackerConnection,
  type TrackerHealth,
  trackerKeys,
  WEBHOOK_CHECK_MS,
  WEBHOOK_POLL_MS,
  webhookCheckVerdict
} from './api'

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type='button'
      variant='outline'
      size='sm'
      aria-label={label}
      className='h-7 shrink-0 gap-1 px-2 text-[11.5px]'
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => toast.error('Could not copy — select the text and copy it yourself.')
        )
      }}
    >
      {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

type CheckState =
  | { phase: 'idle' }
  | { phase: 'waiting'; since: number }
  | { phase: 'arrived'; at: string }
  | { phase: 'timeout' }

/**
 * Reads the connection's last delivery when the button is pressed, then polls
 * its health every 3 s for 30 s and reports arrived once that value moves on.
 * Server timestamps are compared with each other, never with the browser clock.
 */
function useWebhookCheck(id: number, fallbackBaseline: string | null) {
  const qc = useQueryClient()
  const [state, setState] = useState<CheckState>({ phase: 'idle' })
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const run = useRef(0)

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }, [])

  useEffect(
    () => () => {
      run.current++
      stop()
    },
    [stop]
  )

  const readHealth = useCallback(
    () => api.get<{ data: TrackerHealth }>(`/trackers/${id}/health`).then((r) => r.data.data),
    [id]
  )

  const start = useCallback(async () => {
    stop()
    const mine = ++run.current
    const since = Date.now()
    setState({ phase: 'waiting', since })
    let baseline = fallbackBaseline
    try {
      baseline = (await readHealth()).last_webhook_at
    } catch {
      // keep the value the page already had
    }
    if (mine !== run.current) return
    let busy = false
    timer.current = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const health = await readHealth()
        if (mine !== run.current) return
        const verdict = webhookCheckVerdict(health.last_webhook_at, baseline, since, Date.now())
        if (verdict === 'arrived') {
          stop()
          setState({ phase: 'arrived', at: health.last_webhook_at as string })
          qc.setQueryData(trackerKeys.health(id), health)
          void qc.invalidateQueries({ queryKey: trackerKeys.connections() })
        } else if (verdict === 'timeout') {
          stop()
          setState({ phase: 'timeout' })
        }
      } catch {
        if (Date.now() - since >= WEBHOOK_CHECK_MS) {
          stop()
          setState({ phase: 'timeout' })
        }
      } finally {
        busy = false
      }
    }, WEBHOOK_POLL_MS)
  }, [fallbackBaseline, id, qc, readHealth, stop])

  return { state, start }
}

export function WebhookSetup({
  connection,
  secret,
  webhookUrl,
  onSecret
}: {
  connection: TrackerConnection
  /** A secret just made (create / rotate) — shown once, gone on reload. */
  secret: string | null
  webhookUrl?: string
  onSecret: (secret: string, url: string) => void
}) {
  // Always the server's address (its admin URL): the browser may be on another host.
  const url = webhookUrl || connection.webhook_url || ''
  const [confirmRotate, setConfirmRotate] = useState(false)
  const check = useWebhookCheck(connection.id, connection.last_webhook_at)

  const rotate = useMutation({
    mutationFn: () =>
      api
        .post<{ secret: string; webhook_url: string }>(`/trackers/${connection.id}/rotate-secret`)
        .then((r) => r.data),
    onSuccess: (d) => {
      setConfirmRotate(false)
      onSecret(d.secret, d.webhook_url)
    },
    onError: (err) => toastError(err, 'Could not make a new secret')
  })

  const s = check.state

  return (
    <section
      aria-labelledby={`tracker-hook-${connection.id}`}
      className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div>
        <h3
          id={`tracker-hook-${connection.id}`}
          className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
        >
          Webhook
        </h3>
        <p className='mt-0.5 max-w-[68ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          GitLab tells Nivaro the moment an issue or comment changes. Without it Nivaro still
          catches up by polling every few minutes.
        </p>
      </div>

      <ol className='space-y-3 text-[12px] text-slate-700 dark:text-slate-200'>
        <li className='space-y-1.5'>
          <p>
            In the GitLab project, open <span className='font-medium'>Settings → Webhooks</span> and
            add a webhook with this URL:
          </p>
          {url ? (
            <div className='flex items-center gap-2'>
              <code className='min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[11.5px] text-slate-800 dark:border-border dark:bg-muted/40 dark:text-slate-100'>
                {url}
              </code>
              <CopyButton value={url} label='Copy URL' />
            </div>
          ) : (
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Reload the page to see the address.
            </p>
          )}
        </li>
        <li className='space-y-1.5'>
          <p>
            Paste the secret into <span className='font-medium'>Secret token</span>.
          </p>
          {secret ? (
            <div className='space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-500/30 dark:bg-amber-500/10'>
              <div className='flex items-center gap-2'>
                <code className='min-w-0 flex-1 break-all font-mono text-[11.5px] text-slate-900 dark:text-slate-100'>
                  {secret}
                </code>
                <CopyButton value={secret} label='Copy secret' />
              </div>
              <p className='text-[11px] text-amber-900 dark:text-amber-200'>
                Shown once. Copy it now — Nivaro keeps only a fingerprint of it.
              </p>
            </div>
          ) : (
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              The secret was shown once when it was made. Lost it? Make a new one and paste that
              into GitLab instead.
            </p>
          )}
          <div className='flex flex-wrap items-center gap-2'>
            {confirmRotate ? (
              <>
                <span className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                  The webhook in GitLab stops working until it gets the new secret.
                </span>
                <Button
                  type='button'
                  size='sm'
                  className='h-7 bg-nvr-cyan px-2.5 text-[11.5px] text-white hover:bg-nvr-cyan/90'
                  disabled={rotate.isPending}
                  onClick={() => rotate.mutate()}
                >
                  {rotate.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                  Rotate now
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='h-7 px-2 text-[11.5px]'
                  onClick={() => setConfirmRotate(false)}
                >
                  Keep the current one
                </Button>
              </>
            ) : (
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='h-7 gap-1 px-2 text-[11.5px]'
                onClick={() => setConfirmRotate(true)}
              >
                <KeyRound className='h-3 w-3' />
                Rotate secret
              </Button>
            )}
          </div>
        </li>
        <li className='space-y-1.5'>
          <p>Under Trigger, tick:</p>
          <ul className='flex flex-wrap gap-2'>
            {['Issues events', 'Comments'].map((e) => (
              <li
                key={e}
                className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] dark:border-border'
              >
                <Check className='h-3 w-3 text-nvr-cyan' aria-hidden />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </li>
        <li className='space-y-1.5'>
          <p>
            Save it, press <span className='font-medium'>Check it arrived</span> here, then send{' '}
            <span className='font-medium'>Test → Issues events</span> from GitLab:
          </p>
          <div className='flex flex-wrap items-center gap-3'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-7 gap-1 px-2.5 text-[11.5px]'
              disabled={s.phase === 'waiting'}
              onClick={() => void check.start()}
            >
              <Radio className='h-3 w-3' />
              Check it arrived
            </Button>
            <span aria-live='polite' className='text-[11.5px]'>
              {s.phase === 'waiting' && (
                <span className='inline-flex items-center gap-1.5 text-slate-500 dark:text-muted-foreground'>
                  <Loader2 className='h-3 w-3 animate-spin' />
                  Waiting for GitLab — send the test now.
                </span>
              )}
              {s.phase === 'arrived' && (
                <span className='inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400'>
                  <CircleCheck className='h-3.5 w-3.5' />
                  Webhook arrived {formatRelative(s.at)}. GitLab changes now show up right away.
                </span>
              )}
              {s.phase === 'timeout' && (
                <span className='inline-flex items-start gap-1.5 text-amber-800 dark:text-amber-300'>
                  <TriangleAlert className='mt-px h-3.5 w-3.5 shrink-0' />
                  Nothing arrived in 30 seconds. Check the URL and secret in GitLab, and that GitLab
                  can reach this address.
                </span>
              )}
            </span>
          </div>
          {s.phase === 'idle' && connection.last_webhook_at && (
            <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              Last webhook {formatRelative(connection.last_webhook_at)}.
            </p>
          )}
        </li>
      </ol>
    </section>
  )
}
