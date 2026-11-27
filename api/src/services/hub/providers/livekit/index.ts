import { isIP } from 'node:net'
import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  type SecretValue
} from '../types.js'
import {
  EGRESS_SERVICE,
  livekitCall,
  projectHost,
  ROOM_SERVICE,
  SIP_SERVICE,
  safeValue,
  wsUrlOf
} from './client.js'
import type { LiveKitGrants } from './token.js'

/**
 * LiveKit Cloud (`livekit`): project URL (`wss://<project>.livekit.cloud`) + API key + sealed API
 * secret. LiveKit Cloud has no public project-management API, so the project is made in the
 * LiveKit dashboard and ADOPTED; the Hub never creates or deletes one, and keys are pasted once
 * (sealed), never made here. The server API is Twirp over HTTPS, authenticated by an HS256 token
 * signed from the key (token.ts).
 *
 * Types: `livekit.project` (shared, adopt only: rooms and participants as health),
 * `livekit.api_key` (a key pair pasted once; outputs `api_key`, `api_secret`, `url` for the huddle
 * settings), `livekit.room` (read + close op, for a stuck huddle), `livekit.egress` (read + stop
 * op), `livekit.sip_trunk` (create / update / delete). All are billed by LiveKit usage, so none
 * has a cost class. The app already runs huddles on LiveKit (routes/chat-huddle-sfu.ts): this
 * adapter does not touch that code, it only fills the settings it reads.
 *
 * The project is pinned by the connection URL: every call goes to that one host, so every id read
 * (room, egress, trunk) is inside the project by construction. Named ops (close a room, stop an
 * egress) check that the op's target equals `desired.externalId` (`TARGET_MISMATCH`) and send only
 * what comes from `desired`; `op.data` is compared, never sent.
 */

const T = {
  project: 'livekit.project',
  apiKey: 'livekit.api_key',
  room: 'livekit.room',
  egress: 'livekit.egress',
  sip: 'livekit.sip_trunk'
} as const

const ROOM_LIST: LiveKitGrants = { video: { roomList: true, roomAdmin: true } }
const EGRESS_ADMIN: LiveKitGrants = { video: { roomRecord: true } }
const SIP_ADMIN: LiveKitGrants = { sip: { admin: true } }
const roomGrant = (room: string): LiveKitGrants => ({
  video: { roomList: true, roomAdmin: true, room }
})

// ── Small helpers ──

/** First present key of an object (Twirp answers may be camelCase or snake_case). */
function pick(o: any, ...names: string[]): any {
  for (const n of names) if (o && o[n] !== undefined && o[n] !== null) return o[n]
  return undefined
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])

function strList(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return []
  const list = Array.isArray(v) ? v : [v]
  return list.map((x) => String(x ?? '').trim()).filter(Boolean)
}

const sameList = (a: unknown, b: unknown) =>
  JSON.stringify([...strList(a)].sort()) === JSON.stringify([...strList(b)].sort())

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function isoOfSeconds(v: unknown): string | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

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
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

function notSupported(what: string): ProviderError {
  return new ProviderError('NOT_SUPPORTED', what, { retryable: false })
}

function alreadyExists(label: string, name: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `A ${label} named ${name} already exists in this LiveKit project. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function targetMismatch(what: string): ProviderError {
  return new ProviderError('TARGET_MISMATCH', `The ${what} to change is not the one this op names.`)
}

const KEY_ID = /^[A-Za-z0-9_-]{3,64}$/
const ROOM_ID_MAX = 255
const EGRESS_ID = /^[A-Za-z0-9_-]{3,64}$/
const TRUNK_ID = /^[A-Za-z0-9_-]{3,64}$/

function egressId(id: unknown): string {
  const s = safeValue(id, 'egress id', 64)
  if (!EGRESS_ID.test(s)) throw new ProviderError('BAD_ID', 'The egress id has the wrong shape.')
  return s
}

function trunkId(id: unknown): string {
  const s = safeValue(id, 'trunk id', 64)
  if (!TRUNK_ID.test(s)) throw new ProviderError('BAD_ID', 'The trunk id has the wrong shape.')
  return s
}

function roomId(id: unknown): string {
  return safeValue(id, 'room name', ROOM_ID_MAX)
}

function hostOf(ctx: ProviderContext): string {
  const h = projectHost(ctx.config)
  if (!h) throw new ProviderError('BAD_CONFIG', 'The connection has no valid LiveKit Cloud URL.')
  return h
}

const consoleUrl = (host: string) =>
  `https://cloud.livekit.io/projects?search=${host.split('.')[0]}`

// ── Reads ──

async function listRoomsRaw(ctx: ProviderContext, names?: string[]): Promise<any[]> {
  const r = await livekitCall(ctx, ROOM_SERVICE, 'ListRooms', names ? { names } : {}, ROOM_LIST)
  return arr(r.body?.rooms)
}

function roomObserved(r: any, host: string): Observed {
  const name = String(r.name ?? '')
  return {
    type: T.room,
    externalId: name,
    name,
    fields: {
      name,
      participants: Number(pick(r, 'num_participants', 'numParticipants') ?? 0),
      publishers: Number(pick(r, 'num_publishers', 'numPublishers') ?? 0),
      recording: pick(r, 'active_recording', 'activeRecording') === true,
      created_at: isoOfSeconds(pick(r, 'creation_time', 'creationTime'))
    },
    tags: {},
    version: null,
    status: 'open',
    url: consoleUrl(host)
  }
}

async function readRoom(ctx: ProviderContext, name: string): Promise<Observed | null> {
  const id = roomId(name)
  const found = (await listRoomsRaw(ctx, [id])).find((r) => r.name === id)
  return found ? roomObserved(found, hostOf(ctx)) : null
}

async function readProject(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const host = hostOf(ctx)
  // The project is the connection: any other id is outside it.
  if (externalId.toLowerCase() !== host) return null
  const rooms = await listRoomsRaw(ctx)
  const participants = rooms.reduce(
    (n, r) => n + Number(pick(r, 'num_participants', 'numParticipants') ?? 0),
    0
  )
  return {
    type: T.project,
    externalId: host,
    name: host,
    fields: { url: wsUrlOf(host), rooms: rooms.length, participants },
    tags: {},
    version: null,
    status: 'ok',
    url: consoleUrl(host)
  }
}

const EGRESS_STATUS: Record<string, string> = {
  '0': 'starting',
  '1': 'active',
  '2': 'ending',
  '3': 'complete',
  '4': 'failed',
  '5': 'aborted',
  '6': 'limit_reached',
  egress_starting: 'starting',
  egress_active: 'active',
  egress_ending: 'ending',
  egress_complete: 'complete',
  egress_failed: 'failed',
  egress_aborted: 'aborted',
  egress_limit_reached: 'limit_reached'
}

function egressStatus(v: unknown): string {
  return EGRESS_STATUS[String(v ?? '').toLowerCase()] ?? 'unknown'
}

const egressLive = (s: string) => s === 'starting' || s === 'active'

async function listEgressRaw(ctx: ProviderContext, body: Record<string, unknown>): Promise<any[]> {
  const r = await livekitCall(ctx, EGRESS_SERVICE, 'ListEgress', body, EGRESS_ADMIN)
  return arr(r.body?.items)
}

function egressObserved(e: any, host: string): Observed {
  const id = String(pick(e, 'egress_id', 'egressId') ?? '')
  return {
    type: T.egress,
    externalId: id,
    name: id,
    fields: {
      id,
      room: pick(e, 'room_name', 'roomName') ?? null,
      status: egressStatus(e.status),
      started_at: isoOfSeconds(Number(pick(e, 'started_at', 'startedAt') ?? 0) / 1e9)
    },
    tags: {},
    version: null,
    status: egressStatus(e.status),
    url: consoleUrl(host)
  }
}

async function readEgress(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const eid = egressId(id)
  const found = (await listEgressRaw(ctx, { egress_id: eid })).find(
    (e) => pick(e, 'egress_id', 'egressId') === eid
  )
  return found ? egressObserved(found, hostOf(ctx)) : null
}

// SIP trunks: inbound and outbound are two lists at LiveKit.

type TrunkDirection = 'inbound' | 'outbound'

async function listTrunksRaw(
  ctx: ProviderContext
): Promise<Array<{ direction: TrunkDirection; t: any }>> {
  const [ins, outs] = await Promise.all([
    livekitCall(ctx, SIP_SERVICE, 'ListSIPInboundTrunk', {}, SIP_ADMIN),
    livekitCall(ctx, SIP_SERVICE, 'ListSIPOutboundTrunk', {}, SIP_ADMIN)
  ])
  return [
    ...arr(ins.body?.items).map((t) => ({ direction: 'inbound' as const, t })),
    ...arr(outs.body?.items).map((t) => ({ direction: 'outbound' as const, t }))
  ]
}

/** Never carries the trunk's password. */
function trunkObserved(direction: TrunkDirection, t: any, host: string): Observed {
  const id = String(pick(t, 'sip_trunk_id', 'sipTrunkId') ?? '')
  const name = t.name ?? null
  return {
    type: T.sip,
    externalId: id,
    name,
    fields: {
      direction,
      name,
      numbers: strList(t.numbers),
      allowed_addresses:
        direction === 'inbound' ? strList(pick(t, 'allowed_addresses', 'allowedAddresses')) : [],
      allowed_numbers:
        direction === 'inbound' ? strList(pick(t, 'allowed_numbers', 'allowedNumbers')) : [],
      address: direction === 'outbound' ? (t.address ?? null) : null,
      auth_username: pick(t, 'auth_username', 'authUsername') ?? null
    },
    tags: {},
    version: null,
    status: 'active',
    url: consoleUrl(host)
  }
}

async function readTrunk(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const tid = trunkId(id)
  const hit = (await listTrunksRaw(ctx)).find(
    (x) => pick(x.t, 'sip_trunk_id', 'sipTrunkId') === tid
  )
  return hit ? trunkObserved(hit.direction, hit.t, hostOf(ctx)) : null
}

// ── Field specs ──

const READ_ONLY_PROJECT: FieldSpec[] = [
  { key: 'url', label: 'Project URL', kind: 'string', readOnly: true },
  { key: 'rooms', label: 'Rooms open', kind: 'number', readOnly: true },
  { key: 'participants', label: 'People connected', kind: 'number', readOnly: true }
]

const KEY_FIELDS: FieldSpec[] = [
  {
    key: 'api_key',
    label: 'API key',
    kind: 'string',
    required: true,
    pattern: '^[A-Za-z0-9_-]{3,64}$',
    help: 'The key name from LiveKit Cloud, Settings, Keys (it starts with API).'
  },
  {
    key: 'api_secret',
    label: 'API secret',
    kind: 'secret',
    required: true,
    help: 'LiveKit shows the secret once, when the key is made. Paste it here once: the Hub checks it against the project, seals it and hands it to what is bound to it. Lost? Make a new key in the dashboard and paste that one.'
  }
]

const ROOM_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Room name', kind: 'string', readOnly: true },
  { key: 'participants', label: 'People connected', kind: 'number', readOnly: true },
  { key: 'publishers', label: 'People publishing', kind: 'number', readOnly: true },
  { key: 'recording', label: 'Being recorded', kind: 'boolean', readOnly: true },
  { key: 'created_at', label: 'Opened', kind: 'string', readOnly: true },
  {
    key: 'close',
    label: 'Close the room now',
    kind: 'boolean',
    trigger: true,
    help: 'Disconnects everyone in the room and ends it. Use it for a huddle that is stuck.'
  }
]

const EGRESS_FIELDS: FieldSpec[] = [
  { key: 'id', label: 'Egress id', kind: 'string', readOnly: true },
  { key: 'room', label: 'Room', kind: 'string', readOnly: true },
  { key: 'status', label: 'Status', kind: 'string', readOnly: true },
  { key: 'started_at', label: 'Started', kind: 'string', readOnly: true },
  {
    key: 'stop',
    label: 'Stop it now',
    kind: 'boolean',
    trigger: true,
    help: 'Ends this recording or stream. The file or stream is finished, not discarded.'
  }
]

const SIP_FIELDS: FieldSpec[] = [
  {
    key: 'direction',
    label: 'Direction',
    kind: 'enum',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    options: [
      { value: 'inbound', label: 'Inbound (calls come in)' },
      { value: 'outbound', label: 'Outbound (calls go out)' }
    ],
    help: 'Changing it makes a new trunk (the old one is deleted).'
  },
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    pattern: '^.{1,128}$'
  },
  {
    key: 'numbers',
    label: 'Phone numbers',
    kind: 'list',
    items: { key: 'number', label: 'Number', kind: 'string', pattern: '^\\+?[0-9]{3,20}$' },
    help: 'Numbers this trunk answers (inbound) or calls from (outbound), like +15105550100.'
  },
  {
    key: 'allowed_addresses',
    label: 'Allowed addresses (inbound)',
    kind: 'list',
    items: { key: 'address', label: 'Address or CIDR', kind: 'string' },
    help: 'Only these IP addresses or ranges may call in. Empty lets any address in, which is only safe with a username and password.'
  },
  {
    key: 'allowed_numbers',
    label: 'Allowed caller numbers (inbound)',
    kind: 'list',
    items: { key: 'number', label: 'Number', kind: 'string', pattern: '^\\+?[0-9]{3,20}$' }
  },
  {
    key: 'address',
    label: 'Provider address (outbound)',
    kind: 'string',
    pattern: '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$',
    help: 'The SIP provider host calls go out through, like sip.example.com.'
  },
  { key: 'auth_username', label: 'SIP username', kind: 'string', pattern: '^.{0,128}$' },
  {
    key: 'auth_password',
    label: 'SIP password',
    kind: 'secret',
    help: 'Write-only. LiveKit does not show it again.'
  }
]

const SIP_WRITABLE = [
  'name',
  'numbers',
  'allowed_addresses',
  'allowed_numbers',
  'address',
  'auth_username'
]

// ── Planning helpers ──

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    const w = want[k]
    const h = have[k]
    const same = Array.isArray(w) || Array.isArray(h) ? sameList(w, h) : norm(w) === norm(h)
    if (!same)
      out.push({
        field: k,
        from: Array.isArray(h) ? strList(h) : norm(h),
        to: Array.isArray(w) ? strList(w) : norm(w)
      })
  }
  return out
}

const isOn = (v: unknown) => v === true

// ── livekit.project (adopt only) ──

function planProject(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired && !observed) return []
  if (!observed)
    throw notSupported(
      'LiveKit Cloud projects cannot be made by API. Make the project in the LiveKit dashboard and adopt it.'
    )
  return []
}

// ── livekit.api_key (pasted once, sealed) ──

function keyOutputs(host: string, key: string, secret: string): Record<string, string> {
  return { api_key: key, api_secret: secret, url: wsUrlOf(host) }
}

function keyObserved(ctx: ProviderContext, id: string): Observed {
  const host = hostOf(ctx)
  return {
    type: T.apiKey,
    externalId: id,
    name: id,
    fields: { api_key: id },
    tags: {},
    version: null,
    status: 'registered',
    url: consoleUrl(host)
  }
}

function planApiKey(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'LiveKit API key'
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T.apiKey,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Forget ${typedName(label, observed.name)} in the Hub. Nothing is deleted at LiveKit: the key keeps working until it is deleted in the LiveKit dashboard, and what it was bound to keeps its copy.`,
        changes: [],
        preconditions: {},
        risk: []
      }
    ]
  }
  const secret = desired.fields.api_secret as SecretValue | undefined
  const key = String(desired.fields.api_key ?? '').trim()
  if (!observed) {
    return [
      {
        kind: 'create',
        type: T.apiKey,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Check ${typedName(label, key)} against this LiveKit project and seal it. Nothing is created at LiveKit; bind its outputs to the app's huddle settings to turn huddles on.`,
        changes: [
          { field: 'api_key', to: key },
          { field: 'api_secret', secret: true }
        ],
        preconditions: {},
        risk: []
      }
    ]
  }
  const changes: FieldChange[] = []
  if (key && key !== observed.fields.api_key)
    changes.push({ field: 'api_key', from: observed.fields.api_key, to: key })
  if (secret?.changed) changes.push({ field: 'api_secret', secret: true })
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: T.apiKey,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Check the pasted ${fieldWords(KEY_FIELDS, changes)} for ${typedName(label, observed.name)} against this LiveKit project and replace the sealed copy.`,
      changes,
      preconditions: { api_key: observed.fields.api_key },
      risk: []
    }
  ]
}

/** Proves a pasted key pair works for this project (a list-rooms call signed with it). */
async function verifyPasted(ctx: ProviderContext, key: string, secret: string): Promise<void> {
  if (!KEY_ID.test(key))
    throw new ProviderError('INVALID_FIELDS', 'The API key has the wrong shape.')
  if (!secret.trim()) throw new ProviderError('INVALID_FIELDS', 'Paste the API secret.')
  try {
    await livekitCall(ctx, ROOM_SERVICE, 'ListRooms', {}, ROOM_LIST, {
      key: { apiKey: key, apiSecret: secret },
      extraScrub: [secret]
    })
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403))
      throw new ProviderError(
        'KEY_NOT_ACCEPTED',
        'This LiveKit project did not accept that key and secret. Check both were copied whole and belong to this project.',
        { retryable: false, status: err.status }
      )
    throw err
  }
}

async function applyApiKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') return ok(op.externalId, null, { forgotten: true })
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to register.')
  const key = String(desired.fields.api_key ?? '').trim()
  const secret = (desired.fields.api_secret as SecretValue | undefined)?.plain ?? ''
  if (op.kind === 'update' && op.externalId && !secret && key === op.externalId)
    return ok(op.externalId, keyObserved(ctx, op.externalId), { already: 'matches' })
  if (!secret) throw new ProviderError('INVALID_FIELDS', 'Paste the API secret.')
  await verifyPasted(ctx, key, secret)
  return ok(key, keyObserved(ctx, key), { verified: true }, keyOutputs(hostOf(ctx), key, secret))
}

// ── livekit.room (read + close) ──

function planRoom(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) return []
  if (!observed)
    throw notSupported(
      'A room is made by the app when a huddle starts, not here. Adopt a live one.'
    )
  if (!isOn(desired.fields.close)) return []
  return [
    {
      kind: 'update',
      type: T.room,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      action: 'close',
      reason: `Close ${typedName('LiveKit room', observed.name)}: ${observed.fields.participants ?? 0} connected ${observed.fields.participants === 1 ? 'person is' : 'people are'} disconnected and the room ends. A new huddle makes a new room.`,
      changes: [{ field: 'close', from: false, to: true }],
      preconditions: { name: observed.fields.name },
      data: { room: observed.externalId },
      risk: []
    }
  ]
}

async function applyRoomClose(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (!desired?.externalId || op.externalId !== desired.externalId) throw targetMismatch('room')
  const room = roomId(desired.externalId)
  // op.data is compared, never sent.
  if (op.data && op.data.room !== undefined && op.data.room !== room) throw targetMismatch('room')
  const have = await readRoom(ctx, room)
  if (!have) return ok(room, null, { already: 'closed' })
  await livekitCall(ctx, ROOM_SERVICE, 'DeleteRoom', { room }, roomGrant(room), { allow: [404] })
  return ok(room, null, { closed: true })
}

// ── livekit.egress (read + stop) ──

function planEgress(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) return []
  if (!observed)
    throw notSupported('An egress is started by the app or LiveKit, not here. Adopt a live one.')
  if (!isOn(desired.fields.stop)) return []
  const status = String(observed.fields.status ?? '')
  if (!egressLive(status)) return []
  return [
    {
      kind: 'update',
      type: T.egress,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      action: 'stop',
      reason: `Stop ${typedName('LiveKit egress', observed.name)}: the recording or stream ends now and its output is finalised.`,
      changes: [{ field: 'stop', from: false, to: true }],
      preconditions: { id: observed.fields.id, status },
      data: { egress_id: observed.externalId },
      risk: []
    }
  ]
}

async function applyEgressStop(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (!desired?.externalId || op.externalId !== desired.externalId) throw targetMismatch('egress')
  const id = egressId(desired.externalId)
  if (op.data && op.data.egress_id !== undefined && op.data.egress_id !== id)
    throw targetMismatch('egress')
  const have = await readEgress(ctx, id)
  if (!have) return ok(id, null, { already: 'gone' })
  if (!egressLive(String(have.fields.status))) return ok(id, have, { already: 'ended' })
  await livekitCall(ctx, EGRESS_SERVICE, 'StopEgress', { egress_id: id }, EGRESS_ADMIN, {
    allow: [404]
  })
  return ok(id, await readEgress(ctx, id), { stopped: true })
}

// ── livekit.sip_trunk ──

const directionOf = (f: Record<string, unknown>): TrunkDirection =>
  f.direction === 'outbound' ? 'outbound' : 'inbound'

/** Inbound with no address limit and no login: reachable by anyone on the internet. */
function openInbound(f: Record<string, unknown>): boolean {
  if (directionOf(f) !== 'inbound') return false
  if (String(f.auth_username ?? '').trim()) return false
  const addrs = strList(f.allowed_addresses)
  if (!addrs.length) return true
  return addrs.some((a) => a === '0.0.0.0/0' || a === '::/0' || /\/0$/.test(a))
}

function validateTrunk(f: Record<string, unknown>, passwordGiven: boolean): void {
  const name = String(f.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The trunk needs a name.')
  const dir = directionOf(f)
  for (const n of [...strList(f.numbers), ...strList(f.allowed_numbers)])
    if (!/^\+?[0-9]{3,20}$/.test(n))
      throw new ProviderError('INVALID_FIELDS', `${n} is not a phone number (digits, optional +).`)
  if (dir === 'inbound') {
    if (String(f.address ?? '').trim())
      throw new ProviderError('INVALID_FIELDS', 'An inbound trunk has no provider address.')
    for (const a of strList(f.allowed_addresses)) {
      const [ip, mask] = a.split('/')
      const maxMask = ip?.includes(':') ? 128 : 32
      if (
        !isIP(ip ?? '') ||
        (mask !== undefined && !(/^\d{1,3}$/.test(mask) && Number(mask) <= maxMask))
      )
        throw new ProviderError('INVALID_FIELDS', `${a} is not an IP address or CIDR range.`)
    }
  } else {
    if (!String(f.address ?? '').trim())
      throw new ProviderError('INVALID_FIELDS', 'An outbound trunk needs the provider address.')
    if (strList(f.allowed_addresses).length || strList(f.allowed_numbers).length)
      throw new ProviderError(
        'INVALID_FIELDS',
        'Allowed addresses and numbers are for inbound trunks.'
      )
  }
  if (String(f.auth_username ?? '').trim() && !passwordGiven)
    throw new ProviderError('INVALID_FIELDS', 'A SIP username needs a SIP password.')
}

function trunkInfo(f: Record<string, unknown>, password: string | null): Record<string, unknown> {
  const dir = directionOf(f)
  const info: Record<string, unknown> = {
    name: String(f.name ?? '').trim(),
    numbers: strList(f.numbers)
  }
  if (dir === 'inbound') {
    info.allowed_addresses = strList(f.allowed_addresses)
    info.allowed_numbers = strList(f.allowed_numbers)
  } else info.address = String(f.address ?? '').trim()
  const user = String(f.auth_username ?? '').trim()
  if (user) info.auth_username = user
  if (password) info.auth_password = password
  return info
}

function planTrunk(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'SIP trunk'
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T.sip,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(label, observed.name)}. Calls on its numbers stop being routed.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    const shown = ['direction', ...SIP_WRITABLE].filter((k) => {
      const v = desired.fields[k]
      return Array.isArray(v) ? v.length > 0 : norm(v) !== null
    })
    const open = openInbound(desired.fields)
    return [
      {
        kind: 'create',
        type: T.sip,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(`${directionOf(desired.fields)} ${label}`, String(desired.fields.name ?? ''))}.${open ? ' It has no address limit and no login, so anyone on the internet can send calls to it.' : ''}`,
        changes: shown.map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  if (directionOf(desired.fields) !== observed.fields.direction && desired.fields.direction)
    return [
      {
        kind: 'replace',
        type: T.sip,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(label, observed.name)}: ${fieldWords(SIP_FIELDS, ['direction'])} cannot change in place, so the trunk is deleted and a new one is made.`,
        changes: [
          { field: 'direction', from: observed.fields.direction, to: desired.fields.direction }
        ],
        preconditions: { direction: observed.fields.direction, name: observed.fields.name },
        risk: []
      }
    ]
  const changes = diffFields(SIP_WRITABLE, desired.fields, observed.fields)
  const pw = desired.fields.auth_password as SecretValue | undefined
  if (pw?.changed) changes.push({ field: 'auth_password', secret: true })
  if (!changes.length) return []
  const pre: Record<string, unknown> = {}
  for (const c of changes) if (!c.secret) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: T.sip,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${fieldWords(SIP_FIELDS, changes)} on ${typedName(label, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

async function createTrunk(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const f = desired.fields
  const password = (f.auth_password as SecretValue | undefined)?.plain ?? null
  const scrubs = password ? [password] : []
  if (desired.externalId) {
    // A resumed create already has its provider id on the row: just read it back.
    const seen = await readTrunk(ctx, desired.externalId)
    if (seen) return ok(desired.externalId, seen, { already: 'exists' })
  }
  validateTrunk(f, !!password)
  const name = String(f.name ?? '').trim()
  if ((await listTrunksRaw(ctx)).some((x) => x.t.name === name))
    throw alreadyExists('SIP trunk', name)
  const dir = directionOf(f)
  const r = await livekitCall(
    ctx,
    SIP_SERVICE,
    dir === 'inbound' ? 'CreateSIPInboundTrunk' : 'CreateSIPOutboundTrunk',
    { trunk: trunkInfo(f, password) },
    SIP_ADMIN,
    { extraScrub: scrubs }
  )
  const id = pick(r.body, 'sip_trunk_id', 'sipTrunkId')
  if (!id) throw new ProviderError('PROVIDER_REJECTED', 'LiveKit did not return the new trunk.')
  return ok(String(id), trunkObserved(dir, r.body, hostOf(ctx)), { created: true })
}

async function updateTrunk(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  const id = trunkId(op.externalId)
  const have = await readTrunk(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The trunk no longer exists.', { status: 404 })
  const dir = have.fields.direction as TrunkDirection
  const f: Record<string, unknown> = { ...desired.fields, direction: dir }
  const pw = f.auth_password as SecretValue | undefined
  const password = pw?.changed && pw.plain ? pw.plain : null
  validateTrunk(f, !!password || !!have.fields.auth_username)
  const diff = diffFields(SIP_WRITABLE, f, have.fields)
  if (!diff.length && !password) return ok(id, have, { already: 'matches' })
  const update: Record<string, unknown> = {}
  for (const c of diff) {
    if (c.field === 'name') update.name = String(c.to ?? '')
    else if (c.field === 'address') update.address = String(c.to ?? '')
    else if (c.field === 'auth_username') update.auth_username = String(c.to ?? '')
    else update[c.field] = { set: strList(c.to) }
  }
  if (password) update.auth_password = password
  await livekitCall(
    ctx,
    SIP_SERVICE,
    dir === 'inbound' ? 'UpdateSIPInboundTrunk' : 'UpdateSIPOutboundTrunk',
    { sip_trunk_id: id, update },
    SIP_ADMIN,
    { extraScrub: password ? [password] : [] }
  )
  return ok(id, await readTrunk(ctx, id), { changed: diff.map((c) => c.field) })
}

async function deleteTrunk(ctx: ProviderContext, id: string): Promise<void> {
  await livekitCall(ctx, SIP_SERVICE, 'DeleteSIPTrunk', { sip_trunk_id: trunkId(id) }, SIP_ADMIN, {
    allow: [404]
  })
}

async function applyTrunk(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createTrunk(ctx, desired)
  }
  if (op.kind === 'delete') {
    const id = op.externalId as string
    await deleteTrunk(ctx, id)
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'replace') {
    await deleteTrunk(ctx, op.externalId as string)
    return createTrunk(ctx, { ...desired, externalId: null })
  }
  return updateTrunk(ctx, op, desired)
}

// ── Types ──

const noCaps = {
  create: false,
  update: false,
  delete: false,
  adopt: false,
  snapshot: false,
  tag: false
}

const TYPES: ResourceTypeSpec[] = [
  {
    key: T.project,
    label: 'LiveKit project',
    scope: 'shared',
    nameField: 'url',
    fields: READ_ONLY_PROJECT,
    capabilities: { ...noCaps, adopt: true },
    reversible: false,
    refs: [],
    risk: () => []
  },
  {
    key: T.apiKey,
    label: 'LiveKit API key',
    scope: 'app',
    nameField: 'api_key',
    fields: KEY_FIELDS,
    capabilities: { ...noCaps, create: true, update: true, delete: true },
    reversible: false,
    refs: [],
    outputs: [
      { key: 'api_key', label: 'LiveKit API key', secret: true },
      { key: 'api_secret', label: 'LiveKit API secret', secret: true, onceOnly: true },
      { key: 'url', label: 'LiveKit server URL', secret: false }
    ],
    risk: () => []
  },
  {
    key: T.room,
    label: 'LiveKit room',
    scope: 'app',
    nameField: 'name',
    fields: ROOM_FIELDS,
    capabilities: { ...noCaps, update: true, adopt: true },
    reversible: false,
    refs: [],
    risk(op) {
      return op.action === 'close' ? ['destructive'] : []
    }
  },
  {
    key: T.egress,
    label: 'LiveKit egress',
    scope: 'app',
    nameField: 'id',
    fields: EGRESS_FIELDS,
    capabilities: { ...noCaps, update: true, adopt: true },
    reversible: false,
    refs: [],
    risk(op) {
      return op.action === 'stop' ? ['downtime'] : []
    }
  },
  {
    key: T.sip,
    label: 'SIP trunk',
    scope: 'app',
    nameField: 'name',
    fields: SIP_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    risk(op, desired) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      // Judged on what is SENT: an inbound trunk with no address limit and no login is open to
      // the whole internet.
      if (desired && op.kind !== 'delete' && openInbound(desired.fields))
        out.push('public_exposure')
      return out
    }
  }
]

const TYPE_KEYS = new Set<string>(Object.values(T))

function known(type: unknown): string {
  if (typeof type !== 'string' || !TYPE_KEYS.has(type))
    throw new ProviderError('UNKNOWN_TYPE', `LiveKit has no ${String(type)}.`)
  return type
}

// ── The adapter ──

export const livekitAdapter: ProviderAdapter = {
  key: 'livekit',
  label: 'LiveKit Cloud',
  connection: {
    fields: [
      {
        key: 'url',
        label: 'Project URL',
        kind: 'string',
        required: true,
        placeholder: 'wss://my-project-abc123.livekit.cloud',
        help: 'The project’s server URL from LiveKit Cloud, Settings. It must be a *.livekit.cloud address.'
      },
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'string',
        required: true,
        placeholder: 'APIxxxxxxxxxxx',
        help: 'The key name (not the secret) of a key the Hub may use to read and manage the project.'
      },
      {
        key: 'apiSecret',
        label: 'API secret',
        kind: 'string',
        secret: true,
        required: true,
        help: 'The matching secret. LiveKit shows it once, when the key is made.'
      }
    ],
    hosts(config) {
      const h = projectHost(config)
      return h ? [h] : []
    },
    describe(config) {
      return `LiveKit ${projectHost(config) ?? 'project'}`
    },
    validate(config, secrets) {
      const problems: string[] = []
      if (!projectHost(config))
        problems.push(
          'The project URL must be https or wss on a *.livekit.cloud host, with no port, path or login.'
        )
      if (!KEY_ID.test(String(config.apiKey ?? '').trim()))
        problems.push('The API key does not look like a LiveKit key name.')
      if (secrets.apiSecret !== undefined && !secrets.apiSecret.trim())
        problems.push('The API secret is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const need = [
      { type: T.room, need: 'list and close rooms' },
      { type: T.egress, need: 'list and stop egress' },
      { type: T.sip, need: 'manage SIP trunks (SIP must be on for the project)' }
    ]
    const result = (has: boolean[]) =>
      need.map((n, i) => ({ type: n.type, need: n.need, has: has[i] === true }))
    let rooms: any[]
    try {
      rooms = await listRoomsRaw(ctx)
    } catch (err) {
      if (err instanceof ProviderError) {
        const permissions = result([false, false, false])
        return {
          ok: false,
          identity: null,
          permissions,
          missing: permissions.map((p) => p.need),
          message: ctx.scrub(err.message)
        }
      }
      throw err
    }
    const probe = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
        return true
      } catch (err) {
        if (err instanceof ProviderError && err.status && err.status < 500 && err.status !== 429)
          return false
        throw err
      }
    }
    const has = [
      true,
      await probe(() => listEgressRaw(ctx, {})),
      await probe(() => listTrunksRaw(ctx))
    ]
    const permissions = result(has)
    return {
      ok: true,
      identity: `LiveKit project ${hostOf(ctx)} · ${rooms.length} room${rooms.length === 1 ? '' : 's'} open`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  async observe(ctx, type, externalId) {
    switch (known(type)) {
      case T.project:
        return readProject(ctx, externalId)
      case T.apiKey: {
        const id = safeValue(externalId, 'API key', 64)
        // The project must be reachable; LiveKit has no read for a key itself.
        await listRoomsRaw(ctx)
        return keyObserved(ctx, id)
      }
      case T.room:
        return readRoom(ctx, externalId)
      case T.egress:
        return readEgress(ctx, externalId)
      default:
        return readTrunk(ctx, externalId)
    }
  },

  async list(ctx, type): Promise<ListPage> {
    const host = hostOf(ctx)
    switch (known(type)) {
      case T.project: {
        const one = await readProject(ctx, host)
        return { items: one ? [one] : [], cursor: null }
      }
      case T.apiKey:
        // A key's secret cannot be read back, so there is nothing to adopt: paste it instead.
        return { items: [], cursor: null }
      case T.room:
        return { items: (await listRoomsRaw(ctx)).map((r) => roomObserved(r, host)), cursor: null }
      case T.egress:
        return {
          items: (await listEgressRaw(ctx, { active: true })).map((e) => egressObserved(e, host)),
          cursor: null
        }
      default:
        return {
          items: (await listTrunksRaw(ctx)).map((x) => trunkObserved(x.direction, x.t, host)),
          cursor: null
        }
    }
  },

  /** Plan time: a trunk of that name already in the project. */
  async findExisting(ctx, type, desired) {
    if (type !== T.sip || desired.externalId) return null
    const name = String(desired.fields.name ?? '').trim()
    if (!name) return null
    const hit = (await listTrunksRaw(ctx)).find((x) => x.t.name === name)
    return hit ? trunkObserved(hit.direction, hit.t, hostOf(ctx)) : null
  },

  plan(_ctx, desired, observed) {
    if (!desired && !observed) return []
    switch (known(desired?.type ?? observed?.type)) {
      case T.project:
        return planProject(desired, observed)
      case T.apiKey:
        return planApiKey(desired, observed)
      case T.room:
        return planRoom(desired, observed)
      case T.egress:
        return planEgress(desired, observed)
      default:
        return planTrunk(desired, observed)
    }
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    switch (known(op.type)) {
      case T.project:
        throw notSupported('A LiveKit project is adopted, never changed by the Hub.')
      case T.apiKey:
        return applyApiKey(ctx, op, desired)
      case T.room:
        if (op.action === 'close') return applyRoomClose(ctx, op, desired)
        throw notSupported('A room only has the close action.')
      case T.egress:
        if (op.action === 'stop') return applyEgressStop(ctx, op, desired)
        throw notSupported('An egress only has the stop action.')
      default:
        return applyTrunk(ctx, op, desired)
    }
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    known(type)
    try {
      if (type === T.project) {
        const seen = await readProject(ctx, externalId)
        if (!seen)
          return { status: 'down', message: 'This is not the connection’s project.', checkedAt }
        return {
          status: 'ok',
          checkedAt,
          details: {
            rooms: Number(seen.fields.rooms ?? 0),
            participants: Number(seen.fields.participants ?? 0),
            reachable: true
          }
        }
      }
      const seen = await this.observe(ctx, type, externalId)
      if (!seen) return { status: 'down', message: 'It is gone at LiveKit.', checkedAt }
      if (type === T.room)
        return {
          status: 'ok',
          checkedAt,
          details: { participants: Number(seen.fields.participants ?? 0) }
        }
      if (type === T.egress) {
        const status = String(seen.fields.status ?? '')
        const bad = status === 'failed' || status === 'aborted' || status === 'limit_reached'
        return {
          status: bad ? 'warn' : 'ok',
          ...(bad ? { message: `The egress ${status.replace('_', ' ')}.` } : {}),
          checkedAt,
          details: { status }
        }
      }
      return { status: 'ok', checkedAt }
    } catch (err) {
      if (err instanceof ProviderError)
        return { status: 'down', message: ctx.scrub(err.message), checkedAt }
      throw err
    }
  }
}
