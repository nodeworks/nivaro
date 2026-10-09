import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1: document autofill re-reads stored documents named in `file_ids`. An
// admin may name any file — but never a help-video recording.

const HV = '11111111-1111-4111-8111-111111111111'
const DOC = '44444444-4444-4444-8444-444444444444'

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  },
  requireAdmin: async () => {}
}))
vi.mock('../../../hooks/ai-validation.js', () => ({
  findDuplicates: vi.fn(),
  runAiValidation: vi.fn(),
  getAiCollectionSettings: vi.fn(async () => ({ document_autofill: true }))
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
const reads = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('../../../services/files.js', () => ({
  getFile: vi.fn(async (id: string) => ({
    id: id.toUpperCase(),
    filename_disk: `${id}.pdf`,
    filename_download: 'a.pdf',
    type: 'application/pdf',
    uploaded_by: 'SOMEONE-ELSE'
  })),
  readFileBuffer: vi.fn(async (f: { id: string }) => {
    reads.ids.push(f.id)
    return Buffer.from('%PDF')
  }),
  uploadFileBuffer: vi.fn()
}))
vi.mock('../../../services/help-video-files.js', () => ({
  isHelpVideoFile: vi.fn(async (id: string) => id.toLowerCase() === HV)
}))
const extract = vi.hoisted(() => ({ files: null as null | unknown[] }))
vi.mock('../../../services/document-autofill.js', () => ({
  proposeFromDocuments: vi.fn(async (input: { files: unknown[] }) => {
    extract.files = input.files
    return { fields: [] }
  })
}))

import { aiRoutes } from '../../../routes/ai.js'

async function post(fileIds: string[]) {
  const a = Fastify()
  await a.register(import('@fastify/multipart'))
  await a.register(aiRoutes, { prefix: '/api/ai' })
  const B = 'b0undary'
  const field = (name: string, value: string) =>
    `--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  return a.inject({
    method: 'POST',
    url: '/api/ai/extract-record',
    headers: { 'content-type': `multipart/form-data; boundary=${B}` },
    payload: `${field('collection', 'workflows')}${field('file_ids', fileIds.join(','))}--${B}--\r\n`
  })
}

beforeEach(() => {
  reads.ids = []
  extract.files = null
})

describe('document autofill never reads a help-video file', () => {
  it('skips it even for an admin: with nothing else named there is no document', async () => {
    const res = await post([HV])
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'No file provided' })
    expect(reads.ids).toEqual([])
  })

  it('still reads an ordinary stored document named beside it', async () => {
    await post([HV, DOC])
    expect(reads.ids).toEqual([DOC.toUpperCase()])
  })
})
