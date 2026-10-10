import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ method: 'masquerade' as string }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: Record<string, unknown>) => {
    req.user = { id: 'T1', role: 'R-TARGET' }
    req.isAdmin = false
    req.authMethod = state.method
    if (state.method === 'masquerade') req.masqueradeAdminId = 'A1'
  }
}))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  // The masquerading admin: the request runs as them (an author, an admin).
  actAsMasqueradeAuthor: vi.fn(async (req: Record<string, unknown>) => {
    if (req.authMethod !== 'masquerade') return
    req.user = { id: 'A1', role: 'R-ADMIN' }
    req.isAdmin = true
  })
}))
}))

import { helpVideosRoutes } from '../../../routes/help-videos.js'

async function exportPackage() {
  const a = Fastify()
  await a.register(helpVideosRoutes, { prefix: '/api/help-videos' })
  return a.inject({ method: 'POST', url: '/api/help-videos/packages', payload: { ids: [] } })
}

describe('admin-only help-video routes during a masquerade', () => {
  it('are refused even though the request runs as the admin', async () => {
    state.method = 'masquerade'
    const res = await exportPackage()
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('ADMIN_ONLY')
  })
})
