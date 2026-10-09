import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// C1: content export and semantic search refuse the files table under any
// spelling (their system-table checks were case-sensitive; SQL Server is not).

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  },
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  }
}))
const can = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../../services/permissions.js', () => ({ can }))
vi.mock('../../../services/embeddings.js', () => ({
  embedText: vi.fn(async () => [0]),
  searchEmbeddings: vi.fn(async () => []),
  getEmbeddableFields: vi.fn(async () => []),
  upsertItemEmbedding: vi.fn()
}))

import { contentExportRoutes } from '../../../routes/content-export.js'
import { semanticSearchRoutes } from '../../../routes/semantic-search.js'

const SPELLINGS = [
  'nivaro_files',
  'NIVARO_FILES',
  'Nivaro_Files',
  'directus_files',
  'dbo.nivaro_files'
]

describe('export and semantic search never reach the files table', () => {
  for (const c of SPELLINGS) {
    it(`${c}: export, search and reindex are refused before any permission or row read`, async () => {
      const a = Fastify()
      await a.register(contentExportRoutes, { prefix: '/api/content-export' })
      await a.register(semanticSearchRoutes, { prefix: '/api/search' })
      can.mockClear()
      const ex = await a.inject({
        method: 'POST',
        url: `/api/content-export/${c}`,
        payload: { format: 'csv' }
      })
      expect(ex.statusCode).toBe(403)
      const se = await a.inject({
        method: 'POST',
        url: '/api/search/semantic',
        payload: { collection: c, query: 'recording' }
      })
      expect(se.statusCode).toBe(403)
      const re = await a.inject({ method: 'POST', url: `/api/search/reindex/${c}` })
      expect(re.statusCode).toBe(403)
      expect(can).not.toHaveBeenCalled()
    })
  }
})
