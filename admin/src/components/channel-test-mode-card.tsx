import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Test mode for web push and Teams (#832) — the same idea as mail and SMS
 * test mode: in dev and staging nobody outside the allowlist is reached.
 * Saves its own keys; the rest of the page is untouched.
 */
interface Row {
  push_test_mode?: boolean | number
  push_test_recipient?: string | null
  push_test_allowlist?: string | null
  teams_test_mode?: boolean | number
  teams_test_webhook_url?: string | null
  push_test_env_mode?: boolean
  push_test_env_recipient?: string | null
  teams_test_env_mode?: boolean
  teams_test_env_webhook?: boolean | null
}

const on = (v: unknown) => v === true || v === 1

export function ChannelTestModeCard() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['settings', 'channel-test-mode'],
    queryFn: () => api.get<{ data: Row }>('/settings').then((r) => r.data.data)
  })
  const [draft, setDraft] = useState({
    push: false,
    pushRecipient: '',
    pushAllow: '',
    teams: false,
    teamsWebhook: ''
  })
  useEffect(() => {
    const s = q.data
    if (!s) return
    setDraft({
      push: on(s.push_test_mode),
      pushRecipient: s.push_test_recipient ?? '',
      pushAllow: s.push_test_allowlist ?? '',
      teams: on(s.teams_test_mode),
      teamsWebhook: s.teams_test_webhook_url ?? ''
    })
  }, [q.data])
  const save = useMutation({
    mutationFn: () =>
      api.patch('/settings', {
        push_test_mode: draft.push,
        push_test_recipient: draft.pushRecipient.trim() || null,
        push_test_allowlist: draft.pushAllow.trim() || null,
        teams_test_mode: draft.teams,
        teams_test_webhook_url: draft.teamsWebhook.trim() || null
      }),
    onSuccess: () => {
      toast.success('Test mode saved')
      void qc.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: () => toast.error('Could not save test mode')
  })
  const s = q.data
  if (!s) return <div className='h-24 animate-pulse rounded-lg bg-muted' />
  const pushForced = !!s.push_test_env_mode
  const teamsForced = !!s.teams_test_env_mode
  const box = (active: boolean) =>
    cn(
      'rounded-lg border p-4',
      active
        ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
        : 'border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/30'
    )
  return (
    <div className='space-y-3' data-channel-test-mode>
      <div className={box(draft.push || pushForced)} data-push-test-mode>
        <div className='mb-2 flex items-center justify-between'>
          <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Browser push test mode
          </p>
          <Switch checked={draft.push} onCheckedChange={(v) => setDraft({ ...draft, push: v })} />
        </div>
        <p className='mb-3 text-[11px] text-slate-500 dark:text-muted-foreground'>
          When on, a push to anyone outside the allowlist goes to the test person&apos;s browsers
          instead, titled with who it was for. With no test person it is dropped.
          {pushForced &&
            ` PUSH_TEST_MODE forces this on for this instance${s.push_test_env_recipient ? ` (default recipient ${s.push_test_env_recipient}, used while the field is empty and the switch is off)` : ''}.`}
        </p>
        {(draft.push || pushForced) && (
          <div className='grid gap-3 sm:grid-cols-2'>
            <label className='space-y-1 text-[11.5px] text-slate-600 dark:text-slate-300'>
              Test person (email of a Nivaro user)
              <Input
                value={draft.pushRecipient}
                onChange={(e) => setDraft({ ...draft, pushRecipient: e.target.value })}
                placeholder='qa@example.com'
                className='h-8 font-mono text-[13px]'
                data-push-test-recipient
              />
            </label>
            <label className='space-y-1 text-[11.5px] text-slate-600 dark:text-slate-300'>
              Allowlist (emails or @domains)
              <Input
                value={draft.pushAllow}
                onChange={(e) => setDraft({ ...draft, pushAllow: e.target.value })}
                placeholder='@example.com, pat@partner.com'
                className='h-8 font-mono text-[13px]'
                data-push-test-allowlist
              />
            </label>
          </div>
        )}
      </div>
      <div className={box(draft.teams || teamsForced)} data-teams-test-mode>
        <div className='mb-2 flex items-center justify-between'>
          <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
            Teams test mode
          </p>
          <Switch checked={draft.teams} onCheckedChange={(v) => setDraft({ ...draft, teams: v })} />
        </div>
        <p className='mb-3 text-[11px] text-slate-500 dark:text-muted-foreground'>
          When on, every Teams card goes to the test channel&apos;s webhook instead, titled with the
          channel it was for. With no test webhook it is dropped.
          {teamsForced && ' TEAMS_TEST_MODE forces this on for this instance.'}
        </p>
        {(draft.teams || teamsForced) && (
          <label className='block space-y-1 text-[11.5px] text-slate-600 dark:text-slate-300'>
            Test channel incoming webhook URL
            <Input
              type='url'
              value={draft.teamsWebhook}
              onChange={(e) => setDraft({ ...draft, teamsWebhook: e.target.value })}
              placeholder='https://…webhook.office.com/…'
              className='h-8 text-[13px]'
              data-teams-test-webhook
            />
          </label>
        )}
      </div>
      <Button
        size='sm'
        onClick={() => save.mutate()}
        disabled={save.isPending}
        data-channel-test-save
      >
        Save test mode
      </Button>
    </div>
  )
}
