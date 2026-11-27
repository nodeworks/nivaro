import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { pagerdutyAdapter } from '../../../services/hub/providers/pagerduty/index.js'
import {
  handoverOfLayer,
  layerOfFields,
  rotaProblem,
  rotaToScheduleFields,
  windowFieldsOfPlanned
} from '../../../services/hub/providers/pagerduty/rota.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import type {
  DesiredResource,
  OutboundMessage,
  PlannedOp
} from '../../../services/hub/providers/types.js'

// Hub providers Task 22: the PagerDuty adapter against recorded (fake-valued) answers.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/pagerduty/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-pagerduty-token-0001'
const ROUTING = 'test-secret-routing-key-0001'
const FROM = 'hub@example.test'

interface Call {
  method: string
  host: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  host?: string
  path: RegExp
  query?: (q: URLSearchParams) => boolean
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[], config: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      host: u.host,
      path: u.pathname,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find(
      (r) =>
        r.method === call.method &&
        r.path.test(call.path) &&
        (!r.host || r.host === call.host) &&
        (!r.query || r.query(call.query))
    )
    if (!hit) return new Response(JSON.stringify(fx('error-not-found')), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: pagerdutyAdapter,
    connectionId: 1,
    config: { region: 'us', from_email: FROM, ...config },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 },
    now: () => new Date('2026-11-26T12:00:00.000Z')
  })
  return { ctx, calls }
}

const noCalls = () => harness([])
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: DesiredResource['refs'] = {},
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const SERVICE = 'pagerduty.service'
const POLICY = 'pagerduty.escalation_policy'
const SCHEDULE = 'pagerduty.schedule'
const INTEGRATION = 'pagerduty.integration'
const WINDOW = 'pagerduty.maintenance_window'

const serviceFields = {
  name: 'checkout-api',
  description: 'Checkout',
  escalation_policy: { resourceId: 3 },
  urgency: 'high',
  auto_resolve_timeout_seconds: 14400,
  acknowledgement_timeout_seconds: 1800,
  alert_creation: 'create_alerts_and_incidents'
}
const scheduleFields = {
  name: 'checkout on-call',
  description: '',
  time_zone: 'America/New_York',
  people: ['ada@example.test', 'bo@example.test'],
  handover_weekday: 1,
  handover_time: '09:00',
  starts_on: '2026-11-25T00:00:00.000Z'
}
const policyFields = {
  name: 'checkout escalation',
  description: '',
  num_loops: 2,
  escalation_delay_minutes: 30,
  schedule: { resourceId: 4 },
  users: ['ada@example.test'],
  escalate_to: ['bo@example.test']
}
const windowFields = {
  service: { resourceId: 1 },
  start_time: '2026-12-01T07:00:00.000Z',
  end_time: '2026-12-01T09:00:00.000Z',
  description: 'Nivaro Hub: Change freeze'
}

const readRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/users$/,
    query: (q) => q.getAll('ids[]').length > 0,
    body: fx('users-both')
  },
  {
    method: 'GET',
    path: /^\/users$/,
    query: (q) => q.get('query') === 'ada@example.test',
    body: fx('users-ada')
  },
  {
    method: 'GET',
    path: /^\/users$/,
    query: (q) => q.get('query') === 'bo@example.test',
    body: fx('users-bo')
  },
  { method: 'GET', path: /^\/users$/, body: fx('users-empty') }
]

describe('pagerduty adapter: registration', () => {
  it('is a core provider on the two hosts of the connection’s region', () => {
    ensureCoreProviders()
    expect(getProvider('pagerduty')).toBe(pagerdutyAdapter)
    expect(pagerdutyAdapter.connection.hosts({ region: 'us' })).toEqual([
      'api.pagerduty.com',
      'events.pagerduty.com'
    ])
    expect(pagerdutyAdapter.connection.hosts({ region: 'eu' })).toEqual([
      'api.eu.pagerduty.com',
      'events.eu.pagerduty.com'
    ])
    expect(pagerdutyAdapter.connection.hosts({})).toEqual([
      'api.pagerduty.com',
      'events.pagerduty.com'
    ])
    expect(pagerdutyAdapter.connection.fields.find((f) => f.key === 'token')?.secret).toBe(true)
    expect(pagerdutyAdapter.connection.fields.find((f) => f.key === 'from_email')?.secret).toBe(
      undefined
    )
    expect(pagerdutyAdapter.connection.describe({ region: 'eu', from_email: FROM })).not.toContain(
      TOKEN
    )
    expect(pagerdutyAdapter.types.map((t) => t.key)).toEqual([
      SERVICE,
      POLICY,
      SCHEDULE,
      INTEGRATION,
      WINDOW
    ])
  })

  it('validates the region, the From user and the key', () => {
    const v = pagerdutyAdapter.connection.validate
    expect(v?.({ region: 'us', from_email: FROM }, { token: TOKEN })).toEqual([])
    expect(v?.({ region: 'mars', from_email: FROM }, {})).not.toEqual([])
    expect(v?.({ region: 'us', from_email: 'not an email' }, {})).not.toEqual([])
    expect(v?.({ region: 'us', from_email: FROM }, { token: ' ' })).not.toEqual([])
  })

  it('refuses a host other than the connection’s own, and the other region', async () => {
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
    await expect(ctx.fetch('https://api.eu.pagerduty.com/x')).rejects.toThrow(/allowed hosts/)
  })

  it('calls the REST host with the token, the version header and From on writes only', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') },
      { method: 'DELETE', path: /^\/services\/PSVC001$/, status: 204 }
    ])
    await pagerdutyAdapter.observe(ctx, SERVICE, 'PSVC001')
    expect(calls[0]?.host).toBe('api.pagerduty.com')
    expect(calls[0]?.headers.authorization).toBe(`Token token=${TOKEN}`)
    expect(calls[0]?.headers.accept).toContain('version=2')
    expect(calls[0]?.headers.from).toBeUndefined()
    const op: PlannedOp = {
      kind: 'delete',
      type: SERVICE,
      resourceId: null,
      externalId: 'PSVC001',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    await pagerdutyAdapter.apply(ctx, op, null)
    expect(calls[1]?.headers.from).toBe(FROM)
  })
})

describe('pagerduty adapter: testConnection', () => {
  it('lists missing permissions when a read is refused and the From user is unknown', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/users$/, body: fx('users-empty') },
      { method: 'GET', path: /^\/maintenance_windows$/, status: 403, body: fx('error-forbidden') },
      { method: 'GET', path: /^\/(services|escalation_policies|schedules)$/, body: { more: false } }
    ])
    const r = await pagerdutyAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toBeNull()
    expect(r.missing).toContain('a PagerDuty user for the From email')
    expect(r.missing).toContain(`read ${WINDOW}`)
    expect(r.missing).not.toContain(`read ${SERVICE}`)
    expect(r.message).toContain('From')
  })

  it('names the account and the user, nothing missing for a working key', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/users$/,
        query: (q) => q.get('query') === FROM,
        body: { users: [{ ...fx('users-ada').users[0], email: FROM }], more: false }
      },
      {
        method: 'GET',
        path: /^\/(services|escalation_policies|schedules|maintenance_windows)$/,
        body: { more: false }
      }
    ])
    const r = await pagerdutyAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('Ada Test')
    expect(r.identity).toContain('testco')
    expect(r.missing).toEqual([])
  })

  it('answers not ok when the key is refused', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/users$/, status: 401, body: fx('error-forbidden') }
    ])
    const r = await pagerdutyAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing.length).toBe(r.permissions.length)
  })
})

describe('pagerduty adapter: observe', () => {
  it('maps service, policy, schedule, integration (no key) and window fields', async () => {
    const { ctx } = harness([
      ...readRoutes,
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') },
      { method: 'GET', path: /^\/escalation_policies\/PPOL001$/, body: fx('policy') },
      { method: 'GET', path: /^\/schedules\/PSCH001$/, body: fx('schedule') },
      {
        method: 'GET',
        path: /^\/services\/PSVC001\/integrations\/PINT001$/,
        body: fx('integration')
      },
      { method: 'GET', path: /^\/maintenance_windows\/PWIN001$/, body: fx('window') }
    ])
    const service = await pagerdutyAdapter.observe(ctx, SERVICE, 'PSVC001')
    expect(service?.fields).toEqual({
      name: 'checkout-api',
      description: 'Checkout',
      escalation_policy: 'PPOL001',
      urgency: 'high',
      auto_resolve_timeout_seconds: 14400,
      acknowledgement_timeout_seconds: 1800,
      alert_creation: 'create_alerts_and_incidents'
    })
    const policy = await pagerdutyAdapter.observe(ctx, POLICY, 'PPOL001')
    expect(policy?.fields).toMatchObject({
      schedule: 'PSCH001',
      users: ['ada@example.test'],
      escalate_to: ['bo@example.test'],
      escalation_delay_minutes: 30,
      num_loops: 2,
      rules_unmodelled: false
    })
    const schedule = await pagerdutyAdapter.observe(ctx, SCHEDULE, 'PSCH001')
    expect(schedule?.fields).toMatchObject({
      time_zone: 'America/New_York',
      people: ['ada@example.test', 'bo@example.test'],
      handover_weekday: 1,
      handover_time: '09:00',
      layer_start: '2026-11-23T14:00:00.000Z',
      layers_count: 1
    })
    const integration = await pagerdutyAdapter.observe(ctx, INTEGRATION, 'PSVC001/PINT001')
    expect(integration?.fields).toEqual({ service: 'PSVC001', name: 'Nivaro Hub' })
    const win = await pagerdutyAdapter.observe(ctx, WINDOW, 'PWIN001')
    expect(win?.fields).toEqual({
      service: 'PSVC001',
      start_time: '2026-12-01T07:00:00.000Z',
      end_time: '2026-12-01T09:00:00.000Z',
      description: 'Nivaro Hub: Change freeze'
    })
    expect(win?.status).toBe('open')
    expect(JSON.stringify([service, policy, schedule, integration, win])).not.toContain(ROUTING)
  })

  it('answers null for a missing resource and refuses ids that cannot sit in a path', async () => {
    const { ctx, calls } = harness([])
    expect(await pagerdutyAdapter.observe(ctx, SERVICE, 'PGONE01')).toBeNull()
    expect(calls).toHaveLength(1)
    for (const id of ['..', 'a/b', '', 'a\\b', 'x\n', 'P 1'])
      await expect(pagerdutyAdapter.observe(ctx, SERVICE, id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(pagerdutyAdapter.observe(ctx, INTEGRATION, 'PSVC001/../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls).toHaveLength(1)
  })

  it('an integration of another service is not ours', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/services\/PSVC999\/integrations\/PINT001$/,
        body: fx('integration')
      }
    ])
    expect(await pagerdutyAdapter.observe(ctx, INTEGRATION, 'PSVC999/PINT001')).toBeNull()
  })

  it('lists with the provider offset', async () => {
    const { ctx } = harness([
      ...readRoutes,
      {
        method: 'GET',
        path: /^\/services$/,
        body: { ...fx('services'), more: true }
      },
      { method: 'GET', path: /^\/escalation_policies$/, body: fx('policies') },
      { method: 'GET', path: /^\/schedules$/, body: fx('schedules') },
      { method: 'GET', path: /^\/maintenance_windows$/, body: fx('windows') }
    ])
    const s = await pagerdutyAdapter.list(ctx, SERVICE, null)
    expect(s.items.map((i) => i.externalId)).toEqual(['PSVC001'])
    expect(s.cursor).toBe('1')
    const p = await pagerdutyAdapter.list(ctx, POLICY, null)
    expect(p.items[0]?.fields.users).toEqual(['ada@example.test'])
    expect(p.cursor).toBeNull()
    const sc = await pagerdutyAdapter.list(ctx, SCHEDULE, null)
    expect(sc.items[0]?.fields.people).toBeUndefined()
    const w = await pagerdutyAdapter.list(ctx, WINDOW, null)
    expect(w.items[0]?.externalId).toBe('PWIN001')
  })
})

describe('pagerduty adapter: plan', () => {
  const observedService = () => ({
    type: SERVICE,
    externalId: 'PSVC001',
    name: 'checkout-api',
    fields: {
      name: 'checkout-api',
      description: 'Checkout',
      escalation_policy: 'PPOL001',
      urgency: 'high',
      auto_resolve_timeout_seconds: 14400,
      acknowledgement_timeout_seconds: 1800,
      alert_creation: 'create_alerts_and_incidents'
    },
    tags: {}
  })

  it('creates, changes, replaces and deletes with plain reasons', () => {
    const { ctx } = noCalls()
    const refs = { escalation_policy: 'PPOL001' }
    const create = pagerdutyAdapter.plan(ctx, desired(SERVICE, serviceFields, refs), null)
    expect(create).toHaveLength(1)
    expect(create[0]?.kind).toBe('create')
    expect(create[0]?.reason).toBe('Create PagerDuty service checkout-api.')

    expect(
      pagerdutyAdapter.plan(
        ctx,
        desired(SERVICE, serviceFields, refs, 'PSVC001'),
        observedService()
      )
    ).toEqual([])
    const changed = pagerdutyAdapter.plan(
      ctx,
      desired(SERVICE, { ...serviceFields, urgency: 'low', description: 'New' }, refs, 'PSVC001'),
      observedService()
    )
    expect(changed[0]?.kind).toBe('update')
    expect(changed[0]?.changes.map((c) => c.field)).toEqual(['description', 'urgency'])
    expect(changed[0]?.reason).toContain('Incident urgency')

    const removed = pagerdutyAdapter.plan(ctx, null, observedService())
    expect(removed[0]?.kind).toBe('delete')

    const integObserved = {
      type: INTEGRATION,
      externalId: 'PSVC001/PINT001',
      name: 'Nivaro Hub',
      fields: { service: 'PSVC001', name: 'Nivaro Hub' },
      tags: {}
    }
    const moved = pagerdutyAdapter.plan(
      ctx,
      desired(
        INTEGRATION,
        { service: { resourceId: 1 }, name: 'Nivaro Hub' },
        { service: 'PSVC002' },
        'PSVC001/PINT001'
      ),
      integObserved
    )
    expect(moved[0]?.kind).toBe('replace')
  })

  it('a rota change on a schedule is the sync_rota op; matching rota plans nothing', () => {
    const { ctx } = noCalls()
    const observed = {
      type: SCHEDULE,
      externalId: 'PSCH001',
      name: 'checkout on-call',
      fields: {
        name: 'checkout on-call',
        description: '',
        time_zone: 'America/New_York',
        people: ['ada@example.test', 'bo@example.test'],
        handover_weekday: 1,
        handover_time: '09:00',
        layer_start: '2026-11-23T14:00:00.000Z',
        layers_count: 1
      },
      tags: {}
    }
    expect(
      pagerdutyAdapter.plan(ctx, desired(SCHEDULE, scheduleFields, {}, 'PSCH001'), observed)
    ).toEqual([])
    const edited = pagerdutyAdapter.plan(
      ctx,
      desired(
        SCHEDULE,
        { ...scheduleFields, people: ['bo@example.test', 'ada@example.test'] },
        {},
        'PSCH001'
      ),
      observed
    )
    expect(edited[0]?.action).toBe('sync_rota')
    expect(edited[0]?.reason).toContain('Copy the Hub on-call rota to PagerDuty schedule')
    // A rota that starts on another week moves who is on call.
    const later = pagerdutyAdapter.plan(
      ctx,
      desired(
        SCHEDULE,
        { ...scheduleFields, starts_on: '2026-12-02T00:00:00.000Z' },
        {},
        'PSCH001'
      ),
      observed
    )
    expect(later[0]?.action).toBe('sync_rota')
    // Weekday 0 (Sunday) is never mistaken for "no value".
    const none = { ...observed, fields: { ...observed.fields, handover_weekday: null } }
    const sunday = pagerdutyAdapter.plan(
      ctx,
      desired(SCHEDULE, { ...scheduleFields, handover_weekday: 0 }, {}, 'PSCH001'),
      none
    )
    expect(sunday[0]?.changes.some((c) => c.field === 'handover_weekday')).toBe(true)
  })

  it('refuses a policy with nobody to page and a window that ends before it starts', () => {
    const { ctx } = noCalls()
    expect(() =>
      pagerdutyAdapter.plan(
        ctx,
        desired(POLICY, { ...policyFields, schedule: null, users: [] }, {}),
        null
      )
    ).toThrowError(/schedule or at least one person/)
    expect(() =>
      pagerdutyAdapter.plan(
        ctx,
        desired(
          WINDOW,
          { ...windowFields, end_time: '2026-12-01T06:00:00.000Z' },
          { service: 'PSVC001' }
        ),
        null
      )
    ).toThrowError(/ends before it starts/)
  })
})

describe('pagerduty adapter: apply is idempotent (read-before-write)', () => {
  const op = (
    kind: PlannedOp['kind'],
    type: string,
    externalId: string | null,
    extra: Partial<PlannedOp> = {}
  ): PlannedOp => ({
    kind,
    type,
    resourceId: 7,
    externalId,
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    ...extra
  })

  it('an update that already matches writes nothing', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') }
    ])
    const r = await pagerdutyAdapter.apply(
      ctx,
      op('update', SERVICE, 'PSVC001'),
      desired(SERVICE, serviceFields, { escalation_policy: 'PPOL001' }, 'PSVC001')
    )
    expect(r.ok).toBe(true)
    expect(r.answer).toEqual({ already: 'matches' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('an update writes only the changed fields', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') },
      { method: 'PUT', path: /^\/services\/PSVC001$/, body: fx('service') }
    ])
    await pagerdutyAdapter.apply(
      ctx,
      op('update', SERVICE, 'PSVC001'),
      desired(
        SERVICE,
        { ...serviceFields, urgency: 'low', auto_resolve_timeout_seconds: 0 },
        { escalation_policy: 'PPOL001' },
        'PSVC001'
      )
    )
    const put = writes(calls)[0]
    expect(put?.method).toBe('PUT')
    expect(put?.body.service).toEqual({
      type: 'service',
      incident_urgency_rule: { type: 'constant', urgency: 'low' },
      auto_resolve_timeout: null
    })
  })

  it('a create that finds an unmanaged service stops with ALREADY_EXISTS', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/services$/, body: fx('services') },
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') }
    ])
    await expect(
      pagerdutyAdapter.apply(
        ctx,
        op('create', SERVICE, null),
        desired(SERVICE, serviceFields, { escalation_policy: 'PPOL001' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(calls)).toHaveLength(0)
    // The same row resuming its own create reuses what it made.
    const again = await pagerdutyAdapter.apply(
      ctx,
      op('create', SERVICE, null),
      desired(SERVICE, serviceFields, { escalation_policy: 'PPOL001' }, 'PSVC001')
    )
    expect(again.externalId).toBe('PSVC001')
    expect(again.answer).toEqual({ already: 'exists' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('creates a service with the policy ref and the defaults', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/services$/, body: { services: [], more: false } },
      { method: 'POST', path: /^\/services$/, status: 201, body: fx('service') }
    ])
    const r = await pagerdutyAdapter.apply(
      ctx,
      op('create', SERVICE, null),
      desired(
        SERVICE,
        { name: 'checkout-api', escalation_policy: { resourceId: 3 } },
        { escalation_policy: 'PPOL001' }
      )
    )
    expect(r.externalId).toBe('PSVC001')
    expect(writes(calls)[0]?.body.service).toMatchObject({
      type: 'service',
      name: 'checkout-api',
      escalation_policy: { id: 'PPOL001', type: 'escalation_policy_reference' },
      incident_urgency_rule: { type: 'constant', urgency: 'high' },
      auto_resolve_timeout: 14400,
      acknowledgement_timeout: 1800
    })
  })

  it('creates a policy: schedule + people at level 1, people at level 2', async () => {
    const { ctx, calls } = harness([
      ...readRoutes,
      {
        method: 'GET',
        path: /^\/escalation_policies$/,
        body: { escalation_policies: [], more: false }
      },
      { method: 'POST', path: /^\/escalation_policies$/, status: 201, body: fx('policy') }
    ])
    const r = await pagerdutyAdapter.apply(
      ctx,
      op('create', POLICY, null),
      desired(POLICY, policyFields, { schedule: 'PSCH001' })
    )
    expect(r.externalId).toBe('PPOL001')
    const body = writes(calls)[0]?.body.escalation_policy
    expect(body.escalation_rules).toEqual([
      {
        escalation_delay_in_minutes: 30,
        targets: [
          { id: 'PSCH001', type: 'schedule_reference' },
          { id: 'PUSER01', type: 'user_reference' }
        ]
      },
      {
        escalation_delay_in_minutes: 30,
        targets: [{ id: 'PUSER02', type: 'user_reference' }]
      }
    ])
  })

  it('an email PagerDuty does not know stops the change and is never guessed', async () => {
    const { ctx, calls } = harness([
      ...readRoutes,
      { method: 'GET', path: /^\/schedules$/, body: { schedules: [], more: false } }
    ])
    await expect(
      pagerdutyAdapter.apply(
        ctx,
        op('create', SCHEDULE, null),
        desired(SCHEDULE, {
          ...scheduleFields,
          people: ['ada@example.test', 'nobody@example.test']
        })
      )
    ).rejects.toMatchObject({ code: 'UNKNOWN_USERS' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('sync_rota rewrites the first layer in place (keeps its id, drops the rest)', async () => {
    const { ctx, calls } = harness([
      ...readRoutes,
      { method: 'GET', path: /^\/schedules\/PSCH001$/, body: fx('schedule') },
      { method: 'PUT', path: /^\/schedules\/PSCH001$/, body: fx('schedule') }
    ])
    await pagerdutyAdapter.apply(
      ctx,
      op('update', SCHEDULE, 'PSCH001', { action: 'sync_rota' }),
      desired(
        SCHEDULE,
        { ...scheduleFields, people: ['bo@example.test', 'ada@example.test'] },
        {},
        'PSCH001'
      )
    )
    const put = writes(calls)[0]
    expect(put?.query.get('overflow')).toBe('false')
    const layer = put?.body.schedule.schedule_layers
    expect(layer).toHaveLength(1)
    expect(layer[0]).toMatchObject({
      id: 'PLAY001',
      rotation_turn_length_seconds: 604800,
      rotation_virtual_start: '2026-11-23T14:00:00.000Z',
      users: [
        { user: { id: 'PUSER02', type: 'user_reference' } },
        { user: { id: 'PUSER01', type: 'user_reference' } }
      ]
    })
  })

  it('a schedule that already matches writes nothing', async () => {
    const { ctx, calls } = harness([
      ...readRoutes,
      { method: 'GET', path: /^\/schedules\/PSCH001$/, body: fx('schedule') }
    ])
    const r = await pagerdutyAdapter.apply(
      ctx,
      op('update', SCHEDULE, 'PSCH001'),
      desired(SCHEDULE, scheduleFields, {}, 'PSCH001')
    )
    expect(r.answer).toEqual({ already: 'matches' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('creates an integration and hands the routing key out as an output only', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') },
      {
        method: 'GET',
        path: /^\/services\/PSVC001\/integrations\/PINT001$/,
        body: {
          integration: { id: 'PINT001', type: 'generic_email_inbound_integration', name: 'Email' }
        }
      },
      {
        method: 'POST',
        path: /^\/services\/PSVC001\/integrations$/,
        status: 201,
        body: fx('integration-created')
      }
    ])
    const r = await pagerdutyAdapter.apply(
      ctx,
      op('create', INTEGRATION, null),
      desired(
        INTEGRATION,
        { service: { resourceId: 1 }, name: 'Nivaro Hub' },
        { service: 'PSVC001' }
      )
    )
    expect(r.externalId).toBe('PSVC001/PINT002')
    expect(r.outputs).toEqual({ routing_key: 'test-secret-routing-key-0002' })
    expect(writes(calls)[0]?.body).toEqual({
      integration: { type: 'events_api_v2_inbound_integration', name: 'Nivaro Hub' }
    })
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('routing-key-0002')
  })

  it('creates a maintenance window on the service; the same window already there is ALREADY_EXISTS', async () => {
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: /^\/maintenance_windows$/,
        body: { maintenance_windows: [], more: false }
      },
      { method: 'POST', path: /^\/maintenance_windows$/, status: 201, body: fx('window') }
    ])
    const r = await pagerdutyAdapter.apply(
      ctx,
      op('create', WINDOW, null),
      desired(WINDOW, windowFields, { service: 'PSVC001' })
    )
    expect(r.externalId).toBe('PWIN001')
    expect(writes(calls)[0]?.body.maintenance_window).toEqual({
      type: 'maintenance_window',
      start_time: '2026-12-01T07:00:00.000Z',
      end_time: '2026-12-01T09:00:00.000Z',
      description: 'Nivaro Hub: Change freeze',
      services: [{ id: 'PSVC001', type: 'service_reference' }]
    })
    const dup = harness([{ method: 'GET', path: /^\/maintenance_windows$/, body: fx('windows') }])
    await expect(
      pagerdutyAdapter.apply(
        dup.ctx,
        op('create', WINDOW, null),
        desired(WINDOW, windowFields, { service: 'PSVC001' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('delete of something already gone is fine', async () => {
    const { ctx } = harness([{ method: 'DELETE', path: /^\/services\/PSVC001$/, status: 404 }])
    const r = await pagerdutyAdapter.apply(ctx, op('delete', SERVICE, 'PSVC001'), null)
    expect(r.ok).toBe(true)
  })

  it('readOutputs re-reads the routing key (never once-only)', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/services\/PSVC001\/integrations\/PINT001$/,
        body: fx('integration')
      }
    ])
    expect(await pagerdutyAdapter.readOutputs?.(ctx, INTEGRATION, 'PSVC001/PINT001')).toEqual({
      routing_key: ROUTING
    })
    expect(await pagerdutyAdapter.readOutputs?.(ctx, SERVICE, 'PSVC001')).toEqual({})
    const spec = pagerdutyAdapter.types.find((t) => t.key === INTEGRATION)
    expect(spec?.outputs).toEqual([{ key: 'routing_key', label: 'Routing key', secret: true }])
    expect(spec?.sends).toBe(true)
  })
})

describe('pagerduty adapter: errors', () => {
  it('maps 429 to retryable', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/services\/PSVC001$/,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '7' }
      }
    ])
    await expect(pagerdutyAdapter.observe(ctx, SERVICE, 'PSVC001')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429
    })
  })

  it('5xx is retryable, 4xx validation is not', async () => {
    const a = harness([{ method: 'GET', path: /^\/services\/PSVC001$/, status: 503, body: {} }])
    await expect(pagerdutyAdapter.observe(a.ctx, SERVICE, 'PSVC001')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true
    })
    const b = harness([
      { method: 'GET', path: /^\/services$/, body: { services: [], more: false } },
      { method: 'POST', path: /^\/services$/, status: 400, body: fx('error-validation') }
    ])
    await expect(
      pagerdutyAdapter.apply(
        b.ctx,
        {
          kind: 'create',
          type: SERVICE,
          resourceId: 1,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        desired(SERVICE, serviceFields, { escalation_policy: 'PPOL001' })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_REJECTED', retryable: false })
  })

  it('secrets never appear in errors', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/services\/PSVC001$/,
        status: 429,
        body: fx('error-rate-limited')
      }
    ])
    const err: any = await pagerdutyAdapter.observe(ctx, SERVICE, 'PSVC001').catch((e) => e)
    expect(err.message).toContain('Rate limit exceeded')
    expect(err.message).not.toContain(TOKEN)
    const ev = harness([
      {
        method: 'GET',
        path: /^\/services\/PSVC001\/integrations\/PINT001$/,
        body: fx('integration')
      },
      {
        method: 'POST',
        host: 'events.pagerduty.com',
        path: /^\/v2\/enqueue$/,
        status: 400,
        body: fx('events-invalid')
      }
    ])
    const sent: any = await pagerdutyAdapter
      .notify?.(ev.ctx, integrationRow(), msg())
      .catch((e: unknown) => e)
    expect(sent.message).toContain('routing_key')
    expect(sent.message).not.toContain(ROUTING)
    expect(sent.code).toBe('PROVIDER_REJECTED')
  })
})

describe('pagerduty adapter: risk flags', () => {
  it('flags per type', () => {
    const spec = (t: string) => pagerdutyAdapter.types.find((x) => x.key === t)
    const op = (kind: PlannedOp['kind'], type: string): PlannedOp => ({
      kind,
      type,
      resourceId: 1,
      externalId: 'X',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    })
    expect(spec(SERVICE)?.risk(op('delete', SERVICE), null)).toEqual(['destructive', 'data_loss'])
    expect(spec(SERVICE)?.risk(op('update', SERVICE), null)).toEqual([])
    expect(spec(POLICY)?.risk(op('delete', POLICY), null)).toEqual(['destructive'])
    expect(spec(SCHEDULE)?.risk(op('delete', SCHEDULE), null)).toEqual(['destructive'])
    expect(spec(INTEGRATION)?.risk(op('replace', INTEGRATION), null)).toEqual(['destructive'])
    expect(spec(WINDOW)?.risk(op('create', WINDOW), null)).toEqual(['downtime'])
    expect(spec(WINDOW)?.risk(op('delete', WINDOW), null)).toEqual([])
    for (const t of pagerdutyAdapter.types) expect(t.costClass).toBeUndefined()
  })
})

describe('pagerduty adapter: outputs', () => {
  it('declares outputs and none leak into observed/desired', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/services\/PSVC001\/integrations\/PINT001$/,
        body: fx('integration')
      }
    ])
    const declared = pagerdutyAdapter.types.filter((t) => t.outputs?.length)
    expect(declared.map((t) => t.key)).toEqual([INTEGRATION])
    const seen = await pagerdutyAdapter.observe(ctx, INTEGRATION, 'PSVC001/PINT001')
    expect(JSON.stringify(seen)).not.toContain(ROUTING)
    for (const t of pagerdutyAdapter.types)
      for (const o of t.outputs ?? []) expect(t.fields.some((f) => f.key === o.key)).toBe(false)
  })
})

// ── Notify ──

function integrationRow(): HubResourceRow {
  return {
    id: 9,
    connection_id: 1,
    provider: 'pagerduty',
    type: INTEGRATION,
    external_id: 'PSVC001/PINT001',
    name: 'Nivaro Hub',
    scope: 'app',
    app_id: 1,
    environment_id: null,
    desired: null,
    observed: null,
    drift: false,
    observed_at: null,
    tags: {},
    refs: [],
    created_by: null,
    adopted: false,
    deleted_at: null,
    created_at: null,
    updated_at: null
  }
}

function msg(extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    kind: 'text',
    title: 'Incident opened: checkout · production',
    body: 'The site is down.',
    link: 'https://hub.example.test/hub/incidents?incident=4',
    severity: 'critical',
    ...extra
  }
}

const notifyRoutes = (events: Partial<Route> = {}): Route[] => [
  {
    method: 'GET',
    path: /^\/services\/PSVC001\/integrations\/PINT001$/,
    body: fx('integration')
  },
  {
    method: 'POST',
    host: 'events.pagerduty.com',
    path: /^\/v2\/enqueue$/,
    status: 202,
    body: fx('events-ok'),
    ...events
  }
]

describe('pagerduty adapter: notify', () => {
  it('notify sends one message: a trigger with the Hub incident dedup key', async () => {
    const { ctx, calls } = harness(notifyRoutes())
    const r = await pagerdutyAdapter.notify?.(
      ctx,
      integrationRow(),
      msg({ dedupKey: 'incident:4', action: 'open' })
    )
    expect(r?.ok).toBe(true)
    expect(r?.answer).toMatchObject({ event_action: 'trigger', dedup_key: 'hub-incident-4' })
    const sent = writes(calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.host).toBe('events.pagerduty.com')
    expect(sent[0]?.body).toMatchObject({
      routing_key: ROUTING,
      event_action: 'trigger',
      dedup_key: 'hub-incident-4',
      payload: {
        summary: 'Incident opened: checkout · production',
        severity: 'critical',
        source: 'nivaro-hub'
      },
      links: [{ href: 'https://hub.example.test/hub/incidents?incident=4' }]
    })
    // The routing key is never part of what the engine stores.
    expect(JSON.stringify(r)).not.toContain(ROUTING)
  })

  it('resolve sends a resolve for the same key; update re-triggers it; resolve needs a key', async () => {
    const { ctx, calls } = harness(notifyRoutes())
    await pagerdutyAdapter.notify?.(
      ctx,
      integrationRow(),
      msg({ dedupKey: 'incident:4', action: 'resolve', severity: 'info' })
    )
    await pagerdutyAdapter.notify?.(
      ctx,
      integrationRow(),
      msg({ dedupKey: 'incident:4', action: 'update', severity: 'warning' })
    )
    const events = writes(calls).map((c) => c.body)
    expect(events[0]).toMatchObject({ event_action: 'resolve', dedup_key: 'hub-incident-4' })
    expect(events[0].payload).toBeUndefined()
    expect(events[1]).toMatchObject({
      event_action: 'trigger',
      dedup_key: 'hub-incident-4',
      payload: { severity: 'warning' }
    })
    await expect(
      pagerdutyAdapter.notify?.(ctx, integrationRow(), msg({ action: 'resolve' }))
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })

  it('maps 429 to retryable', async () => {
    const { ctx } = harness(
      notifyRoutes({
        status: 429,
        body: { status: 'throttle exceeded', message: 'Too many requests' },
        headers: { 'retry-after': '3' }
      })
    )
    await expect(pagerdutyAdapter.notify?.(ctx, integrationRow(), msg())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429
    })
  })

  it('only a PagerDuty integration sends, and a gone integration is NOT_A_SENDER', async () => {
    const { ctx, calls } = noCalls()
    await expect(
      pagerdutyAdapter.notify?.(ctx, { ...integrationRow(), type: SERVICE }, msg())
    ).rejects.toMatchObject({ code: 'NOT_A_SENDER' })
    expect(calls).toHaveLength(0)
    await expect(pagerdutyAdapter.notify?.(ctx, integrationRow(), msg())).rejects.toMatchObject({
      code: 'NOT_A_SENDER'
    })
  })

  it('a key without a Hub dedup prefix is kept, made safe', async () => {
    const { ctx, calls } = harness(notifyRoutes())
    await pagerdutyAdapter.notify?.(ctx, integrationRow(), msg({ dedupKey: 'deploy 12/x' }))
    expect(writes(calls)[0]?.body.dedup_key).toBe('deploy-12-x')
  })
})

// ── Health ──

describe('pagerduty adapter: health', () => {
  it('a service reports its status and open incidents', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/services\/PSVC001$/, body: fx('service') },
      { method: 'GET', path: /^\/incidents$/, body: fx('incidents-total') }
    ])
    const h = await pagerdutyAdapter.health?.(ctx, SERVICE, 'PSVC001')
    expect(h?.status).toBe('ok')
    expect(h?.details).toMatchObject({ status: 'active', open_incidents: 3 })
    const gone = harness([])
    expect((await pagerdutyAdapter.health?.(gone.ctx, SERVICE, 'PSVC001'))?.status).toBe('down')
  })
})

// ── Rota and planned-maintenance helpers ──

describe('pagerduty rota helpers', () => {
  it('turns a rota into one weekly layer aligned to its hand-over and back', () => {
    const layer = layerOfFields(
      {
        people: ['Ada@Example.test', 'bo@example.test'],
        handover_weekday: 1,
        handover_time: '09:00',
        starts_on: '2026-11-25T00:00:00.000Z'
      },
      'America/New_York',
      new Date('2026-11-26T00:00:00Z')
    )
    expect(layer).toEqual({
      people: ['ada@example.test', 'bo@example.test'],
      turn_seconds: 604800,
      virtual_start: '2026-11-23T14:00:00.000Z'
    })
    expect(handoverOfLayer(layer.virtual_start, layer.turn_seconds, 'America/New_York')).toEqual({
      weekday: 1,
      time: '09:00'
    })
  })

  it('checks a rota and maps the Hub rota and a planned freeze', () => {
    expect(rotaProblem({ people: [], handover_weekday: 1, handover_time: '09:00' })).toContain(
      '1 to 20'
    )
    expect(rotaProblem({ people: ['x'], handover_weekday: 1, handover_time: '09:00' })).toContain(
      'email'
    )
    expect(
      rotaProblem({ people: ['a@b.co'], handover_weekday: 9, handover_time: '09:00' })
    ).toContain('weekday')
    expect(
      rotaProblem({ people: ['a@b.co'], handover_weekday: 1, handover_time: '9am' })
    ).toContain('HH:MM')
    expect(
      rotaToScheduleFields(
        { handover_weekday: 2, handover_time: '10:30', starts_on: '2026-01-01T00:00:00.000Z' },
        ['A@b.co']
      )
    ).toEqual({
      people: ['a@b.co'],
      handover_weekday: 2,
      handover_time: '10:30',
      starts_on: '2026-01-01T00:00:00.000Z'
    })
    expect(
      windowFieldsOfPlanned({
        title: 'Change freeze — no updates',
        starts_at: '2026-12-01T07:00:00.000Z',
        ends_at: null
      })
    ).toEqual({
      start_time: '2026-12-01T07:00:00.000Z',
      end_time: '2026-12-01T09:00:00.000Z',
      description: 'Nivaro Hub: Change freeze — no updates'
    })
  })
})
