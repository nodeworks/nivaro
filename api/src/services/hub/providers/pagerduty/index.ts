import { isTimeZone } from '../../releases/zoned.js'
import { fieldWords, typedName } from '../plan-words.js'
import type { HubResourceRow } from '../store.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type OutboundMessage,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import {
  emailProblem,
  enqueue,
  eventsHost,
  fromOf,
  idSeg,
  nextOffset,
  offsetOf,
  type PdAnswer,
  pdCall,
  regionOf,
  restHost,
  splitIntegration
} from './client.js'
import {
  handoverOfLayer,
  layerOfFields,
  type RotaFields,
  rotaProblem,
  WEEK_SECONDS
} from './rota.js'

/**
 * PagerDuty (`pagerduty`): a REST API key + the email of a PagerDuty user the Hub writes as
 * (the `From` header PagerDuty requires on writes) + the region (US or EU). Types: service (per
 * app), escalation policy, schedule (a Hub on-call rota copied to a weekly layer), integration
 * (Events API v2; its routing key is an OUTPUT, never part of observed or desired state) and
 * maintenance window. The integration is also the SENDER: `notify` turns a Hub event into an
 * Events v2 trigger / resolve with one dedup key per Hub incident, so a Hub incident is one
 * PagerDuty incident. The adapter reads the routing key from PagerDuty at send time (it never
 * touches the Hub database); a key rotated by hand at PagerDuty therefore keeps working.
 *
 * External ids: service, policy, schedule, window = the PagerDuty id; integration =
 * `<service id>/<integration id>`. People are matched by EMAIL; an email PagerDuty does not know
 * stops the change (`UNKNOWN_USERS`), never guessed. PagerDuty bills per user seat, not per
 * resource, so none of these types has a cost class.
 */

const SERVICE = 'pagerduty.service'
const POLICY = 'pagerduty.escalation_policy'
const SCHEDULE = 'pagerduty.schedule'
const INTEGRATION = 'pagerduty.integration'
const WINDOW = 'pagerduty.maintenance_window'
const PAGE = 50
const V2 = 'events_api_v2_inbound_integration'
const LAYER_NAME = 'Nivaro Hub on-call rota'

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const idOf = (v: unknown): string | null => str(asObj(v).id)

// ── Comparison helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function canon(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.entries(x as Obj)
          .filter(([, y]) => y !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, y]) => [k, walk(y)])
      )
    return x
  }
  return JSON.stringify(walk(v))
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (Array.isArray(x) || Array.isArray(y)) return canon(x ?? []) === canon(y ?? [])
  if (x === null || y === null) return x === y
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return canon(x) === canon(y)
}

function diffFields(keys: string[], want: Obj, have: Obj): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (!sameValue(want[k], have[k])) out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

/** A time in UTC ISO form (PagerDuty answers local offsets), or null. */
function isoOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

const lowerSorted = (v: unknown): string[] =>
  arr(v)
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
    .sort()

const numOf = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at PagerDuty. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

/** The provider id a `ref` field resolved to: a string, null (not created yet) or undefined. */
function refStr(d: DesiredResource | null, field: string): string | null | undefined {
  const v = d?.refs?.[field]
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null
  return typeof v === 'string' && v ? v : v === null ? null : undefined
}

function refOne(d: DesiredResource | null, field: string): string {
  const v = refStr(d, field)
  if (typeof v === 'string') return v
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field.replace(/_/g, ' ')} this change belongs to is not created yet.`
  )
}

// ── Users (by email) ──

async function emailMap(ctx: ProviderContext, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = [...new Set(ids)].filter(Boolean).slice(0, 100)
  if (!list.length) return out
  const r = await pdCall(ctx, 'GET', '/users', {
    query: { 'ids[]': list.map((i) => idSeg(i, 'user id')), limit: 100 }
  })
  for (const u of arr(r.body?.users)) {
    const o = asObj(u)
    const id = str(o.id)
    const email = str(o.email)
    if (id && email) out.set(id, email.toLowerCase())
  }
  return out
}

/** The PagerDuty ids of these emails; one unknown address stops the change (never guessed). */
async function userIds(ctx: ProviderContext, emails: string[]): Promise<string[]> {
  const out: string[] = []
  const unknown: string[] = []
  for (const email of emails) {
    const want = email.trim().toLowerCase()
    const r = await pdCall(ctx, 'GET', '/users', { query: { query: want, limit: 25 } })
    const hit = arr(r.body?.users).find((u) => str(asObj(u).email)?.toLowerCase() === want)
    const id = hit ? idOf(hit) : null
    if (id) out.push(id)
    else unknown.push(email)
  }
  if (unknown.length)
    throw new ProviderError(
      'UNKNOWN_USERS',
      `PagerDuty has no user with the email ${unknown.join(', ')}. Add them in PagerDuty first.`
    )
  return out
}

// ── Observed mappers (never carry a routing key or a token) ──

function serviceObserved(s: Obj): Observed {
  const rule = asObj(s.incident_urgency_rule)
  return {
    type: SERVICE,
    externalId: String(s.id),
    name: str(s.name),
    fields: {
      name: str(s.name),
      description: str(s.description) ?? '',
      escalation_policy: idOf(s.escalation_policy),
      urgency: rule.type === 'constant' ? str(rule.urgency) : null,
      auto_resolve_timeout_seconds:
        s.auto_resolve_timeout == null ? 0 : numOf(s.auto_resolve_timeout),
      acknowledgement_timeout_seconds:
        s.acknowledgement_timeout == null ? 0 : numOf(s.acknowledgement_timeout),
      alert_creation: str(s.alert_creation)
    },
    tags: {},
    version: null,
    status: str(s.status),
    url: str(s.html_url)
  }
}

interface Level {
  schedules: string[]
  users: string[]
  other: boolean
}

function levelOf(rule: unknown, emails: Map<string, string>): Level {
  const out: Level = { schedules: [], users: [], other: false }
  for (const t of arr(asObj(rule).targets)) {
    const o = asObj(t)
    const id = str(o.id)
    if (!id) continue
    if (o.type === 'schedule_reference') out.schedules.push(id)
    else if (o.type === 'user_reference') out.users.push(emails.get(id) ?? id)
    else out.other = true
  }
  out.users.sort()
  return out
}

function policyUserIds(p: Obj): string[] {
  const ids: string[] = []
  for (const r of arr(p.escalation_rules))
    for (const t of arr(asObj(r).targets)) {
      const o = asObj(t)
      if (o.type === 'user_reference' && str(o.id)) ids.push(String(o.id))
    }
  return ids
}

function policyObserved(p: Obj, emails: Map<string, string>): Observed {
  const rules = arr(p.escalation_rules)
  const l1 = levelOf(rules[0], emails)
  const l2 = levelOf(rules[1], emails)
  const unmodelled =
    rules.length > 2 || l1.other || l2.other || l2.schedules.length > 0 || l1.schedules.length > 1
  return {
    type: POLICY,
    externalId: String(p.id),
    name: str(p.name),
    fields: {
      name: str(p.name),
      description: str(p.description) ?? '',
      num_loops: numOf(p.num_loops),
      escalation_delay_minutes: numOf(asObj(rules[0]).escalation_delay_in_minutes),
      schedule: l1.schedules[0] ?? null,
      users: l1.users,
      escalate_to: l2.users,
      rules_unmodelled: unmodelled
    },
    tags: {},
    version: null,
    status: null,
    url: str(p.html_url)
  }
}

function scheduleObserved(s: Obj, emails: Map<string, string>): Observed {
  const fields: Obj = {
    name: str(s.name),
    description: str(s.description) ?? '',
    time_zone: str(s.time_zone)
  }
  // The list answers no layers: then the rota fields are simply not readable (not compared).
  if (Array.isArray(s.schedule_layers)) {
    const layers = s.schedule_layers as unknown[]
    const l = asObj(layers[0])
    const people = arr(l.users).map((u) => {
      const id = idOf(asObj(u).user) ?? ''
      return emails.get(id) ?? id
    })
    const virtual = isoOf(l.rotation_virtual_start)
    const turn = numOf(l.rotation_turn_length_seconds)
    const tz = str(s.time_zone) ?? 'UTC'
    const hand = virtual && isTimeZone(tz) ? handoverOfLayer(virtual, turn, tz) : null
    fields.people = people.map((p) => p.toLowerCase())
    fields.handover_weekday = hand ? hand.weekday : null
    fields.handover_time = hand ? hand.time : null
    fields.layer_start = virtual
    fields.layer_turn_seconds = turn || null
    fields.layers_count = layers.length
  }
  return {
    type: SCHEDULE,
    externalId: String(s.id),
    name: str(s.name),
    fields,
    tags: {},
    version: null,
    status: null,
    url: str(s.html_url)
  }
}

function scheduleUserIds(s: Obj): string[] {
  const ids: string[] = []
  for (const l of arr(s.schedule_layers))
    for (const u of arr(asObj(l).users)) {
      const id = idOf(asObj(u).user)
      if (id) ids.push(id)
    }
  return ids
}

function integrationObserved(serviceId: string, i: Obj): Observed {
  // `integration_key` is the routing key: never copied.
  return {
    type: INTEGRATION,
    externalId: `${serviceId}/${String(i.id)}`,
    name: str(i.name),
    fields: { service: serviceId, name: str(i.name) },
    tags: {},
    version: null,
    status: null,
    url: str(i.html_url)
  }
}

function windowObserved(ctx: ProviderContext, w: Obj): Observed {
  const end = isoOf(w.end_time)
  return {
    type: WINDOW,
    externalId: String(w.id),
    name: str(w.description) ?? str(w.summary),
    fields: {
      service: idOf(arr(w.services)[0]),
      start_time: isoOf(w.start_time),
      end_time: end,
      description: str(w.description) ?? ''
    },
    tags: {},
    version: null,
    status: end && Date.parse(end) < ctx.now().getTime() ? 'ended' : 'open',
    url: null
  }
}

// ── Reads ──

async function readRaw(ctx: ProviderContext, path: string): Promise<PdAnswer> {
  return pdCall(ctx, 'GET', path, { allow: [404] })
}

async function readService(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await readRaw(ctx, `/services/${idSeg(id, 'service id')}`)
  return r.status === 404 ? null : serviceObserved(asObj(r.body?.service))
}

async function readPolicyRaw(ctx: ProviderContext, id: string): Promise<Obj | null> {
  const r = await readRaw(ctx, `/escalation_policies/${idSeg(id, 'policy id')}`)
  return r.status === 404 ? null : asObj(r.body?.escalation_policy)
}

async function readPolicy(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const raw = await readPolicyRaw(ctx, id)
  return raw ? policyObserved(raw, await emailMap(ctx, policyUserIds(raw))) : null
}

async function readScheduleRaw(ctx: ProviderContext, id: string): Promise<Obj | null> {
  const r = await readRaw(ctx, `/schedules/${idSeg(id, 'schedule id')}`)
  return r.status === 404 ? null : asObj(r.body?.schedule)
}

async function readSchedule(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const raw = await readScheduleRaw(ctx, id)
  return raw ? scheduleObserved(raw, await emailMap(ctx, scheduleUserIds(raw))) : null
}

async function readIntegrationRaw(ctx: ProviderContext, externalId: string): Promise<Obj | null> {
  const [sid, iid] = splitIntegration(externalId)
  const r = await readRaw(ctx, `/services/${sid}/integrations/${iid}`)
  if (r.status === 404) return null
  const raw = asObj(r.body?.integration)
  // The path names the service; an answer for another one is not ours.
  const owner = idOf(raw.service)
  if (owner && owner !== sid) return null
  return raw
}

async function readIntegration(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const raw = await readIntegrationRaw(ctx, externalId)
  return raw ? integrationObserved(splitIntegration(externalId)[0], raw) : null
}

async function readWindow(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await readRaw(ctx, `/maintenance_windows/${idSeg(id, 'window id')}`)
  return r.status === 404 ? null : windowObserved(ctx, asObj(r.body?.maintenance_window))
}

const sameName = (a: unknown, b: unknown) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase()

async function findByName(
  ctx: ProviderContext,
  type: string,
  name: string
): Promise<Observed | null> {
  const path =
    type === SERVICE ? '/services' : type === POLICY ? '/escalation_policies' : '/schedules'
  const key = type === SERVICE ? 'services' : type === POLICY ? 'escalation_policies' : 'schedules'
  const r = await pdCall(ctx, 'GET', path, { query: { query: name, limit: 25 } })
  const hit = arr(r.body?.[key]).find((x) => sameName(asObj(x).name, name))
  const id = hit ? idOf(hit) : null
  if (!id) return null
  if (type === SERVICE) return readService(ctx, id)
  if (type === POLICY) return readPolicy(ctx, id)
  return readSchedule(ctx, id)
}

async function listIntegrations(ctx: ProviderContext, serviceId: string): Promise<Observed[]> {
  const r = await pdCall(ctx, 'GET', `/services/${idSeg(serviceId, 'service id')}`, {
    query: { 'include[]': ['integrations'] },
    allow: [404]
  })
  if (r.status === 404) return []
  // The service answer lists its integrations as references; read each events integration.
  const out: Observed[] = []
  for (const ref of arr(asObj(r.body?.service).integrations)) {
    const iid = idOf(ref)
    if (!iid) continue
    const one = await pdCall(
      ctx,
      'GET',
      `/services/${idSeg(serviceId, 'service id')}/integrations/${idSeg(iid, 'integration id')}`,
      { allow: [404] }
    )
    const raw = asObj(one.body?.integration)
    if (one.status === 200 && raw.type === V2) out.push(integrationObserved(serviceId, raw))
  }
  return out
}

// ── Specs ──

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

const TYPES: ResourceTypeSpec[] = [
  {
    key: SERVICE,
    label: 'PagerDuty service',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 255 },
      { key: 'description', label: 'Description', kind: 'string', max: 1024 },
      {
        key: 'escalation_policy',
        label: 'Escalation policy',
        kind: 'ref',
        refType: POLICY,
        required: true
      },
      {
        key: 'urgency',
        label: 'Incident urgency',
        kind: 'enum',
        default: 'high',
        options: [
          { value: 'high', label: 'High' },
          { value: 'low', label: 'Low' }
        ]
      },
      {
        key: 'auto_resolve_timeout_seconds',
        label: 'Auto-resolve after (seconds)',
        kind: 'number',
        default: 14400,
        min: 0,
        help: '0 = never auto-resolve.'
      },
      {
        key: 'acknowledgement_timeout_seconds',
        label: 'Acknowledgement timeout (seconds)',
        kind: 'number',
        default: 1800,
        min: 0,
        help: '0 = an acknowledged incident stays acknowledged.'
      },
      {
        key: 'alert_creation',
        label: 'Alert creation',
        kind: 'enum',
        default: 'create_alerts_and_incidents',
        options: [
          { value: 'create_alerts_and_incidents', label: 'Alerts and incidents' },
          { value: 'create_incidents', label: 'Incidents only' }
        ]
      }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'escalation_policy', type: POLICY, required: true }],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive', 'data_loss'] : []
    }
  },
  {
    key: POLICY,
    label: 'PagerDuty escalation policy',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 255 },
      { key: 'description', label: 'Description', kind: 'string', max: 1024 },
      {
        key: 'num_loops',
        label: 'Repeat the policy',
        kind: 'number',
        default: 2,
        min: 0,
        max: 9,
        help: 'How many times the levels repeat when nobody acknowledges.'
      },
      {
        key: 'escalation_delay_minutes',
        label: 'Escalate after (minutes)',
        kind: 'number',
        default: 30,
        min: 1,
        max: 10080
      },
      {
        key: 'schedule',
        label: 'Level 1 schedule',
        kind: 'ref',
        refType: SCHEDULE,
        help: 'Level 1 pages whoever is on call on this schedule.'
      },
      {
        key: 'users',
        label: 'Level 1 people (emails)',
        kind: 'list',
        items: { key: 'email', label: 'Email', kind: 'string' },
        help: 'Level 1 also pages these people. A policy needs a schedule or at least one person.'
      },
      {
        key: 'escalate_to',
        label: 'Level 2 people (emails)',
        kind: 'list',
        items: { key: 'email', label: 'Email', kind: 'string' },
        help: 'Paged when level 1 does not acknowledge in time.'
      },
      {
        key: 'rules_unmodelled',
        label: 'Has more levels than the Hub manages',
        kind: 'boolean',
        readOnly: true
      }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'schedule', type: SCHEDULE, required: false }],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
    }
  },
  {
    key: SCHEDULE,
    label: 'PagerDuty schedule',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 255 },
      { key: 'description', label: 'Description', kind: 'string', max: 1024 },
      {
        key: 'time_zone',
        label: 'Time zone',
        kind: 'string',
        required: true,
        default: 'UTC',
        help: 'An IANA zone such as America/New_York. The hand-over time is on this zone.'
      },
      {
        key: 'people',
        label: 'On-call people (emails, in order)',
        kind: 'list',
        required: true,
        items: { key: 'email', label: 'Email', kind: 'string' },
        help: 'Copy of the Hub rota: one weekly layer, first person first. Matched by email.'
      },
      {
        key: 'handover_weekday',
        label: 'Hand-over weekday',
        kind: 'number',
        required: true,
        min: 0,
        max: 6,
        help: '0 = Sunday … 6 = Saturday.'
      },
      {
        key: 'handover_time',
        label: 'Hand-over time',
        kind: 'string',
        required: true,
        pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
        help: 'HH:MM on the schedule’s time zone.'
      },
      {
        key: 'starts_on',
        label: 'Rota starts on',
        kind: 'string',
        help: 'The day the first person starts (the Hub rota’s start). Empty = today on create.'
      },
      { key: 'layer_start', label: 'Layer start (read)', kind: 'string', readOnly: true },
      { key: 'layer_turn_seconds', label: 'Turn length (read)', kind: 'number', readOnly: true },
      { key: 'layers_count', label: 'Layers at PagerDuty', kind: 'number', readOnly: true }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
    }
  },
  {
    key: INTEGRATION,
    label: 'PagerDuty integration (Events API v2)',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'service',
        label: 'Service',
        kind: 'ref',
        refType: SERVICE,
        required: true,
        replaceOnChange: true
      },
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        default: 'Nivaro Hub',
        max: 255
      }
    ],
    capabilities: FULL,
    reversible: false,
    refs: [{ field: 'service', type: SERVICE, required: true }],
    outputs: [{ key: 'routing_key', label: 'Routing key', secret: true }],
    sends: true,
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
    }
  },
  {
    key: WINDOW,
    label: 'PagerDuty maintenance window',
    scope: 'app',
    nameField: 'description',
    fields: [
      {
        key: 'service',
        label: 'Service',
        kind: 'ref',
        refType: SERVICE,
        required: true,
        replaceOnChange: true
      },
      {
        key: 'start_time',
        label: 'Starts (UTC, ISO)',
        kind: 'string',
        required: true,
        help: 'For example 2026-12-01T02:00:00.000Z.'
      },
      { key: 'end_time', label: 'Ends (UTC, ISO)', kind: 'string', required: true },
      { key: 'description', label: 'Description', kind: 'string', max: 1024 }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'service', type: SERVICE, required: true }],
    risk(op) {
      // While a window runs the service pages nobody.
      const out: RiskFlag[] = []
      if (op.kind === 'create' || op.kind === 'replace' || op.kind === 'update')
        out.push('downtime')
      return out
    }
  }
]

const specOf = (type: string) => TYPES.find((t) => t.key === type)
const labelOf = (type: string) => specOf(type)?.label ?? type
const wordsOf = (type: string, changes: Array<{ field: string }>) =>
  fieldWords(specOf(type)?.fields, changes)

// ── Plan ──

interface Handler {
  type: string
  compare: string[]
  create: string[]
  replaceRefs: string[]
  nameOf(f: Obj): string
}

const HANDLERS: Record<string, Handler> = {
  [SERVICE]: {
    type: SERVICE,
    compare: [
      'name',
      'description',
      'escalation_policy',
      'urgency',
      'auto_resolve_timeout_seconds',
      'acknowledgement_timeout_seconds',
      'alert_creation'
    ],
    create: [
      'name',
      'description',
      'escalation_policy',
      'urgency',
      'auto_resolve_timeout_seconds',
      'acknowledgement_timeout_seconds',
      'alert_creation'
    ],
    replaceRefs: [],
    nameOf: (f) => String(f.name ?? '')
  },
  [POLICY]: {
    type: POLICY,
    compare: [
      'name',
      'description',
      'num_loops',
      'escalation_delay_minutes',
      'schedule',
      'users',
      'escalate_to'
    ],
    create: [
      'name',
      'description',
      'num_loops',
      'escalation_delay_minutes',
      'schedule',
      'users',
      'escalate_to'
    ],
    replaceRefs: [],
    nameOf: (f) => String(f.name ?? '')
  },
  [SCHEDULE]: {
    type: SCHEDULE,
    compare: ['name', 'description', 'time_zone', 'people', 'handover_weekday', 'handover_time'],
    create: ['name', 'description', 'time_zone', 'people', 'handover_weekday', 'handover_time'],
    replaceRefs: [],
    nameOf: (f) => String(f.name ?? '')
  },
  [INTEGRATION]: {
    type: INTEGRATION,
    compare: ['name'],
    create: ['name'],
    replaceRefs: ['service'],
    nameOf: (f) => String(f.name ?? '')
  },
  [WINDOW]: {
    type: WINDOW,
    compare: ['start_time', 'end_time', 'description'],
    create: ['start_time', 'end_time', 'description'],
    replaceRefs: ['service'],
    nameOf: (f) => String(f.description ?? '')
  }
}

/** Desired values in the shape observed values come in. */
function wantOf(type: string, d: DesiredResource): Obj {
  const f = d.fields
  const out: Obj = { ...f }
  if (type === SERVICE) {
    const ep = refStr(d, 'escalation_policy')
    out.escalation_policy = ep === null ? undefined : ep
    for (const k of ['auto_resolve_timeout_seconds', 'acknowledgement_timeout_seconds'])
      if (f[k] !== undefined) out[k] = numOf(f[k])
  }
  if (type === POLICY) {
    const empty = f.schedule == null || f.schedule === ''
    const s = refStr(d, 'schedule')
    out.schedule = empty ? null : typeof s === 'string' ? s : undefined
    out.users = lowerSorted(f.users)
    out.escalate_to = lowerSorted(f.escalate_to)
    for (const k of ['num_loops', 'escalation_delay_minutes'])
      if (f[k] !== undefined) out[k] = numOf(f[k])
  }
  if (type === SCHEDULE) {
    out.people = Array.isArray(f.people)
      ? arr(f.people).map((p) => String(p).trim().toLowerCase())
      : undefined
    for (const k of ['handover_weekday']) if (f[k] !== undefined) out[k] = numOf(f[k])
  }
  if (type === WINDOW) {
    out.start_time = isoOf(f.start_time) ?? f.start_time
    out.end_time = isoOf(f.end_time) ?? f.end_time
  }
  return out
}

function planGeneric(h: Handler, d: DesiredResource | null, o: Observed | null): PlannedOp[] {
  const type = h.type
  const label = labelOf(type)
  if (!d) {
    if (!o) return []
    return [
      {
        kind: 'delete',
        type,
        resourceId: null,
        externalId: o.externalId,
        reason: `Delete ${typedName(label, o.name)} at PagerDuty.`,
        changes: [],
        preconditions: { name: o.name },
        risk: []
      }
    ]
  }
  const want = wantOf(type, d)
  if (!o) {
    return [
      {
        kind: 'create',
        type,
        resourceId: d.resourceId,
        externalId: null,
        reason: `Create ${typedName(label, h.nameOf(d.fields))}.`,
        changes: h.create
          .filter((k) => norm(want[k]) !== null && want[k] !== undefined)
          .map((k) => ({ field: k, to: want[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const refChanged = h.replaceRefs.filter((r) => {
    const v = d.refs?.[r]
    return typeof v === 'string' && v !== o.fields[r]
  })
  if (refChanged.length) {
    return [
      {
        kind: 'replace',
        type,
        resourceId: d.resourceId,
        externalId: o.externalId,
        reason: `Replace ${typedName(label, o.name)}: the service it belongs to cannot change in place.`,
        changes: refChanged.map((r) => ({ field: r, from: o.fields[r], to: d.refs?.[r] })),
        preconditions: { name: o.name },
        risk: []
      }
    ]
  }
  const changes = diffFields(h.compare, want, o.fields)
  if (type === SCHEDULE) startChange(d, o, changes)
  if (!changes.length) return []
  const pre: Obj = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  const rotaTouched =
    type === SCHEDULE &&
    changes.some((c) =>
      ['people', 'handover_weekday', 'handover_time', 'starts_on'].includes(c.field)
    )
  const extra =
    type === SCHEDULE && numOf(o.fields.layers_count) > 1 && rotaTouched
      ? ' Layers beyond the first are removed.'
      : type === POLICY && o.fields.rules_unmodelled === true
        ? ' Levels beyond the two the Hub manages are replaced.'
        : ''
  return [
    {
      kind: 'update',
      type,
      resourceId: d.resourceId,
      externalId: o.externalId,
      ...(rotaTouched ? { action: 'sync_rota' } : {}),
      reason: `${
        rotaTouched ? 'Copy the Hub on-call rota to' : `Change ${wordsOf(type, changes)} on`
      } ${typedName(label, o.name)}.${extra}`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

/** A different rota start moves who is on call: judged against the layer PagerDuty holds. */
function startChange(d: DesiredResource, o: Observed, changes: FieldChange[]): void {
  const starts = str(d.fields.starts_on)
  const have = str(o.fields.layer_start)
  const tz = str(d.fields.time_zone) ?? str(o.fields.time_zone) ?? 'UTC'
  if (!starts || !have || changes.some((c) => c.field === 'starts_on') || !isTimeZone(tz)) return
  const f = rotaFieldsOf(d.fields)
  if (!f || rotaProblem(f)) return
  const want = layerOfFields(f, tz, new Date(starts)).virtual_start
  if (Date.parse(want) !== Date.parse(have))
    changes.push({ field: 'starts_on', from: have, to: want })
}

function rotaFieldsOf(f: Obj): RotaFields | null {
  if (!Array.isArray(f.people)) return null
  return {
    people: arr(f.people).map(String),
    handover_weekday: numOf(f.handover_weekday),
    handover_time: String(f.handover_time ?? ''),
    ...(str(f.starts_on) ? { starts_on: String(f.starts_on) } : {})
  }
}

function validate(type: string, d: DesiredResource | null): void {
  if (!d) return
  const f = d.fields
  const bad = (msg: string): never => {
    throw new ProviderError('INVALID_FIELDS', msg)
  }
  if (type === POLICY) {
    const hasSchedule = !(f.schedule == null || f.schedule === '')
    if (!hasSchedule && !arr(f.users).length)
      bad('An escalation policy needs a level 1 schedule or at least one person.')
    for (const e of [...arr(f.users), ...arr(f.escalate_to)])
      if (emailProblem(e)) bad(`${String(e)} is not an email address.`)
  }
  if (type === SCHEDULE) {
    if (!isTimeZone(f.time_zone)) bad('The time zone is not an IANA zone name.')
    const r = rotaFieldsOf(f)
    const problem = r ? rotaProblem(r) : 'The schedule needs its on-call people.'
    if (problem) bad(problem)
  }
  if (type === WINDOW) {
    const s = Date.parse(String(f.start_time ?? ''))
    const e = Date.parse(String(f.end_time ?? ''))
    if (Number.isNaN(s) || Number.isNaN(e)) bad('The window needs a start and an end time.')
    if (e <= s) bad('The window ends before it starts.')
  }
}

// ── Apply ──

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs ? { outputs } : {})
})

const gone = (what: string) =>
  new ProviderError('NOT_FOUND', `The ${what} no longer exists at PagerDuty.`, { status: 404 })

function secondsOrNull(v: unknown): number | null {
  const n = numOf(v)
  return n > 0 ? n : null
}

function serviceBody(d: DesiredResource, only?: string[]): Obj {
  const f = d.fields
  const all: Obj = {
    name: f.name,
    description: f.description ?? '',
    escalation_policy: { id: refOne(d, 'escalation_policy'), type: 'escalation_policy_reference' },
    incident_urgency_rule: { type: 'constant', urgency: f.urgency ?? 'high' },
    auto_resolve_timeout: secondsOrNull(f.auto_resolve_timeout_seconds ?? 14400),
    acknowledgement_timeout: secondsOrNull(f.acknowledgement_timeout_seconds ?? 1800),
    alert_creation: f.alert_creation ?? 'create_alerts_and_incidents'
  }
  const key: Record<string, string> = {
    name: 'name',
    description: 'description',
    escalation_policy: 'escalation_policy',
    urgency: 'incident_urgency_rule',
    auto_resolve_timeout_seconds: 'auto_resolve_timeout',
    acknowledgement_timeout_seconds: 'acknowledgement_timeout',
    alert_creation: 'alert_creation'
  }
  if (!only) return { type: 'service', ...all }
  const body: Obj = { type: 'service' }
  for (const k of only) {
    const pd = key[k]
    if (pd) body[pd] = all[pd]
  }
  return body
}

async function applyService(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    await pdCall(ctx, 'DELETE', `/services/${idSeg(op.externalId, 'service id')}`, { allow: [404] })
    return ok(op.externalId, null)
  }
  if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  validate(SERVICE, d)
  if (op.kind === 'create' || op.kind === 'replace') {
    const existing = await findByName(ctx, SERVICE, String(d.fields.name))
    if (existing) {
      if (d.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`A service named ${String(d.fields.name)} already exists`)
    }
    const r = await pdCall(ctx, 'POST', '/services', { body: { service: serviceBody(d) } })
    const made = serviceObserved(asObj(r.body?.service))
    return ok(made.externalId, made)
  }
  const id = op.externalId as string
  const have = await readService(ctx, id)
  if (!have) throw gone('service')
  const diff = diffFields(HANDLERS[SERVICE]?.compare ?? [], wantOf(SERVICE, d), have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const r = await pdCall(ctx, 'PUT', `/services/${idSeg(id, 'service id')}`, {
    body: {
      service: serviceBody(
        d,
        diff.map((c) => c.field)
      )
    }
  })
  return ok(id, serviceObserved(asObj(r.body?.service)))
}

async function policyBody(ctx: ProviderContext, d: DesiredResource): Promise<Obj> {
  const f = d.fields
  const scheduleId = refStr(d, 'schedule')
  const hasSchedule = !(f.schedule == null || f.schedule === '')
  if (hasSchedule && typeof scheduleId !== 'string')
    throw new ProviderError('INVALID_FIELDS', 'The schedule this policy pages is not created yet.')
  const l1 = lowerSorted(f.users)
  const l2 = lowerSorted(f.escalate_to)
  const ids = await userIds(ctx, [...new Set([...l1, ...l2])])
  const byEmail = new Map<string, string>()
  const all = [...new Set([...l1, ...l2])]
  for (const [i, e] of all.entries()) byEmail.set(e, ids[i] as string)
  const delay = numOf(f.escalation_delay_minutes ?? 30) || 30
  const target = (id: string) => ({ id, type: 'user_reference' })
  const rules: Obj[] = [
    {
      escalation_delay_in_minutes: delay,
      targets: [
        ...(hasSchedule ? [{ id: scheduleId, type: 'schedule_reference' }] : []),
        ...l1.map((e) => target(byEmail.get(e) as string))
      ]
    }
  ]
  if (l2.length)
    rules.push({
      escalation_delay_in_minutes: delay,
      targets: l2.map((e) => target(byEmail.get(e) as string))
    })
  return {
    type: 'escalation_policy',
    name: f.name,
    description: f.description ?? '',
    num_loops: numOf(f.num_loops ?? 2),
    escalation_rules: rules
  }
}

async function applyPolicy(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    await pdCall(ctx, 'DELETE', `/escalation_policies/${idSeg(op.externalId, 'policy id')}`, {
      allow: [404]
    })
    return ok(op.externalId, null)
  }
  if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  validate(POLICY, d)
  if (op.kind === 'create' || op.kind === 'replace') {
    const existing = await findByName(ctx, POLICY, String(d.fields.name))
    if (existing) {
      if (d.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`An escalation policy named ${String(d.fields.name)} already exists`)
    }
    const r = await pdCall(ctx, 'POST', '/escalation_policies', {
      body: { escalation_policy: await policyBody(ctx, d) }
    })
    const raw = asObj(r.body?.escalation_policy)
    const made = policyObserved(raw, await emailMap(ctx, policyUserIds(raw)))
    return ok(made.externalId, made)
  }
  const id = op.externalId as string
  const have = await readPolicy(ctx, id)
  if (!have) throw gone('escalation policy')
  const diff = diffFields(HANDLERS[POLICY]?.compare ?? [], wantOf(POLICY, d), have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const r = await pdCall(ctx, 'PUT', `/escalation_policies/${idSeg(id, 'policy id')}`, {
    body: { escalation_policy: await policyBody(ctx, d) }
  })
  const raw = asObj(r.body?.escalation_policy)
  return ok(id, policyObserved(raw, await emailMap(ctx, policyUserIds(raw))))
}

async function scheduleBody(
  ctx: ProviderContext,
  d: DesiredResource,
  existingLayerId: string | null
): Promise<Obj> {
  const f = d.fields
  const rota = rotaFieldsOf(f) as RotaFields
  const tz = String(f.time_zone)
  const layer = layerOfFields(rota, tz, ctx.now())
  const ids = await userIds(ctx, layer.people)
  return {
    type: 'schedule',
    name: f.name,
    description: f.description ?? '',
    time_zone: tz,
    schedule_layers: [
      {
        ...(existingLayerId ? { id: existingLayerId } : {}),
        name: LAYER_NAME,
        start: layer.virtual_start,
        rotation_virtual_start: layer.virtual_start,
        rotation_turn_length_seconds: WEEK_SECONDS,
        users: ids.map((id) => ({ user: { id, type: 'user_reference' } }))
      }
    ]
  }
}

async function applySchedule(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    await pdCall(ctx, 'DELETE', `/schedules/${idSeg(op.externalId, 'schedule id')}`, {
      allow: [404]
    })
    return ok(op.externalId, null)
  }
  if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  validate(SCHEDULE, d)
  if (op.kind === 'create' || op.kind === 'replace') {
    const existing = await findByName(ctx, SCHEDULE, String(d.fields.name))
    if (existing) {
      if (d.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`A schedule named ${String(d.fields.name)} already exists`)
    }
    const r = await pdCall(ctx, 'POST', '/schedules', {
      query: { overflow: false },
      body: { schedule: await scheduleBody(ctx, d, null) }
    })
    const raw = asObj(r.body?.schedule)
    const made = scheduleObserved(raw, await emailMap(ctx, scheduleUserIds(raw)))
    return ok(made.externalId, made)
  }
  const id = op.externalId as string
  const raw = await readScheduleRaw(ctx, id)
  if (!raw) throw gone('schedule')
  const have = scheduleObserved(raw, await emailMap(ctx, scheduleUserIds(raw)))
  const changes = diffFields(HANDLERS[SCHEDULE]?.compare ?? [], wantOf(SCHEDULE, d), have.fields)
  startChange(d, have, changes)
  if (!changes.length) return ok(id, have, { already: 'matches' })
  const layerId = idOf(arr(raw.schedule_layers)[0])
  const r = await pdCall(ctx, 'PUT', `/schedules/${idSeg(id, 'schedule id')}`, {
    query: { overflow: false },
    body: { schedule: await scheduleBody(ctx, d, layerId) }
  })
  const after = asObj(r.body?.schedule)
  return ok(id, scheduleObserved(after, await emailMap(ctx, scheduleUserIds(after))))
}

async function applyIntegration(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource | null
): Promise<OpResult> {
  const remove = async (externalId: string) => {
    const [sid, iid] = splitIntegration(externalId)
    await pdCall(ctx, 'DELETE', `/services/${sid}/integrations/${iid}`, { allow: [404] })
  }
  const withKey = (externalId: string, o: Observed, raw: Obj): OpResult => {
    const key = str(raw.integration_key)
    return ok(externalId, o, undefined, key ? { routing_key: key } : undefined)
  }
  const add = async (): Promise<OpResult> => {
    if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const sid = idSeg(refOne(d, 'service'), 'service id')
    const name = String(d.fields.name ?? 'Nivaro Hub')
    const existing = (await listIntegrations(ctx, sid)).find((i) => sameName(i.name, name))
    if (existing) {
      if (d.externalId !== existing.externalId)
        throw alreadyExists(`An integration named ${name} already exists on this service`)
      const raw = await readIntegrationRaw(ctx, existing.externalId)
      return raw ? withKey(existing.externalId, existing, raw) : ok(existing.externalId, existing)
    }
    const r = await pdCall(ctx, 'POST', `/services/${sid}/integrations`, {
      body: { integration: { type: V2, name } }
    })
    const raw = asObj(r.body?.integration)
    const made = integrationObserved(sid, raw)
    return withKey(made.externalId, made, raw)
  }
  if (op.kind === 'delete') {
    await remove(op.externalId as string)
    return ok(op.externalId, null)
  }
  if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') return add()
  if (op.kind === 'replace') {
    await remove(op.externalId as string)
    return add()
  }
  const externalId = op.externalId as string
  const raw = await readIntegrationRaw(ctx, externalId)
  if (!raw) throw gone('integration')
  const [sid, iid] = splitIntegration(externalId)
  const have = integrationObserved(sid, raw)
  if (sameName(have.name, d.fields.name)) return withKey(externalId, have, raw)
  const r = await pdCall(ctx, 'PUT', `/services/${sid}/integrations/${iid}`, {
    body: { integration: { type: V2, name: d.fields.name } }
  })
  const after = asObj(r.body?.integration)
  return withKey(externalId, integrationObserved(sid, { ...raw, ...after }), { ...raw, ...after })
}

function windowBody(d: DesiredResource, withService: boolean): Obj {
  const f = d.fields
  return {
    type: 'maintenance_window',
    start_time: isoOf(f.start_time),
    end_time: isoOf(f.end_time),
    description: f.description ?? '',
    ...(withService ? { services: [{ id: refOne(d, 'service'), type: 'service_reference' }] } : {})
  }
}

async function findWindow(ctx: ProviderContext, d: DesiredResource): Promise<Observed | null> {
  const sid = refStr(d, 'service')
  if (typeof sid !== 'string') return null
  const r = await pdCall(ctx, 'GET', '/maintenance_windows', {
    query: { 'service_ids[]': [idSeg(sid, 'service id')], limit: 100 }
  })
  const start = isoOf(d.fields.start_time)
  const end = isoOf(d.fields.end_time)
  for (const w of arr(r.body?.maintenance_windows)) {
    const o = windowObserved(ctx, asObj(w))
    if (
      o.fields.start_time === start &&
      o.fields.end_time === end &&
      sameName(o.fields.description, d.fields.description)
    )
      return o
  }
  return null
}

async function applyWindow(
  ctx: ProviderContext,
  op: PlannedOp,
  d: DesiredResource | null
): Promise<OpResult> {
  const remove = async (id: string) => {
    await pdCall(ctx, 'DELETE', `/maintenance_windows/${idSeg(id, 'window id')}`, { allow: [404] })
  }
  const add = async (): Promise<OpResult> => {
    if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const existing = await findWindow(ctx, d)
    if (existing) {
      if (d.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists('The same maintenance window already exists')
    }
    const r = await pdCall(ctx, 'POST', '/maintenance_windows', {
      body: { maintenance_window: windowBody(d, true) }
    })
    const made = windowObserved(ctx, asObj(r.body?.maintenance_window))
    return ok(made.externalId, made)
  }
  if (op.kind === 'delete') {
    await remove(op.externalId as string)
    return ok(op.externalId, null)
  }
  if (!d) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  validate(WINDOW, d)
  if (op.kind === 'create') return add()
  if (op.kind === 'replace') {
    await remove(op.externalId as string)
    return add()
  }
  const id = op.externalId as string
  const have = await readWindow(ctx, id)
  if (!have) throw gone('maintenance window')
  const diff = diffFields(HANDLERS[WINDOW]?.compare ?? [], wantOf(WINDOW, d), have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const r = await pdCall(ctx, 'PUT', `/maintenance_windows/${idSeg(id, 'window id')}`, {
    body: { maintenance_window: windowBody(d, false) }
  })
  return ok(id, windowObserved(ctx, asObj(r.body?.maintenance_window)))
}

// ── Notify (Events API v2) ──

const SEVERITY = { info: 'info', warning: 'warning', critical: 'critical' } as const

/** `incident:12` (the Hub's key) becomes `hub-incident-12`; any other key is kept, made safe. */
export function dedupKeyOf(key: string | undefined): string | undefined {
  if (!key) return undefined
  const m = /^incident:(\d{1,12})$/.exec(key)
  if (m) return `hub-incident-${m[1]}`
  const safe = key.replace(/[^\w.:-]/g, '-').slice(0, 255)
  return safe || undefined
}

async function routingKeyOf(ctx: ProviderContext, externalId: string): Promise<string> {
  const raw = await readIntegrationRaw(ctx, externalId)
  const key = raw && raw.type === V2 ? str(raw.integration_key) : null
  if (!key)
    throw new ProviderError(
      'NOT_A_SENDER',
      'The integration is gone at PagerDuty or has no Events API v2 routing key.'
    )
  return key
}

// ── Permissions ──

const READS: Array<{ type: string; path: string }> = [
  { type: SERVICE, path: '/services' },
  { type: POLICY, path: '/escalation_policies' },
  { type: SCHEDULE, path: '/schedules' },
  { type: INTEGRATION, path: '/services' },
  { type: WINDOW, path: '/maintenance_windows' }
]

// ── The adapter ──

export const pagerdutyAdapter: ProviderAdapter = {
  key: 'pagerduty',
  label: 'PagerDuty',
  connection: {
    fields: [
      {
        key: 'region',
        label: 'Region',
        kind: 'enum',
        default: 'us',
        required: true,
        options: [
          { value: 'us', label: 'US (api.pagerduty.com)' },
          { value: 'eu', label: 'EU (api.eu.pagerduty.com)' }
        ],
        help: 'The service region of your PagerDuty account.'
      },
      {
        key: 'from_email',
        label: 'From (user email)',
        kind: 'string',
        required: true,
        placeholder: 'hub@example.com',
        help: 'The email of a PagerDuty user the Hub writes as. PagerDuty requires it on every write.'
      },
      {
        key: 'token',
        label: 'REST API key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A general access REST API key (Integrations → API Access Keys). Read-only keys cannot change anything.'
      }
    ],
    hosts: (config) => [restHost(config), eventsHost(config)],
    describe: (config) => `PagerDuty ${regionOf(config).toUpperCase()} as ${fromOf(config)}`,
    validate(config, secrets) {
      const problems: string[] = []
      const r = String(config.region ?? 'us').toLowerCase()
      if (r !== 'us' && r !== 'eu') problems.push('The region is US or EU.')
      if (emailProblem(config.from_email))
        problems.push('The From user is the email address of a PagerDuty user.')
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The REST API key is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const perms = (read: (t: string) => boolean, fromOk: boolean) => [
      { type: '*', need: 'a PagerDuty user for the From email', has: fromOk },
      ...READS.flatMap((x) => [
        { type: x.type, need: `read ${x.type}`, has: read(x.type) },
        // PagerDuty lists no key rights: a key that reads is assumed to write (a read-only key
        // fails at its first write with 401/403).
        {
          type: x.type,
          need: `write ${x.type} (assumed from a general access key)`,
          has: read(x.type)
        }
      ])
    ]
    const failAll = (message: string): ConnectionTest => {
      const p = perms(() => false, false)
      return { ok: false, identity: null, permissions: p, missing: p.map((x) => x.need), message }
    }
    let user: Obj | null = null
    try {
      const r = await pdCall(ctx, 'GET', '/users', {
        query: { query: fromOf(ctx.config), limit: 25 }
      })
      user =
        asObj(
          arr(r.body?.users).find((u) => str(asObj(u).email)?.toLowerCase() === fromOf(ctx.config))
        ) ?? null
      if (user && !str(user.id)) user = null
    } catch (err) {
      if (err instanceof ProviderError) return failAll(ctx.scrub(err.message))
      throw err
    }
    const ok_: Record<string, boolean> = {}
    for (const x of READS) {
      try {
        const r = await pdCall(ctx, 'GET', x.path, { query: { limit: 1 }, allow: [401, 403] })
        ok_[x.type] = r.status === 200
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err
        ok_[x.type] = false
      }
    }
    const p = perms((t) => ok_[t] === true, !!user)
    const missing = p.filter((x) => !x.has).map((x) => x.need)
    let host = ''
    try {
      host = user ? (new URL(String(user.html_url)).hostname.split('.')[0] ?? '') : ''
    } catch {
      host = ''
    }
    return {
      ok: Object.values(ok_).some(Boolean),
      identity: user
        ? `${str(user.name) ?? str(user.email) ?? 'user'}${host ? ` · account ${host}` : ''}`
        : null,
      permissions: p,
      missing,
      ...(!user
        ? { message: 'PagerDuty has no user with the From email, so writes will be refused.' }
        : {})
    }
  },

  async observe(ctx, type, externalId) {
    if (type === SERVICE) return readService(ctx, externalId)
    if (type === POLICY) return readPolicy(ctx, externalId)
    if (type === SCHEDULE) return readSchedule(ctx, externalId)
    if (type === INTEGRATION) return readIntegration(ctx, externalId)
    if (type === WINDOW) return readWindow(ctx, externalId)
    throw new ProviderError('UNKNOWN_TYPE', `PagerDuty has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    const offset = offsetOf(cursor)
    const q = { limit: PAGE, offset }
    if (type === SERVICE || type === INTEGRATION) {
      const r = await pdCall(ctx, 'GET', '/services', { query: q })
      const services = arr(r.body?.services).map(asObj)
      const next = nextOffset(r.body, offset, services.length)
      if (type === SERVICE) return { items: services.map(serviceObserved), cursor: next }
      const items: Observed[] = []
      for (const s of services) items.push(...(await listIntegrations(ctx, String(s.id))))
      return { items, cursor: next }
    }
    if (type === POLICY) {
      const r = await pdCall(ctx, 'GET', '/escalation_policies', { query: q })
      const list = arr(r.body?.escalation_policies).map(asObj)
      const emails = await emailMap(ctx, list.flatMap(policyUserIds))
      return {
        items: list.map((p) => policyObserved(p, emails)),
        cursor: nextOffset(r.body, offset, list.length)
      }
    }
    if (type === SCHEDULE) {
      const r = await pdCall(ctx, 'GET', '/schedules', { query: q })
      const list = arr(r.body?.schedules).map(asObj)
      return {
        items: list.map((s) => scheduleObserved(s, new Map())),
        cursor: nextOffset(r.body, offset, list.length)
      }
    }
    if (type === WINDOW) {
      const r = await pdCall(ctx, 'GET', '/maintenance_windows', { query: q })
      const list = arr(r.body?.maintenance_windows).map(asObj)
      return {
        items: list.map((w) => windowObserved(ctx, w)).filter((o) => o.status !== 'ended'),
        cursor: nextOffset(r.body, offset, list.length)
      }
    }
    throw new ProviderError('UNKNOWN_TYPE', `PagerDuty has no ${type}.`)
  },

  /** Plan time: the same name at PagerDuty (a service, policy, schedule, integration) or window. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === SERVICE || type === POLICY || type === SCHEDULE)
      return findByName(ctx, type, String(desired.fields.name ?? ''))
    if (type === INTEGRATION) {
      const sid = refStr(desired, 'service')
      if (typeof sid !== 'string' || !sid) return null
      const list = await listIntegrations(ctx, sid)
      return list.find((i) => sameName(i.name, desired.fields.name)) ?? null
    }
    if (type === WINDOW) return findWindow(ctx, desired)
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    const h = type ? HANDLERS[type] : undefined
    if (!h) throw new ProviderError('UNKNOWN_TYPE', `PagerDuty has no ${String(type)}.`)
    if (desired && !observed) validate(h.type, desired)
    return planGeneric(h, desired, observed)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === SERVICE) return applyService(ctx, op, desired)
    if (op.type === POLICY) return applyPolicy(ctx, op, desired)
    if (op.type === SCHEDULE) return applySchedule(ctx, op, desired)
    if (op.type === INTEGRATION) return applyIntegration(ctx, op, desired)
    if (op.type === WINDOW) return applyWindow(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `PagerDuty has no ${op.type}.`)
  },

  /** PagerDuty shows the routing key again on request, so it is never once-only. */
  async readOutputs(ctx, type, externalId): Promise<Record<string, string>> {
    if (type !== INTEGRATION) return {}
    const raw = await readIntegrationRaw(ctx, externalId)
    const key = raw && raw.type === V2 ? str(raw.integration_key) : null
    return key ? { routing_key: key } : {}
  },

  /** One Hub event → one Events v2 trigger or resolve; one dedup key = one PagerDuty incident. */
  async notify(ctx, resource: HubResourceRow, msg: OutboundMessage): Promise<OpResult> {
    if (resource.provider !== 'pagerduty' || resource.type !== INTEGRATION || !resource.external_id)
      throw new ProviderError('NOT_A_SENDER', 'Only a PagerDuty integration can send.')
    const dedup = dedupKeyOf(msg.dedupKey)
    const resolving = msg.action === 'resolve'
    if (resolving && !dedup)
      throw new ProviderError('INVALID_FIELDS', 'Resolving needs the dedup key of the incident.')
    const routing = await routingKeyOf(ctx, resource.external_id)
    const answer = await enqueue(ctx, {
      routing_key: routing,
      event_action: resolving ? 'resolve' : 'trigger',
      ...(dedup ? { dedup_key: dedup } : {}),
      ...(resolving
        ? {}
        : {
            payload: {
              summary: (msg.title || msg.body || 'Nivaro Hub').slice(0, 1024),
              source: 'nivaro-hub',
              severity: SEVERITY[msg.severity] ?? 'info',
              timestamp: ctx.now().toISOString(),
              component: 'nivaro-hub',
              custom_details: { body: msg.body.slice(0, 2000) }
            },
            ...(msg.link ? { links: [{ href: msg.link, text: 'Open in the Nivaro Hub' }] } : {})
          })
    })
    return ok(resource.external_id, null, {
      event_action: resolving ? 'resolve' : 'trigger',
      status: answer.status,
      ...(answer.dedup_key ? { dedup_key: answer.dedup_key } : {})
    })
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at PagerDuty.', checkedAt }
    if (type === WINDOW)
      return {
        status: 'ok',
        message:
          seen.status === 'ended' ? 'The window has ended.' : 'The window is open or planned.',
        checkedAt
      }
    if (type !== SERVICE) return { status: 'ok', checkedAt }
    let open: number | null = null
    try {
      const r = await pdCall(ctx, 'GET', '/incidents', {
        query: {
          'service_ids[]': [idSeg(externalId, 'service id')],
          'statuses[]': ['triggered', 'acknowledged'],
          limit: 1,
          total: true
        },
        allow: [401, 403]
      })
      if (r.status === 200)
        open = typeof r.body?.total === 'number' ? r.body.total : arr(r.body?.incidents).length
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
    }
    const details: Record<string, string | number | boolean> = {}
    if (seen.status) details.status = seen.status
    if (open !== null) details.open_incidents = open
    const status = seen.status === 'disabled' ? 'warn' : seen.status === 'critical' ? 'warn' : 'ok'
    return {
      status,
      message:
        open === null
          ? `Service is ${seen.status ?? 'unknown'}.`
          : `Service is ${seen.status ?? 'unknown'}; ${open} open incident${open === 1 ? '' : 's'}.`,
      checkedAt,
      details
    }
  }
}
