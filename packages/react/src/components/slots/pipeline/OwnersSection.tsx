import type { NivaroClient } from '@nivaro/sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { del, get, post } from '../../../lib/commands'
import { initials } from './HistoryTimeline'
import type { PState } from './StateTrack'

type POwner = {
  id: number
  first_name: string | null
  last_name: string | null
  email: string
  state: string | null
}
type PUser = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

export function OwnersSection({
  collection,
  itemId,
  states,
  client
}: {
  collection: string
  itemId: string | number
  states: PState[]
  client: NivaroClient | null | undefined
}) {
  const [owners, setOwners] = useState<POwner[]>([])
  const [users, setUsers] = useState<PUser[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [stateScope, setStateScope] = useState('')
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchOwners = useCallback(async () => {
    if (!client) return
    try {
      const res = await client.request<{ data: POwner[] }>(
        get(`/pipelines/instance/${collection}/${itemId}/owners`)
      )
      if (mountedRef.current) setOwners(res.data ?? [])
    } catch {
      if (mountedRef.current) setOwners([])
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [client, collection, itemId])

  useEffect(() => {
    void fetchOwners()
  }, [fetchOwners])

  useEffect(() => {
    if (!client) return
    client
      .request<{ data: PUser[] }>(get('/users', { limit: 200, sort: 'first_name' }))
      .then((res) => {
        if (mountedRef.current) setUsers(res.data ?? [])
      })
      .catch(() => {
        /* no-op */
      })
  }, [client])

  const stateLabelFor = (stateVal: string | null) => {
    if (!stateVal) return null
    const s = states.find((s) => s.id === stateVal) ?? states.find((s) => s.key === stateVal)
    return s?.label ?? stateVal
  }

  async function addOwner() {
    if (!client || !userId || saving) return
    setSaving(true)
    try {
      await client.request(
        post(`/pipelines/instance/${collection}/${itemId}/owners`, {
          user: userId,
          state: stateScope || undefined
        })
      )
      setAdding(false)
      setUserId('')
      setStateScope('')
      await fetchOwners()
    } catch {
      /* no-op */
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  async function removeOwner(id: number) {
    if (!client) return
    try {
      await client.request(del(`/pipelines/instance-owners/${id}`))
      await fetchOwners()
    } catch {
      /* no-op */
    }
  }

  return (
    <div data-nf-owners-section>
      <div data-nf-owners-header>
        <span data-nf-owners-title>
          <svg
            aria-hidden='true'
            width='13'
            height='13'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' />
            <circle cx='9' cy='7' r='4' />
            <path d='M23 21v-2a4 4 0 0 0-3-3.87' />
            <path d='M16 3.13a4 4 0 0 1 0 7.75' />
          </svg>
          Owners
          {loading ? (
            <span data-nf-skeleton style={{ display: 'inline-block', width: 16, height: 10 }} />
          ) : (
            <span data-nf-owners-count>({owners.length})</span>
          )}
        </span>
        {!adding && (
          <button type='button' data-nf-owners-add-btn onClick={() => setAdding(true)}>
            <svg
              aria-hidden='true'
              width='12'
              height='12'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' />
              <circle cx='8.5' cy='7' r='4' />
              <line x1='20' y1='8' x2='20' y2='14' />
              <line x1='23' y1='11' x2='17' y2='11' />
            </svg>
            Add
          </button>
        )}
      </div>

      {loading ? (
        <div data-nf-owners-loading>
          <span
            data-nf-skeleton
            style={{ height: 28, display: 'block', borderRadius: 6, marginBottom: 6 }}
          />
          <span
            data-nf-skeleton
            style={{ height: 28, width: '75%', display: 'block', borderRadius: 6 }}
          />
        </div>
      ) : owners.length === 0 ? (
        <p data-nf-empty>No owners assigned.</p>
      ) : (
        <div data-nf-owner-list>
          {owners.map((o) => (
            <div key={o.id} data-nf-owner-row>
              <span data-nf-owner-avatar>{initials(o.first_name, o.last_name, o.email)}</span>
              <div data-nf-owner-info>
                <span data-nf-owner-name>
                  {[o.first_name, o.last_name].filter(Boolean).join(' ') || o.email}
                </span>
                <span data-nf-owner-email>{o.email}</span>
              </div>
              <span data-nf-owner-scope>{o.state ? stateLabelFor(o.state) : 'all states'}</span>
              <button
                type='button'
                data-nf-icon-btn
                data-nf-icon-btn-danger
                title='Remove'
                onClick={() => void removeOwner(o.id)}
              >
                <svg
                  aria-hidden='true'
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <line x1='18' y1='6' x2='6' y2='18' />
                  <line x1='6' y1='6' x2='18' y2='18' />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div data-nf-owners-form>
          <p data-nf-owners-form-title>Add owner</p>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} data-nf-task-input>
            <option value=''>Select a user…</option>
            {users.map((u) => {
              const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
              return (
                <option key={u.id} value={u.id}>
                  {name}
                </option>
              )
            })}
          </select>
          <select
            value={stateScope}
            onChange={(e) => setStateScope(e.target.value)}
            data-nf-task-input
          >
            <option value=''>All states</option>
            {states.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <div data-nf-confirm-actions>
            <button
              type='button'
              data-nf-btn-ghost
              onClick={() => {
                setAdding(false)
                setUserId('')
                setStateScope('')
              }}
            >
              Cancel
            </button>
            <button
              type='button'
              data-nf-btn-primary
              disabled={!userId || saving}
              onClick={() => void addOwner()}
            >
              {saving ? '…' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
