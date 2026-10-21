import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, CircleDashed, Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { type IceProbeResult, type IceServerDto, probeIce } from '@/lib/ice-probe'

/**
 * Settings → Huddles (#2457): whether huddles run, and the STUN/TURN servers
 * browsers use to reach each other. Per instance (GET/PATCH
 * /chat/huddle/settings), because a laptop, staging and production each have
 * their own network. Secrets come back masked and a masked value re-submitted
 * keeps what is stored.
 */

interface HuddleSettingsDto {
  enabled: boolean
  stun_urls: string[]
  turn_urls: string[]
  turn_username: string | null
  turn_credential: string | null
  turn_secret: string | null
  turn_ttl_s: number
  max_participants: number
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  /** Gets the id the label points at. */
  children: (id: string) => React.ReactNode
}) {
  const id = useId()
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id} className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {label}
      </Label>
      {children(id)}
      {hint && <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>}
    </div>
  )
}

type HuddleForm = {
  enabled: boolean
  stun: string
  turn: string
  username: string
  credential: string
  secret: string
  ttl: string
  max: string
}

function toForm(d: HuddleSettingsDto): HuddleForm {
  return {
    enabled: d.enabled,
    stun: d.stun_urls.join('\n'),
    turn: d.turn_urls.join('\n'),
    username: d.turn_username ?? '',
    credential: d.turn_credential ?? '',
    secret: d.turn_secret ?? '',
    ttl: String(d.turn_ttl_s),
    max: String(d.max_participants)
  }
}

export function HuddleSettingsSection() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['huddle-settings'],
    queryFn: () =>
      api.get<{ data: HuddleSettingsDto }>('/chat/huddle/settings').then((r) => r.data.data)
  })
  const [form, setForm] = useState<HuddleForm | null>(null)
  if (data && !form) setForm(toForm(data))

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ data: HuddleSettingsDto }>('/chat/huddle/settings', {
        enabled: form?.enabled,
        stun_urls: form?.stun ?? '',
        turn_urls: form?.turn ?? '',
        turn_username: form?.username ?? '',
        turn_credential: form?.credential ?? '',
        turn_secret: form?.secret ?? '',
        turn_ttl_s: Number(form?.ttl),
        max_participants: Number(form?.max)
      }),
    onSuccess: (r) => {
      qc.setQueryData(['huddle-settings'], r.data.data)
      setForm(null)
      toast.success('Huddle settings saved')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Could not save huddle settings')
  })

  const test = useMutation({
    mutationFn: async (): Promise<IceProbeResult & { stun: boolean; turn: boolean }> => {
      const r = await api.get<{ data: { iceServers: IceServerDto[] } }>(
        '/chat/huddle/settings/test-ice'
      )
      const servers = r.data.data.iceServers
      const stun = servers.some((x) => x.urls.some((u) => u.startsWith('stun')))
      const turn = servers.some((x) => x.urls.some((u) => u.startsWith('turn')))
      return { ...(await probeIce(servers)), stun, turn }
    }
  })

  const hasTurn = !!form?.turn.trim()
  const update = (patch: Partial<HuddleForm>) => setForm((f) => (f ? { ...f, ...patch } : f))
  const dirty = !!data && !!form && JSON.stringify(toForm(data)) !== JSON.stringify(form)

  return (
    <div className='p-8'>
      <div className='max-w-2xl'>
        <h2 className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Huddles
        </h2>
        <p className='mb-6 mt-1 max-w-[70ch] text-[12px] text-muted-foreground'>
          Voice huddles with an optional screen share, started from a channel or a record's room.
          Audio goes browser to browser; this instance only relays the handshake. With nothing set
          here, people on the same network reach each other directly and no outside server is
          contacted. Add a STUN/TURN server for people on different networks — behind strict
          firewalls that means a TURN relay, such as a self-hosted coturn, with either its shared
          secret or a username and password.
        </p>
        {isError ? (
          <p className='text-[12px] text-red-600 dark:text-red-300'>
            Huddle settings could not be loaded. Reload the page to try again.
          </p>
        ) : isLoading || !form ? (
          <div className='space-y-3'>
            <Skeleton className='h-9 w-full rounded-lg' />
            <Skeleton className='h-24 w-full rounded-lg' />
            <Skeleton className='h-24 w-full rounded-lg' />
          </div>
        ) : (
          <div className='space-y-5'>
            <div className='flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-4 py-3 dark:border-border'>
              <div>
                <p className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  Allow huddles
                </p>
                <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  Off hides the headphones button for everyone. Running huddles end.
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
                aria-label='Allow huddles'
              />
            </div>

            <Field
              label='STUN servers'
              hint='One per line. Leave empty when everyone is on the same network.'
            >
              {(id) => (
                <Textarea
                  id={id}
                  value={form.stun}
                  onChange={(e) => update({ stun: e.target.value })}
                  placeholder='e.g. stun:stun.example.com:3478'
                  rows={2}
                  className='font-mono text-[12px]'
                />
              )}
            </Field>

            <Field
              label='TURN servers'
              hint='One per line, e.g. turn:turn.example.com:3478?transport=udp and turns:turn.example.com:5349. Empty = no relay.'
            >
              {(id) => (
                <Textarea
                  id={id}
                  value={form.turn}
                  onChange={(e) => update({ turn: e.target.value })}
                  placeholder={'e.g. turn:turn.example.com:3478\nturns:turn.example.com:5349'}
                  rows={2}
                  className='font-mono text-[12px]'
                />
              )}
            </Field>

            <div className='space-y-5'>
              {!hasTurn && (
                <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  The relay credentials below open once a TURN server is listed.
                </p>
              )}
              <Field
                label='coturn shared secret'
                hint='Recommended: with `use-auth-secret` on coturn, each person gets a short-lived credential minted here. The secret never leaves the server.'
              >
                {(id) => (
                  <Input
                    id={id}
                    type='password'
                    value={form.secret}
                    onChange={(e) => update({ secret: e.target.value })}
                    placeholder='static-auth-secret from turnserver.conf'
                    autoComplete='off'
                    disabled={!hasTurn}
                    className='h-8 font-mono text-[12px]'
                  />
                )}
              </Field>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <Field label='Credential lifetime (seconds)' hint='60 – 86400; 3600 is usual.'>
                  {(id) => (
                    <Input
                      id={id}
                      type='number'
                      min={60}
                      max={86400}
                      value={form.ttl}
                      onChange={(e) => update({ ttl: e.target.value })}
                      disabled={!hasTurn || !form.secret}
                      className='h-8 text-[12px]'
                    />
                  )}
                </Field>
              </div>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <Field
                  label='TURN username'
                  hint='Only without a shared secret (long-term credentials).'
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={form.username}
                      onChange={(e) => update({ username: e.target.value })}
                      autoComplete='off'
                      disabled={!hasTurn || !!form.secret}
                      className='h-8 text-[12px]'
                    />
                  )}
                </Field>
                <Field label='TURN password'>
                  {(id) => (
                    <Input
                      id={id}
                      type='password'
                      value={form.credential}
                      onChange={(e) => update({ credential: e.target.value })}
                      autoComplete='off'
                      disabled={!hasTurn || !!form.secret}
                      className='h-8 text-[12px]'
                    />
                  )}
                </Field>
              </div>
            </div>

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <Field
                label='People per huddle'
                hint='Audio is sent peer to peer, so every extra person costs every browser a stream. 2 – 16; 8 is a sensible cap.'
              >
                {(id) => (
                  <Input
                    id={id}
                    type='number'
                    min={2}
                    max={16}
                    value={form.max}
                    onChange={(e) => update({ max: e.target.value })}
                    className='h-8 text-[12px]'
                  />
                )}
              </Field>
            </div>

            <div className='flex items-center gap-2 border-t border-slate-200 pt-4 dark:border-border'>
              <Button size='sm' onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setForm(null)}
                disabled={!dirty || save.isPending}
              >
                Discard changes
              </Button>
            </div>

            <div className='space-y-2 rounded-lg border border-slate-200 px-4 py-3 dark:border-border'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <p className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
                    Test the connection
                  </p>
                  <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    Asks the saved servers for a relay from this browser. Nobody is called.
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => test.mutate()}
                  disabled={dirty || test.isPending}
                  data-tip={
                    dirty ? 'Save your changes first — the test uses the saved servers' : undefined
                  }
                >
                  {test.isPending && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
                  {test.isPending ? 'Testing…' : 'Test connection'}
                </Button>
              </div>
              {test.isError && (
                <ProbeLine tone='bad'>
                  The test could not start. Reload the page and try again.
                </ProbeLine>
              )}
              {test.data && <ProbeOutcome r={test.data} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ProbeLine({
  tone,
  children
}: {
  tone: 'good' | 'warn' | 'bad' | 'none'
  children: React.ReactNode
}) {
  const Icon = tone === 'good' ? CircleCheck : tone === 'none' ? CircleDashed : CircleAlert
  return (
    <p
      className={
        tone === 'good'
          ? 'flex items-start gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-300'
          : tone === 'warn'
            ? 'flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-300'
            : tone === 'bad'
              ? 'flex items-start gap-1.5 text-[12px] text-red-700 dark:text-red-300'
              : 'flex items-start gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'
      }
      role='status'
      data-huddle-probe={tone}
    >
      <Icon className='mt-px h-3.5 w-3.5 shrink-0' strokeWidth={2} />
      <span>{children}</span>
    </p>
  )
}

function ProbeOutcome({ r }: { r: IceProbeResult & { stun: boolean; turn: boolean } }) {
  if (r.error) return <ProbeLine tone='bad'>{r.error}</ProbeLine>
  if (!r.stun && !r.turn)
    return (
      <ProbeLine tone='none'>
        No servers are saved, so only people on the same network can reach each other.
      </ProbeLine>
    )
  return (
    <div className='space-y-1'>
      {r.turn &&
        (r.relay ? (
          <ProbeLine tone='good'>
            The relay works: the TURN server accepted the credential and gave this browser{' '}
            <span className='font-mono'>{r.relay}</span> ({r.ms} ms).
          </ProbeLine>
        ) : (
          <ProbeLine tone='bad'>
            No relay came back. Check the TURN address, that the shared secret matches
            turnserver.conf, and that UDP 3478 and the relay ports (49152–49252) are open from this
            network.
          </ProbeLine>
        ))}
      {r.stun &&
        (r.srflx ? (
          <ProbeLine tone='good'>
            STUN answered: this browser is seen as <span className='font-mono'>{r.srflx}</span>.
          </ProbeLine>
        ) : (
          <ProbeLine tone={r.relay ? 'warn' : 'bad'}>
            STUN did not answer. Check the STUN address and UDP 3478.
          </ProbeLine>
        ))}
    </div>
  )
}
