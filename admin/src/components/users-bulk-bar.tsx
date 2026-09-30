import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { api } from '@/lib/api'

type Mode = null | 'role' | 'suspend' | 'activate' | 'delegate' | 'team' | 'notify'

interface BulkResult {
  results: Array<{
    id: string
    name: string
    outcome: 'changed' | 'skipped' | 'failed'
    reason?: string
  }>
  changed: number
  skipped: number
  failed: number
}

const errMsg = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

/**
 * #641 — the Users list's bulk bar: set a role, suspend or reactivate, give
 * everyone one delegate, add to a team, check the directory, or send a
 * message. Server writes are per person with their own activity row; the bar
 * reports who was changed, who was already there and who failed, by name.
 */
export function UsersBulkBar({
  selected,
  roles,
  onClear
}: {
  selected: Map<string, { id: string; name: string }>
  roles: Array<{ id: string; name: string }>
  onClear: () => void
}) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [roleId, setRoleId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [delegate, setDelegate] = useState<{ id: string; name: string } | null>(null)
  const [delegateQuery, setDelegateQuery] = useState('')
  const [expires, setExpires] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [emailToo, setEmailToo] = useState(false)
  const [last, setLast] = useState<BulkResult | null>(null)
  const ids = [...selected.keys()]
  const n = ids.length

  const { data: teams = [] } = useQuery<Array<{ id: number; name: string }>>({
    queryKey: ['bulk-teams'],
    queryFn: () => api.get('/user-groups').then((r) => r.data.data ?? []),
    enabled: mode === 'team'
  })
  const { data: people = [] } = useQuery<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
  >({
    queryKey: ['bulk-delegate-search', delegateQuery],
    queryFn: () =>
      api.get('/users', { params: { search: delegateQuery, limit: 8 } }).then((r) => r.data.data),
    enabled: mode === 'delegate' && delegateQuery.trim().length > 1
  })

  async function run(body: Record<string, unknown>, verb: string) {
    setBusy(true)
    try {
      const r = await api.post<{ data: BulkResult }>('/users/bulk', { ids, ...body })
      const s = r.data.data
      setLast(s)
      const parts = [
        `${s.changed} ${verb}`,
        s.skipped ? `${s.skipped} already there` : null,
        s.failed ? `${s.failed} failed` : null
      ].filter(Boolean)
      toast[s.failed ? 'warning' : 'success'](parts.join(' · '))
      qc.invalidateQueries({ queryKey: ['users'] })
      setMode(null)
    } catch (err) {
      toast.error(errMsg(err, 'Bulk change failed'))
    } finally {
      setBusy(false)
    }
  }

  async function checkDirectory() {
    setBusy(true)
    try {
      const r = await api.post('/directory/check', { user_ids: ids })
      const s = r.data.data as {
        checked: number
        disabled: number
        missing: number
        suspended: number
      }
      toast.success(
        `Checked ${s.checked} — ${s.disabled} disabled, ${s.missing} not in the directory, ${s.suspended} suspended`
      )
      qc.invalidateQueries({ queryKey: ['users'] })
    } catch (err) {
      toast.error(errMsg(err, 'Directory check failed'))
    } finally {
      setBusy(false)
    }
  }

  async function notify() {
    setBusy(true)
    try {
      const r = await api.post('/notifications/bulk', {
        subject,
        message,
        user_ids: ids,
        channels: { inapp: true, email: emailToo }
      })
      const sent = (r.data?.data?.recipients ?? r.data?.data?.sent ?? n) as number
      toast.success(`Sent to ${sent} ${sent === 1 ? 'person' : 'people'}`)
      setSubject('')
      setMessage('')
      setMode(null)
    } catch (err) {
      toast.error(errMsg(err, 'Could not send'))
    } finally {
      setBusy(false)
    }
  }

  if (n === 0) return null
  const pill = (m: Exclude<Mode, null>, label: string, tone?: 'danger') => (
    <button
      type='button'
      data-users-bulk={m}
      aria-pressed={mode === m}
      onClick={() => setMode(mode === m ? null : m)}
      className={
        mode === m
          ? 'h-7 rounded-md bg-nvr-cyan/15 px-2.5 text-[12px] font-semibold text-nvr-navy dark:text-nvr-cyan'
          : tone === 'danger'
            ? 'h-7 rounded-md px-2.5 text-[12px] font-medium text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10'
            : 'h-7 rounded-md px-2.5 text-[12px] font-medium text-slate-700 hover:bg-muted dark:text-slate-200'
      }
    >
      {label}
    </button>
  )

  return (
    <div
      data-users-bulk-bar
      className='mb-3 rounded-lg border border-nvr-cyan/40 bg-white shadow-sm dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-1 px-3 py-2'>
        <span className='mr-2 text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          {n} selected
        </span>
        {pill('role', 'Set role')}
        {pill('delegate', 'Assign delegate')}
        {pill('team', 'Add to team')}
        {pill('notify', 'Send message')}
        <button
          type='button'
          data-users-bulk='directory'
          disabled={busy}
          onClick={checkDirectory}
          className='h-7 rounded-md px-2.5 text-[12px] font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:text-slate-200'
        >
          Check directory
        </button>
        {pill('activate', 'Reactivate')}
        {pill('suspend', 'Suspend', 'danger')}
        <button
          type='button'
          onClick={() => {
            onClear()
            setMode(null)
            setLast(null)
          }}
          className='ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-slate-500 hover:bg-muted'
        >
          <X className='h-3.5 w-3.5' /> Clear
        </button>
      </div>

      {mode && (
        <div
          className='flex flex-wrap items-end gap-2 border-t border-slate-100 px-3 py-2.5 dark:border-border/60'
          data-users-bulk-panel={mode}
        >
          {mode === 'role' && (
            <>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger className='h-8 w-56 text-[12.5px]' aria-label='Role'>
                  <SelectValue placeholder='Pick a role' />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size='sm'
                disabled={!roleId || busy}
                onClick={() => run({ action: 'set_role', role_id: roleId }, 'changed')}
              >
                {busy && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
                Set role for {n}
              </Button>
            </>
          )}
          {(mode === 'suspend' || mode === 'activate') && (
            <>
              <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
                {mode === 'suspend'
                  ? `Suspend ${n} ${n === 1 ? 'person' : 'people'}? They are signed out on their next request and drop out of every picker. What they own stays with them; use Hand off for that.`
                  : `Reactivate ${n} ${n === 1 ? 'person' : 'people'}?`}
              </p>
              <Button
                size='sm'
                variant={mode === 'suspend' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() =>
                  run({ action: mode }, mode === 'suspend' ? 'suspended' : 'reactivated')
                }
              >
                {busy && <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />}
                {mode === 'suspend' ? `Suspend ${n}` : `Reactivate ${n}`}
              </Button>
            </>
          )}
          {mode === 'delegate' && (
            <>
              {delegate ? (
                <span className='inline-flex h-8 items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                  {delegate.name}
                  <button
                    type='button'
                    aria-label='Clear delegate'
                    onClick={() => setDelegate(null)}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <div className='relative'>
                  <Input
                    value={delegateQuery}
                    onChange={(e) => setDelegateQuery(e.target.value)}
                    placeholder='Delegate — search people'
                    className='h-8 w-60 text-[12.5px]'
                  />
                  {delegateQuery.trim().length > 1 && people.length > 0 && (
                    <div className='absolute z-20 mt-1 w-60 rounded-md border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card'>
                      {people.map((p) => {
                        const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || p.email
                        return (
                          <button
                            key={p.id}
                            type='button'
                            onClick={() => {
                              setDelegate({ id: p.id, name })
                              setDelegateQuery('')
                            }}
                            className='block w-full px-2.5 py-1.5 text-left text-[12.5px] hover:bg-muted'
                          >
                            {name}
                            <span className='ml-1.5 text-[11px] text-slate-400'>{p.email}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              <div className='flex flex-col gap-0.5 text-[11px] text-slate-500'>
                <span id='bulk-delegate-until'>Until (optional)</span>
                <Input
                  type='date'
                  aria-labelledby='bulk-delegate-until'
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  className='h-8 w-40 text-[12.5px]'
                />
              </div>
              <Button
                size='sm'
                disabled={!delegate || busy}
                onClick={() =>
                  run(
                    {
                      action: 'set_delegate',
                      delegate_id: delegate?.id,
                      expires_at: expires || null
                    },
                    'now delegate'
                  )
                }
              >
                Set delegate for {n}
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={() => run({ action: 'set_delegate', delegate_id: null }, 'cleared')}
              >
                Clear their delegates
              </Button>
            </>
          )}
          {mode === 'team' && (
            <>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className='h-8 w-56 text-[12.5px]' aria-label='Team'>
                  <SelectValue placeholder='Pick a team' />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size='sm'
                disabled={!teamId || busy}
                onClick={() => run({ action: 'add_to_team', team_id: Number(teamId) }, 'added')}
              >
                Add {n} to team
              </Button>
            </>
          )}
          {mode === 'notify' && (
            <>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder='Subject'
                className='h-8 w-64 text-[12.5px]'
              />
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder='Message'
                className='h-8 min-w-[240px] flex-1 text-[12.5px]'
              />
              <label className='inline-flex h-8 items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                <input
                  type='checkbox'
                  checked={emailToo}
                  onChange={(e) => setEmailToo(e.target.checked)}
                />
                Email too
              </label>
              <Button
                size='sm'
                disabled={!subject.trim() || !message.trim() || busy}
                onClick={notify}
              >
                Send to {n}
              </Button>
            </>
          )}
        </div>
      )}

      {last && (last.skipped > 0 || last.failed > 0) && (
        <details
          className='border-t border-slate-100 px-3 py-2 text-[12px] dark:border-border/60'
          data-users-bulk-result
        >
          <summary className='cursor-pointer text-slate-600 dark:text-slate-300'>
            {last.changed} changed · {last.skipped} already there · {last.failed} failed
          </summary>
          <ul className='mt-1.5 space-y-0.5'>
            {last.results
              .filter((r) => r.outcome !== 'changed')
              .map((r) => (
                <li
                  key={r.id}
                  className={
                    r.outcome === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-slate-500'
                  }
                >
                  {r.name} — {r.reason}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  )
}
