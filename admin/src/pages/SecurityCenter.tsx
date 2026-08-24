import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Security Center — active sessions with revoke, login history with new-IP
 * flags, and the instance-wide maintenance switch (writes frozen, admins
 * exempt, banner everywhere).
 */

interface SessionRow {
  sid_prefix: string
  user_id: string
  user_name: string
  ttl_seconds: number
}

interface LoginRow {
  id: number
  user: string
  user_name: string | null
  user_email: string | null
  method: string
  ip: string | null
  user_agent: string | null
  new_ip: boolean
  created_at: string
}

function rel(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/** Active edit locks (#89): who is holding which record, with force-release —
 *  the "someone left for lunch mid-edit" fix without hunting them down. */
function EditLocksCard() {
  const qc = useQueryClient()
  const { data: locks = [] } = useQuery<
    Array<{
      id: number
      collection: string
      item: string
      user: string
      locked_at: string
      holder_name: string | null
      holder_email: string | null
    }>
  >({
    queryKey: ['security-edit-locks'],
    queryFn: () => api.get('/item-locks').then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const release = useMutation({
    mutationFn: (l: { collection: string; item: string }) =>
      api.delete(`/item-locks/${l.collection}/${l.item}/lock?force=1`),
    onSuccess: () => {
      toast.success('Lock released')
      void qc.invalidateQueries({ queryKey: ['security-edit-locks'] })
    },
    onError: () => toast.error('Release failed')
  })
  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='border-b border-slate-200 px-4 py-3 dark:border-border'>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Active edit locks
        </p>
        <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Records someone is currently editing. Force-releasing kicks their lock — their unsaved
          changes stop saving, so use it for abandoned sessions, not active colleagues.
        </p>
      </div>
      <div className='divide-y divide-slate-50 dark:divide-border/40'>
        {locks.length === 0 && (
          <p className='px-4 py-4 text-[12.5px] text-slate-400'>No records are locked right now.</p>
        )}
        {locks.map((l) => (
          <div key={l.id} className='flex items-center gap-3 px-4 py-2 text-[12.5px]'>
            <span className='min-w-0 flex-1 truncate'>
              <span className='font-mono font-medium text-slate-700 dark:text-foreground'>
                {l.collection}/{l.item}
              </span>{' '}
              <span className='text-slate-500 dark:text-muted-foreground'>
                — {l.holder_name?.trim() || l.holder_email || l.user} since{' '}
                {new Date(l.locked_at).toLocaleTimeString()}
              </span>
            </span>
            <button
              type='button'
              disabled={release.isPending}
              onClick={() => release.mutate(l)}
              className='shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400'
            >
              Force release
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function MaintenanceCard() {
  const qc = useQueryClient()
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get('/settings').then((r) => r.data.data)
  })
  const [message, setMessage] = useState<string | null>(null)
  const on = !!settings?.maintenance_mode

  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api.patch('/settings', {
        maintenance_mode: next,
        ...(message != null ? { maintenance_message: message } : {})
      }),
    onSuccess: (_r, next) => {
      toast.success(next ? 'Maintenance mode ON — writes frozen for non-admins' : 'Maintenance mode off')
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['announcements-active'] })
    }
  })

  return (
    <div
      className={cn(
        'rounded-lg border bg-white p-4 dark:bg-card',
        on ? 'border-red-300 dark:border-red-500/40' : 'border-slate-200 dark:border-border'
      )}
    >
      <div className='flex flex-wrap items-center gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Maintenance mode
            {on && (
              <span className='ml-2 rounded bg-red-500/10 px-1.5 py-px text-[10.5px] font-semibold uppercase text-red-600 dark:text-red-400'>
                Active
              </span>
            )}
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            Freezes all writes for non-admins (reads keep working) and shows a banner everywhere.
            For cutovers and migrations — admins stay exempt so you can work.
          </p>
        </div>
        <input
          value={message ?? settings?.maintenance_message ?? ''}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Banner message (optional)'
          className='h-8 w-[280px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
        />
        <button
          type='button'
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!on)}
          className={cn(
            'h-8 rounded-md px-4 text-[12.5px] font-medium text-white disabled:opacity-50',
            on ? 'bg-emerald-600' : 'bg-red-600'
          )}
        >
          {on ? 'End maintenance' : 'Start maintenance'}
        </button>
      </div>
    </div>
  )
}

export default function SecurityCenter() {
  const qc = useQueryClient()
  const [newIpOnly, setNewIpOnly] = useState(false)
  const [page, setPage] = useState(1)

  const sessions = useQuery<SessionRow[]>({
    queryKey: ['security-sessions'],
    queryFn: () => api.get('/security/sessions').then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const logins = useQuery({
    queryKey: ['security-logins', newIpOnly, page],
    queryFn: () =>
      api
        .get('/security/logins', { params: { new_ip: newIpOnly || undefined, page } })
        .then((r) => r.data)
  })

  const revoke = useMutation({
    mutationFn: (prefix: string) => api.delete(`/security/sessions/${prefix}`),
    onSuccess: () => {
      toast.success('Session revoked — that browser is signed out')
      void qc.invalidateQueries({ queryKey: ['security-sessions'] })
    },
    onError: () => toast.error('Revoke failed')
  })

  // Group sessions per user for scanability.
  const byUser = new Map<string, SessionRow[]>()
  for (const s of sessions.data ?? []) {
    byUser.set(s.user_name, [...(byUser.get(s.user_name) ?? []), s])
  }
  const loginRows: LoginRow[] = logins.data?.data ?? []
  const total = logins.data?.total ?? 0

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <ShieldAlert className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Security Center
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Who is signed in right now (with a kill switch), every sign-in with new-location
              flags, and the instance maintenance switch.
            </p>
          </div>
        </div>
      </header>

      <div className='flex-1 space-y-4 overflow-y-auto p-6'>
        <MaintenanceCard />

        <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Active sessions
            <span className='ml-1.5 font-normal text-slate-400'>
              {sessions.data?.length ?? 0} session{(sessions.data?.length ?? 0) === 1 ? '' : 's'}
            </span>
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            Cookie sessions only — static API tokens don't appear here (revoke those on the user).
          </p>
          <div className='mt-3 space-y-2'>
            {[...byUser.entries()]
              .sort((a, z) => a[0].localeCompare(z[0]))
              .map(([name, list]) => (
                <div key={name} className='rounded-md border border-slate-100 px-3 py-2 dark:border-border'>
                  <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                    {name}
                    <span className='ml-1.5 text-[11px] font-normal text-slate-400'>
                      {list.length} session{list.length === 1 ? '' : 's'}
                    </span>
                  </p>
                  <div className='mt-1 flex flex-wrap gap-2'>
                    {list.map((s) => (
                      <span
                        key={s.sid_prefix}
                        className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'
                      >
                        <span className='font-mono'>{s.sid_prefix}…</span>
                        expires in {Math.max(0, Math.round(s.ttl_seconds / 3600))}h
                        <button
                          type='button'
                          onClick={() => {
                            if (window.confirm(`Sign out this session of ${name}?`)) revoke.mutate(s.sid_prefix)
                          }}
                          className='text-slate-300 transition-colors hover:text-red-500'
                          title='Revoke — signs that browser out immediately'
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            {(sessions.data?.length ?? 0) === 0 && (
              <p className='text-[12px] text-slate-400'>No active cookie sessions.</p>
            )}
          </div>
        </div>

        <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <div className='flex items-center justify-between'>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              Sign-in history
            </p>
            <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              <input
                type='checkbox'
                checked={newIpOnly}
                onChange={(e) => {
                  setNewIpOnly(e.target.checked)
                  setPage(1)
                }}
                className='h-3.5 w-3.5'
              />
              New locations only
            </label>
          </div>
          <div className='mt-3 overflow-x-auto'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
                  <th className='py-1 pr-3 font-semibold'>User</th>
                  <th className='py-1 pr-3 font-semibold'>Method</th>
                  <th className='py-1 pr-3 font-semibold'>IP</th>
                  <th className='py-1 pr-3 font-semibold'>When</th>
                  <th className='py-1 font-semibold'>Device</th>
                </tr>
              </thead>
              <tbody>
                {loginRows.map((r) => (
                  <tr key={r.id} className='border-t border-slate-100 dark:border-border'>
                    <td className='py-1.5 pr-3 text-slate-700 dark:text-foreground'>
                      {r.user_name || r.user_email || r.user}
                    </td>
                    <td className='py-1.5 pr-3'>
                      <span
                        className={cn(
                          'rounded px-1.5 py-px text-[10.5px] font-medium uppercase',
                          r.method === 'masquerade'
                            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                            : 'bg-slate-500/10 text-slate-500'
                        )}
                      >
                        {r.method}
                      </span>
                    </td>
                    <td className='py-1.5 pr-3 font-mono text-[11.5px] text-slate-500'>
                      {r.ip ?? '—'}
                      {r.new_ip && (
                        <span className='ml-1.5 rounded bg-sky-500/10 px-1.5 py-px font-sans text-[10px] font-medium text-sky-700 dark:text-sky-400'>
                          new
                        </span>
                      )}
                    </td>
                    <td className='py-1.5 pr-3 text-slate-500' title={new Date(r.created_at).toLocaleString()}>
                      {rel(r.created_at)}
                    </td>
                    <td className='max-w-[320px] truncate py-1.5 text-[11px] text-slate-400'>
                      {r.user_agent ?? '—'}
                    </td>
                  </tr>
                ))}
                {loginRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className='py-6 text-center text-[12px] text-slate-400'>
                      No sign-ins recorded yet — capture starts with the next login.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > 50 && (
            <div className='mt-2 flex items-center justify-end gap-2 text-[12px] text-slate-500'>
              <button
                type='button'
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className='rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 dark:border-border'
              >
                Prev
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil(total / 50))}
              </span>
              <button
                type='button'
                disabled={page >= Math.ceil(total / 50)}
                onClick={() => setPage((p) => p + 1)}
                className='rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 dark:border-border'
              >
                Next
              </button>
            </div>
          )}
        </div>
        <EditLocksCard />
        <MasqueradeHistoryCard />
        <LoginAnomaliesCard />
      </div>
    </div>
  )
}

// ─── Masquerade history (#233) ───────────────────────────────────────────────

function MasqueradeHistoryCard() {
  const { data: rows = [] } = useQuery<
    Array<{ id: number; action: string; admin: string; target: string; at: string }>
  >({
    queryKey: ['masquerade-history'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: number; action: string; admin: string; target: string; at: string }> }>(
          '/security/masquerades'
        )
        .then((r) => r.data.data)
        .catch(() => []),
    staleTime: 60_000
  })
  if (rows.length === 0) return null
  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='border-b border-slate-200 px-4 py-3 dark:border-border'>
        <h2 className='text-[13px] font-medium'>Masquerade history</h2>
        <p className='text-[11px] text-muted-foreground'>Who impersonated whom, and when.</p>
      </div>
      <div className='max-h-64 divide-y divide-slate-50 overflow-y-auto dark:divide-border/40'>
        {rows.map((r) => (
          <p key={r.id} className='flex items-center gap-2 px-4 py-1.5 text-[12.5px]'>
            <span className='font-medium text-slate-700 dark:text-slate-200'>{r.admin}</span>
            <span className='text-slate-400'>{r.action === 'masquerade-start' ? '→ became' : '← ended'}</span>
            <span className='text-slate-700 dark:text-slate-200'>{r.target}</span>
            <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
              {new Date(r.at).toLocaleString()}
            </span>
          </p>
        ))}
      </div>
    </div>
  )
}

// ─── Login anomalies (#255, honest scope: multi-IP windows, no geo db) ───────

function LoginAnomaliesCard() {
  const { data: rows = [] } = useQuery<
    Array<{ user: string; name: string; ips: string[]; window_start: string }>
  >({
    queryKey: ['login-anomalies'],
    queryFn: () =>
      api
        .get<{ data: Array<{ user: string; name: string; ips: string[]; window_start: string }> }>(
          '/security/login-anomalies'
        )
        .then((r) => r.data.data)
        .catch(() => []),
    staleTime: 5 * 60_000
  })
  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='border-b border-slate-200 px-4 py-3 dark:border-border'>
        <h2 className='text-[13px] font-medium'>Login anomalies (7d)</h2>
        <p className='text-[11px] text-muted-foreground'>
          Sign-ins from multiple IPs within an hour — the impossible-travel signal (a location map
          needs a geo provider this instance doesn't have).
        </p>
      </div>
      {rows.length === 0 ? (
        <p className='px-4 py-3 text-[12px] text-emerald-600'>No multi-IP windows detected.</p>
      ) : (
        <div className='divide-y divide-slate-50 dark:divide-border/40'>
          {rows.map((r) => (
            <p key={`${r.user}-${r.window_start}`} className='flex items-center gap-2 px-4 py-1.5 text-[12.5px]'>
              <span className='font-medium text-amber-700 dark:text-amber-400'>{r.name}</span>
              <span className='font-mono text-[11px] text-slate-500'>{r.ips.join(' · ')}</span>
              <span className='ml-auto text-[11px] tabular-nums text-slate-400'>
                {new Date(r.window_start).toLocaleString()}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
