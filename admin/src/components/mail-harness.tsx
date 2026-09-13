import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Send, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * "Send a real one": pick an email type, pick a REAL sample (a workflow
 * transition, a changed record, a user…), see the exact email production
 * would send — with its resolved recipients — and send it to yourself, to an
 * address, or to the real recipients.
 */

interface MailType {
  key: string
  label: string
  group: string
  description: string
  template: string | null
  category: string | null
  sample: { kind: string; collection?: string | null }
}
interface Sample {
  id: string
  label: string
  hint?: string
}
interface Rendered {
  subject: string
  html: string
  recipients: Array<{ email: string; reason: string; app?: 'portal' | 'admin' }>
}

const SAMPLE_LABEL: Record<string, string> = {
  history: 'Pick a transition',
  record: 'Pick a record',
  user: 'Pick a user',
  notification: 'Pick a recent event',
  none: ''
}

export function MailHarness() {
  const [typeKey, setTypeKey] = useState<string | null>(null)
  const [sample, setSample] = useState<Sample | null>(null)
  const [q, setQ] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rendered, setRendered] = useState<Rendered | null>(null)
  const [address, setAddress] = useState('')
  const [confirmReal, setConfirmReal] = useState(false)

  const { data: types = [] } = useQuery<MailType[]>({
    queryKey: ['mail-types'],
    queryFn: () => api.get('/mail-types').then((r) => r.data.data)
  })
  const type = types.find((t) => t.key === typeKey) ?? null
  const groups = useMemo(() => {
    const m = new Map<string, MailType[]>()
    for (const t of types) m.set(t.group, [...(m.get(t.group) ?? []), t])
    return [...m.entries()]
  }, [types])

  const { data: samples = [], isFetching: samplesLoading } = useQuery<Sample[]>({
    queryKey: ['mail-type-samples', typeKey, q],
    queryFn: () =>
      api.get(`/mail-types/${typeKey}/samples`, { params: { q } }).then((r) => r.data.data),
    enabled: !!typeKey && type?.sample.kind !== 'none'
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset ONLY when the type changes
  useEffect(() => {
    setSample(null)
    setRendered(null)
    setConfirmReal(false)
    setQ('')
  }, [typeKey])

  const preview = useMutation({
    mutationFn: () =>
      api
        .post(`/mail-types/${typeKey}/preview`, { sample_id: sample?.id })
        .then((r) => r.data.data as Rendered),
    onSuccess: (r) => setRendered(r),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Preview failed')
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: preview is stable per sample
  useEffect(() => {
    if (typeKey && (sample || type?.sample.kind === 'none')) preview.mutate()
  }, [sample?.id, typeKey])

  const send = useMutation({
    mutationFn: (mode: 'self' | 'address' | 'recipients') =>
      api.post(`/mail-types/${typeKey}/send`, {
        sample_id: sample?.id,
        mode,
        to: mode === 'address' ? address : undefined
      }),
    onSuccess: (r) => {
      setConfirmReal(false)
      toast.success(
        `Sent to ${(r.data.data.to as string[]).join(', ')} (mail test mode still applies)`
      )
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Send failed')
  })

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden' data-mail-harness>
      <aside className='w-[260px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white py-2 dark:border-border dark:bg-card'>
        {groups.map(([group, list]) => (
          <div key={group} className='mb-2'>
            <p className='px-4 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
              {group}
            </p>
            {list.map((t) => (
              <button
                key={t.key}
                type='button'
                onClick={() => setTypeKey(t.key)}
                title={t.description}
                className={cn(
                  'flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12.5px]',
                  typeKey === t.key
                    ? 'bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-muted-foreground dark:hover:bg-muted/50'
                )}
              >
                <span className='min-w-0 flex-1 truncate'>{t.label}</span>
                {t.template && (
                  <span className='shrink-0 font-mono text-[10px] text-slate-400'>
                    {t.template}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className='flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-background'>
        {!type ? (
          <p className='px-6 py-10 text-center text-[13px] text-slate-400'>
            Pick an email type to render it with real data.
          </p>
        ) : (
          <>
            <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
              <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                {type.label}
              </p>
              <p className='mt-0.5 max-w-[80ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
                {type.description}
              </p>
              <div className='mt-3 flex flex-wrap items-center gap-2'>
                {type.sample.kind !== 'none' && (
                  <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className='inline-flex h-8 min-w-[320px] max-w-[560px] items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-[12.5px] text-slate-700 hover:border-slate-400 dark:border-border dark:bg-background dark:text-slate-200'
                        data-mail-sample-trigger
                      >
                        <span className='min-w-0 flex-1 truncate'>
                          {sample
                            ? sample.label
                            : (SAMPLE_LABEL[type.sample.kind] ?? 'Pick a sample')}
                        </span>
                        <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align='start' className='w-[560px] p-0'>
                      <Command shouldFilter={false}>
                        <CommandInput placeholder='Search…' value={q} onValueChange={setQ} />
                        <CommandList className='max-h-[320px]'>
                          <CommandEmpty>{samplesLoading ? 'Loading…' : 'No samples'}</CommandEmpty>
                          <CommandGroup>
                            {samples.map((s) => (
                              <CommandItem
                                key={s.id}
                                value={s.id}
                                onSelect={() => {
                                  setSample(s)
                                  setPickerOpen(false)
                                }}
                                className='flex items-start gap-2'
                              >
                                <Check
                                  className={cn(
                                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                                    sample?.id === s.id ? 'opacity-100' : 'opacity-0'
                                  )}
                                />
                                <span className='min-w-0 flex-1'>
                                  <span className='block truncate text-[12.5px]'>{s.label}</span>
                                  {s.hint && (
                                    <span className='block truncate text-[11px] text-slate-400'>
                                      {s.hint}
                                    </span>
                                  )}
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                )}
                {preview.isPending && (
                  <span className='text-[12px] text-slate-400'>Rendering…</span>
                )}
                <span className='flex-1' />
                <button
                  type='button'
                  disabled={!rendered || send.isPending}
                  onClick={() => send.mutate('self')}
                  className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted'
                >
                  <Send className='h-3.5 w-3.5' /> Send to me
                </button>
                <span className='inline-flex h-8 items-center overflow-hidden rounded-md border border-slate-200 dark:border-border'>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder='someone@example.com'
                    className='h-full w-[220px] bg-white px-2 text-[12px] outline-none dark:bg-background'
                    data-mail-harness-address
                  />
                  <button
                    type='button'
                    disabled={!rendered || !address.includes('@') || send.isPending}
                    onClick={() => send.mutate('address')}
                    className='h-full border-l border-slate-200 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted'
                  >
                    Send
                  </button>
                </span>
                {confirmReal ? (
                  <span className='inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'>
                    Send to {rendered?.recipients.length ?? 0} real recipient(s)?
                    <button
                      type='button'
                      onClick={() => send.mutate('recipients')}
                      className='rounded bg-amber-600 px-2 py-0.5 font-semibold text-white'
                    >
                      Yes, send
                    </button>
                    <button
                      type='button'
                      onClick={() => setConfirmReal(false)}
                      className='px-1 text-amber-700 dark:text-amber-300'
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type='button'
                    disabled={!rendered || rendered.recipients.length === 0 || send.isPending}
                    onClick={() => setConfirmReal(true)}
                    className='inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-300 px-3 text-[12.5px] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10'
                  >
                    <Users className='h-3.5 w-3.5' /> Send to actual recipients
                  </button>
                )}
              </div>
            </div>
            <div className='flex min-h-0 flex-1'>
              <div className='min-h-0 flex-1 overflow-auto bg-slate-100 p-4 dark:bg-background'>
                {rendered ? (
                  <iframe
                    title='Email preview'
                    srcDoc={rendered.html}
                    sandbox=''
                    className='h-full min-h-[700px] w-full rounded-lg border border-slate-200 bg-white dark:border-border'
                    data-mail-harness-preview
                  />
                ) : (
                  <p className='px-6 py-10 text-center text-[12.5px] text-slate-400'>
                    {type.sample.kind === 'none'
                      ? 'Rendering…'
                      : 'Pick a sample to render the email.'}
                  </p>
                )}
              </div>
              <aside className='w-[300px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
                <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  Subject
                </p>
                <p className='mt-1 text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {rendered?.subject ?? '—'}
                </p>
                <p className='mt-4 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  Production would send to
                </p>
                {rendered?.recipients.length ? (
                  <ul className='mt-1 space-y-1.5'>
                    {rendered.recipients.map((r) => (
                      <li key={r.email} className='text-[12.5px]'>
                        <span className='block truncate font-mono text-slate-800 dark:text-foreground'>
                          {r.email}
                        </span>
                        <span className='block text-[11px] text-slate-400'>
                          {r.reason}
                          {r.app && (
                            <span className='ml-1.5 rounded bg-slate-100 px-1 py-px text-[9.5px] font-semibold uppercase text-slate-500 dark:bg-muted dark:text-slate-400'>
                              {r.app}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className='mt-1 text-[12px] text-slate-400'>
                    {rendered ? 'Nobody — no recipient resolves for this sample.' : '—'}
                  </p>
                )}
                {type.template && (
                  <>
                    <p className='mt-4 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                      Template
                    </p>
                    <p className='mt-1 font-mono text-[12px] text-slate-600 dark:text-slate-300'>
                      {type.template}.liquid
                    </p>
                    <p className='mt-1 text-[11px] text-slate-400'>
                      Edit it on the Templates tab — overrides apply here immediately.
                    </p>
                  </>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
