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
 *   HOSTNAME_TAKEN (no cross-stack capture). A shared deployment's host
 *   pattern (phase 6) is not a host claim: its HostRegexp router has
 *   priority=1, so a name another stack routes with Host() is not taken by it,
 *   and hostTaken never reads it as one. Only the SAME pattern rule on another
 *   stack is refused (409 HOSTNAME_TAKEN on host_pattern): two equal priority-1
 *   catch-alls would split traffic.
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
  existingExtension,
  extensionFolderExists,
  registryAuthHeader,
  removeExtensionFolders
} from './extensions.js'
import { ensureUploadsFolder, type FolderFs } from './folders.js'
import { parsePinned } from './image-ref.js'
import type { Log } from './log.js'
import {
  caBundleSecretName,
  isStackName,
  LABEL_APP,
  LABEL_ENV,
  LABEL_HOSTS,
  LABEL_MANAGED,
  LABEL_NAMESPACE,
  LABEL_ROLE,
  LABEL_SHARED,
  LABEL_SPEC_HASH,
  ownershipLabels,
  secretName,
  specHash
} from './names.js'
import { type EngineServiceSpec, patternRule, renderServices } from './render.js'
import type { StackSpec } from './spec.js'
import {
  foldersOverlap,
  folderUnderExport,
  isNfsOpts,
  nfsExport,
  redisConstraint,
  redisVolumeChanged,
  redisVolumeOf,
  redisVolumePlan,
  uploadsVolumePlan,
  type VolumePlan
} from './volumes.js'

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
type VolumeRow = { Name?: string; Labels?: Labels; Options?: Record<string, unknown> | null }
type TaskRow = {
  ServiceID?: string
  DesiredState?: string
  Status?: { State?: string }
  Spec?: { ContainerSpec?: { Labels?: Record<string, string> } }
}

/**
 * Task states before a task has ended: its container may still be running (or starting, or
 * draining after its service was removed). Swarm keeps a removed service's tasks, desired state
 * `remove`, until their containers have stopped; their actual state stays one of these till then.
 */
export const ACTIVE_TASK_STATES: readonly string[] = [
  'new',
  'allocated',
  'pending',
  'assigned',
  'accepted',
  'preparing',
  'ready',
  'starting',
  'running'
]

export type StackDeps = {
  /** The agent's swarm node id (extension placement). */
  nodeId: string
  log?: Log
  sleep?: (ms: number) => Promise<void>
  extension?: ExtensionDeps
  /** The swarm's cluster id (GET /info): the marker that claims a stack folder names it. */
  clusterId?: string
  /** File access to the NFS export mount (stack uploads folders); tests pass a fake. */
  folderFs?: FolderFs
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
  /** 0.2.3: volumes on an NFS export, kept on a remove with volumes (their files are on the share). */
  kept_volumes?: string[]
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

/** The Traefik HTTP and TCP router rules among a service's labels, lower-cased. */
function routerRules(labels: Labels): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(labels)) {
    if (/^traefik\.(?:http|tcp)\.routers\..+\.rule$/i.test(k) && typeof v === 'string')
      out.push(v.toLowerCase())
  }
  return out
}

/**
 * The host claim another stack carries (LABEL_HOSTS: the Hub's GitLab template stacks set it on
 * their web service), as Host rules: a name claimed there is taken here even if that stack
 * routes it some other way.
 */
function hostClaimRules(labels: Labels): string[] {
  const v = labels[LABEL_HOSTS]
  if (typeof v !== 'string') return []
  return v
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .map((h) => `host(\`${h}\`)`)
}

/**
 * Hostnames named by `Host(...)`, `HostHeader(...)` or (TCP) `HostSNI(...)`
 * in a rule, with backtick or double-quoted arguments (`\"` escapes included).
 */
export function ruleHosts(rule: string): string[] {
  const out: string[] = []
  for (const m of rule.matchAll(
    /\bHost(?:Header|SNI)?\s*\(((?:[^()"`]|"(?:[^"\\]|\\.)*"|`[^`]*`)*)\)/gi
  )) {
    for (const a of m[1].matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)) {
      const raw = a[1] ?? (a[2] ?? '').replace(/\\(.)/g, '$1')
      const h = raw.trim().toLowerCase()
      if (h) out.push(h)
    }
  }
  return out
}

/** A character that may be part of a hostname: before the name, it means a longer name. */
const HOST_CHAR = /[a-z0-9.-]/

/**
 * The rule contains `host` where it starts a name: at the start of the rule
 * or after a character no hostname holds (quote, backtick, space, `(`, `,`,
 * `|`, `&`, `\`…). `acme-staging.x` does not contain `staging.x` this way.
 */
function containsAsName(rule: string, host: string): boolean {
  for (let i = rule.indexOf(host); i !== -1; i = rule.indexOf(host, i + 1)) {
    if (i === 0 || !HOST_CHAR.test(rule[i - 1])) return true
  }
  return false
}

/**
 * Is `host` served by one of these rules? Parsed hosts first; then, failing
 * closed, any rule that contains the name at a name boundary (a rule syntax
 * the parser does not know must not let a stack capture it).
 */
export function hostTaken(host: string, rules: string[]): boolean {
  const h = host.toLowerCase()
  return rules.some((r) => ruleHosts(r).includes(h) || containsAsName(r, h))
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
  return parsePinned(image)?.repo ?? null
}

// ── hashes ──────────────────────────────────────────────────────────────

/**
 * The stack hash answered as `spec_hash` and stamped on every service: the
 * spec hash (secret values replaced by keyed digests) plus every agent setting
 * that changes what is rendered — edge mode, network and Traefik version, entrypoints, cert
 * resolver, redis image, volume driver and options, the extension root and
 * placement — and the CA bundle's sha256 when HUB_AGENT_CA_BUNDLE_FILE is set. A config change
 * therefore re-applies (ruling P4-5). Without a bundle the key is left out entirely, so a stack on
 * an agent without one keeps the hash it had before the option existed.
 */
export function stackHash(spec: StackSpec, cfg: AgentConfig, nodeId: string): string {
  const pinned = Object.keys(spec.extensions).length > 0 && !cfg.extensionsShared
  const agent = {
    edge: cfg.edge,
    edgeNetwork: cfg.edgeNetwork,
    // It picks the network label (P6-34), so it is part of what is rendered.
    traefikVersion: cfg.traefikVersion,
    entrypoints: cfg.entrypoints,
    certResolver: cfg.certResolver ?? null,
    redisImage: cfg.redisImage,
    volumeDriver: cfg.volumeDriver,
    volumeOpts: cfg.volumeOpts,
    extensionsShared: cfg.extensionsShared,
    extensionsHostRoot: cfg.extensionsHostRoot,
    node: pinned ? nodeId : null,
    ...(cfg.caBundle ? { caBundle: cfg.caBundle.sha256 } : {}),
    // 0.2.3, each only where it changes what is rendered (else the hash an older agent made):
    // one folder per stack on an NFS export, and a Redis volume other than the uploads one.
    ...(nfsExport(cfg) !== null ? { uploadsLayout: 'per-stack' } : {}),
    ...(redisVolumeChanged(cfg) ? { redisVolume: redisVolumeOf(cfg) } : {}),
    // Never the agent's node id: an agent that moves must not change a stack's hash.
    ...(redisConstraint(cfg) ? { redisPin: redisConstraint(cfg) } : {})
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
  auth: string | undefined,
  uploadsFolder: string | undefined
): Promise<void> {
  const name = body.Name as string
  const send = (v: number) =>
    engine.call<{ message?: string }>('POST', `/services/${name}/update`, {
      query: { version: v },
      body,
      ...(auth ? { headers: { 'X-Registry-Auth': auth } } : {}),
      ...(uploadsFolder !== undefined ? { uploadsFolder } : {})
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

async function createService(
  engine: Engine,
  body: Obj,
  auth: string | undefined,
  uploadsFolder: string | undefined
): Promise<void> {
  const r = await engine.call('POST', '/services/create', {
    body,
    ...(auth ? { headers: { 'X-Registry-Auth': auth } } : {}),
    ...(uploadsFolder !== undefined ? { uploadsFolder } : {})
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
  /** Every service and volume read (the uploads-folder check looks at other stacks' ones). */
  services: ServiceRow[]
  volumes: VolumeRow[]
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
  for (const s of services) {
    if (belongs(s, name)) continue
    foreignRules.push(...routerRules(labelsOf(s)), ...hostClaimRules(labelsOf(s)))
  }
  const hostFields = spec.hostnames.flatMap((h, i) =>
    hostTaken(h, foreignRules) ? [{ field: `hostnames[${i}]`, code: 'HOSTNAME_TAKEN' }] : []
  )
  if (spec.host_pattern !== undefined) {
    const mine = patternRule(spec.host_pattern).toLowerCase()
    if (foreignRules.includes(mine))
      hostFields.push({ field: 'host_pattern', code: 'HOSTNAME_TAKEN' })
  }
  if (hostFields.length > 0) {
    throw new StackError(
      409,
      'HOSTNAME_TAKEN',
      'A hostname is already routed to another stack',
      hostFields
    )
  }
  mine.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  return { owner, network, mine, myNetwork, myVolumes, mySecrets, services, volumes }
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
  extensionPaths: Record<string, string>,
  caBundle: { id: string; name: string } | null
): EngineServiceSpec[] {
  return renderServices(name, spec, cfg, {
    hash,
    secretIds,
    extensionPaths,
    agentNodeId: deps.nodeId,
    network,
    ...(caBundle ? { caBundle } : {})
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

/** The NFS device a managed volume or service mount names (null when none). */
function mountDevices(s: ServiceRow): unknown[] {
  const mounts = s.Spec?.TaskTemplate?.ContainerSpec?.Mounts
  if (!Array.isArray(mounts)) return []
  return mounts.map((m) => (isObj(m) ? m.VolumeOptions?.DriverConfig?.Options?.device : null))
}

/**
 * Two stacks never share an uploads folder (0.2.3): another Hub stack's SERVICE that mounts this
 * folder, a folder inside it or one around it refuses 409 UPLOADS_FOLDER_TAKEN. Left-over volume
 * objects (a removed stack, a folder that changed) do not count: the agent never removes an NFS
 * uploads volume, so they would block a folder for ever, and they serve nothing. The export root
 * itself is the pre-0.2.3 layout every older stack used: it counts for none. Services the Hub
 * does not manage (an app's old stack during its cutover) do not count either: the same app may
 * keep reading its folder from there.
 */
function assertFolderFree(
  stack: string,
  plan: VolumePlan,
  exportDevice: string,
  services: ServiceRow[]
): void {
  const folder = plan.folder as string
  const taken = (device: unknown) => {
    const rel = folderUnderExport(exportDevice, device)
    return !!rel && foldersOverlap(rel, folder)
  }
  const byService = services.some(
    (s) => !belongs(s, stack) && isManaged(labelsOf(s)) && mountDevices(s).some(taken)
  )
  if (byService) {
    throw new StackError(
      409,
      'UPLOADS_FOLDER_TAKEN',
      `Another Hub stack keeps its files in ${folder}, or in a folder inside or around it`,
      [{ field: plan.adopted ? 'uploads_folder' : 'uploads', code: 'UPLOADS_FOLDER_TAKEN' }]
    )
  }
}

/**
 * M3 (0.2.3): a stack an older agent deployed mounts the export ROOT itself, where its files are.
 * Moving it to `<stack>/uploads` would start the app on an empty folder, so while its running
 * service still mounts the root the agent refuses 409 UPLOADS_LAYOUT_CHANGED, unless the stack
 * names its folder explicitly (`uploads_folder`): move the files into a folder by hand and adopt
 * it (README "Upgrading from an agent before 0.2.3").
 */
function assertLayoutKept(
  stack: string,
  spec: StackSpec,
  exportDevice: string,
  mine: ServiceRow[],
  myVolumes: VolumeRow[]
): void {
  if (spec.uploads_folder !== undefined) return
  for (const s of mine) {
    const mounts = s.Spec?.TaskTemplate?.ContainerSpec?.Mounts
    if (!Array.isArray(mounts)) continue
    for (const m of mounts) {
      if (!isObj(m) || m.Type !== 'volume' || m.Target !== '/app/uploads') continue
      const device =
        m.VolumeOptions?.DriverConfig?.Options?.device ??
        myVolumes.find((v) => v.Name === m.Source)?.Options?.device
      if (folderUnderExport(exportDevice, device) === '') {
        throw new StackError(
          409,
          'UPLOADS_LAYOUT_CHANGED',
          `${stack} keeps its files on the export root (an agent before 0.2.3 deployed it). Move them into a folder on the file server and set the stack's uploads folder to it before applying`,
          [{ field: 'uploads_folder', code: 'UPLOADS_LAYOUT_CHANGED' }]
        )
      }
    }
  }
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
  const { owner, network, mine, myNetwork, myVolumes, mySecrets, services } = await survey(
    engine,
    name,
    spec
  )
  const hash = stackHash(spec, cfg, deps.nodeId)

  // 1b. The uploads folder on an NFS export: free, there (or made) and writable by uid 1000 —
  // before any Docker write, so a refusal leaves the stack as it was.
  const uploads = uploadsVolumePlan(name, spec, cfg)
  const exportDevice = nfsExport(cfg)
  if (uploads.folder !== null && exportDevice !== null) {
    assertLayoutKept(name, spec, exportDevice, mine, myVolumes)
    assertFolderFree(name, uploads, exportDevice, services)
    await ensureUploadsFolder(
      cfg.exportMount,
      uploads,
      spec.files_subfolder,
      { clusterId: deps.clusterId ?? '', stack: name },
      deps.folderFs
    )
  }

  // 2. The stack network.
  if (myNetwork.length === 0) {
    const r = await engine.call('POST', '/networks/create', {
      body: { Name: network, Driver: 'overlay', Attachable: false, Labels: { ...owner } }
    })
    if (!ok(r.status)) throw engineFailed()
  }

  // 3. Volumes: uploads (on an export, the stack's own folder) and Redis, each with its driver.
  const wantVolumes = [uploads]
  if (spec.redis === 'bundled') wantVolumes.push(redisVolumePlan(name, cfg))
  for (const v of wantVolumes) {
    if (myVolumes.some((x) => x.Name === v.name)) continue
    const r = await engine.call('POST', '/volumes/create', {
      body: {
        Name: v.name,
        Driver: v.driver,
        DriverOpts: { ...v.opts },
        Labels: { ...owner }
      },
      ...(spec.uploads_folder !== undefined ? { uploadsFolder: spec.uploads_folder } : {})
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
  // 4b. The agent's CA bundle (HUB_AGENT_CA_BUNDLE_FILE): one more secret of this stack, made
  // and labelled like the others; a changed bundle = a new name, the old one pruned in step 8.
  let caBundle: { id: string; name: string } | null = null
  if (cfg.caBundle) {
    const sn = caBundleSecretName(name, cfg.caBundle.sha256)
    let id = existing.get(sn)
    if (!id) {
      const r = await engine.call<{ ID?: unknown }>('POST', '/secrets/create', {
        body: {
          Name: sn,
          Labels: { ...owner },
          Data: Buffer.from(cfg.caBundle.pem, 'utf8').toString('base64')
        }
      })
      if (!ok(r.status) || typeof r.body?.ID !== 'string') throw engineFailed()
      id = r.body.ID
      existing.set(sn, id)
    }
    caBundle = { id, name: sn }
  }

  // 5. Extensions: unpacked folders on the host.
  const extensionPaths = await prepareExtensions(engine, cfg, name, spec, deps)

  // 6. Services, rendered fresh.
  const rendered = render(name, spec, cfg, deps, hash, network, secretIds, extensionPaths, caBundle)
  const current = new Map(mine.map((s) => [nameOf(s), s]))
  const changed: string[] = []
  const unchanged: string[] = []
  const updated = new Set<string>()
  for (const svc of rendered) {
    const auth = authFor(cfg, svc)
    const cur = current.get(svc.Name)
    if (!cur) {
      await createService(engine, svc, auth, spec.uploads_folder)
      changed.push(svc.Name)
      continue
    }
    const labels = labelsOf(cur)
    const sameService = labels[LABEL_SERVICE_HASH] === svc.Labels[LABEL_SERVICE_HASH]
    // Swarm rolled this service back (its spec, labels included, is the previous one again): it
    // is sent again even when it already matches, so swarm's rollback state can clear (P4-28).
    const rolledBack = (cur.UpdateStatus?.State ?? '').startsWith('rollback_')
    if (sameService && labels[LABEL_SPEC_HASH] === hash && !rolledBack) {
      unchanged.push(svc.Name)
      continue
    }
    // Keep the live ForceUpdate (a restart raised it): sending 0 back would restart the tasks.
    const body = withForceUpdate(svc, liveForceUpdate(cur))
    await updateService(engine, body, cur.Version?.Index, auth, spec.uploads_folder)
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
  let caBundle: { id: string; name: string } | null = null
  if (cfg.caBundle) {
    const sn = caBundleSecretName(name, cfg.caBundle.sha256)
    const id = existing.get(sn)
    if (!id) throw specMismatch()
    caBundle = { id, name: sn }
  }
  // Restart creates nothing: an extension folder that is not there means another spec.
  const extensionPaths: Record<string, string> = {}
  for (const id of Object.keys(spec.extensions).sort()) {
    const path = await existingExtension(cfg, name, id, spec.extensions[id])
    if (!path) throw specMismatch()
    extensionPaths[id] = path
  }
  const rendered = render(name, spec, cfg, deps, hash, network, secretIds, extensionPaths, caBundle)

  const current = new Map(mine.map((s) => [nameOf(s), s]))
  if (rendered.length !== mine.length || rendered.some((svc) => !current.has(svc.Name)))
    throw specMismatch()
  for (const svc of rendered) {
    const cur = current.get(svc.Name) as ServiceRow
    const body = withForceUpdate(svc, liveForceUpdate(cur) + 1)
    await updateService(engine, body, cur.Version?.Index, authFor(cfg, svc), spec.uploads_folder)
  }
  return { services: rendered.map((s) => s.Name).sort() }
}

// ── scale (0.2.4) ───────────────────────────────────────────────────────

export type ScaleResult = ApplyResult & {
  /** true = the stack already ran the scaled spec: nothing was sent (a repeated request). */
  already: boolean
}

/**
 * Scale (0.2.4): `spec` is the StackSpec the stack runs now, `next` the same spec with only the
 * replica counts and limits of roles it already runs replaced (scale.ts builds and validates it).
 * Judged like a restart: ownership, owner and hostnames from a fresh read, the live stack hash
 * must be `spec`'s — or already `next`'s, which answers `already` and writes nothing, so a Hub
 * that lost the answer can send the same request again — and it creates nothing (every secret,
 * extension folder and service must be there; else 409 SPEC_MISMATCH). Bodies are rendered fresh
 * from `next` like an apply's; a service whose own hash changes is updated (replicas alone: swarm
 * adds or stops tasks and restarts none; limits: a rolling update, one task at a time,
 * start-first, rollback on failure), the others only get the new stack hash on their labels.
 */
export async function scaleStack(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  spec: StackSpec,
  next: StackSpec,
  deps: StackDeps
): Promise<ScaleResult> {
  assertName(name)
  const { network, mine, mySecrets } = await survey(engine, name, next)
  if (mine.length === 0) throw notFound()
  const from = stackHash(spec, cfg, deps.nodeId)
  const to = stackHash(next, cfg, deps.nodeId)
  const live = new Set(mine.map((s) => labelsOf(s)[LABEL_SPEC_HASH] ?? ''))
  const names = mine.map(nameOf).sort()
  if (live.size === 1 && live.has(to))
    return { spec_hash: to, changed: [], unchanged: names, already: true }
  if (live.size !== 1 || !live.has(from)) throw specMismatch()

  const existing = new Map<string, string>()
  for (const s of mySecrets) if (s.Spec?.Name) existing.set(s.Spec.Name, s.ID)
  const secretIds: Record<string, { id: string; name: string }> = {}
  for (const key of Object.keys(next.secrets).sort()) {
    const sn = secretName(name, key, next.secrets[key], cfg.hmacKey)
    const id = existing.get(sn)
    if (!id) throw specMismatch()
    secretIds[key] = { id, name: sn }
  }
  let caBundle: { id: string; name: string } | null = null
  if (cfg.caBundle) {
    const sn = caBundleSecretName(name, cfg.caBundle.sha256)
    const id = existing.get(sn)
    if (!id) throw specMismatch()
    caBundle = { id, name: sn }
  }
  const extensionPaths: Record<string, string> = {}
  for (const id of Object.keys(next.extensions).sort()) {
    const path = await existingExtension(cfg, name, id, next.extensions[id])
    if (!path) throw specMismatch()
    extensionPaths[id] = path
  }
  const rendered = render(name, next, cfg, deps, to, network, secretIds, extensionPaths, caBundle)
  const current = new Map(mine.map((s) => [nameOf(s), s]))
  if (rendered.length !== mine.length || rendered.some((svc) => !current.has(svc.Name)))
    throw specMismatch()

  const changed: string[] = []
  const unchanged: string[] = []
  for (const svc of rendered) {
    const cur = current.get(svc.Name) as ServiceRow
    const sameService = labelsOf(cur)[LABEL_SERVICE_HASH] === svc.Labels[LABEL_SERVICE_HASH]
    // The live ForceUpdate rides along (as in apply): sending 0 back would restart the tasks.
    const body = withForceUpdate(svc, liveForceUpdate(cur))
    await updateService(engine, body, cur.Version?.Index, authFor(cfg, svc), next.uploads_folder)
    ;(sameService ? unchanged : changed).push(svc.Name)
  }
  return { spec_hash: to, changed: changed.sort(), unchanged: unchanged.sort(), already: false }
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
  // A rollback_* service counts as rolled back only while it does not run the wanted spec. One
  // that does (swarm already rolled back to the spec the Hub now deploys — a Hub rollback after
  // swarm's own, P4-28) is judged by what its rollback reached: completed, still going, paused.
  const judged = services.map((s, i) => {
    if (!s.update.startsWith('rollback_')) return s.update
    if (!want || labelsOf(mine[i])[LABEL_SPEC_HASH] !== want) return s.update
    return s.update === 'rollback_completed'
      ? 'completed'
      : s.update === 'rollback_paused'
        ? 'paused'
        : 'updating'
  })
  let state: StackStatus['state']
  if (judged.some((u) => u.startsWith('rollback_'))) state = 'rolled_back'
  else if (
    want &&
    mine.every((s) => labelsOf(s)[LABEL_SPEC_HASH] === want) &&
    services.every(
      (s, i) =>
        (judged[i] === 'none' || judged[i] === 'completed') &&
        s.replicas.running === s.replicas.desired
    )
  )
    state = 'converged'
  else if (judged.some((u) => u === 'paused')) state = 'paused'
  else if (
    !want ||
    mine.some((s) => labelsOf(s)[LABEL_SPEC_HASH] !== want) ||
    judged.some((u) => u === 'updating')
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

/** Who the caller says owns the stack it removes (StackSpec owner + environment). */
export type RemoveOwner = ({ app: string } | { shared: string }) & { environment: string }

/** Everything managed a stack still has on the engine, by name, with its labels. */
async function stackObjects(engine: Engine, name: string) {
  const services = await stackServices(engine, name)
  const network = `nvh_${name}`
  const named = (n: unknown, labels: unknown) => ({ name: n as string, labels: labels as Labels })
  const secrets = (await listSecrets(engine))
    .filter(
      (s) =>
        objectOfStack(s.Spec?.Name, name) &&
        s.Spec?.Name !== network &&
        ownObject(s.Spec?.Labels, name)
    )
    .map((s) => named(s.Spec?.Name, s.Spec?.Labels))
  const networks = (await listNetworks(engine))
    .filter((n) => n.Name === network && ownObject(n.Labels, name))
    .map((n) => named(n.Name, n.Labels))
  const all = (await listVolumes(engine)).filter(
    (v) => objectOfStack(v.Name, name) && v.Name !== network && ownObject(v.Labels, name)
  )
  const onShare = (v: VolumeRow) => isNfsOpts(v.Options as Record<string, unknown> | null)
  const volumes = all.filter((v) => !onShare(v)).map((v) => named(v.Name, v.Labels))
  const shareVolumes = all.filter(onShare).map((v) => named(v.Name, v.Labels))
  return { services, secrets, networks, volumes, shareVolumes }
}

/**
 * The caller's idea of the owner must be the stack's: every managed service and object of the
 * stack carries the same app/shared + environment labels (STACK_OWNER_MISMATCH otherwise).
 */
function assertOwner(objects: Awaited<ReturnType<typeof stackObjects>>, owner: RemoveOwner) {
  const want: Labels = {
    [LABEL_APP]: 'app' in owner ? owner.app : undefined,
    [LABEL_SHARED]: 'shared' in owner ? owner.shared : undefined,
    [LABEL_ENV]: owner.environment
  } as Labels
  const labels = [
    ...objects.services.map(labelsOf),
    ...[...objects.secrets, ...objects.networks, ...objects.volumes, ...objects.shareVolumes].map(
      (o) => o.labels
    )
  ]
  for (const l of labels) if (!ownerMatches(l, want)) throw ownerMismatch()
}

export type Leftovers = {
  services: string[]
  secrets: string[]
  networks: string[]
  volumes: string[]
  /**
   * 0.2.3: the stack's volumes on an NFS export. Not leftovers to clear: the agent never removes
   * them (their files are on the share) and they never block anything. Delete by hand if wanted.
   */
  share_volumes: string[]
  /** The stack's extensions folder still exists on the agent's host. */
  extensions: boolean
  /**
   * 0.2.1: tasks of this stack (by the container labels the agent sets) whose actual state has
   * not ended, whatever Docker still wants for them: a removed service's containers that are
   * still shutting down count. 0 = nothing of the stack runs anywhere in the swarm.
   */
  tasks_active: number
}

/**
 * What of a stack is still there (reads only): managed services, secrets, network, volumes and
 * the extensions folder. A stack whose services are gone can still hold volumes and secrets;
 * `GET /v1/stacks/:name` answers 404 for it, this does not. STACK_OWNER_MISMATCH when anything
 * there is labelled for another owner; STACK_NOT_HUB as for every stack read.
 */
export async function stackLeftovers(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  owner: RemoveOwner
): Promise<Leftovers> {
  assertName(name)
  const objects = await stackObjects(engine, name)
  assertOwner(objects, owner)
  const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name).sort()
  return {
    services: objects.services.map(nameOf).sort(),
    secrets: names(objects.secrets),
    networks: names(objects.networks),
    volumes: names(objects.volumes),
    share_volumes: names(objects.shareVolumes),
    extensions: await extensionFolderExists(cfg, name),
    tasks_active: await activeTasks(engine, name)
  }
}

/**
 * How many tasks of this stack have not ended (ACTIVE_TASK_STATES), across the swarm: every task
 * is read (a removed service can no longer be named in a filter) and matched on the container
 * labels the agent sets (managed + stack namespace). Reads only.
 */
async function activeTasks(engine: Engine, stack: string): Promise<number> {
  const body = await read<unknown>(engine, '/tasks', { filters: '{}' })
  const tasks = (Array.isArray(body) ? body : []) as TaskRow[]
  return tasks.filter((t) => {
    const l = t?.Spec?.ContainerSpec?.Labels
    return (
      isManaged(l) &&
      (l as Record<string, string>)[LABEL_NAMESPACE] === stack &&
      ACTIVE_TASK_STATES.includes(String(t.Status?.State ?? ''))
    )
  }).length
}

/**
 * Services (the app's first, Redis last) → secrets → network → (volumes, only with the flag) →
 * extension folders. Only managed objects of this stack, by name. Answers the names.
 */
export async function removeStack(
  engine: Engine,
  cfg: AgentConfig,
  name: string,
  opts: { removeVolumes: boolean; owner: RemoveOwner },
  deps: Partial<StackDeps> = {}
): Promise<RemoveResult> {
  assertName(name)
  const objects = await stackObjects(engine, name)
  assertOwner(objects, opts.owner)
  const mine = objects.services
  const network = `nvh_${name}`
  const removed: RemoveResult['removed'] = { services: [], secrets: [], networks: [], volumes: [] }

  // 0.2.1: the app's services first, the stack's Redis LAST: a remove that fails part way never
  // leaves an app process running without the Redis that holds its maintenance freeze.
  const order = [...mine].sort(
    (a, b) =>
      Number(labelsOf(a)[LABEL_ROLE] === 'redis') - Number(labelsOf(b)[LABEL_ROLE] === 'redis')
  )
  for (const s of order) {
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

  const kept: string[] = []
  if (opts.removeVolumes) {
    const vols = (await listVolumes(engine))
      .filter((v) => objectOfStack(v.Name, name) && v.Name !== network && ownObject(v.Labels, name))
      .sort((a, b) => String(a.Name).localeCompare(String(b.Name)))
    for (const v of vols) {
      const n = v.Name as string
      // L6 (0.2.3): a volume that mounts NFS holds nothing itself and its files live on the
      // share: it is kept (reported), never removed, so a remove can never reach those files.
      if (isNfsOpts(v.Options as Record<string, unknown> | null)) {
        kept.push(n)
        continue
      }
      if (await removeObject(engine, `/volumes/${n}`, deps)) removed.volumes.push(n)
    }
  }

  await removeExtensionFolders(cfg, name)
  // The answer names stay sorted (the order removed in is Redis last, above).
  removed.services.sort()
  return kept.length ? { removed, kept_volumes: kept } : { removed }
}
