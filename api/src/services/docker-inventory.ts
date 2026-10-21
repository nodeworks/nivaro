/**
 * Docker inventory derivations for the Infrastructure page (#2830 containers, #2832 volumes,
 * #2833 images + prune preview, #2840 provenance). Everything here is read-only: the derive*
 * functions are pure over Engine API payloads, the load* functions fetch through docker-source.
 */
import { NIVARO_VERSION } from '../version.js'
import { type DockerHost, dockerGet, ownerOf } from './docker-source.js'
import { metricsQuery, storeEnabled } from './telemetry-store.js'

const DAY_S = 86_400
const STOPPED_FLAG_DAYS = 7

// --- Engine API shapes (the fields we read) ---------------------------------------------------

export interface EngineMount {
  Type?: string
  Name?: string
  Source?: string
  Destination?: string
  Driver?: string
  RW?: boolean
}

export interface EngineContainer {
  Id: string
  Names?: string[]
  Image?: string
  ImageID?: string
  State?: string
  Status?: string
  Created?: number
  Labels?: Record<string, string> | null
  Mounts?: EngineMount[]
  NetworkSettings?: { Networks?: Record<string, unknown> | null }
}

export interface EngineInspect {
  HostConfig?: { RestartPolicy?: { Name?: string; MaximumRetryCount?: number } }
  State?: { FinishedAt?: string; StartedAt?: string; Status?: string }
}

export interface EngineImage {
  Id: string
  ParentId?: string
  RepoTags?: string[] | null
  RepoDigests?: string[] | null
  Created?: number
  Size?: number
  SharedSize?: number
  Containers?: number
  Labels?: Record<string, string> | null
}

export interface EngineVolume {
  Name: string
  Driver?: string
  Mountpoint?: string
  Labels?: Record<string, string> | null
  Scope?: string
  UsageData?: { Size?: number; RefCount?: number } | null
}

export interface EngineBuildCache {
  ID?: string
  InUse?: boolean
  Shared?: boolean
  Size?: number
  Type?: string
}

export interface EngineDf {
  LayersSize?: number
  Images?: EngineImage[]
  Volumes?: EngineVolume[] | null
  BuildCache?: EngineBuildCache[] | null
}

export interface EngineNetwork {
  Id: string
  Name: string
  Driver?: string
  Scope?: string
  Containers?: Record<string, unknown> | null
}

// --- helpers ----------------------------------------------------------------------------------

const cname = (c: EngineContainer): string => (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '')

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

/** Docker reports 0001-01-01 for "never"; anything unparsable is null. */
export function parseDockerTime(v: string | undefined | null): number | null {
  if (!v || v.startsWith('0001-')) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

export function isDangling(img: EngineImage): boolean {
  const tags = (img.RepoTags ?? []).filter((t) => t && t !== '<none>:<none>')
  return tags.length === 0
}

function imageRepo(ref: string | undefined): { repo: string; tag: string | null } {
  if (!ref) return { repo: '', tag: null }
  const at = ref.indexOf('@')
  const noDigest = at >= 0 ? ref.slice(0, at) : ref
  const colon = noDigest.lastIndexOf(':')
  const slash = noDigest.lastIndexOf('/')
  if (colon > slash) return { repo: noDigest.slice(0, colon), tag: noDigest.slice(colon + 1) }
  return { repo: noDigest, tag: at >= 0 ? null : 'latest' }
}

/** Env comma list -> trimmed non-empty entries. */
export function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function globToRe(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${esc}$`)
}

export function matchesAnyGlob(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRe(g).test(value))
}

// --- #2830 containers -------------------------------------------------------------------------

export type ContainerFlagCode = 'no-owner' | 'stopped-long' | 'compose-foreign-dir'

export interface ContainerFlag {
  code: ContainerFlagCode
  text: string
}

export interface ContainerRow {
  id: string
  name: string
  image: string
  state: string
  status: string
  owner: {
    kind: 'stack' | 'compose' | 'none'
    stack: string | null
    service: string | null
    compose_project: string | null
    compose_service: string | null
    label: string
  }
  restart_policy: string | null
  created: number | null
  age_s: number | null
  stopped_since: number | null
  stopped_days: number | null
  working_dir: string | null
  flags: ContainerFlag[]
}

export function deriveContainers(
  list: EngineContainer[],
  inspects: Record<string, EngineInspect | null>,
  nowS: number
): ContainerRow[] {
  // The working dir most containers of each compose project share; others are the odd ones out.
  const dirsByProject = new Map<string, Map<string, number>>()
  for (const c of list) {
    const l = c.Labels ?? {}
    const proj = l['com.docker.compose.project']
    const dir = l['com.docker.compose.project.working_dir']
    if (!proj || !dir) continue
    const m = dirsByProject.get(proj) ?? new Map<string, number>()
    m.set(dir, (m.get(dir) ?? 0) + 1)
    dirsByProject.set(proj, m)
  }
  const mainDir = new Map<string, string>()
  for (const [proj, m] of dirsByProject) {
    if (m.size < 2) continue
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    mainDir.set(proj, best[0])
  }

  return list
    .map((c): ContainerRow => {
      const o = ownerOf(c.Labels)
      const dir = c.Labels?.['com.docker.compose.project.working_dir'] ?? null
      const ins = inspects[c.Id] ?? null
      const state = c.State ?? 'unknown'
      const running = state === 'running' || state === 'restarting' || state === 'paused'
      const finished = running ? null : parseDockerTime(ins?.State?.FinishedAt)
      const stoppedSince = running ? null : (finished ?? num(c.Created))
      const stoppedDays =
        stoppedSince != null ? Math.max(0, Math.floor((nowS - stoppedSince) / DAY_S)) : null
      const kind = o.stack || o.service ? 'stack' : o.compose_project ? 'compose' : 'none'
      const label =
        kind === 'stack'
          ? `${o.stack ?? '—'}${o.service ? ` / ${o.service}` : ''}`
          : kind === 'compose'
            ? `${o.compose_project}${o.compose_service ? ` / ${o.compose_service}` : ''}`
            : 'No owner'
      const flags: ContainerFlag[] = []
      const name = cname(c)
      if (kind === 'none')
        flags.push({
          code: 'no-owner',
          text: `${name} was started by hand (docker run) and belongs to no stack or compose project. Nothing redeploys or restarts it after a rebuild.`
        })
      if (stoppedDays != null && stoppedDays > STOPPED_FLAG_DAYS)
        flags.push({
          code: 'stopped-long',
          text: `${name} has been stopped for ${stoppedDays} days. It still holds its volumes and a docker container prune would delete it.`
        })
      const proj = o.compose_project
      const expected = proj ? mainDir.get(proj) : undefined
      if (proj && expected && dir && dir !== expected)
        flags.push({
          code: 'compose-foreign-dir',
          text: `Compose project "${proj}" also owns ${name}, but it was started from ${dir}, not ${expected} like the rest of the project. Running docker compose up --remove-orphans from ${expected} would remove ${name}.`
        })
      const created = num(c.Created)
      return {
        id: c.Id,
        name,
        image: c.Image ?? '',
        state,
        status: c.Status ?? '',
        owner: { kind, ...o, label },
        restart_policy: ins?.HostConfig?.RestartPolicy
          ? ins.HostConfig.RestartPolicy.Name || 'no'
          : null,
        created,
        age_s: created != null ? Math.max(0, nowS - created) : null,
        stopped_since: stoppedSince,
        stopped_days: stoppedDays,
        working_dir: dir,
        flags
      }
    })
    .sort(
      (a, b) =>
        b.flags.length - a.flags.length ||
        a.owner.label.localeCompare(b.owner.label) ||
        a.name.localeCompare(b.name)
    )
}

// --- #2832 volumes ----------------------------------------------------------------------------

export type VolumeFlagCode = 'orphaned' | 'unbacked-in-use'

export interface VolumeRow {
  name: string
  kind: 'volume' | 'bind'
  driver: string | null
  anonymous: boolean
  size_bytes: number | null
  ref_count: number
  owner: string | null
  containers: string[]
  orphaned: boolean
  last_write: number | null
  backup: 'label' | 'env' | 'none'
  flags: Array<{ code: VolumeFlagCode; text: string }>
}

export interface VolumeInventory {
  volumes: VolumeRow[]
  reclaimable_bytes: number
  orphan_count: number
  last_write_known: boolean
}

export function deriveVolumes(
  df: EngineDf,
  containers: EngineContainer[],
  opts: { backedUp: string[]; lastWrite: Record<string, number> | null }
): VolumeInventory {
  const users = new Map<string, Set<string>>()
  const binds = new Map<string, Set<string>>()
  const ownerHint = new Map<string, string>()
  for (const c of containers) {
    const o = ownerOf(c.Labels)
    const label = o.stack ?? o.compose_project ?? null
    for (const m of c.Mounts ?? []) {
      if (m.Type === 'volume' && m.Name) {
        const s = users.get(m.Name) ?? new Set<string>()
        s.add(cname(c))
        users.set(m.Name, s)
        if (label && !ownerHint.has(m.Name)) ownerHint.set(m.Name, label)
      } else if (m.Type === 'bind' && m.Source) {
        const s = binds.get(m.Source) ?? new Set<string>()
        s.add(cname(c))
        binds.set(m.Source, s)
      }
    }
  }
  const lw = opts.lastWrite
  const rows: VolumeRow[] = []

  for (const v of df.Volumes ?? []) {
    const labels = v.Labels ?? {}
    const l = ownerOf(labels)
    const owner = l.stack ?? l.compose_project ?? ownerHint.get(v.Name) ?? null
    const refs = v.UsageData?.RefCount
    const using = [...(users.get(v.Name) ?? [])].sort()
    const refCount = typeof refs === 'number' && refs >= 0 ? refs : using.length
    const orphaned = refCount === 0 && using.length === 0
    const size = num(v.UsageData?.Size) // -1 = not computed
    const backup: VolumeRow['backup'] =
      labels['nivaro.backup'] === 'true'
        ? 'label'
        : matchesAnyGlob(v.Name, opts.backedUp)
          ? 'env'
          : 'none'
    const flags: VolumeRow['flags'] = []
    if (orphaned)
      flags.push({
        code: 'orphaned',
        text: `${v.Name} is used by no container${size != null ? ` and holds ${size} bytes` : ''}.`
      })
    if (!orphaned && backup === 'none')
      flags.push({
        code: 'unbacked-in-use',
        text: `${v.Name} is in use by ${using.join(', ') || `${refCount} container(s)`} and is not listed as backed up (INFRA_BACKED_UP_VOLUMES or the nivaro.backup=true label).`
      })
    rows.push({
      name: v.Name,
      kind: 'volume',
      driver: v.Driver ?? null,
      anonymous: /^[0-9a-f]{64}$/.test(v.Name),
      size_bytes: size,
      ref_count: refCount,
      owner,
      containers: using,
      orphaned,
      last_write: lw?.[v.Name] ?? null,
      backup,
      flags
    })
  }

  for (const [src, set] of binds) {
    const using = [...set].sort()
    const backup: VolumeRow['backup'] = matchesAnyGlob(src, opts.backedUp) ? 'env' : 'none'
    rows.push({
      name: src,
      kind: 'bind',
      driver: null,
      anonymous: false,
      size_bytes: null,
      ref_count: using.length,
      owner: null,
      containers: using,
      orphaned: false,
      last_write: null,
      backup,
      flags:
        backup === 'none'
          ? [
              {
                code: 'unbacked-in-use',
                text: `${src} is bind-mounted by ${using.join(', ')} and is not listed as backed up (INFRA_BACKED_UP_VOLUMES).`
              }
            ]
          : []
    })
  }

  rows.sort(
    (a, b) =>
      Number(b.orphaned) - Number(a.orphaned) ||
      (b.orphaned && a.orphaned ? (b.size_bytes ?? 0) - (a.size_bytes ?? 0) : 0) ||
      b.flags.length - a.flags.length ||
      (b.size_bytes ?? -1) - (a.size_bytes ?? -1) ||
      a.name.localeCompare(b.name)
  )
  const orphans = rows.filter((r) => r.orphaned)
  return {
    volumes: rows,
    reclaimable_bytes: orphans.reduce((s, r) => s + (r.size_bytes ?? 0), 0),
    orphan_count: orphans.length,
    last_write_known: lw != null
  }
}

// --- #2833 images, build cache, prune preview -------------------------------------------------

export interface ImageRow {
  id: string
  tags: string[]
  size_bytes: number
  shared_bytes: number | null
  unique_bytes: number
  containers: number
  created: number | null
  status: 'in-use' | 'unused' | 'dangling'
}

export interface PruneItem {
  name: string
  detail: string
  bytes: number | null
}

export interface ImageInventory {
  images: ImageRow[]
  totals: {
    in_use: { count: number; bytes: number }
    unused: { count: number; bytes: number }
    dangling: { count: number; bytes: number }
    layers_bytes: number | null
  }
  build_cache: { total_bytes: number; reclaimable_bytes: number; entries: number }
  prune: {
    stopped_containers: PruneItem[]
    dangling_images: PruneItem[]
    unused_networks: PruneItem[]
    build_cache: { bytes: number; entries: number }
    /** Extra with `docker system prune -a`. */
    unused_images: PruneItem[]
    plain_bytes: number
    all_bytes: number
  }
}

const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none', 'ingress', 'docker_gwbridge'])

export function deriveImages(
  df: EngineDf,
  containers: EngineContainer[],
  networks: EngineNetwork[]
): ImageInventory {
  const usedBy = new Map<string, number>()
  for (const c of containers) if (c.ImageID) usedBy.set(c.ImageID, (usedBy.get(c.ImageID) ?? 0) + 1)

  const images: ImageRow[] = (df.Images ?? []).map((i) => {
    const n = Math.max(num(i.Containers) ?? 0, usedBy.get(i.Id) ?? 0)
    const dangling = isDangling(i)
    const size = num(i.Size) ?? 0
    const shared = num(i.SharedSize)
    return {
      id: i.Id,
      tags: (i.RepoTags ?? []).filter((t) => t && t !== '<none>:<none>'),
      size_bytes: size,
      shared_bytes: shared,
      unique_bytes: shared != null ? Math.max(0, size - shared) : size,
      containers: n,
      created: num(i.Created),
      status: n > 0 ? 'in-use' : dangling ? 'dangling' : 'unused'
    }
  })
  images.sort((a, b) => b.unique_bytes - a.unique_bytes)
  const sum = (s: ImageRow['status']) => {
    const rows = images.filter((i) => i.status === s)
    return { count: rows.length, bytes: rows.reduce((t, r) => t + r.unique_bytes, 0) }
  }

  const bc = df.BuildCache ?? []
  const bcTotal = bc.reduce((s, b) => s + (num(b.Size) ?? 0), 0)
  const bcFree = bc.filter((b) => !b.InUse)
  const bcReclaim = bcFree.reduce((s, b) => s + (num(b.Size) ?? 0), 0)

  const stopped: PruneItem[] = containers
    .filter((c) => c.State !== 'running' && c.State !== 'restarting' && c.State !== 'paused')
    .map((c) => ({
      name: cname(c),
      detail: `${c.State ?? 'stopped'} · ${c.Status ?? ''}`.trim(),
      bytes: null
    }))
  const dangling: PruneItem[] = images
    .filter((i) => i.status === 'dangling')
    .map((i) => ({
      name: i.id.replace(/^sha256:/, '').slice(0, 12),
      detail: 'no tag',
      bytes: i.unique_bytes
    }))
  const unusedImgs: PruneItem[] = images
    .filter((i) => i.status === 'unused')
    .map((i) => ({
      name: i.tags[0] ?? i.id.slice(7, 19),
      detail: 'no container',
      bytes: i.unique_bytes
    }))

  const netInUse = new Set<string>()
  for (const c of containers)
    for (const n of Object.keys(c.NetworkSettings?.Networks ?? {})) netInUse.add(n)
  const unusedNets: PruneItem[] = networks
    .filter(
      (n) =>
        !BUILTIN_NETWORKS.has(n.Name) &&
        n.Scope !== 'swarm' &&
        !netInUse.has(n.Name) &&
        Object.keys(n.Containers ?? {}).length === 0
    )
    .map((n) => ({ name: n.Name, detail: n.Driver ?? '', bytes: null }))

  const plain = dangling.reduce((s, i) => s + (i.bytes ?? 0), 0) + bcReclaim
  const all = plain + unusedImgs.reduce((s, i) => s + (i.bytes ?? 0), 0)
  return {
    images,
    totals: {
      in_use: sum('in-use'),
      unused: sum('unused'),
      dangling: sum('dangling'),
      layers_bytes: num(df.LayersSize)
    },
    build_cache: { total_bytes: bcTotal, reclaimable_bytes: bcReclaim, entries: bc.length },
    prune: {
      stopped_containers: stopped,
      dangling_images: dangling,
      unused_networks: unusedNets,
      build_cache: { bytes: bcReclaim, entries: bcFree.length },
      unused_images: unusedImgs,
      plain_bytes: plain,
      all_bytes: all
    }
  }
}

// --- #2840 provenance -------------------------------------------------------------------------

export type ProvenanceFlagCode = 'latest-tag' | 'untagged' | 'no-revision'

export interface ProvenanceRow {
  container: string
  state: string
  image: string
  repo: string
  tag: string | null
  digest: string | null
  revision: string | null
  revision_url: string | null
  version: string | null
  built: number | null
  age_s: number | null
  own: boolean
  releases_behind: { kind: 'patch' | 'minor' | 'major'; n: number } | null
  ahead: boolean
  flags: Array<{ code: ProvenanceFlagCode; text: string }>
}

const OCI = {
  revision: 'org.opencontainers.image.revision',
  version: 'org.opencontainers.image.version',
  created: 'org.opencontainers.image.created',
  source: 'org.opencontainers.image.source'
}

function semver(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** How far a running version trails the reference one, in the coarsest unit that differs. */
export function releasesBehind(
  running: string | null,
  current: string
): { behind: ProvenanceRow['releases_behind']; ahead: boolean } {
  const a = semver(running)
  const b = semver(current)
  if (!a || !b) return { behind: null, ahead: false }
  for (let i = 0; i < 3; i++) {
    if (a[i] === b[i]) continue
    if (a[i] > b[i]) return { behind: null, ahead: true }
    return {
      behind: { kind: (['major', 'minor', 'patch'] as const)[i], n: b[i] - a[i] },
      ahead: false
    }
  }
  return { behind: null, ahead: false }
}

export function revisionUrl(source: string | undefined, rev: string | null): string | null {
  if (!source || !rev) return null
  const s = source
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  return /^https?:\/\/[^\s]+$/i.test(s) ? `${s}/commit/${rev}` : null
}

export function deriveProvenance(
  containers: EngineContainer[],
  images: EngineImage[],
  opts: { ownImages: string[]; ownVersion: string; nowS: number }
): ProvenanceRow[] {
  const byId = new Map(images.map((i) => [i.Id, i]))
  const rows: ProvenanceRow[] = []
  for (const c of containers) {
    if (c.State !== 'running' && c.State !== 'restarting') continue
    const img = c.ImageID ? byId.get(c.ImageID) : undefined
    const labels = img?.Labels ?? {}
    const { repo, tag } = imageRepo(c.Image)
    const hasOci = !!(labels[OCI.revision] || labels[OCI.version] || labels[OCI.created])
    const configured = opts.ownImages.some((p) => repo === p || repo.startsWith(p))
    if (!hasOci && !configured) continue

    const revision = labels[OCI.revision] ?? null
    const version = labels[OCI.version] ?? null
    const built = parseDockerTime(labels[OCI.created]) ?? num(img?.Created)
    const isNivaro = /(^|\/)nivaro$/.test(repo)
    const rb = isNivaro ? releasesBehind(version, opts.ownVersion) : { behind: null, ahead: false }
    const digestFull =
      (img?.RepoDigests ?? []).find((d) => d.startsWith(`${repo}@`)) ??
      img?.RepoDigests?.[0] ??
      null
    const untagged =
      !c.Image || /^sha256:|^[0-9a-f]{12,64}$/.test(c.Image) || (img ? isDangling(img) : false)
    const own = configured
    const flags: ProvenanceRow['flags'] = []
    const nm = cname(c)
    if (own && tag === 'latest')
      flags.push({
        code: 'latest-tag',
        text: `${nm} runs ${repo}:latest, so what is deployed depends on when the image was last pulled. Pin a version tag.`
      })
    if (own && untagged)
      flags.push({
        code: 'untagged',
        text: `${nm} runs an untagged image (${c.Image || c.ImageID?.slice(7, 19)}). It cannot be traced to a release.`
      })
    if (own && !revision)
      flags.push({
        code: 'no-revision',
        text: `${nm} runs an image with no revision label. It was not built by the release pipeline.`
      })
    rows.push({
      container: nm,
      state: c.State ?? '',
      image: c.Image ?? '',
      repo,
      tag,
      digest: digestFull ? digestFull.slice(digestFull.indexOf('@') + 1) : null,
      revision,
      revision_url: revisionUrl(labels[OCI.source], revision),
      version,
      built,
      age_s: built != null ? Math.max(0, opts.nowS - built) : null,
      own,
      releases_behind: rb.behind,
      ahead: rb.ahead,
      flags
    })
  }
  return rows.sort(
    (a, b) =>
      b.flags.length - a.flags.length ||
      (b.releases_behind ? 1 : 0) - (a.releases_behind ? 1 : 0) ||
      a.container.localeCompare(b.container)
  )
}

// --- loaders (one host) -----------------------------------------------------------------------

const nowS = () => Math.floor(Date.now() / 1000)

async function listContainers(host: DockerHost): Promise<EngineContainer[]> {
  return dockerGet<EngineContainer[]>(host, '/containers/json', { query: { all: 1 } })
}

async function inspectMany(
  host: DockerHost,
  ids: string[]
): Promise<Record<string, EngineInspect | null>> {
  const out: Record<string, EngineInspect | null> = {}
  let i = 0
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++]
      try {
        out[id] = await dockerGet<EngineInspect>(host, `/containers/${id}/json`, {
          cacheMs: 60_000
        })
      } catch {
        out[id] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker))
  return out
}

export async function loadContainers(host: DockerHost): Promise<ContainerRow[]> {
  const list = await listContainers(host)
  const inspects = await inspectMany(
    host,
    list.map((c) => c.Id)
  )
  return deriveContainers(list, inspects, nowS())
}

async function volumeLastWrite(host: string): Promise<Record<string, number> | null> {
  if (!storeEnabled()) return null
  try {
    const rows = await metricsQuery('nivaro_host_volume_last_write_seconds')
    const out: Record<string, number> = {}
    let seen = false
    for (const r of rows) {
      if (r.labels.host !== host || !r.labels.volume || !Number.isFinite(r.value)) continue
      out[r.labels.volume] = r.value
      seen = true
    }
    return seen ? out : null
  } catch {
    return null
  }
}

export async function loadVolumes(host: DockerHost): Promise<VolumeInventory> {
  const [df, containers, lastWrite] = await Promise.all([
    dockerGet<EngineDf>(host, '/system/df', { cacheMs: 30_000 }),
    listContainers(host),
    volumeLastWrite(host.name)
  ])
  return deriveVolumes(df, containers, { backedUp: envList('INFRA_BACKED_UP_VOLUMES'), lastWrite })
}

export async function loadImages(host: DockerHost): Promise<ImageInventory> {
  const [df, containers, networks] = await Promise.all([
    dockerGet<EngineDf>(host, '/system/df', { cacheMs: 30_000 }),
    listContainers(host),
    dockerGet<EngineNetwork[]>(host, '/networks')
  ])
  return deriveImages(df, containers, networks)
}

export async function loadProvenance(host: DockerHost): Promise<ProvenanceRow[]> {
  const [containers, images] = await Promise.all([
    listContainers(host),
    dockerGet<EngineImage[]>(host, '/images/json')
  ])
  return deriveProvenance(containers, images, {
    ownImages: envList('INFRA_OWN_IMAGES'),
    ownVersion: NIVARO_VERSION,
    nowS: nowS()
  })
}
