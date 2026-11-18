import { beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal in-memory stand-in for the connections table.
let rows: Array<Record<string, unknown>> = []
let nextId = 1
vi.mock('../../db/index.js', () => {
  const builder = (filter: Record<string, unknown> = {}) => {
    const match = () => rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
    const b: Record<string, unknown> = {}
    b.where = (f: Record<string, unknown>) => builder(f)
    b.orderBy = () => b
    b.first = async () => match()[0]
    b.update = async (patch: Record<string, unknown>) => {
      for (const r of match()) Object.assign(r, patch)
      return match().length
    }
    b.insert = (row: Record<string, unknown>) => ({
      returning: async () => {
        const id = nextId++
        rows.push({ id, ...row })
        return [{ id }]
      }
    })
    // biome-ignore lint/suspicious/noThenProperty: the fake must be awaitable like a knex builder
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(match()).then(res)
    return b
  }
  return { db: () => builder() }
})

import {
  getConnection,
  listConnections,
  normalizeSync,
  rotateWebhookSecret,
  saveConnection,
  TOKEN_MASK,
  verifyWebhookToken
} from './connections.js'

const base = { name: 'GL', base_url: 'https://gitlab.example.com/', token: 'glpat-secret' }

describe('tracker connections', () => {
  beforeEach(() => {
    rows = []
    nextId = 1
    delete process.env.ENCRYPTION_KEY
  })

  it('GET never returns token', async () => {
    const saved = await saveConnection(base, 'u1')
    expect(saved.token_set).toBe(true)
    const list = await listConnections()
    const one = await getConnection(saved.id)
    for (const v of [...list, one]) {
      expect(JSON.stringify(v)).not.toContain('glpat-secret')
      expect(v).not.toHaveProperty('token')
    }
    expect(saved.base_url).toBe('https://gitlab.example.com')
  })

  it('PATCH with mask keeps stored token', async () => {
    const saved = await saveConnection(base, 'u1')
    await saveConnection({ id: saved.id, name: 'Renamed', token: TOKEN_MASK }, 'u2')
    expect(rows[0].token).toBe('glpat-secret')
    expect(rows[0].name).toBe('Renamed')
    expect(rows[0].updated_by).toBe('u2')
    await saveConnection({ id: saved.id, token: 'glpat-new' }, 'u2')
    expect(rows[0].token).toBe('glpat-new')
  })

  it('verifyWebhookToken true only for the rotated secret', async () => {
    const saved = await saveConnection(base, 'u1')
    expect(await verifyWebhookToken(saved.id, 'anything')).toBe(false)
    const first = await rotateWebhookSecret(saved.id)
    expect(await verifyWebhookToken(saved.id, first)).toBe(true)
    const second = await rotateWebhookSecret(saved.id)
    expect(await verifyWebhookToken(saved.id, first)).toBe(false)
    expect(await verifyWebhookToken(saved.id, second)).toBe(true)
    expect(await verifyWebhookToken(saved.id, undefined)).toBe(false)
    expect(rows[0].webhook_secret_hash).not.toBe(second)
  })

  it('normalizeSync fills defaults and drops unknown keys', () => {
    expect(normalizeSync(null)).toEqual({
      status_map: { closed: 'resolved' },
      close_on_resolve: true,
      reopen_on_recur: true,
      recur_when_closed: 'reopen',
      comments: true,
      seen_note: true,
      seen_note_min_minutes: 60,
      labels: { always: [], by_severity: {}, by_source: {}, on_example: [] },
      similar: { enabled: true, join_at: 0.88, suggest_at: 0.78 },
      priority_map: {},
      lane_map: {},
      priority_two_way: true,
      lanes_two_way: true,
      push_to_linked: false,
      ticket_priority_map: {},
      ticket_lane_map: {},
      create_roles: [],
      sources: { issue: true, ticket: true, record: true }
    })
    const n = normalizeSync({ comments: false, bogus: 1, recur_when_closed: 'new' })
    expect(n).not.toHaveProperty('bogus')
    expect(n.comments).toBe(false)
    expect(n.recur_when_closed).toBe('new')
  })

  it('normalizeSync keeps the seen-again note to at most one an hour', () => {
    expect(normalizeSync({ seen_note_min_minutes: 0 }).seen_note_min_minutes).toBe(60)
    expect(normalizeSync({ seen_note_min_minutes: 5 }).seen_note_min_minutes).toBe(60)
    expect(normalizeSync({ seen_note_min_minutes: 59.9 }).seen_note_min_minutes).toBe(60)
    expect(normalizeSync({ seen_note_min_minutes: 90 }).seen_note_min_minutes).toBe(90)
    expect(normalizeSync({ seen_note_min_minutes: -3 }).seen_note_min_minutes).toBe(60)
    expect(normalizeSync({ seen_note_min_minutes: 'x' }).seen_note_min_minutes).toBe(60)
  })

  it('origin change without a new token is refused', async () => {
    const saved = await saveConnection(base, 'u1')
    await expect(
      saveConnection({ id: saved.id, base_url: 'https://evil.example.net' }, 'u2')
    ).rejects.toMatchObject({ code: 'TOKEN_REQUIRED_FOR_NEW_URL' })
    await expect(
      saveConnection(
        { id: saved.id, base_url: 'https://other.example.net', token: TOKEN_MASK },
        'u2'
      )
    ).rejects.toMatchObject({ code: 'TOKEN_REQUIRED_FOR_NEW_URL' })
    expect(rows[0].base_url).toBe('https://gitlab.example.com')
  })

  it('origin change with a new token saves both', async () => {
    const saved = await saveConnection(base, 'u1')
    await saveConnection(
      { id: saved.id, base_url: 'https://other.example.net', token: 'glpat-new' },
      'u2'
    )
    expect(rows[0].base_url).toBe('https://other.example.net')
    expect(rows[0].token).toBe('glpat-new')
  })

  it('path-only change keeps the token', async () => {
    const saved = await saveConnection(base, 'u1')
    await saveConnection({ id: saved.id, base_url: 'https://GitLab.example.com/sub' }, 'u2')
    expect(rows[0].base_url).toBe('https://GitLab.example.com/sub')
    expect(rows[0].token).toBe('glpat-secret')
  })

  it('rejects bad input', async () => {
    await expect(saveConnection({ ...base, base_url: 'ftp://x' }, 'u')).rejects.toThrow()
    await expect(saveConnection({ ...base, name: '' }, 'u')).rejects.toThrow()
  })
})
