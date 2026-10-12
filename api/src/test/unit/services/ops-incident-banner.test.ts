import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// #2016 incident banner, server side: the change notice is payload-free and
// goes only to the admin watch room; the route the banner re-reads is admin-only.

const who = vi.hoisted(() => ({ admin: false }))
const io = vi.hoisted(() => {
  const emit = vi.fn()
  const to = vi.fn(() => ({ emit }))
  return { to, emit, all: vi.fn() }
})

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({ to: io.to, emit: io.all }),
  getApp: () => null
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: who.admin ? 'ANA' : 'BOB' }
    req.isAdmin = who.admin
    if (!who.admin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
}))
vi.mock('../../../services/ops-incidents.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/ops-incidents.js')>()),
  currentIncident: vi.fn(async () => ({ id: 4, title: 'Partner pushes failing' })),
  recentIncidents: vi.fn(async () => [])
}))

import { opsAssistantRoutes } from '../../../routes/ops-assistant.js'
import { announceIncidentChange } from '../../../services/ops-incidents.js'

describe('incident banner notice', () => {
  it('goes only to the admin watch room and carries no incident data', () => {
    announceIncidentChange()
    expect(io.to).toHaveBeenCalledWith('watch:ops')
    expect(io.all).not.toHaveBeenCalled()
    const [event, payload] = io.emit.mock.calls[0]
    expect(event).toBe('ops:incident')
    expect(Object.keys(payload)).toEqual(['at'])
  })
})

describe('GET /ops-assistant/incident', () => {
  async function get() {
    const a = Fastify()
    await a.register(opsAssistantRoutes, { prefix: '/api/ops-assistant' })
    return a.inject({ method: 'GET', url: '/api/ops-assistant/incident' })
  }
  it('refuses a non-admin', async () => {
    who.admin = false
    const r = await get()
    expect(r.statusCode).toBe(403)
    expect(r.body).not.toContain('Partner pushes failing')
  })
  it('answers an admin with the current incident', async () => {
    who.admin = true
    const r = await get()
    expect(r.statusCode).toBe(200)
    expect(r.json().data.current.title).toBe('Partner pushes failing')
  })
})
