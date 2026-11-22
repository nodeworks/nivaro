/**
 * Stack operations: apply, status, restart, remove, list. The only code that
 * changes a Docker host, and only through the allow-listed Engine client.
 *
 * Ownership (Decision 4), judged from a fresh read BEFORE any write:
 * - a stack is the services named `<stack>_*` or labelled with the stack's
 *   namespace; if ANY of them lacks `nivaro.hub.managed=1` the stack is not
 *   ours: 409 STACK_NOT_HUB for every route (EFP's `efp` stack, say);
 * - managed objects labelled for another app / shared key / environment:
 *   409 STACK_OWNER_MISMATCH;
 * - an object squatting one of our names (`nvh_<stack>`, `nvh_<stack>_*`)
 *   without our labels: STACK_NOT_HUB;
 * - a hostname another stack's Traefik router already serves: 409
 *   HOSTNAME_TAKEN (no cross-stack capture).
 * Only objects that carry the managed label AND an `nvh_<stack>` /
 * `<stack>_` name are ever updated or deleted, always by NAME (the engine
 * guard checks the same names and labels again).
 *
 * Update bodies are always rendered fresh from the StackSpec (network names,
 * never the ids an inspect returns) — restart included: the Hub sends the
 * StackSpec with the restart (ruling P4-16). The live TaskTemplate.ForceUpdate
 * is carried into every update body (after hashing), so an apply after a
 * restart does not restart tasks again.
 *
 * Hashes: the service-level label `nivaro.hub.spec-hash` is the STACK hash
 * (what status compares with `expect`); `nivaro.hub.service-hash` is the hash
 * of one rendered service without it. A service whose own hash is unchanged
 * gets only its service-level labels updated: its task template is identical,
 * so swarm does not restart its tasks. The container labels never carry the
 * stack hash.
 */
import { createHash } from 'node:crypto'
import type { AgentConfig } from './config.js'
import type { Engine } from './engine.js'
import { engineFailed, StackError } from './errors.js'
import {
  type ExtensionDeps,
  ensureExtension,
  registryAuthHeader,
  removeExtensionFolders
} from './extensions.js'
import type { Log } from './log.js'
import {
  isStackName,
  LABEL_APP,
  LABEL_ENV,
  LABEL_MANAGED,
  LABEL_NAMESPACE,
  LABEL_ROLE,
  LABEL_SHARED,
  LABEL_SPEC_HASH,
  ownershipLabels,
  redisVolume,
  secretName,
  specHash,
  uploadsVolume
} from './names.js'
import { type EngineServiceSpec, renderServices } from './render.js'
import type { StackSpec } from './spec.js'

export { StackError } from './errors.js'

export const LABEL_SERVICE_HASH = 'nivaro.hub.service-hash'

type Labels = Record<string, string>
type Obj = Record<string, any>

type ServiceRow = {
  ID: string
  Version?: { Index?: number }
  Spec?: Obj
  PreviousSpec?: Obj
  UpdateStatus?: { State?: string; Message?: string }
  Endpoint?: { Ports?: Array<{ PublishedPort?: number }> }
}
type SecretRow = { ID: string; Spec?: { Name?: string; Labels?: Labels } }
type NetworkRow = { Id?: string; Name?: string; Labels?: Labels }
type VolumeRow = { Name?: string; Labels?: Labels }
type TaskRow = { ServiceID?: string; DesiredState?: string; Status?: { State?: string } }

export type StackDeps = {
  /** The agent's swarm node id (extension placement). */
  nodeId: string
  log?: Log
  sleep?: (ms: number) => Promise<void>
  extension?: ExtensionDeps
  /** Remove retries for objects still in use while tasks shut down. */
  removeAttempts?: number
  removeDelayMs?: number
}

export type ApplyResult = { spec_hash: string; changed: string[]; unchanged: string[] }

export type ServiceUpdateState =
  | 'none'
  | 'updating'
  | 'completed'
  | 'paused'
  | 'rollback_started'
  | 'rollback_completed'
  | 'rollback_paused'

export type StackStatus = {
  name: string
  owner: { app: string } | { shared: string }
  environment: string
  spec_hash: string | null
  image: string | null
  state: 'converged' | 'updating' | 'rolled_back' | 'paused' | 'degraded'
  published_port: number | null
  services: Array<{
    name: string
    role: string
    image: string
    replicas: { desired: number; running: number }
    update: ServiceUpdateState
    message: string | null
  }>
}

export type StackSummary = {
  name: string
  owner: { app: string } | { shared: string }
  environment: string
  image: string | null
  services: number
}

export type RemoveResult = {
  removed: { services: string[]; secrets: string[]; networks: string[]; volumes: string[] }
}

const UPDATE_STATES: readonly ServiceUpdateState[] = [
  'none',
  'updating',
  'completed',
  'paused',
  'rollback_started',
  'rollback_completed',
  'rollback_paused'
]
/** While a service is in one of these, swarm may still roll back to its PreviousSpec. */
const ROLLBACK_POSSIBLE = new Set(['updating', 'paused', 'rollback_started', 'rollback_paused'])
const MESSAGE_MAX = 300
const PINNED_RE = /^(.+)@sha256:[a-f0-9]{64}$/

// ── errors ──────────────────────────────────────────────────────────────

const notHub = () =>
  new StackError(
    409,
    'STACK_NOT_HUB',
    'This stack name is used by services the Hub does not manage'
  )
const notFound = () => new StackError(404, 'STACK_NOT_FOUND', 'No such stack')
const ownerMismatch = () =>
  new StackError(409, 'STACK_OWNER_MISMATCH', 'This stack belongs to another app or environment')

function assertName(name: string): void {
  if (!isStackName(name)) throw new StackError(400, 'STACK_NAME_INVALID', 'Invalid stack name')
}

// ── small helpers ───────────────────────────────────────────────────────

const ok = (status: number) => status >= 200 && status < 300
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (isObj(value)) {
    const out: Obj = {}
    for (const k of Object.keys(value).sort())
      if (value[k] !== undefined) out[k] = canonical(value[k])
    return out
  }
  return value
}

const isManaged = (l: unknown) => isObj(l) && l[LABEL_MANAGED] === '1'
const nameOf = (s: ServiceRow): string => (typeof s.Spec?.Name === 'string' ? s.Spec.Name : '')
const labelsOf = (s: ServiceRow): Labels =>
  isObj(s.Spec?.Labels) ? (s.Spec?.Labels as Labels) : {}

/** A service of `stack`: by name or by namespace label (whoever made it). */
function belongs(s: ServiceRow, stack: string): boolean {
  return nameOf(s).startsWith(`${stack}_`) || labelsOf(s)[LABEL_NAMESPACE] === stack
}

/** `nvh_<stack>` or `nvh_<stack>_…` — a stack name holds no `_`, so never another stack's. */
function objectOfStack(name: unknown, stack: string): name is string {
  return typeof name === 'string' && (name === `nvh_${stack}` || name.startsWith(`nvh_${stack}_`))
}

/** Our own object of this stack: the managed label and the namespace label both say so. */
function ownObject(labels: unknown, stack: string): boolean {
  return isManaged(labels) && (labels as Labels)[LABEL_NAMESPACE] === stack
}

function ownerMatches(labels: Labels, want: Labels): boolean {
  return (
    labels[LABEL_APP] === want[LABEL_APP] &&
    labels[LABEL_SHARED] === want[LABEL_SHARED] &&
    labels[LABEL_ENV] === want[LABEL_ENV]
  )
}

async function read<T>(engine: Engine, path: string, query?: Record<string, string>): Promise<T> {
  const r = await engine.call<T>('GET', path, query ? { query } : {})
  if (r.status !== 200) throw engineFailed()
  return r.body
}

async function listServices(engine: Engine): Promise<ServiceRow[]> {
  const b = await read<unknown>(engine, '/services')
  if (!Array.isArray(b)) throw engineFailed()
  return b.filter((s): s is ServiceRow => isObj(s) && typeof s.ID === 'string')
}

async function listSecrets(engine: Engine): Promise<SecretRow[]> {
  const b = await read<unknown>(engine, '/secrets')
  if (!Array.isArray(b)) throw engineFailed()
  return b.filter((s): s is SecretRow => isObj(s) && typeof s.ID === 'string')
}

async function listNetworks(engine: Engine): Promise<NetworkRow[]> {
  const b = await read<unknown>(engine, '/networks')
  if (!Array.isArray(b)) throw engineFailed()
  return b.filter(isObj) as NetworkRow[]
}

async function listVolumes(engine: Engine): Promise<VolumeRow[]> {
  const b = await read<{ Volumes?: unknown }>(engine, '/volumes')
  const v = isObj(b) ? b.Volumes : null
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) throw engineFailed()
  return v.filter(isObj) as VolumeRow[]
}

/**
 * A stack's services may be touched only when every one of them is ours:
 * managed label, this stack's namespace label AND a `<stack>_` name.
 */
function assertOwnServices(mine: ServiceRow[], stack: string): void {
  for (const s of mine) {
    const l = labelsOf(s)
    if (!isManaged(l) || l[LABEL_NAMESPACE] !== stack || !nameOf(s).startsWith(`${stack}_`))
      throw notHub()
  }
}

/** The managed services of a stack; STACK_NOT_HUB if any service of that name is not ours. */
async function stackServices(engine: Engine, stack: string): Promise<ServiceRow[]> {
  const mine = (await listServices(engine)).filter((s) => belongs(s, stack))
  assertOwnServices(mine, stack)
  return mine.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
}

function ownerOf(l: Labels): StackStatus['owner'] {
  if (l[LABEL_APP]) return { app: l[LABEL_APP] }
  if (l[LABEL_SHARED]) return { shared: l[LABEL_SHARED] }
  return { app: '' }
}

function imageOf(s: ServiceRow | Obj | undefined): string {
  const img = (s as Obj | undefined)?.Spec?.TaskTemplate?.ContainerSpec?.Image
  return typeof img === 'string' ? img : ''
}

/** The Nivaro service a stack summary reports (web, else all, else any but redis). */
function mainService(services: ServiceRow[]): ServiceRow | undefined {
  const role = (s: ServiceRow) => labelsOf(s)[LABEL_ROLE]
  return (
    services.find((s) => role(s) === 'web') ??
    services.find((s) => role(s) === 'all') ??
    services.find((s) => role(s) !== 'redis')
  )
}

/** The Traefik router rules among a service's labels, lower-cased. */
function routerRules(labels: Labels): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(labels)) {
    if (/^traefik\.http\.routers\..+\.rule$/i.test(k) && typeof v === 'string')
      out.push(v.toLowerCase())
  }
  return out
}

/**
 * Hostnames named by `Host(...)` / `HostHeader(...)` in a rule, with
 * backtick or double-quoted arguments (`\"` escapes included).
 */
export function ruleHosts(rule: string): string[] {
  const out: string[] = []
  for (const m of rule.matchAll(
    /\bHost(?:Header)?\s*\(((?:[^()"`]|"(?:[^"\\]|\\.)*"|`[^`]*`)*)\)/gi
  )) {
    for (const a of m[1].matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)) {
      const raw = a[1] ?? (a[2] ?? '').replace(/\\(.)/g, '$1')
      const h = raw.trim().toLowerCase()
      if (h) out.push(h)
    }
  }
  return out
}

/**
 * Is `host` served by one of these rules? Parsed hosts first; then, failing
 * closed, any rule that merely CONTAINS the name (a rule syntax the parser
 * does not know must not let a stack capture it).
 */
function hostTaken(host: string, rules: string[]): boolean {
  const h = host.toLowerCase()
  return rules.some((r) => ruleHosts(r).includes(h) || r.includes(h))
}

function secretRefs(spec: Obj | undefined): string[] {
  const refs = spec?.TaskTemplate?.ContainerSpec?.Secrets
  if (!Array.isArray(refs)) return []
  const out: string[] = []
  for (const r of refs) {
    if (typeof r?.SecretName === 'string') out.push(r.SecretName)
    if (typeof r?.SecretID === 'string') out.push(r.SecretID)
  }
  return out
}

function repoOfImage(image: string): string | null {
  const m = PINNED_RE.exec(image)
  return m ? m[1] : null
}

// ── hashes ──────────────────────────────────────────────────────────────

/**
 * The stack hash answered as `spec_hash` and stamped on every service: the
 * spec hash (secret values replaced by keyed digests) plus every agent setting
 * that changes what is rendered — edge mode and network, entrypoints, cert
 * resolver, redis image, volume driver and options, the extension root and
 * placement. A config change therefore re-applies (ruling P4-5).
 */
export function stackHash(spec: StackSpec, cfg: AgentConfig, nodeId: string): string {
  const pinned = Object.keys(spec.extensions).length > 0 && !cfg.extensionsShared
  const agent = {
    edge: cfg.edge,
    edgeNetwork: cfg.edgeNetwork,
    entrypoints: cfg.entrypoints,
    certResolver: cfg.certResolver ?? null,
    redisImage: cfg.redisImage,
    volumeDriver: cfg.volumeDriver,
    volumeOpts: cfg.volumeOpts,
    extensionsShared: cfg.extensionsShared,
    extensionsHostRoot: cfg.extensionsHostRoot,
    node: pinned ? nodeId : null
  }
  return sha256(JSON.stringify(canonical({ v: 1, spec: specHash(spec, cfg.hmacKey), agent })))
}

/** Container labels lose the stack hash; the service gains its own hash. */
function finalize(svc: EngineServiceSpec): EngineServiceSpec {
  const out = structuredClone(svc)
  delete out.TaskTemplate.ContainerSpec.Labels[LABEL_SPEC_HASH]
  const forHash = structuredClone(out) as Obj
  delete forHash.Labels[LABEL_SPEC_HASH]
  out.Labels[LABEL_SERVICE_HASH] = sha256(JSON.stringify(canonical(forHash)))
  return out
}

// ── engine writes ───────────────────────────────────────────────────────

async function updateService(
  engine: Engine,
  body: Obj,
  version: number | undefined,
  auth: string | undefined
): Promise<void> {
  const name = body.Name as string
  const send = (v: number) =>
    engine.call<{ message?: string }>('POST', `/services/${name}/update`, {
      query: { version: v },
      body,
      ...(auth ? { headers: { 'X-Registry-Auth': auth } } : {})
    })
  if (typeof version !== 'number') throw engineFailed()
  let r = await send(version)
  // Someone (swarm itself, mid-rollback) moved the version on: read it once more and retry once.
  if (!ok(r.status) && /out of sequence/i.test(String(r.body?.message ?? ''))) {
    const fresh = await read<ServiceRow>(engine, `/services/${name}`)
    if (!isObj(fresh) || typeof fresh.Version?.Index !== 'number') throw engineFailed()
    r = await send(fresh.Version.Index)
  }
  if (!ok(r.status)) throw engineFailed()
}

async function createService(engine: Engine, body: Obj, auth: string | undefined): Promise<void> {
  const r = await engine.call('POST', '/services/create', {
    body,
    ...(auth ? { headers: { 'X-Registry-Auth': auth } } : {})
  })
  if (!ok(r.status)) throw engineFailed()
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** DELETE by name; retried while the object is still in use. True = removed, false = already gone. */
async function removeObject(
  engine: Engine,
  path: string,
  deps: Partial<StackDeps>
): Promise<boolean> {
  const attempts = deps.removeAttempts ?? 15
  const delay = deps.removeDelayMs ?? 2000
  const sleep = deps.sleep ?? defaultSleep
  for (let i = 0; i < attempts; i++) {
    const r = await engine.call('DELETE', path)
    if (ok(r.status)) return true
    if (r.status === 404) return false
    // Only "still in use" waits (400 secret in use, 403 network endpoints, 409 volume in use).
    if (![400, 403, 409].includes(r.status)) throw engineFailed()
    await sleep(delay)
  }
  throw engineFailed()
}

/**
 * Delete this stack's managed secrets that nothing references any more. A
 * service's PreviousSpec counts while swarm may still roll back to it (an
 * update runs, or this apply just started one). "In use" and other refusals
 * are left for the next apply.
 */
async function pruneSecrets(
  engine: Engine,
  stack: string,
  updated: Set<string>,
  log?: Log
): Promise<void> {
  const services = await listServices(engine)
  const referenced = new Set<string>()
  for (const s of services) {
    for (const r of secretRefs(s.Spec)) referenced.add(r)
    const state = s.UpdateStatus?.State ?? ''
    if (updated.has(nameOf(s)) || ROLLBACK_POSSIBLE.has(state)) {
      for (const r of secretRefs(s.PreviousSpec)) referenced.add(r)
    }
  }
  for (const sec of await listSecrets(engine)) {
    const n = sec.Spec?.Name
    if (!objectOfStack(n, stack) || n === `nvh_${stack}`) continue
    if (!ownObject(sec.Spec?.Labels, stack)) continue
    if (referenced.has(n) || referenced.has(sec.ID)) continue
    const r = await engine.call('DELETE', `/secrets/${n}`)
    if (!ok(r.status) && r.status !== 404) {
      log?.({
        t: new Date().toISOString(),
        level: 'warn',
        op: 'prune-secret',
        stack,
        status: r.status
      })
    }
  }
}

// ── apply ───────────────────────────────────────────────────────────────

type Survey = {
  owner: Labels
  network: string
  mine: ServiceRow[]
  myNetwork: NetworkRow[]
  myVolumes: VolumeRow[]
  mySecrets: SecretRow[]
}

/**
 * Read everything and judge ownership and hostnames — before any write.
 * Apply and restart both start here.
 */
async function survey(engine: Engine, name: string, spec: StackSpec): Promise<Survey> {
  const owner = ownershipLabels(name, spec)
  const network = `nvh_${name}`
  const services = await listServices(engine)
  const secrets = await listSecrets(engine)
  const networks = await listNetworks(engine)
  const volumes = await listVolumes(engine)

  const mine = services.filter((s) => belongs(s, name))
  assertOwnServices(mine, name)
  const myNetwork = networks.filter((n) => n.Name === network)
  const myVolumes = volumes.filter((v) => objectOfStack(v.Name, name) && v.Name !== network)
  const mySecrets = secrets.filter(
    (s) => objectOfStack(s.Spec?.Name, name) && s.Spec?.Name !== network
  )
  const objectLabels = [
    ...myNetwork.map((n) => n.Labels),
    ...myVolumes.map((v) => v.Labels),
    ...mySecrets.map((s) => s.Spec?.Labels)
  ]
  if (objectLabels.some((l) => !ownObject(l, name))) throw notHub()
  for (const l of [...mine.map(labelsOf), ...(objectLabels as Labels[])]) {
    if (!ownerMatches(l, owner)) throw ownerMismatch()
  }

  const foreignRules: string[] = []
  for (const s of services) if (!belongs(s, name)) foreignRules.push(...routerRules(labelsOf(s)))
  const hostFields = spec.hostnames.flatMap((h, i) =>
    hostTaken(h, foreignRules) ? [{ field: `hostnames[${i}]`, code: 'HOSTNAME_TAKEN' }] : []
  )
  if (hostFields.length > 0) {
    throw new StackError(
      409,
      'HOSTNAME_TAKEN',
      'A hostname is already routed to another stack',
      hostFields
    )
  }
  mine.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  return { owner, network, mine, myNetwork, myVolumes, mySecrets }
}

/** The live TaskTemplate.ForceUpdate of a service (0 when unset). */
function liveForceUpdate(s: ServiceRow): number {
  const v = s.Spec?.TaskTemplate?.ForceUpdate
  return Number.isSafeInteger(v) && v > 0 ? v : 0
}

/** A finalized body with ForceUpdate set — after hashing, so it never changes a hash. */
function withForceUpdate(svc: EngineServiceSpec, forceUpdate: number): Obj {
  const body = structuredClone(svc) as Obj
  if (forceUpdate > 0) body.TaskTemplate.ForceUpdate = forceUpdate
  return body
}

function render(
  name: string,
  spec: StackSpec,
  cfg: AgentConfig,
  deps: StackDeps,
  hash: string,
  network: string,
  secretIds: Record<string, { id: string; name: string }>,
  extensionPaths: Record<string, string>
): EngineServiceSpec[] {
  return renderServices(name, spec, cfg, {
    hash,
    secretIds,
    extensionPaths,
    agentNodeId: deps.nodeId,
    network
  }).map(finalize)
}

async function prepareExtensions(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  spec: StackSpec,
  deps: StackDeps
): Promise<Record<string, string>> {
  const extensionPaths: Record<string, string> = {}
  for (const id of Object.keys(spec.extensions).sort()) {
    extensionPaths[id] = await ensureExtension(
      engine,
      cfg,
      name,
      id,
      spec.extensions[id],
      deps.extension
    )
  }
  return extensionPaths
}

function authFor(cfg: AgentConfig, svc: EngineServiceSpec): string | undefined {
  const repo = repoOfImage(svc.TaskTemplate.ContainerSpec.Image)
  return repo ? registryAuthHeader(cfg, repo) : undefined
}

export async function applyStack(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  spec: StackSpec,
  deps: StackDeps
): Promise<ApplyResult> {
  assertName(name)
  // 1. Read everything, judge ownership and hostnames — before any write.
  const { owner, network, mine, myNetwork, myVolumes, mySecrets } = await survey(engine, name, spec)
  const hash = stackHash(spec, cfg, deps.nodeId)

  // 2. The stack network.
  if (myNetwork.length === 0) {
    const r = await engine.call('POST', '/networks/create', {
      body: { Name: network, Driver: 'overlay', Attachable: false, Labels: { ...owner } }
    })
    if (!ok(r.status)) throw engineFailed()
  }

  // 3. Volumes, with the configured driver and options.
  const wantVolumes = [uploadsVolume(name)]
  if (spec.redis === 'bundled') wantVolumes.push(redisVolume(name))
  for (const v of wantVolumes) {
    if (myVolumes.some((x) => x.Name === v)) continue
    const r = await engine.call('POST', '/volumes/create', {
      body: {
        Name: v,
        Driver: cfg.volumeDriver,
        DriverOpts: { ...cfg.volumeOpts },
        Labels: { ...owner }
      }
    })
    if (!ok(r.status)) throw engineFailed()
  }

  // 4. Secrets: one swarm secret per name (a changed value = a new name).
  const existing = new Map<string, string>()
  for (const s of mySecrets) if (s.Spec?.Name) existing.set(s.Spec.Name, s.ID)
  const secretIds: Record<string, { id: string; name: string }> = {}
  for (const key of Object.keys(spec.secrets).sort()) {
    const value = spec.secrets[key]
    const sn = secretName(name, key, value, cfg.hmacKey)
    let id = existing.get(sn)
    if (!id) {
      const r = await engine.call<{ ID?: unknown }>('POST', '/secrets/create', {
        body: {
          Name: sn,
          Labels: { ...owner },
          Data: Buffer.from(value, 'utf8').toString('base64')
        }
      })
      if (!ok(r.status) || typeof r.body?.ID !== 'string') throw engineFailed()
      id = r.body.ID
      existing.set(sn, id)
    }
    secretIds[key] = { id, name: sn }
  }

  // 5. Extensions: unpacked folders on the host.
  const extensionPaths = await prepareExtensions(engine, cfg, name, spec, deps)

  // 6. Services, rendered fresh.
  const rendered = render(name, spec, cfg, deps, hash, network, secretIds, extensionPaths)
  const current = new Map(mine.map((s) => [nameOf(s), s]))
  const changed: string[] = []
  const unchanged: string[] = []
  const updated = new Set<string>()
  for (const svc of rendered) {
    const auth = authFor(cfg, svc)
    const cur = current.get(svc.Name)
    if (!cur) {
      await createService(engine, svc, auth)
      changed.push(svc.Name)
      continue
    }
    const labels = labelsOf(cur)
    const sameService = labels[LABEL_SERVICE_HASH] === svc.Labels[LABEL_SERVICE_HASH]
    if (sameService && labels[LABEL_SPEC_HASH] === hash) {
      unchanged.push(svc.Name)
      continue
    }
    // Keep the live ForceUpdate (a restart raised it): sending 0 back would restart the tasks.
    const body = withForceUpdate(svc, liveForceUpdate(cur))
    await updateService(engine, body, cur.Version?.Index, auth)
    updated.add(svc.Name)
    ;(sameService ? unchanged : changed).push(svc.Name)
  }

  // 7. Services no longer rendered (a large → small change).
  const keep = new Set(rendered.map((s) => s.Name))
  for (const s of mine) {
    const n = nameOf(s)
    if (keep.has(n)) continue
    const r = await engine.call('DELETE', `/services/${n}`)
    if (!ok(r.status) && r.status !== 404) throw engineFailed()
    changed.push(n)
  }

  // 8. Old secrets nothing needs any more.
  await pruneSecrets(engine, name, updated, deps.log)

  return { spec_hash: hash, changed: changed.sort(), unchanged: unchanged.sort() }
}

// ── restart ─────────────────────────────────────────────────────────────

const specMismatch = () =>
  new StackError(
    409,
    'SPEC_MISMATCH',
    'The stack does not run this spec; apply it instead of restarting'
  )

/**
 * Restart (ruling P4-16): the Hub sends the StackSpec the stack runs. The
 * agent judges it like an apply (ownership, owner, hostnames), renders fresh
 * bodies exactly like apply, and sends each with ForceUpdate = live + 1.
 * It never builds a body from an inspected spec. It creates nothing: when the
 * live stack does not run this spec (another hash, a missing secret or
 * service), it answers 409 SPEC_MISMATCH.
 */
export async function restartStack(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  spec: StackSpec,
  deps: StackDeps
): Promise<{ services: string[] }> {
  assertName(name)
  const { network, mine, mySecrets } = await survey(engine, name, spec)
  if (mine.length === 0) throw notFound()
  const hash = stackHash(spec, cfg, deps.nodeId)
  if (mine.some((s) => labelsOf(s)[LABEL_SPEC_HASH] !== hash)) throw specMismatch()

  const existing = new Map<string, string>()
  for (const s of mySecrets) if (s.Spec?.Name) existing.set(s.Spec.Name, s.ID)
  const secretIds: Record<string, { id: string; name: string }> = {}
  for (const key of Object.keys(spec.secrets).sort()) {
    const sn = secretName(name, key, spec.secrets[key], cfg.hmacKey)
    const id = existing.get(sn)
    if (!id) throw specMismatch()
    secretIds[key] = { id, name: sn }
  }
  const extensionPaths = await prepareExtensions(engine, cfg, name, spec, deps)
  const rendered = render(name, spec, cfg, deps, hash, network, secretIds, extensionPaths)

  const current = new Map(mine.map((s) => [nameOf(s), s]))
  if (rendered.length !== mine.length || rendered.some((svc) => !current.has(svc.Name)))
    throw specMismatch()
  for (const svc of rendered) {
    const cur = current.get(svc.Name) as ServiceRow
    const body = withForceUpdate(svc, liveForceUpdate(cur) + 1)
    await updateService(engine, body, cur.Version?.Index, authFor(cfg, svc))
  }
  return { services: rendered.map((s) => s.Name).sort() }
}

// ── status / list ───────────────────────────────────────────────────────

function updateState(s: ServiceRow): ServiceUpdateState {
  const st = s.UpdateStatus?.State
  if (st === undefined || st === null || st === '') return 'none'
  return (UPDATE_STATES as readonly string[]).includes(st) ? (st as ServiceUpdateState) : 'updating'
}

export async function stackStatus(
  engine: Engine,
  name: string,
  expect?: string | null
): Promise<StackStatus> {
  assertName(name)
  const mine = await stackServices(engine, name)
  if (mine.length === 0) throw notFound()
  const tasksBody = await read<unknown>(engine, '/tasks', {
    filters: JSON.stringify({ service: mine.map((s) => s.ID) })
  })
  const tasks = (Array.isArray(tasksBody) ? tasksBody : []) as TaskRow[]

  const services = mine.map((s) => {
    const l = labelsOf(s)
    const desired = Number(s.Spec?.Mode?.Replicated?.Replicas ?? 0)
    const running = tasks.filter(
      (t) => t.ServiceID === s.ID && t.DesiredState === 'running' && t.Status?.State === 'running'
    ).length
    const msg = s.UpdateStatus?.Message
    return {
      name: nameOf(s),
      role: l[LABEL_ROLE] ?? '',
      image: imageOf(s),
      replicas: { desired: Number.isFinite(desired) ? desired : 0, running },
      update: updateState(s),
      message: typeof msg === 'string' && msg ? msg.slice(0, MESSAGE_MAX) : null
    }
  })

  const hashes = new Set(mine.map((s) => labelsOf(s)[LABEL_SPEC_HASH] ?? ''))
  const specHashNow = hashes.size === 1 ? [...hashes][0] || null : null
  const want = expect ?? specHashNow
  let state: StackStatus['state']
  if (services.some((s) => s.update.startsWith('rollback_'))) state = 'rolled_back'
  else if (
    want &&
    mine.every((s) => labelsOf(s)[LABEL_SPEC_HASH] === want) &&
    services.every(
      (s) =>
        (s.update === 'none' || s.update === 'completed') &&
        s.replicas.running === s.replicas.desired
    )
  )
    state = 'converged'
  else if (services.some((s) => s.update === 'paused')) state = 'paused'
  else if (
    !want ||
    mine.some((s) => labelsOf(s)[LABEL_SPEC_HASH] !== want) ||
    services.some((s) => s.update === 'updating')
  )
    state = 'updating'
  else state = 'degraded'

  const main = mainService(mine)
  const port = main?.Endpoint?.Ports?.find(
    (p) => typeof p?.PublishedPort === 'number'
  )?.PublishedPort
  const first = labelsOf(main ?? mine[0])
  return {
    name,
    owner: ownerOf(first),
    environment: first[LABEL_ENV] ?? '',
    spec_hash: specHashNow,
    image: main ? imageOf(main) || null : null,
    state,
    published_port: typeof port === 'number' ? port : null,
    services
  }
}

/** Hub-managed stacks only; a service without the managed label is never listed. */
export async function listStacks(engine: Engine): Promise<StackSummary[]> {
  const groups = new Map<string, ServiceRow[]>()
  for (const s of await listServices(engine)) {
    const l = labelsOf(s)
    if (!isManaged(l)) continue
    const ns = l[LABEL_NAMESPACE]
    if (!isStackName(ns) || !nameOf(s).startsWith(`${ns}_`)) continue
    groups.set(ns, [...(groups.get(ns) ?? []), s])
  }
  return [...groups.keys()].sort().map((name) => {
    const list = groups.get(name) as ServiceRow[]
    const main = mainService(list)
    const l = labelsOf(main ?? list[0])
    return {
      name,
      owner: ownerOf(l),
      environment: l[LABEL_ENV] ?? '',
      image: main ? imageOf(main) || null : null,
      services: list.length
    }
  })
}

// ── remove ──────────────────────────────────────────────────────────────

/**
 * Services → secrets → network → (volumes, only with the flag) → extension
 * folders. Only managed objects of this stack, by name. Answers the names.
 */
export async function removeStack(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  opts: { removeVolumes: boolean },
  deps: Partial<StackDeps> = {}
): Promise<RemoveResult> {
  assertName(name)
  const mine = await stackServices(engine, name)
  const network = `nvh_${name}`
  const removed: RemoveResult['removed'] = { services: [], secrets: [], networks: [], volumes: [] }

  for (const s of mine) {
    const n = nameOf(s)
    const r = await engine.call('DELETE', `/services/${n}`)
    if (ok(r.status)) removed.services.push(n)
    else if (r.status !== 404) throw engineFailed()
  }

  const secrets = (await listSecrets(engine))
    .map((s) => ({ name: s.Spec?.Name, labels: s.Spec?.Labels }))
    .filter((s) => objectOfStack(s.name, name) && s.name !== network && ownObject(s.labels, name))
    .map((s) => s.name as string)
    .sort()
  for (const n of secrets)
    if (await removeObject(engine, `/secrets/${n}`, deps)) removed.secrets.push(n)

  const ownNetwork = (await listNetworks(engine)).some(
    (n) => n.Name === network && ownObject(n.Labels, name)
  )
  if (ownNetwork && (await removeObject(engine, `/networks/${network}`, deps)))
    removed.networks.push(network)

  if (opts.removeVolumes) {
    const vols = (await listVolumes(engine))
      .filter((v) => objectOfStack(v.Name, name) && v.Name !== network && ownObject(v.Labels, name))
      .map((v) => v.Name as string)
      .sort()
    for (const v of vols)
      if (await removeObject(engine, `/volumes/${v}`, deps)) removed.volumes.push(v)
  }

  await removeExtensionFolders(cfg, name)
  return { removed }
}
