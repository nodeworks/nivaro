// The volumes the agent gives a stack: its uploads volume (the app's files) and, with bundled
// Redis, the Redis volume. Pure: no I/O. The renderer, the stack operations and the engine guard
// all ask this module, so the three agree on every name, driver and option set.
//
// Uploads on an NFS export (agent 0.2.3): when HUB_AGENT_VOLUME_OPTS_FILE names an NFS `device`,
// that device is the export ROOT and each stack gets its own folder under it:
// `<export>/<stack>/uploads`, or an existing folder the stack adopts (`uploads_folder`). Two
// stacks never share one folder (the stack operations refuse UPLOADS_FOLDER_TAKEN). The Docker
// volume's name carries a digest of its driver and options (`nvh_<stack>_uploads-<10 hex>`):
// Docker never changes an existing volume's options, so a new folder takes a new volume.
// Bundled Redis never sits on NFS: it gets the local driver unless the operator names a Redis
// driver of their own (HUB_AGENT_REDIS_VOLUME_*). It is pinned only where the operator asks
// (HUB_AGENT_REDIS_PIN_LABEL, a node label), never to the agent's own node.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { redisVolume, uploadsVolume } from './names.js'

/** The part of AgentConfig the volume rules read (a full AgentConfig satisfies it). */
export type VolumeConfig = {
  volumeDriver: string
  volumeOpts?: Record<string, string> | null
  /** Absent = the default (redisVolumeDefault). */
  redisVolumeDriver?: string
  redisVolumeOpts?: Record<string, string> | null
  /**
   * HUB_AGENT_REDIS_PIN_LABEL (0.2.3): bundled Redis runs only on nodes carrying this node label
   * (`node.labels.<key>==<value>`), so its local volume is always there. Absent/null = not pinned
   * (a Redis task that moves starts empty; the data is rebuildable).
   */
  redisPinLabel?: { key: string; value: string } | null
}

export type VolumePlan = {
  name: string
  driver: string
  opts: Record<string, string>
  /** The folder under the NFS export (no leading `/`), or null when not on an export. */
  folder: string | null
  /** The stack named the folder (`uploads_folder`): used as-is, never created or changed. */
  adopted: boolean
}

/** The uid:gid the Nivaro image's server runs as (the `node` user). */
export const APP_UID = 1000
export const APP_GID = 1000
/** A stack's `run_as: 'app'` → the service's ContainerSpec.User. The only User ever set. */
export const APP_USER = `${APP_UID}:${APP_GID}`

const NFS_TYPES = new Set(['nfs', 'nfs4'])

/** Volume options that mount an NFS share (`type` nfs or nfs4). */
export function isNfsOpts(opts: Record<string, unknown> | null | undefined): boolean {
  return NFS_TYPES.has(
    String(opts?.type ?? '')
      .trim()
      .toLowerCase()
  )
}

/**
 * The NFS export root (`:/<path>`) the uploads folders sit under, or null: only when the uploads
 * options are NFS and name a device. Without a device the agent keeps the pre-0.2.3 layout.
 */
export function nfsExport(cfg: Pick<VolumeConfig, 'volumeOpts'>): string | null {
  const o = cfg.volumeOpts ?? {}
  return isNfsOpts(o) && typeof o.device === 'string' && o.device.startsWith(':/') ? o.device : null
}

/** One folder segment: starts with a letter or digit (so never `.`, `..` or hidden). */
export const FOLDER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const MAX_FOLDER_SEGMENTS = 8
export const MAX_FOLDER_LENGTH = 200

/** A relative folder path: 1–8 segments joined by `/`, no `..`, no leading or trailing `/`. */
export function folderOk(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FOLDER_LENGTH) return false
  const segments = v.split('/')
  return (
    segments.length <= MAX_FOLDER_SEGMENTS &&
    segments.every((s) => FOLDER_SEGMENT_RE.test(s) && s !== '..')
  )
}

/** The folder a stack gets on the export when it adopts none. */
export const derivedFolder = (stack: string) => `${stack}/uploads`

const exportBase = (exportDevice: string) => exportDevice.replace(/\/+$/, '')

/** `:/export` + `acme/uploads` → `:/export/acme/uploads` (`:/` + x → `:/x`). */
export function deviceFor(exportDevice: string, folder: string): string {
  return `${exportBase(exportDevice)}/${folder}`
}

/**
 * The folder a device names under the export: '' for the export root itself (the pre-0.2.3
 * layout), the relative path for a valid folder under it, null for anything else.
 */
export function folderUnderExport(exportDevice: string, device: unknown): string | null {
  if (typeof device !== 'string') return null
  const base = exportBase(exportDevice)
  if (device.replace(/\/+$/, '') === base) return ''
  if (!device.startsWith(`${base}/`)) return null
  const rel = device.slice(base.length + 1)
  return folderOk(rel) ? rel : null
}

/** One folder is the other, or holds it. */
export function foldersOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort())
      out[k] = canonical((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

/** `nvh_<stack>_uploads-<10 hex>`: the digest of the driver and options (folder included). */
export function nfsUploadsName(
  stack: string,
  driver: string,
  opts: Record<string, string>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical({ driver, opts })))
    .digest('hex')
    .slice(0, 10)
  return `${uploadsVolume(stack)}-${digest}`
}

/** The stack's uploads volume. `uploads_folder` counts only with an NFS export (spec.ts). */
export function uploadsVolumePlan(
  stack: string,
  spec: { uploads_folder?: string },
  cfg: VolumeConfig
): VolumePlan {
  const base = { ...(cfg.volumeOpts ?? {}) }
  const exp = nfsExport(cfg)
  if (exp === null) {
    return {
      name: uploadsVolume(stack),
      driver: cfg.volumeDriver,
      opts: base,
      folder: null,
      adopted: false
    }
  }
  const adopted = spec.uploads_folder !== undefined
  const folder = spec.uploads_folder ?? derivedFolder(stack)
  const opts = { ...base, device: deviceFor(exp, folder) }
  return {
    name: nfsUploadsName(stack, cfg.volumeDriver, opts),
    driver: cfg.volumeDriver,
    opts,
    folder,
    adopted
  }
}

/**
 * Redis's volume when the operator names none: the uploads driver and options as before 0.2.3,
 * except that options mounting NFS give way to `local` (Redis never on NFS).
 */
export function redisVolumeDefault(
  volumeDriver: string,
  volumeOpts: Record<string, string> | null | undefined
): { driver: string; opts: Record<string, string> } {
  return isNfsOpts(volumeOpts)
    ? { driver: 'local', opts: {} }
    : { driver: volumeDriver, opts: { ...(volumeOpts ?? {}) } }
}

export function redisVolumeOf(cfg: VolumeConfig): { driver: string; opts: Record<string, string> } {
  if (cfg.redisVolumeDriver !== undefined)
    return { driver: cfg.redisVolumeDriver, opts: { ...(cfg.redisVolumeOpts ?? {}) } }
  return redisVolumeDefault(cfg.volumeDriver, cfg.volumeOpts)
}

export function redisVolumePlan(stack: string, cfg: VolumeConfig): VolumePlan {
  const r = redisVolumeOf(cfg)
  return { name: redisVolume(stack), driver: r.driver, opts: r.opts, folder: null, adopted: false }
}

/** A node label `key=value` for HUB_AGENT_REDIS_PIN_LABEL: key and value letters, digits, . _ -. */
export const PIN_LABEL_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * The placement constraint for bundled Redis: only on nodes the operator labelled
 * (HUB_AGENT_REDIS_PIN_LABEL), never the agent's own node id (an agent that moves must not change
 * a stack or strand its Redis). null = not pinned.
 */
export function redisConstraint(cfg: VolumeConfig): string | null {
  const l = cfg.redisPinLabel
  if (!l || !PIN_LABEL_PART_RE.test(l.key) || !PIN_LABEL_PART_RE.test(l.value)) return null
  return `node.labels.${l.key}==${l.value}`
}

/**
 * Redis's volume differs from the one agents before 0.2.3 gave it (the uploads driver and
 * options): then it is part of the stack hash. Equal = the hash an older agent computed.
 */
export function redisVolumeChanged(cfg: VolumeConfig): boolean {
  const r = redisVolumeOf(cfg)
  return r.driver !== cfg.volumeDriver || !isDeepStrictEqual(r.opts, cfg.volumeOpts ?? {})
}

/**
 * Is this a volume the agent would make for `stack` (engine guard, defence in depth)? The Redis
 * volume with the Redis driver and options; the uploads volume with the uploads driver and
 * options — on an export, the same options with a `device` under it, under the name its digest
 * gives. Safety of the options themselves (never a bind) is config.ts volumeOptsSafe, checked
 * by the caller too.
 */
export function volumeAllowed(
  cfg: VolumeConfig,
  stack: string,
  name: unknown,
  driver: unknown,
  opts: Record<string, unknown>,
  /** The folder this stack's uploads must sit in: its adopted one, else `<stack>/uploads`. */
  expectFolder?: string
): boolean {
  if (typeof name !== 'string' || typeof driver !== 'string') return false
  if (name === redisVolume(stack)) {
    const r = redisVolumeOf(cfg)
    return driver === r.driver && isDeepStrictEqual(opts, r.opts)
  }
  if (driver !== cfg.volumeDriver) return false
  const exp = nfsExport(cfg)
  if (exp === null)
    return name === uploadsVolume(stack) && isDeepStrictEqual(opts, cfg.volumeOpts ?? {})
  const { device, ...rest } = opts
  const { device: _root, ...want } = cfg.volumeOpts ?? {}
  if (!isDeepStrictEqual(rest, want)) return false
  const folder = folderUnderExport(exp, device)
  if (!folder || folder !== (expectFolder ?? derivedFolder(stack))) return false
  return name === nfsUploadsName(stack, driver, opts as Record<string, string>)
}

/**
 * May uid APP_UID write a folder with this owner and mode? By mode bits, the way the image's
 * entrypoint judges /app/uploads (owner bit for the owner, group bit for the group, else other).
 */
export function appCanWrite(st: { uid: number; gid: number; mode: number }): boolean {
  if (st.uid === APP_UID) return (st.mode & 0o200) !== 0
  if (st.gid === APP_GID) return (st.mode & 0o020) !== 0
  return (st.mode & 0o002) !== 0
}
