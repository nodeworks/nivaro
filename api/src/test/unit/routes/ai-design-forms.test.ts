import fastifyMultipart from '@fastify/multipart'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Form from a paper form (#3186): the upload route takes several files (a
// form photographed page by page), says what to do with an iPhone photo, and
// passes the per-person AI limits through as 429. The model and the document
// reading are stubs; the route's own checks are real.

const compose = vi.hoisted(() => ({
  documentsContent: vi.fn(),
  composeForm: vi.fn(),
  ask: vi.fn()
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-design/form-compose.js', async () => {
  const real = await vi.importActual<Record<string, unknown>>(
    '../../../services/ai-design/form-compose.js'
  )
  return {
    ...real,
    loadComposeContext: vi.fn(async (collection: string) => ({
      collection,
      label: null,
      fields: [{ field: 'reason', label: 'Reason', type: 'string', note: null, relation: null }],
      states: []
    })),
    composeAsk: vi.fn(async () => compose.ask),
    providerReadsPdf: vi.fn(async () => false),
    documentsContent: compose.documentsContent,
    composeForm: compose.composeForm
  }
})

import { aiDesignFormRoutes } from '../../../routes/ai-design-forms.js'

const BOUNDARY = '----nivaro-test'
function multipart(fields: Record<string, string>, files: Array<[string, Buffer]>) {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields))
    parts.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    )
  for (const [name, body] of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      )
    )
    parts.push(body, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(parts)
}

async function upload(fields: Record<string, string>, files: Array<[string, Buffer]>) {
  const app = Fastify({ logger: false })
  await app.register(fastifyMultipart)
  await app.register(aiDesignFormRoutes)
  await app.ready()
  const res = await app.inject({
    method: 'POST',
    url: '/layouts/compose/file',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart(fields, files)
  })
  await app.close()
  return { status: res.statusCode, body: JSON.parse(res.body || 'null') }
}

const FORM = {
  name: 'Request',
  layout: 'sections',
  groups: [{ label: 'Main', fields: ['reason'], source: null }],
  locks: [],
  requirements: [],
  candidates: [{ label: 'Serial', type: 'text', group: 'Main', key: 'serial' }],
  dropped: [],
  explanation: null
}

beforeEach(() => {
  compose.documentsContent.mockReset()
  compose.composeForm.mockReset()
  compose.documentsContent.mockImplementation(async (docs: unknown[]) => ({
    blocks: docs.map(() => ({ type: 'text', text: 'x' })),
    method: 'image'
  }))
  compose.composeForm.mockImplementation(async () => FORM)
})

describe('POST /layouts/compose/file', () => {
  it('reads several pages of one paper form in one go', async () => {
    const res = await upload({ collection: 'returns', mode: 'picture' }, [
      ['page1.jpg', Buffer.from('a')],
      ['page2.jpg', Buffer.from('b')],
      ['page3.pdf', Buffer.from('%PDF-1.4')]
    ])
    expect(res.status).toBe(200)
    expect(res.body.data.form.candidates[0].key).toBe('serial')
    const [docs, opts] = compose.documentsContent.mock.calls[0]
    expect(docs.map((d: { filename: string }) => d.filename)).toEqual([
      'page1.jpg',
      'page2.jpg',
      'page3.pdf'
    ])
    // A form's PDF on a provider without PDF blocks: its pages are looked at.
    expect(opts).toEqual({ pdfBlocks: false, pdfPagesFirst: true })
  })

  it('refuses too many files, an iPhone photo and an unknown type', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => [`p${i}.jpg`, Buffer.from('a')]) as Array<
      [string, Buffer]
    >
    expect((await upload({ collection: 'returns', mode: 'picture' }, seven)).status).toBe(400)
    const heic = await upload({ collection: 'returns', mode: 'picture' }, [
      ['IMG_0001.HEIC', Buffer.from('a')]
    ])
    expect(heic.status).toBe(400)
    expect(heic.body.error).toMatch(/Share it as JPEG/)
    expect(
      (await upload({ collection: 'returns', mode: 'picture' }, [['x.exe', Buffer.from('a')]]))
        .status
    ).toBe(400)
    expect(compose.composeForm).not.toHaveBeenCalled()
  })

  it('passes the per-person AI limit through as 429 with its own words', async () => {
    compose.composeForm.mockImplementation(async () => {
      throw Object.assign(
        new Error('You are sending AI requests faster than this instance allows.'),
        {
          statusCode: 429,
          code: 'AI_RATE_LIMITED'
        }
      )
    })
    const res = await upload({ collection: 'returns', mode: 'picture' }, [
      ['page1.jpg', Buffer.from('a')]
    ])
    expect(res.status).toBe(429)
    expect(res.body).toEqual({
      error: 'You are sending AI requests faster than this instance allows.',
      code: 'AI_RATE_LIMITED'
    })
  })
})
