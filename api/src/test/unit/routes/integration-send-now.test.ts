import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /integration-obligations/:id/send (Task 19). This exercises the REAL
// wiring between the route and integration-remediation.ts's own
// gate/lookup/outcome logic — only sendPayload (the one thing that would
// ever reach a network) is never invoked by ANY scenario here: every test
// either keeps the gate off, hits an obligation with no submission and no
// prior request to repeat, or never gets past the route's own 404/409
// checks. A partner is never called from this file.

const currentUser: { id: string; isAdmin: boolean } = { id: 'user-admin', isAdmin: true }
function login(id: string, isAdmin: boolean) {
  currentUser.id = id
  currentUser.isAdmin = isAdmin
}

vi.mock('../../../middleware/authenticate.js', () => ({
  // Mirrors the REAL requireAdmin (middleware/authenticate.ts): throws a
  // statusCode-bearing error when the caller is not an admin, which
  // Fastify's own default error handler turns into that HTTP status without
  // any custom error handler needed in this test app.
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id }
    req.isAdmin = currentUser.isAdmin
    if (!currentUser.isAdmin) {
      const err = new Error('Forbidden') as Error & { statusCode: number }
      err.statusCode = 403
      throw err
    }
  }),
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id }
    req.isAdmin = currentUser.isAdmin
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
// Never let this route reach a real send — resendSubmission would import
// sendPayload from here. Every scenario in this file stops before that
// point, but the module is mocked anyway as a hard backstop.
vi.mock('../../../routes/erp-submissions.js', () => ({ sendPayload: vi.fn() }))

import { db } from '../../../db/index.js'
import { sendPayload } from '../../../routes/erp-submissions.js'
import { integrationObligationsRoutes } from '../../../routes/integration-obligations.js'
import {
  clearObligationKinds,
  registerObligationKind
} from '../../../services/integration-obligations.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(integrationObligationsRoutes)
  return app
}

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

function settingsChain(enabled: boolean) {
  return { first: vi.fn().mockResolvedValue({ integration_remediation_enabled: enabled }) }
}

function obligationChain(row: Record<string, unknown> | undefined) {
  const c = { where: vi.fn(), first: vi.fn().mockResolvedValue(row) }
  c.where.mockReturnValue(c)
  return c
}

beforeEach(() => {
  login('user-admin', true)
  clearObligationKinds()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /integration-obligations/:id/send', () => {
  it('403 — a non-admin caller is refused before the route ever runs', async () => {
    login('user-plain', false)
    // No db mock configured — if the route body ran at all despite the
    // rejection, an unconfigured db(...) call would produce undefined and
    // very likely throw somewhere, which would ALSO not be a 200/409, but
    // asserting the status directly is the real check.
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/1/send' })

    expect(res.statusCode).toBe(403)
  })

  it('200 — remediation off answers honestly without reading the obligation at all', async () => {
    mockedDb().mockReturnValue(settingsChain(false) as unknown as ReturnType<typeof db>)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/1/send' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.detail).toMatch(/off/i)
    // Only the settings probe ran.
    expect(db).toHaveBeenCalledTimes(1)
    expect(db).toHaveBeenCalledWith('nivaro_settings')
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('404 — the id in the URL is not a number', async () => {
    mockedDb().mockReturnValue(settingsChain(true) as unknown as ReturnType<typeof db>)
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/integration-obligations/not-a-number/send'
    })

    expect(res.statusCode).toBe(404)
  })

  it('404 — a numeric id that names no obligation', async () => {
    const settings = settingsChain(true)
    const obligations = obligationChain(undefined)
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/999/send' })

    expect(res.statusCode).toBe(404)
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('409 — the ledger already considers this one sent, not a question with a sensible answer', async () => {
    const settings = settingsChain(true)
    const obligations = obligationChain({ id: 1, outcome: 'sent' })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/1/send' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/already sent/)
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('409 — a superseded obligation is closed the same way a sent one is', async () => {
    const settings = settingsChain(true)
    const obligations = obligationChain({ id: 1, outcome: 'superseded' })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/1/send' })

    expect(res.statusCode).toBe(409)
  })

  it('200 — an open obligation with nothing of its own to re-send, and no prior request to repeat, is reported honestly', async () => {
    // The kind has to have opted in before "is there a prior request?" is
    // even asked — C1 — so this is the shape that reaches that question.
    registerObligationKind({
      api: 'Partner',
      kind: 'push',
      collection: 'workflows',
      label: 'x',
      safe_to_refire: true,
      endpoint_path: '/orders',
      expect: async () => []
    })
    const settings = settingsChain(true)
    // The route's own pre-check reads {id, outcome}; sendNow's own lookup
    // reads {id, api, kind, collection, item, submission_id} on the SAME
    // table — one chain answering both is fine, the mock ignores the columns.
    const obligations = obligationChain({
      id: 1,
      outcome: 'missing',
      api: 'Partner',
      kind: 'push',
      collection: 'workflows',
      item: '1',
      submission_id: null
    })
    const priorLookup = {
      join: vi.fn(),
      where: vi.fn(),
      whereRaw: vi.fn(),
      orderBy: vi.fn(),
      first: vi.fn().mockResolvedValue(undefined)
    }
    priorLookup.join.mockReturnValue(priorLookup)
    priorLookup.where.mockReturnValue(priorLookup)
    priorLookup.whereRaw.mockReturnValue(priorLookup)
    priorLookup.orderBy.mockReturnValue(priorLookup)
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      if (table === 'nivaro_erp_submissions as es') return priorLookup
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/1/send' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.detail).toMatch(/nothing to re-send/)
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('200 — C1: a missing obligation whose kind never opted in is refused, in words, without sending', async () => {
    registerObligationKind({
      api: 'Partner',
      kind: 'state',
      collection: 'workflows',
      label: 'x',
      expect: async () => []
    })
    const settings = settingsChain(true)
    const obligations = obligationChain({
      id: 1,
      outcome: 'missing',
      api: 'Partner',
      kind: 'state',
      collection: 'workflows',
      item: '1',
      submission_id: null
    })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/integration-obligations/1/send' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.detail).toMatch(/^not re-sent: /)
    expect(sendPayload).not.toHaveBeenCalled()
  })
})
