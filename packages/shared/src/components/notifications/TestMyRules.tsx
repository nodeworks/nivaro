import { useMutation } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelectXs } from '../ui/SimpleSelect'
import { NOTIFY_RULE_CATS } from './NotificationRulesEditor'
import { WHY_LAYER_LABELS, type WhyLayer } from './why-lines'

/**
 * Profile → Notification rules → "Test my rules" (#3078): the Notification Bench simulate for
 * the signed-in person only (POST /notifications/test-my-rules answers for req.user; it takes
 * no user id). Nothing is sent.
 */
interface TestAnswer {
  evaluated_at: string
  category_label: string
  decision: {
    critical: boolean
    inapp: boolean
    push: boolean
    teams: boolean
    email: 'send' | 'deferred' | 'off' | 'not_requested' | 'no_address'
    dropped: boolean
    reasons: Array<{ code: string; channel: string; text: string; layer?: WhyLayer }>
  }
  layers: Record<'inapp' | 'push' | 'teams' | 'email' | 'quiet', WhyLayer> | null
  role: { id: string; name: string | null } | null
  quiet_hours: string | null
  push_subscriptions: number
}

const WHEN = [
  { value: 'now', label: 'Right now' },
  { value: 'night', label: 'Tonight at 11 PM' }
]

/** Tonight 23:00 America/New_York as an ISO instant (the rules' wall clock is ET). */
function tonightEt(now = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now)
  // 23:00 ET is 03:00 or 04:00 UTC the next day; try both and keep the one that reads 23 in ET.
  for (const offset of [4, 5]) {
    const d = new Date(`${ymd}T23:00:00Z`)
    d.setUTCHours(d.getUTCHours() + offset)
    const h = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false
    }).format(d)
    if (h === '23') return d.toISOString()
  }
  return now.toISOString()
}

export function TestMyRules({ category: initialCategory = 'workflow' }: { category?: string }) {
  const client = useNivaroClient()
  const [category, setCategory] = useState(initialCategory)
  const [when, setWhen] = useState('now')
  const run = useMutation({
    mutationFn: () =>
      client
        .request<{ data: TestAnswer }>(
          post('/notifications/test-my-rules', {
            category,
            email: true,
            ...(when === 'night' ? { at: tonightEt() } : {})
          })
        )
        .then((r) => r.data)
  })
  const r = run.data
  const outcome = (ch: 'inapp' | 'push' | 'teams' | 'email') => {
    if (!r) return null
    if (ch === 'email')
      return r.decision.email === 'send'
        ? 'Emailed now'
        : r.decision.email === 'deferred'
          ? 'Daily summary'
          : r.decision.email === 'no_address'
            ? 'No address on file'
            : 'No email'
    if (ch === 'push' && r.decision.push && r.push_subscriptions === 0)
      return 'Allowed, but no device registered'
    return r.decision[ch] ? 'Yes' : 'No'
  }
  const ruleFor = (ch: string) =>
    r?.decision.reasons.find((x) => x.channel === ch) ??
    r?.decision.reasons.find((x) => x.channel === 'all')
  const showTeams = !!r?.decision.reasons.some((x) => x.channel === 'teams')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-test-my-rules
          data-tip='See what would happen to a notification for you right now, and which rule decides it'
          className='inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 px-2 text-[11.5px] font-medium text-slate-600 hover:border-slate-400 hover:text-slate-800 dark:border-border dark:text-muted-foreground dark:hover:text-foreground'
        >
          <FlaskConical className='h-3.5 w-3.5' />
          Test my rules
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[380px] p-3 text-[12px]'>
        <p className='font-semibold text-slate-800 dark:text-slate-100'>Test my rules</p>
        <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
          What would happen to a notification for you, and which rule decides each channel. Nothing
          is sent.
        </p>
        <div className='mt-2 flex flex-wrap items-center gap-2'>
          <SimpleSelectXs
            ariaLabel='Category to test'
            value={category}
            options={NOTIFY_RULE_CATS.map((c) => ({ value: c.key, label: c.label }))}
            onChange={(v: string) => setCategory(v)}
          />
          <SimpleSelectXs
            ariaLabel='When'
            value={when}
            options={WHEN}
            onChange={(v: string) => setWhen(v)}
          />
          <button
            type='button'
            disabled={run.isPending}
            onClick={() => run.mutate()}
            className='h-6 rounded bg-nvr-cyan px-2 text-[11.5px] font-semibold text-white disabled:opacity-50'
          >
            {run.isPending ? 'Testing…' : 'Test'}
          </button>
        </div>
        {run.isError && (
          <p className='mt-2 text-[11px] text-red-600 dark:text-red-400'>
            The test could not run — try again.
          </p>
        )}
        {r && (
          <div className='mt-2 space-y-1' data-test-my-rules-result>
            {r.decision.dropped ? (
              <p className='rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'>
                Nothing would be delivered — {r.decision.reasons[0]?.text}
              </p>
            ) : (
              <ul className='divide-y divide-slate-100 rounded border border-slate-100 dark:divide-border/60 dark:border-border/60'>
                {(['inapp', 'push', 'email', ...(showTeams ? ['teams'] : [])] as const).map(
                  (ch) => {
                    const rule = ruleFor(ch)
                    const layer = (rule?.layer ?? r.layers?.[ch as 'inapp']) as WhyLayer | undefined
                    return (
                      <li key={ch} className='px-2 py-1' data-test-channel={ch}>
                        <span className='font-medium text-slate-700 dark:text-slate-200'>
                          {ch === 'inapp'
                            ? 'In-app'
                            : ch === 'push'
                              ? 'Push'
                              : ch === 'email'
                                ? 'Email'
                                : 'Teams'}
                          :
                        </span>{' '}
                        {outcome(ch as 'inapp')}
                        {layer && (
                          <span
                            className={cn(
                              'ml-1 rounded px-1 text-[10px]',
                              layer === 'person' &&
                                'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
                              layer === 'role' &&
                                'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
                              layer === 'system' &&
                                'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
                            )}
                          >
                            {WHY_LAYER_LABELS[layer]}
                            {layer === 'role' && r.role?.name ? ` · ${r.role.name}` : ''}
                          </span>
                        )}
                        {rule && (
                          <p className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                            {rule.text}
                          </p>
                        )}
                      </li>
                    )
                  }
                )}
              </ul>
            )}
            <p className='text-[10.5px] text-slate-400'>
              {r.category_label} · {new Date(r.evaluated_at).toLocaleString()}
              {r.quiet_hours ? ` · quiet hours ${r.quiet_hours}` : ''}
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
