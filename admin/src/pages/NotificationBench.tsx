import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, FlaskConical, Send, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { WhoWouldHearCard } from '@/components/who-would-hear'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Notification test bench (admin): send yourself a sample of every category,
 * and simulate "user X gets event Y" — which channels fire and why, where the
 * click lands per app, which inline action it offers. The simulator runs the
 * same decideDelivery() notifyUser executes; nothing is sent from it.
 */

interface Catalog {
  categories: Array<{ value: string; label: string }>
  samples: Array<{ category: string; subject: string }>
}
interface Reason {
  code: string
  channel: 'all' | 'inapp' | 'push' | 'email' | 'sms'
  text: string
}
interface SimResult {
  user: {
    id: string
    name: string
    email: string | null
    phone: string | null
    role: string | null
    admin: boolean
    status: string | null
    preferred_app: 'portal' | 'admin'
    push_subscriptions: number
    quiet_hours: string | null
    matrix_row: { inapp?: boolean; push?: boolean; email?: string } | null
    digest_hour: number | null
    timezone: string | null
  }
  evaluated_at: string
  decision: {
    category: string
    critical: boolean
    inapp: boolean
    push: boolean
    email: 'send' | 'deferred' | 'off' | 'not_requested' | 'no_address'
    sms: boolean
    reasons: Reason[]
    dropped: boolean
  }
  target: Record<string, unknown> | null
  actions: Array<{ key: string; label: string; endpoint: string }>
  urls: { portal: string | null; admin: string | null; preferred: 'portal' | 'admin' }
}
interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

const CHANNEL_LABEL: Record<string, string> = {
  all: 'Everything',
  inapp: 'In-app',
  push: 'Push',
  email: 'Email',
  sms: 'SMS'
}

function Outcome({
  label,
  state,
  detail
}: {
  label: string
  state: 'yes' | 'no' | 'deferred' | 'na'
  detail?: string
}) {
  return (
    <div className='bg-white px-4 py-3 dark:bg-card'>
      <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-[15px] font-semibold',
          state === 'yes' && 'text-emerald-700 dark:text-emerald-400',
          state === 'no' && 'text-red-700 dark:text-red-400',
          state === 'deferred' && 'text-amber-700 dark:text-amber-400',
          state === 'na' && 'text-slate-400'
        )}
      >
        {state === 'yes'
          ? 'Fires'
          : state === 'no'
            ? 'Blocked'
            : state === 'deferred'
              ? 'Daily summary'
              : 'Not requested'}
      </p>
      {detail && <p className='text-[11px] text-slate-400'>{detail}</p>}
    </div>
  )
}

export default function NotificationBench() {
  const { data: catalog } = useQuery<{ data: Catalog }>({
    queryKey: ['notification-bench-catalog'],
    queryFn: () => api.get('/notification-bench/catalog').then((r) => r.data)
  })
  const categories = catalog?.data.categories ?? []

  // ── samples ──
  const [sampleEmail, setSampleEmail] = useState(false)
  const samples = useMutation({
    mutationFn: () =>
      api.post('/notification-bench/samples', { email: sampleEmail }).then((r) => r.data),
    onSuccess: (d: { data: { sent: number } }) =>
      toast.success(
        `${d.data.sent} samples sent to you — check the bell${sampleEmail ? ' and your inbox' : ''}`
      ),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Sample send failed')
  })

  // ── simulator ──
  const [userQ, setUserQ] = useState('')
  const [userOpen, setUserOpen] = useState(false)
  const [user, setUser] = useState<UserRow | null>(null)
  const { data: users } = useQuery<{ data: UserRow[] }>({
    queryKey: ['notification-bench-users', userQ],
    queryFn: () =>
      api.get('/users', { params: { search: userQ || undefined, limit: 25 } }).then((r) => r.data),
    enabled: userOpen
  })
  const [category, setCategory] = useState('workflow')
  const [subject, setSubject] = useState(
    'Approve — order ORD-10042 is now Waiting on Level 2 Approval'
  )
  const [collection, setCollection] = useState('')
  const [item, setItem] = useState('')
  const [email, setEmail] = useState(true)
  const [sms, setSms] = useState(false)
  const [alwaysInbox, setAlwaysInbox] = useState(false)
  const [senderCadence, setSenderCadence] = useState(false)
  const [at, setAt] = useState('')

  const simulate = useMutation({
    mutationFn: () =>
      api
        .post('/notification-bench/simulate', {
          user_id: user?.id,
          category,
          subject,
          collection: collection || null,
          item: item || null,
          channels: { inapp: true, email, sms },
          always_inbox: alwaysInbox,
          cadence: senderCadence ? 'sender' : undefined,
          at: at ? new Date(at).toISOString() : undefined
        })
        .then((r) => r.data as { data: SimResult }),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Simulation failed')
  })
  const r = simulate.data?.data

  const applySample = (cat: string) => {
    const s = catalog?.data.samples.find((x) => x.category === cat)
    setCategory(cat)
    if (s) setSubject(s.subject.replace(/^Sample: /, ''))
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <FlaskConical className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Notification Bench
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              See what a person would receive before they ask. Samples are real sends to you; the
              simulator never sends.
            </p>
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto p-6'>
        <div className='grid grid-cols-[380px_1fr] gap-6'>
          {/* Left: samples + simulator form */}
          <div className='space-y-5'>
            <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                Send me a sample of every category
              </h2>
              <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                {categories.length} categories · each rides your own notification rules, so a
                category you set to Off will not arrive — that is the point.
              </p>
              <label className='mt-3 flex items-center justify-between text-[12.5px]'>
                <span>Also email each sample</span>
                <Switch checked={sampleEmail} onCheckedChange={setSampleEmail} />
              </label>
              <Button
                size='sm'
                className='mt-3 w-full'
                disabled={samples.isPending}
                onClick={() => samples.mutate()}
              >
                <Send className='mr-1.5 h-3.5 w-3.5' />
                Send samples to me
              </Button>
            </section>

            <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
              <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                Simulate
              </h2>
              <div className='mt-3 space-y-3 text-[12.5px]'>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>User</p>
                  <Popover open={userOpen} onOpenChange={setUserOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-background px-2.5 text-left dark:border-border'
                      >
                        <span className={cn('truncate', !user && 'text-slate-400')}>
                          {user
                            ? `${[user.first_name, user.last_name].filter(Boolean).join(' ') || user.email}`
                            : 'Pick a person…'}
                        </span>
                        <ChevronsUpDown className='h-3.5 w-3.5 text-slate-400' />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className='w-[340px] p-0' align='start'>
                      <Command shouldFilter={false}>
                        <CommandInput
                          placeholder='Search people…'
                          value={userQ}
                          onValueChange={setUserQ}
                        />
                        <CommandList>
                          <CommandEmpty>No matches</CommandEmpty>
                          {(users?.data ?? []).map((u) => (
                            <CommandItem
                              key={u.id}
                              value={u.id}
                              onSelect={() => {
                                setUser(u)
                                setUserOpen(false)
                              }}
                            >
                              <Check
                                className={cn(
                                  'mr-2 h-3.5 w-3.5',
                                  user?.id === u.id ? 'opacity-100' : 'opacity-0'
                                )}
                              />
                              <span className='truncate'>
                                {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email}
                                <span className='ml-1 text-[11px] text-slate-400'>{u.email}</span>
                              </span>
                            </CommandItem>
                          ))}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>Event</p>
                  <div className='flex flex-wrap gap-1'>
                    {categories.map((c) => (
                      <button
                        key={c.value}
                        type='button'
                        onClick={() => applySample(c.value)}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[11px]',
                          category === c.value
                            ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted/50'
                        )}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>Subject</p>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 dark:border-border'
                  />
                  <p className='mt-1 text-[10.5px] text-slate-400'>
                    Critical subjects (SLA escalation, maintenance, monitor failing) bypass every
                    rule.
                  </p>
                </div>
                <div className='grid grid-cols-2 gap-2'>
                  <div>
                    <p className='mb-1 text-[11px] font-medium text-slate-500'>
                      Collection (optional)
                    </p>
                    <input
                      value={collection}
                      onChange={(e) => setCollection(e.target.value)}
                      placeholder='workflows'
                      className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[11.5px] dark:border-border'
                    />
                  </div>
                  <div>
                    <p className='mb-1 text-[11px] font-medium text-slate-500'>Record id</p>
                    <input
                      value={item}
                      onChange={(e) => setItem(e.target.value)}
                      placeholder='371393'
                      className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[11.5px] dark:border-border'
                    />
                  </div>
                </div>
                <div className='grid grid-cols-2 gap-x-3 gap-y-1.5'>
                  <label className='flex items-center justify-between'>
                    <span>Email requested</span>
                    <Switch checked={email} onCheckedChange={setEmail} />
                  </label>
                  <label className='flex items-center justify-between'>
                    <span>SMS requested</span>
                    <Switch checked={sms} onCheckedChange={setSms} />
                  </label>
                  <label className='flex items-center justify-between'>
                    <span>Always inbox</span>
                    <Switch checked={alwaysInbox} onCheckedChange={setAlwaysInbox} />
                  </label>
                  <label className='flex items-center justify-between'>
                    <span>Sender cadence</span>
                    <Switch checked={senderCadence} onCheckedChange={setSenderCadence} />
                  </label>
                </div>
                <div>
                  <p className='mb-1 text-[11px] font-medium text-slate-500'>
                    Evaluate as of (optional — tests quiet hours)
                  </p>
                  <input
                    type='datetime-local'
                    value={at}
                    onChange={(e) => setAt(e.target.value)}
                    className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 dark:border-border'
                  />
                </div>
                <Button
                  size='sm'
                  className='w-full'
                  disabled={!user || simulate.isPending}
                  onClick={() => simulate.mutate()}
                >
                  <FlaskConical className='mr-1.5 h-3.5 w-3.5' />
                  Simulate
                </Button>
              </div>
            </section>
          </div>

          {/* Right: result */}
          <div>
            {!r ? (
              <div className='flex h-full min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 text-center dark:border-border'>
                <FlaskConical className='h-6 w-6 text-slate-300' />
                <p className='mt-2 text-[13px] font-medium text-slate-600 dark:text-foreground'>
                  Pick a person and an event
                </p>
                <p className='mt-1 max-w-[360px] text-[12px] text-slate-400'>
                  You get the channel outcome (in-app, push, email, SMS), the reason for each
                  decision, where the click lands in the portal and the admin, and the inline action
                  the row would offer.
                </p>
              </div>
            ) : (
              <div className='space-y-4'>
                <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
                  <div className='flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]'>
                    <span className='font-semibold text-slate-900 dark:text-foreground'>
                      {r.user.name}
                    </span>
                    <span className='text-slate-500'>{r.user.email ?? 'no email'}</span>
                    <span className='text-slate-500'>
                      {r.user.role ?? 'no role'}
                      {r.user.admin ? ' · admin' : ''}
                    </span>
                    <span className='text-slate-500'>
                      opens links in the <b>{r.user.preferred_app}</b>
                    </span>
                    <span className='text-slate-500'>
                      push devices: {r.user.push_subscriptions}
                    </span>
                    {r.user.quiet_hours && (
                      <span className='text-slate-500'>quiet {r.user.quiet_hours}</span>
                    )}
                    <span className='text-slate-500'>
                      summary at {r.user.digest_hour ?? 7}:00
                      {r.user.timezone ? ` ${r.user.timezone}` : ''}
                    </span>
                    <span className='ml-auto text-[11px] text-slate-400'>
                      {new Date(r.evaluated_at).toLocaleString()} · category {r.decision.category}
                      {r.decision.critical ? ' · CRITICAL' : ''}
                    </span>
                  </div>
                  {r.user.matrix_row && (
                    <p className='mt-1 font-mono text-[11px] text-slate-400'>
                      matrix[{r.decision.category}] = {JSON.stringify(r.user.matrix_row)}
                    </p>
                  )}
                </div>

                {r.decision.dropped ? (
                  <div className='rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'>
                    <X className='mr-1.5 inline h-3.5 w-3.5' />
                    Nothing is delivered — {r.decision.reasons[0]?.text}
                  </div>
                ) : (
                  <div className='grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
                    <Outcome
                      label='In-app'
                      state={r.decision.inapp ? 'yes' : 'no'}
                      detail='inbox row + toast'
                    />
                    <Outcome
                      label='Push'
                      state={
                        r.decision.push ? (r.user.push_subscriptions > 0 ? 'yes' : 'no') : 'no'
                      }
                      detail={
                        r.decision.push && r.user.push_subscriptions === 0
                          ? 'allowed, but no device registered'
                          : undefined
                      }
                    />
                    <Outcome
                      label='Email'
                      state={
                        r.decision.email === 'send'
                          ? 'yes'
                          : r.decision.email === 'deferred'
                            ? 'deferred'
                            : r.decision.email === 'not_requested'
                              ? 'na'
                              : 'no'
                      }
                      detail={r.decision.email === 'no_address' ? 'no address on file' : undefined}
                    />
                    <Outcome label='SMS' state={sms ? (r.decision.sms ? 'yes' : 'no') : 'na'} />
                  </div>
                )}

                <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
                    <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                      Why
                    </h2>
                  </div>
                  <ul className='divide-y divide-slate-50 dark:divide-border/40'>
                    {r.decision.reasons.length === 0 && (
                      <li className='px-4 py-3 text-[12px] text-slate-400'>
                        No rule touched this — every requested channel fires.
                      </li>
                    )}
                    {r.decision.reasons.map((x, i) => (
                      <li
                        key={`${x.code}-${i}`}
                        className='flex items-start gap-3 px-4 py-2 text-[12.5px]'
                      >
                        <span className='w-16 shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                          {CHANNEL_LABEL[x.channel]}
                        </span>
                        <span className='text-slate-700 dark:text-foreground'>{x.text}</span>
                        <span className='ml-auto shrink-0 font-mono text-[10.5px] text-slate-300'>
                          {x.code}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
                    <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                      Where the click lands
                    </h2>
                  </div>
                  <dl className='grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-[12.5px]'>
                    <dt className='text-slate-500'>Target</dt>
                    <dd className='font-mono text-[11.5px] text-slate-700 dark:text-foreground'>
                      {r.target ? JSON.stringify(r.target) : '— (plain row, no link)'}
                    </dd>
                    <dt className='text-slate-500'>Portal</dt>
                    <dd className='break-all text-slate-700 dark:text-foreground'>
                      {r.urls.portal ?? '—'}
                      {r.urls.preferred === 'portal' && (
                        <span className='ml-2 text-[10.5px] text-emerald-600'>
                          this person's app
                        </span>
                      )}
                    </dd>
                    <dt className='text-slate-500'>Admin</dt>
                    <dd className='break-all text-slate-700 dark:text-foreground'>
                      {r.urls.admin ?? '—'}
                      {r.urls.preferred === 'admin' && (
                        <span className='ml-2 text-[10.5px] text-emerald-600'>
                          this person's app
                        </span>
                      )}
                    </dd>
                    <dt className='text-slate-500'>Inline action</dt>
                    <dd className='text-slate-700 dark:text-foreground'>
                      {r.actions.length === 0
                        ? 'none — open only'
                        : r.actions.map((a) => `${a.label} → ${a.endpoint}`).join(' · ')}
                    </dd>
                  </dl>
                </section>
              </div>
            )}
          </div>
        </div>
        <WhoWouldHearCard />
      </div>
    </div>
  )
}
