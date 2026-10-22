import { createHash } from 'node:crypto'
import { ENV_HASH_PREFIX } from '../docker-source.js'

/**
 * #2798 stack drift — pure part. A service spec (already through docker-source's
 * `sanitizeServiceSpec`, so env is an `EnvDigest` map with secret values hashed) becomes a flat
 * map of comparable fields; two such maps diff field by field. Volatile fields (Version,
 * CreatedAt, UpdatedAt, PreviousSpec, UpdateStatus, Endpoint) never become fields; the version
 * and id are kept beside them only to tell a hand-run `docker service update` from a deploy.
 */

export interface NormalizedService {
  /** Full service name (`efp_api`). */
  name: string
  id: string | null
  /** Swarm's spec version index when the baseline / live read was taken. */
  version: number | null
  /** field → canonical value; an absent field and an empty one are the same. */
  fields: Record<string, string>
  /** The previous spec's fields, when swarm kept one (live reads only; not stored in baselines). */
  previous?: Record<string, string> | null
}

export type DriftKind = 'changed' | 'added' | 'removed' | 'missing' | 'extra'

export interface DriftItem {
  service: string
  /** e.g. `image`, `env.LOG_LEVEL`, `mounts`, `resources.limits`, `labels.traefik.enable`. */
  field: string
  kind: DriftKind
  /** null when secret (never shown) or when the side has no value. */
  expected: string | null
  actual: string | null
  secret: boolean
  /** hand-run = changed by a docker service update after the deploy; recreated = new service id. */
  origin: 'hand-run' | 'recreated' | null
  detail: string | null
  fingerprint: string
}

// Labels a stack deploy writes itself: the namespace never differs within a stack, and
// com.docker.stack.image is the tag the stack file asked for — the `image` field already
// compares the real reference, so the label would only double every image drift. Everything
// else (traefik routing labels included) is real configuration a hand edit can change.
const IGNORED_LABEL = /^com\.docker\.(stack\.(namespace|image)|swarm\.)/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : ({} as Obj)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null =>
  v == null || v === '' ? null : typeof v === 'string' ? v : String(v)

/** JSON with sorted keys, so two equal objects always print the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Obj)
      .filter((k) => (v as Obj)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Obj)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/**
 * `repo:tag@sha256:…` → the comparable reference. With a digest the tag is dropped (the same
 * digest under a new tag is the same image); without one the full reference is kept.
 */
export function canonicalImage(ref: string | null): string | null {
  if (!ref) return null
  const at = ref.indexOf('@')
  if (at < 0) return ref
  const name = ref.slice(0, at)
  const digest = ref.slice(at + 1)
  const slash = name.lastIndexOf('/')
  const colon = name.lastIndexOf(':')
  const repo = colon > slash ? name.slice(0, colon) : name
  return `${repo}@${digest}`
}

const MiB = 1024 * 1024
function fmtBytes(n: number): string {
  if (n >= 1024 * MiB && n % (1024 * MiB) === 0) return `${n / (1024 * MiB)} GiB`
  if (n % MiB === 0) return `${n / MiB} MiB`
  return `${n} B`
}

function fmtResources(r: unknown): string | null {
  const o = obj(r)
  const parts: string[] = []
  if (o.NanoCPUs) parts.push(`cpus=${Number(o.NanoCPUs) / 1e9}`)
  if (o.MemoryBytes) parts.push(`memory=${fmtBytes(Number(o.MemoryBytes))}`)
  if (o.Pids) parts.push(`pids=${o.Pids}`)
  const generic = arr(o.GenericResources)
  if (generic.length) parts.push(`generic=${stableJson(generic)}`)
  return parts.length ? parts.join(' ') : null
}

const NS = 1_000_000_000
function fmtNs(v: unknown): string | null {
  const n = Number(v)
  if (!n) return null
  return n % NS === 0 ? `${n / NS}s` : `${n / 1e6}ms`
}

function fmtHealthcheck(h: unknown): string | null {
  const o = obj(h)
  if (!Object.keys(o).length) return null
  const test = arr(o.Test).map(String)
  const parts = [test.length ? test.join(' ') : null]
  for (const [k, label] of [
    ['Interval', 'interval'],
    ['Timeout', 'timeout'],
    ['StartPeriod', 'start_period'],
    ['StartInterval', 'start_interval']
  ] as const) {
    const v = fmtNs(o[k])
    if (v) parts.push(`${label}=${v}`)
  }
  if (o.Retries) parts.push(`retries=${o.Retries}`)
  return parts.filter(Boolean).join(' ') || null
}

function fmtMount(m: unknown): string {
  const o = obj(m)
  const type = str(o.Type) ?? 'volume'
  const src = str(o.Source) ?? ''
  const ro = o.ReadOnly ? ' (ro)' : ''
  return `${type} ${src ? `${src} → ` : ''}${str(o.Target) ?? '?'}${ro}`
}

function fmtFileRef(s: unknown, nameKey: 'SecretName' | 'ConfigName'): string {
  const o = obj(s)
  const file = obj(o.File)
  const target = str(file.Name) ?? (o.Runtime ? '(runtime)' : '?')
  return `${str(o[nameKey]) ?? '?'} → ${target}`
}

const sortedLines = (xs: string[]): string | null =>
  xs.length ? [...new Set(xs)].sort().join('\n') : null

// `docker service inspect` asks the Engine to fill in swarm's defaults (insertDefaults=true);
// a plain GET /services leaves them out. Values equal to the default are dropped key by key, so
// a CLI inspect posted by the deploy script and the live Engine read normalize the same.
const UPDATE_DEFAULTS: Obj = {
  Parallelism: 1,
  Delay: 0,
  FailureAction: 'pause',
  Monitor: 5 * NS,
  MaxFailureRatio: 0,
  Order: 'stop-first'
}
const RESTART_DEFAULTS: Obj = { Condition: 'any', Delay: 5 * NS, MaxAttempts: 0, Window: 0 }

function withoutDefaults(v: unknown, defaults: Obj): string | null {
  const out: Obj = {}
  for (const [k, x] of Object.entries(obj(v))) if (x != null && x !== defaults[k]) out[k] = x
  return Object.keys(out).length ? stableJson(out) : null
}

function modeOf(spec: Obj): { mode: string; replicas: string | null } {
  const m = obj(spec.Mode)
  if (m.Global) return { mode: 'global', replicas: null }
  if (m.GlobalJob) return { mode: 'global-job', replicas: null }
  if (m.ReplicatedJob) {
    const j = obj(m.ReplicatedJob)
    return { mode: 'replicated-job', replicas: str(j.TotalCompletions ?? j.MaxConcurrent) }
  }
  return { mode: 'replicated', replicas: str(obj(m.Replicated).Replicas ?? 1) }
}

/** The comparable fields of one service spec (`Spec` or `PreviousSpec`). */
export function specFields(specRaw: unknown): Record<string, string> {
  const spec = obj(specRaw)
  const tt = obj(spec.TaskTemplate)
  const cs = obj(tt.ContainerSpec)
  const res = obj(tt.Resources)
  const placement = obj(tt.Placement)
  const f: Record<string, string | null> = {}

  f.image = canonicalImage(str(cs.Image))
  const { mode, replicas } = modeOf(spec)
  f.mode = mode
  f.replicas = replicas
  for (const [k, v] of Object.entries(obj(cs.EnvDigest))) f[`env.${k}`] = str(v) ?? ''
  f.mounts = sortedLines(arr(cs.Mounts).map(fmtMount))
  f.secrets = sortedLines(arr(cs.Secrets).map((s) => fmtFileRef(s, 'SecretName')))
  f.configs = sortedLines(arr(cs.Configs).map((s) => fmtFileRef(s, 'ConfigName')))
  f['resources.limits'] = fmtResources(res.Limits)
  f['resources.reservations'] = fmtResources(res.Reservations)
  f['placement.constraints'] = sortedLines(arr(placement.Constraints).map(String))
  f['placement.preferences'] = arr(placement.Preferences).length
    ? stableJson(placement.Preferences)
    : null
  f['placement.max_replicas'] = placement.MaxReplicas ? str(placement.MaxReplicas) : null
  f.user = str(cs.User)
  f.read_only = cs.ReadOnly ? 'true' : null
  f.cap_add = sortedLines(arr(cs.CapabilityAdd).map(String))
  f.cap_drop = sortedLines(arr(cs.CapabilityDrop).map(String))
  f.healthcheck = fmtHealthcheck(cs.Healthcheck)
  f.command = arr(cs.Command).length ? arr(cs.Command).map(String).join(' ') : null
  f.args = arr(cs.Args).length ? arr(cs.Args).map(String).join(' ') : null
  f.update_config = withoutDefaults(spec.UpdateConfig, UPDATE_DEFAULTS)
  f.rollback_config = withoutDefaults(spec.RollbackConfig, UPDATE_DEFAULTS)
  f.restart_policy = withoutDefaults(tt.RestartPolicy, RESTART_DEFAULTS)
  for (const [k, v] of Object.entries(obj(spec.Labels)))
    if (!IGNORED_LABEL.test(k)) f[`labels.${k}`] = str(v) ?? ''
  for (const [k, v] of Object.entries(obj(cs.Labels)))
    if (!IGNORED_LABEL.test(k)) f[`container_labels.${k}`] = str(v) ?? ''

  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(f)) if (v != null) out[k] = v.slice(0, 2000)
  return out
}

/** One sanitized service object → its normalized form. */
export function normalizeService(
  svc: unknown,
  opts: { withPrevious?: boolean } = {}
): NormalizedService {
  const o = obj(svc)
  const spec = obj(o.Spec)
  const version = Number(obj(o.Version).Index)
  return {
    name: str(spec.Name) ?? str(o.ID) ?? '?',
    id: str(o.ID),
    version: Number.isFinite(version) ? version : null,
    fields: specFields(spec),
    ...(opts.withPrevious ? { previous: o.PreviousSpec ? specFields(o.PreviousSpec) : null } : {})
  }
}

/** The stack a sanitized service belongs to (`com.docker.stack.namespace`). */
export function serviceStack(svc: unknown): string | null {
  const labels = obj(obj(obj(svc).Spec).Labels)
  return str(labels['com.docker.stack.namespace'])
}

const isSecretValue = (v: string | undefined): boolean =>
  typeof v === 'string' && v.startsWith(ENV_HASH_PREFIX)

export function fingerprint(service: string, field: string, a: string | null, b: string | null) {
  return createHash('sha256')
    .update(`${service}\u0000${field}\u0000${a ?? '\u0001'}\u0000${b ?? '\u0001'}`)
    .digest('hex')
}

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}

/** Why one service's live spec moved away from its baseline. */
function originOf(
  base: NormalizedService,
  live: NormalizedService
): { origin: DriftItem['origin']; detail: string | null } {
  if (base.id && live.id && base.id !== live.id)
    return {
      origin: 'recreated',
      detail: 'The service was removed and created again outside the deploy (new service id).'
    }
  if (base.version != null && live.version != null && live.version > base.version) {
    const once = live.previous && sameFields(live.previous, base.fields)
    return {
      origin: 'hand-run',
      detail: once
        ? 'Changed by one docker service update after the deploy (swarm kept the deployed spec as the previous spec).'
        : 'Changed by docker service update after the deploy (the spec version moved since the baseline).'
    }
  }
  return { origin: null, detail: null }
}

export interface DiffOptions {
  /** false = the env digests were made with another key: secret env values are not compared. */
  secretsComparable?: boolean
}

/** Field-by-field differences between a baseline and the live services of one stack. */
export function diffStack(
  baseline: NormalizedService[],
  live: NormalizedService[],
  opts: DiffOptions = {}
): DriftItem[] {
  const out: DriftItem[] = []
  const liveByName = new Map(live.map((s) => [s.name, s]))
  const baseNames = new Set(baseline.map((s) => s.name))
  const item = (
    service: string,
    field: string,
    kind: DriftKind,
    expected: string | null,
    actual: string | null,
    secret: boolean,
    o: { origin: DriftItem['origin']; detail: string | null }
  ): DriftItem => ({
    service,
    field,
    kind,
    expected: secret ? null : expected,
    actual: secret ? null : actual,
    secret,
    origin: o.origin,
    detail: o.detail,
    fingerprint: fingerprint(service, field, expected, actual)
  })

  for (const b of baseline) {
    const l = liveByName.get(b.name)
    if (!l) {
      out.push(
        item(b.name, '(service)', 'missing', b.fields.image ?? null, null, false, {
          origin: null,
          detail: 'In the baseline but not running in the stack now.'
        })
      )
      continue
    }
    const why = originOf(b, l)
    const keys = new Set([...Object.keys(b.fields), ...Object.keys(l.fields)])
    for (const k of [...keys].sort()) {
      const e = b.fields[k]
      const a = l.fields[k]
      if (e === a) continue
      const secret = isSecretValue(e) || isSecretValue(a)
      if (secret && opts.secretsComparable === false && e !== undefined && a !== undefined) continue
      const kind: DriftKind = e === undefined ? 'added' : a === undefined ? 'removed' : 'changed'
      out.push(item(b.name, k, kind, e ?? null, a ?? null, secret, why))
    }
  }
  for (const l of live) {
    if (baseNames.has(l.name)) continue
    out.push(
      item(l.name, '(service)', 'extra', null, l.fields.image ?? null, false, {
        origin: null,
        detail: 'Running in the stack but not in the baseline (created outside the deploy).'
      })
    )
  }
  return out
}
