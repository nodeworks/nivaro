import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

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
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1.5'>
      <Label className='text-[12px] font-medium text-slate-700 dark:text-foreground'>{label}</Label>
      {children}
      {hint && <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>}
    </div>
  )
}

export function HuddleSettingsSection() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['huddle-settings'],
    queryFn: () =>
      api.get<{ data: HuddleSettingsDto }>('/chat/huddle/settings').then((r) => r.data.data)
  })
  const [form, setForm] = useState<{
    enabled: boolean
    stun: string
    turn: string
    username: string
    credential: string
    secret: string
    ttl: string
    max: string
  } | null>(null)
  if (data && !form) {
    setForm({
      enabled: data.enabled,
      stun: data.stun_urls.join('\n'),
      turn: data.turn_urls.join('\n'),
      username: data.turn_username ?? '',
      credential: data.turn_credential ?? '',
      secret: data.turn_secret ?? '',
      ttl: String(data.turn_ttl_s),
      max: String(data.max_participants)
    })
  }

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

  const hasTurn = !!form?.turn.trim()
  const update = (patch: Partial<NonNullable<typeof form>>) =>
    setForm((f) => (f ? { ...f, ...patch } : f))

  return (
    <div className='p-8'>
      <div className='max-w-2xl'>
        <h2 className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Huddles
        </h2>
        <p className='mb-6 mt-1 text-[12px] text-muted-foreground'>
          Voice huddles with an optional screen share, started from a channel or a record's room.
          Audio goes browser to browser; this instance only relays the handshake. With nothing set
          here, people on the same network reach each other directly and no outside server is
          contacted. Add a STUN/TURN server for people on different networks — behind strict
          firewalls that means a TURN relay, such as a self-hosted coturn, with either its shared
          secret or a username and password.
        </p>
        {isLoading || !form ? (
          <div className='space-y-3'>
            <Skeleton className='h-9 w-full rounded-lg' />
            <Skeleton className='h-24 w-full rounded-lg' />
            <Skeleton className='h-24 w-full rounded-lg' />
          </div>
        ) : isError ? (
          <p className='text-[12px] text-red-600 dark:text-red-300'>
            Huddle settings could not be loaded.
          </p>
        ) : (
          <div className='space-y-5'>
            <div className='flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 dark:border-border'>
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
              hint='One per line. Empty = none: add a STUN/TURN server for people on different networks.'
            >
              <Textarea
                value={form.stun}
                onChange={(e) => update({ stun: e.target.value })}
                placeholder='stun:stun.example.com:3478'
                rows={2}
                className='font-mono text-[12px]'
              />
            </Field>

            <Field
              label='TURN servers'
              hint='One per line, e.g. turn:turn.example.com:3478?transport=udp and turns:turn.example.com:5349. Empty = no relay.'
            >
              <Textarea
                value={form.turn}
                onChange={(e) => update({ turn: e.target.value })}
                placeholder={'turn:turn.example.com:3478\nturns:turn.example.com:5349'}
                rows={2}
                className='font-mono text-[12px]'
              />
            </Field>

            <div className={hasTurn ? 'space-y-5' : 'space-y-5 opacity-50'}>
              <Field
                label='coturn shared secret'
                hint='Recommended: with `use-auth-secret` on coturn, each person gets a short-lived credential minted here. The secret never leaves the server.'
              >
                <Input
                  type='password'
                  value={form.secret}
                  onChange={(e) => update({ secret: e.target.value })}
                  placeholder='static-auth-secret from turnserver.conf'
                  autoComplete='off'
                  disabled={!hasTurn}
                  className='h-8 font-mono text-[12px]'
                />
              </Field>
              <div className='grid grid-cols-2 gap-4'>
                <Field label='Credential lifetime (seconds)' hint='60 – 86400; 3600 is usual.'>
                  <Input
                    type='number'
                    min={60}
                    max={86400}
                    value={form.ttl}
                    onChange={(e) => update({ ttl: e.target.value })}
                    disabled={!hasTurn || !form.secret}
                    className='h-8 text-[12px]'
                  />
                </Field>
              </div>
              <div className='grid grid-cols-2 gap-4'>
                <Field
                  label='TURN username'
                  hint='Only without a shared secret (long-term credentials).'
                >
                  <Input
                    value={form.username}
                    onChange={(e) => update({ username: e.target.value })}
                    autoComplete='off'
                    disabled={!hasTurn || !!form.secret}
                    className='h-8 text-[12px]'
                  />
                </Field>
                <Field label='TURN password'>
                  <Input
                    type='password'
                    value={form.credential}
                    onChange={(e) => update({ credential: e.target.value })}
                    autoComplete='off'
                    disabled={!hasTurn || !!form.secret}
                    className='h-8 text-[12px]'
                  />
                </Field>
              </div>
            </div>

            <div className='grid grid-cols-2 gap-4'>
              <Field
                label='People per huddle'
                hint='Audio is sent peer to peer, so every extra person costs every browser a stream. 2 – 16; 8 is a sensible cap.'
              >
                <Input
                  type='number'
                  min={2}
                  max={16}
                  value={form.max}
                  onChange={(e) => update({ max: e.target.value })}
                  className='h-8 text-[12px]'
                />
              </Field>
            </div>

            <div className='flex items-center gap-2 border-t border-slate-200 pt-4 dark:border-border'>
              <Button
                size='sm'
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className='bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setForm(null)}
                disabled={save.isPending}
              >
                Reset
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
