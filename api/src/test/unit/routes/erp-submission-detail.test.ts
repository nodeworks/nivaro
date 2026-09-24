import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Route harness: the admin gate is stubbed and the fact-reading half of the
// detail service is replaced, so the route + the REAL pure assembly run over
// hand-built facts with no database.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-admin' }
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/external-apis.js', () => ({ callExternalApi: vi.fn() }))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyIds: vi.fn(async (_c: string, ids: string[]) => {
    const out = new Map<string, string>()
    for (const id of ids) out.set(id, `REC-${id}`)
    return out
  })
}))
vi.mock('../../../services/submission-detail.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/submission-detail.js')>()
  return { ...real, gatherSubmissionFacts: vi.fn() }
})

import { erpSubmissionsRoutes } from '../../../routes/erp-submissions.js'
import { gatherSubmissionFacts, type SubmissionFacts } from '../../../services/submission-detail.js'

const PERSON = 'AAAAAAAA-0000-0000-0000-000000000001'
const OTHER = 'AAAAAAAA-0000-0000-0000-000000000002'
const created = new Date('2026-09-21T18:42:03.000Z')

function facts(over: Partial<SubmissionFacts> = {}): SubmissionFacts {
  const row = {
    id: 82,
    collection: 'orders',
    item: '1001',
    external_api: 9,
    status: 'failed',
    attempts: 1,
    payload: JSON.stringify({ endpoint_path: '/api/v1/update', body: { a: 1 } }),
    response: '{"status":"ERROR"}',
    last_error: 'HTTP 401: Unauthorized',
    external_ref: null,
    created_at: created,
    updated_at: created,
    error_class: 'auth',
    obligation_id: null,
    requested_by: null,
    requested_via: null
  }
  return {
    raw: row,
    row: {
      id: row.id,
      collection: row.collection,
      item: row.item,
      external_api: row.external_api,
      status: row.status,
      attempts: row.attempts,
      payload: row.payload,
      created_at: row.created_at,
      updated_at: row.updated_at,
      error_class: row.error_class,
      obligation_id: null,
      requested_by: null,
      requested_via: null
    },
    api: { id: 9, name: 'Partner', owner_user: null },
    record_label: 'REC-1001',
    obligation: null,
    obligation_transition: null,
    flow: null,
    attempts: [],
    activity: [],
    call_logs: [],
    history: null,
    record_edit: null,
    newer_landed: null,
    users: [
      {
        id: PERSON,
        first_name: 'Dana',
        last_name: 'Reyes',
        email: 'dana@example.com',
        status: 'active',
        is_redacted: false,
        account_kind: null
      },
      {
        id: OTHER,
        first_name: 'Sam',
        last_name: 'Okafor',
        email: 'sam@example.com',
        status: 'active',
        is_redacted: false,
        account_kind: null
      }
    ],
    ...over
  }
}

function withRow(f: SubmissionFacts, patch: Partial<SubmissionFacts['row']>): SubmissionFacts {
  return { ...f, row: { ...f.row, ...patch }, raw: { ...f.raw, ...patch } }
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(erpSubmissionsRoutes, { prefix: '/erp-submissions' })
  return app
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /erp-submissions/:id', () => {
  it('404s an unknown id and never reads for a non-positive or non-numeric one', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(null)
    const app = buildApp()
    const unknown = await app.inject({ method: 'GET', url: '/erp-submissions/999999' })
    expect(unknown.statusCode).toBe(404)
    expect(gatherSubmissionFacts).toHaveBeenCalledTimes(1)
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const res = await app.inject({ method: 'GET', url: `/erp-submissions/${bad}` })
      expect(res.statusCode).toBe(404)
    }
    expect(gatherSubmissionFacts).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('serializes the submission and carries the obligation and its trigger', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(
      facts({
        obligation: {
          id: 7,
          kind: 'order.submit',
          api: 'Partner',
          trigger: 'transition',
          trigger_ref: 'T-1',
          outcome: 'failed',
          reason: 'The partner refused the credentials',
          due_at: created,
          resolved_at: created,
          created_at: created
        },
        obligation_transition: {
          id: 'T-1',
          label: 'Submit',
          auto_trigger: false,
          template_id: 'TPL-1',
          template_name: 'Order approval'
        },
        history: {
          user: PERSON,
          origin: 'person',
          timestamp: new Date(created.getTime() - 2_000),
          transition: null
        }
      })
    )
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/erp-submissions/82' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.submission).toMatchObject({
      id: 82,
      endpoint_path: '/api/v1/update',
      payload: { a: 1 },
      response: { status: 'ERROR' },
      record_label: 'REC-1001',
      external_api_name: 'Partner',
      error_class: 'auth'
    })
    expect(d.partner).toMatchObject({ id: 9, name: 'Partner' })
    expect(d.endpoint).toEqual({ method: 'POST', path: '/api/v1/update' })
    expect(d.obligation).toMatchObject({
      id: 7,
      kind: 'order.submit',
      outcome: 'failed',
      reason: 'The partner refused the credentials',
      trigger: 'transition',
      open: false
    })
    expect(d.trigger).toMatchObject({
      kind: 'transition',
      label: '“Submit” transition · Order approval',
      link: '/pipelines/TPL-1',
      source: 'obligation'
    })
    // The person who made the transition moments before — inferred, and it says so.
    expect(d.triggered_by).toMatchObject({ kind: 'person', basis: 'inferred', label: 'Dana Reyes' })
    expect(d.triggered_by.how).toMatch(/moments before/)
    expect(d.retry).toMatchObject({ eligible: true })
    await app.close()
  })

  it('a stored requested_by wins over every inference', async () => {
    const f = withRow(
      facts({
        // Every inference points at OTHER…
        call_logs: [
          {
            id: 1,
            created_at: created,
            method: 'POST',
            url: 'https://partner.example/api/v1/update',
            response_status: 401,
            duration_ms: 120,
            error: null,
            triggered_by: 'transition-action',
            user_id: OTHER,
            body_match: true
          }
        ],
        history: { user: OTHER, origin: 'person', timestamp: created, transition: null },
        record_edit: { action: 'update', user: OTHER, comment: null, timestamp: created }
      }),
      // …but the row names PERSON.
      { requested_by: PERSON, requested_via: 'transition' }
    )
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(f)
    const app = buildApp()
    const d = (await app.inject({ method: 'GET', url: '/erp-submissions/82' })).json().data
    expect(d.triggered_by).toMatchObject({
      kind: 'person',
      basis: 'recorded',
      label: 'Dana Reyes',
      via: 'transition',
      how: null
    })
    expect(d.submission).toMatchObject({ requested_by: PERSON, requested_via: 'transition' })
    await app.close()
  })

  it('falls back to "Not recorded" when nothing names who sent it', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(facts())
    const app = buildApp()
    const d = (await app.inject({ method: 'GET', url: '/erp-submissions/82' })).json().data
    expect(d.triggered_by).toMatchObject({ kind: 'unknown', basis: 'none', label: 'Not recorded' })
    expect(d.trigger).toMatchObject({ kind: 'unknown', label: 'Not recorded' })
    expect(d.attempt_requesters).toEqual([
      { attempt: 1, requester: expect.objectContaining({ label: 'Not recorded' }) }
    ])
    await app.close()
  })

  it('a machine account reads as the account, never as a person', async () => {
    const f = facts({
      record_edit: { action: 'update', user: PERSON, comment: null, timestamp: created },
      users: [
        {
          id: PERSON,
          first_name: 'Partner',
          last_name: 'Integration',
          email: 'partner@example.com',
          status: 'active',
          is_redacted: false,
          account_kind: 'integration'
        }
      ]
    })
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(f)
    const app = buildApp()
    const d = (await app.inject({ method: 'GET', url: '/erp-submissions/82' })).json().data
    expect(d.triggered_by).toMatchObject({
      kind: 'machine',
      basis: 'inferred',
      label: 'Integration account — Partner Integration'
    })
    await app.close()
  })

  it('names who started each attempt — a later retry by someone else is theirs', async () => {
    const f = withRow(
      facts({
        attempts: [
          {
            attempt: 1,
            recorded_at: created,
            source: 'captured',
            requested_by: PERSON,
            requested_via: 'transition'
          },
          {
            attempt: 2,
            recorded_at: new Date(created.getTime() + 60_000),
            source: 'send',
            requested_by: OTHER,
            requested_via: 'retry'
          },
          {
            attempt: 3,
            recorded_at: new Date(created.getTime() + 120_000),
            source: 'send',
            requested_by: null,
            requested_via: 'cron'
          }
        ]
      }),
      { attempts: 3, requested_by: PERSON, requested_via: 'transition' }
    )
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(f)
    const app = buildApp()
    const d = (await app.inject({ method: 'GET', url: '/erp-submissions/82' })).json().data
    const by = Object.fromEntries(
      (d.attempt_requesters as Array<{ attempt: number; requester: { label: string } }>).map(
        (a) => [a.attempt, a.requester.label]
      )
    )
    expect(by).toEqual({
      1: 'Dana Reyes',
      2: 'Sam Okafor',
      3: 'Scheduled — the retry ladder'
    })
    await app.close()
  })

  it('refuses a retry when a newer push already landed, and says why', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue(
      facts({ newer_landed: { id: 90, status: 'accepted' } })
    )
    const app = buildApp()
    const d = (await app.inject({ method: 'GET', url: '/erp-submissions/82' })).json().data
    expect(d.retry.eligible).toBe(false)
    expect(d.retry.reason).toMatch(/#90/)
    await app.close()
  })
})
