import { useMutation } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../context'
import { post } from '../lib/commands'
import { cn } from '../lib/utils'

/**
 * "Draft a broadcast" (#2379): a few bullets → a banner line, a fuller email
 * and an SMS under 160 characters, drafted by AI for the chosen audience and
 * channels (POST /announcements/draft — the same gate as sending). "Use"
 * copies a draft into the composer; the sender edits and sends as usual.
 * Nothing is sent from here.
 */

export interface BroadcastDraftResult {
  banner: string
  email: { subject: string; body: string }
  sms: string
}

export const SMS_LIMIT = 160

export function BroadcastDraftPanel({
  audience,
  channels,
  severity,
  onUse
}: {
  audience: Record<string, unknown>
  channels: string[]
  severity: string
  /** Put a draft into the composer. */
  onUse: (d: { subject?: string; message: string }) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [bullets, setBullets] = useState('')
  const [error, setError] = useState<string | null>(null)
  const draft = useMutation({
    mutationFn: () =>
      client
        .request<{ data: BroadcastDraftResult }>(
          post('/announcements/draft', { bullets, audience, channels, severity })
        )
        .then((r) => r.data),
    onSuccess: () => setError(null),
    onError: (e) =>
      setError(
        (e as { response?: { error?: string } })?.response?.error ??
          (e as Error)?.message ??
          'The draft failed'
      )
  })
  const d = draft.data

  if (!open)
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
        data-broadcast-draft-open
      >
        <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' /> Draft from bullets
      </button>
    )

  const card = (
    title: string,
    body: string,
    use: () => void,
    extra?: React.ReactNode,
    key?: string
  ) => (
    <div
      className='rounded-md border border-slate-200 p-2.5 dark:border-border'
      data-broadcast-draft={key}
    >
      <div className='flex items-center gap-2'>
        <span className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-500'>
          {title}
        </span>
        {extra}
        <button
          type='button'
          onClick={use}
          className='ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10'
        >
          Use
        </button>
      </div>
      <p className='mt-1 whitespace-pre-wrap text-[12px] text-slate-700 dark:text-slate-200'>
        {body}
      </p>
    </div>
  )

  return (
    <div
      className='mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/40'
      data-broadcast-draft-panel
    >
      <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
        Draft from bullets
      </p>
      <p className='text-[11px] text-slate-500 dark:text-slate-400'>
        A few points, one per line. AI drafts each channel for this audience; nothing is sent until
        you send it. The AI sees your points and the audience's roles and counts — never who is in
        it.
      </p>
      <textarea
        value={bullets}
        onChange={(e) => setBullets(e.target.value)}
        rows={4}
        placeholder={
          '- System down Saturday 6–8am for upgrades\n- Save your work Friday\n- Questions: IT desk'
        }
        className='mt-2 w-full rounded-md border border-slate-200 bg-background px-2.5 py-2 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'
        data-broadcast-draft-bullets
      />
      <div className='mt-1.5 flex items-center gap-2'>
        <button
          type='button'
          disabled={!bullets.trim() || draft.isPending}
          onClick={() => draft.mutate()}
          className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white disabled:opacity-50'
          data-broadcast-draft-run
        >
          <Sparkles className='h-3.5 w-3.5' /> {draft.isPending ? 'Drafting…' : 'Draft'}
        </button>
        <button
          type='button'
          onClick={() => setOpen(false)}
          className='text-[11.5px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
        >
          Close
        </button>
        {error && <span className='text-[11.5px] text-red-600 dark:text-red-400'>{error}</span>}
      </div>
      {d && (
        <div className='mt-2.5 space-y-2'>
          {card('Banner', d.banner, () => onUse({ message: d.banner }), undefined, 'banner')}
          {card(
            'Email / in-app message',
            `${d.email.subject}\n\n${d.email.body}`,
            () => onUse({ subject: d.email.subject, message: d.email.body }),
            undefined,
            'email'
          )}
          {card(
            'SMS',
            d.sms,
            () => onUse({ message: d.sms }),
            <span
              className={cn(
                'text-[10.5px] tabular-nums',
                d.sms.length > SMS_LIMIT ? 'text-red-600' : 'text-slate-400'
              )}
            >
              {d.sms.length}/{SMS_LIMIT}
            </span>,
            'sms'
          )}
        </div>
      )}
    </div>
  )
}
