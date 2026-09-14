import { Bell, Inbox, Mail, MessageSquare } from 'lucide-react'
import type { NotificationDeliveryRecord } from '../../lib/notification-target'

/**
 * "Where did this go?" — one small chip per channel with the outcome and,
 * on hover, why (quiet hours, matrix off, daily summary, no address…). The
 * email chip links to the mail-log row when the host can show one.
 */

type Tone = 'ok' | 'muted' | 'warn' | 'bad'

const TONE: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  muted: 'text-slate-400 dark:text-slate-500',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400'
}

function describe(delivery: NotificationDeliveryRecord | null | undefined): Array<{
  key: string
  icon: typeof Bell
  label: string
  tone: Tone
  tip: string
  mailLogId?: number | null
}> {
  const d = delivery ?? { inapp: { status: 'delivered' } }
  const out: ReturnType<typeof describe> = []
  const inapp = d.inapp?.status ?? 'delivered'
  out.push({
    key: 'inapp',
    icon: Inbox,
    label: 'In-app',
    tone: inapp === 'delivered' ? 'ok' : 'muted',
    tip: inapp === 'delivered' ? 'Landed in your inbox' : (d.inapp?.reason ?? 'Skipped')
  })
  if (d.push) {
    const s = d.push.status
    out.push({
      key: 'push',
      icon: Bell,
      label: 'Push',
      tone: s === 'sent' ? 'ok' : s === 'failed' ? 'bad' : 'muted',
      tip:
        s === 'sent'
          ? `Browser push sent${d.push.at ? ` · ${new Date(d.push.at).toLocaleString()}` : ''}`
          : s === 'no_subscription'
            ? 'No browser registered for push'
            : s === 'failed'
              ? 'Push failed'
              : (d.push.reason ?? 'Push skipped')
    })
  }
  if (d.email && d.email.status !== 'not_requested') {
    const s = d.email.status
    const tone: Tone =
      s === 'sent' ? 'ok' : s === 'deferred' ? 'warn' : s === 'failed' ? 'bad' : 'muted'
    const tip =
      s === 'sent'
        ? `Email sent${d.email.at ? ` · ${new Date(d.email.at).toLocaleString()}` : ''}`
        : s === 'deferred'
          ? (d.email.reason ?? 'Held for your daily summary')
          : s === 'dropped'
            ? 'Email dropped (mail test mode / inactive address)'
            : s === 'failed'
              ? `Email failed${d.email.reason ? `: ${d.email.reason}` : ''}`
              : s === 'off'
                ? (d.email.reason ?? 'Email is off for this category')
                : s === 'no_address'
                  ? 'No email address on the account'
                  : s === 'unconfigured'
                    ? 'No mail server configured'
                    : (d.email.reason ?? s)
    out.push({
      key: 'email',
      icon: Mail,
      label:
        s === 'deferred'
          ? 'Email · summary'
          : s === 'sent'
            ? 'Email'
            : `Email · ${s.replace(/_/g, ' ')}`,
      tone,
      tip,
      mailLogId: d.email.mail_log_id ?? null
    })
  }
  if (d.escalation?.email_at || d.escalation?.push_at) {
    out.push({
      key: 'escalation',
      icon: Bell,
      label: d.escalation.email_at ? 'Escalated · email' : 'Escalated · push',
      tone: 'warn',
      tip: `Still unread, so it climbed channels${
        d.escalation.push_at ? ` · pushed ${new Date(d.escalation.push_at).toLocaleString()}` : ''
      }${
        d.escalation.email_at
          ? ` · emailed ${new Date(d.escalation.email_at).toLocaleString()}`
          : ''
      }`,
      mailLogId: d.escalation.email_log_id ?? null
    })
  }
  if (d.sms && d.sms.status !== 'not_requested') {
    out.push({
      key: 'sms',
      icon: MessageSquare,
      label: 'SMS',
      tone: d.sms.status === 'sent' ? 'ok' : d.sms.status === 'failed' ? 'bad' : 'muted',
      tip: d.sms.status === 'sent' ? 'Text sent' : (d.sms.reason ?? `SMS ${d.sms.status}`)
    })
  }
  return out
}

export interface DeliveryChipsProps {
  delivery: NotificationDeliveryRecord | null | undefined
  /** Host route for a mail-log row (admin: /mail-log?id=N). Absent = no link. */
  mailLogUrl?: (mailLogId: number) => string | null
  onNavigate?: (path: string) => void
  className?: string
}

export function DeliveryChips({ delivery, mailLogUrl, onNavigate, className }: DeliveryChipsProps) {
  const chips = describe(delivery)
  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1 ${className ?? ''}`}
      data-nvr-delivery
    >
      {chips.map((c) => {
        const Icon = c.icon
        const link = c.mailLogId != null && mailLogUrl ? mailLogUrl(c.mailLogId) : null
        const inner = (
          <>
            <Icon className='h-2.5 w-2.5' strokeWidth={2} />
            {c.label}
          </>
        )
        const cls = `inline-flex items-center gap-0.5 rounded border border-slate-200/70 px-1 py-px text-[9.5px] font-medium leading-none dark:border-border ${TONE[c.tone]}`
        return link ? (
          <button
            key={c.key}
            type='button'
            data-tip={`${c.tip} · open mail log`}
            title={c.tip}
            onClick={(e) => {
              e.stopPropagation()
              onNavigate?.(link)
            }}
            className={`${cls} underline decoration-dotted underline-offset-2`}
          >
            {inner}
          </button>
        ) : (
          <span key={c.key} data-tip={c.tip} title={c.tip} className={cls}>
            {inner}
          </span>
        )
      })}
    </span>
  )
}
