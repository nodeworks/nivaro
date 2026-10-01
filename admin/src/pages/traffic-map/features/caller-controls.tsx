/**
 * #1126 — caller controls. An API key: set its calls-per-minute limit or revoke it. A person (or
 * machine account): suspend it. Every change is a two-click confirm through the existing admin
 * routes, which write the activity row.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { ConfirmButton, errorOf, INPUT, Note } from './shared'

interface ApiKeyRow {
  id: number
  name: string
  is_active: boolean | number
  rate_limit_per_minute: number | null
  expires_at: string | null
}
interface UserRow {
  id: string
  status: string
  email: string
}

/** The rate limit an input means: blank = none, else a whole number ≥ 1 (null = invalid). */
export function parseRateLimit(text: string): number | null | 'none' {
  const t = text.trim()
  if (t === '') return 'none'
  const n = Number(t)
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null
}

function KeyControls({ id }: { id: number }) {
  const qc = useQueryClient()
  const key = ['traffic-map', 'caller-key', id]
  const q = useQuery({
    queryKey: key,
    queryFn: async () =>
      ((await api.get(`/api-keys/${id}`))?.data as { data?: ApiKeyRow })?.data ?? null
  })
  const [limit, setLimit] = useState('')
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (q.data) setLimit(q.data.rate_limit_per_minute ? String(q.data.rate_limit_per_minute) : '')
  }, [q.data])
  const after = (text: string) => {
    setNote({ tone: 'ok', text })
    void qc.invalidateQueries({ queryKey: key })
  }
  const setRate = useMutation({
    mutationFn: (v: number | null) => api.patch(`/api-keys/${id}`, { rate_limit_per_minute: v }),
    onSuccess: (_r, v) => after(v ? `Limit set to ${v} calls per minute.` : 'Limit removed.'),
    onError: (e) => setNote({ tone: 'error', text: errorOf(e) })
  })
  const revoke = useMutation({
    mutationFn: () => api.post(`/api-keys/${id}/revoke`),
    onSuccess: () => after('Key revoked. Calls with it are refused from now on.'),
    onError: (e) => setNote({ tone: 'error', text: errorOf(e) })
  })
  if (q.isLoading) return <Empty>Reading the key…</Empty>
  if (!q.data) return <Empty>This API key no longer exists.</Empty>
  const active = q.data.is_active === true || q.data.is_active === 1
  const parsed = parseRateLimit(limit)
  const current = q.data.rate_limit_per_minute ?? null
  const changed = parsed !== null && (parsed === 'none' ? current !== null : parsed !== current)
  return (
    <div className='grid gap-2 text-[12px]' data-tm-caller-key={id}>
      <p className='text-[var(--tm-fg-2)]'>
        <span className='font-medium text-[var(--tm-fg)]'>{q.data.name}</span> ·{' '}
        {active ? 'active' : <span className='text-[var(--tm-error-ink)]'>revoked</span>} ·{' '}
        {current ? `${current} calls/min` : 'no rate limit'}
      </p>
      {active && (
        <>
          <div className='flex flex-wrap items-center gap-1.5'>
            <label htmlFor='tm-key-limit' className='text-[var(--tm-fg-2)]'>
              Calls per minute
            </label>
            <input
              id='tm-key-limit'
              inputMode='numeric'
              placeholder='none'
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className={`${INPUT} w-24 tabular-nums`}
            />
            <ConfirmButton
              id='tm-key-limit-save'
              label='Set limit'
              confirmLabel={parsed === 'none' ? 'Remove the limit?' : `Limit to ${parsed}/min?`}
              disabled={!changed}
              busy={setRate.isPending}
              onConfirm={() => setRate.mutate(parsed === 'none' ? null : (parsed as number))}
            />
          </div>
          {parsed === null && (
            <Note tone='error'>A whole number of calls per minute, or blank.</Note>
          )}
          <div>
            <ConfirmButton
              id='tm-key-revoke'
              danger
              label='Revoke key'
              confirmLabel='Revoke it now?'
              busy={revoke.isPending}
              onConfirm={() => revoke.mutate()}
            />
          </div>
        </>
      )}
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </div>
  )
}

function PersonControls({ id }: { id: string }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const key = ['traffic-map', 'caller-user', id]
  const q = useQuery({
    queryKey: key,
    queryFn: async () => ((await api.get(`/users/${id}`))?.data as { data?: UserRow })?.data ?? null
  })
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const suspend = useMutation({
    mutationFn: () => api.patch(`/users/${id}`, { status: 'suspended' }),
    onSuccess: () => {
      setNote({ tone: 'ok', text: 'Suspended. Their sessions and token are refused from now on.' })
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => setNote({ tone: 'error', text: errorOf(e) })
  })
  if (q.isLoading) return <Empty>Reading the account…</Empty>
  if (!q.data) return <Empty>This account could not be read.</Empty>
  const self = String(user?.id ?? '').toUpperCase() === id.toUpperCase()
  const suspended = q.data.status === 'suspended'
  return (
    <div className='grid gap-2 text-[12px]' data-tm-caller-user={id}>
      <p className='text-[var(--tm-fg-2)]'>
        {q.data.email} ·{' '}
        <span className={suspended ? 'text-[var(--tm-error-ink)]' : ''}>{q.data.status}</span>
      </p>
      {self ? (
        <Empty>This is you.</Empty>
      ) : suspended ? null : (
        <div>
          <ConfirmButton
            id='tm-user-suspend'
            danger
            label='Suspend'
            confirmLabel='Suspend this account?'
            busy={suspend.isPending}
            onConfirm={() => suspend.mutate()}
          />
        </div>
      )}
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </div>
  )
}

function CallerControls({ sel }: { sel: Selection; d: InspectorData }) {
  const k = sel.id.match(/^k(\d{1,12})$/)
  const u = sel.id.match(/^u([0-9A-Fa-f-]{36})$/)
  return (
    <Section title='Caller controls'>
      {k ? <KeyControls id={Number(k[1])} /> : u ? <PersonControls id={u[1]} /> : null}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'caller-controls',
  order: 20,
  applies: (sel) => sel.kind === 'caller' && /^(k\d{1,12}|u[0-9A-Fa-f-]{36})$/.test(sel.id),
  Component: CallerControls
})
