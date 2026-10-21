import { type DockerHost, dockerGet } from '../docker-source.js'
import { type EngineSecret, type EngineService, iso } from './engine.js'
import { loadSwarmObjects } from './stacks.js'

/**
 * #2839 Secret and config usage map: names and metadata ONLY. Swarm secrets are listed from
 * /secrets (the Engine never returns their values). Configs are NEVER read: /configs returns each
 * config's contents, which often hold credentials, so docker-source refuses it. Config names come
 * from the service specs that reference them (TaskTemplate.ContainerSpec.Configs), which means a
 * config no service uses cannot be listed.
 */

export interface SwarmObjectRef {
  service_id: string
  service: string
  target: string | null
}

export interface SwarmObjectVersion {
  id: string
  name: string
  version: number | null
  created_at: string | null
  updated_at: string | null
  stack: string | null
  used_by: SwarmObjectRef[]
  unused: boolean
  latest: boolean
}

export interface SwarmObjectGroup {
  kind: 'secret' | 'config'
  /** swarm = listed from the swarm's objects; service-specs = only names services reference. */
  source: 'swarm' | 'service-specs'
  /** The name without its version suffix (`db_password_v2` → `db_password`). */
  base: string
  versions: SwarmObjectVersion[]
  /** Services still on an older version while a newer one exists. */
  stale: Array<{ service_id: string; service: string; uses: string; latest: string }>
}

export interface HostSecrets {
  manager: boolean
  groups: SwarmObjectGroup[]
  counts: {
    secrets: number
    configs: number
    unused: number
    stale: number
  }
  /** Sections the proxy refused (`secrets`). */
  unavailable: string[]
}

type Meta = {
  ID: string
  CreatedAt?: string
  UpdatedAt?: string
  Name: string
  stack: string | null
}

/** Copies named metadata only — never `Spec.Data`, never anything unlisted. */
export function stripObject(o: EngineSecret): Meta {
  return {
    ID: String(o.ID),
    CreatedAt: o.CreatedAt,
    UpdatedAt: o.UpdatedAt,
    Name: String(o.Spec?.Name ?? o.ID),
    stack: o.Spec?.Labels?.['com.docker.stack.namespace'] ?? null
  }
}

/** `name_v3` / `name-v3` / `name.v3` → { base: name, version: 3 }; otherwise unversioned. */
export function splitVersion(name: string): { base: string; version: number | null } {
  const m = /^(.+?)[_.-]v(\d+)$/i.exec(name)
  return m ? { base: m[1], version: Number(m[2]) } : { base: name, version: null }
}

function dedupeRefs(refs: SwarmObjectRef[]): SwarmObjectRef[] {
  const seen = new Set<string>()
  return refs.filter((r) => {
    const k = `${r.service_id}|${r.target}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function refsFor(services: EngineService[], kind: 'secret' | 'config') {
  const byId = new Map<string, SwarmObjectRef[]>()
  const byName = new Map<string, SwarmObjectRef[]>()
  for (const s of services) {
    const spec = s.Spec?.TaskTemplate?.ContainerSpec
    const list =
      kind === 'secret'
        ? (spec?.Secrets ?? []).map((r) => ({ id: r.SecretID, name: r.SecretName, file: r.File }))
        : (spec?.Configs ?? []).map((r) => ({ id: r.ConfigID, name: r.ConfigName, file: r.File }))
    for (const r of list) {
      const ref = { service_id: s.ID, service: s.Spec?.Name ?? s.ID, target: r.file?.Name ?? null }
      if (r.id) byId.set(r.id, [...(byId.get(r.id) ?? []), ref])
      if (r.name) byName.set(r.name, [...(byName.get(r.name) ?? []), ref])
    }
  }
  return { byId, byName }
}

/** The configs services reference, by id (or name when a spec carries no id); no dates known. */
export function configsFromServices(services: EngineService[]): Meta[] {
  const seen = new Map<string, Meta>()
  for (const s of services)
    for (const r of s.Spec?.TaskTemplate?.ContainerSpec?.Configs ?? []) {
      const name = r.ConfigName ?? r.ConfigID
      if (!name) continue
      const key = r.ConfigID ?? `name:${name}`
      if (!seen.has(key))
        seen.set(key, {
          ID: r.ConfigID ?? name,
          Name: name,
          stack: s.Spec?.Labels?.['com.docker.stack.namespace'] ?? null
        })
    }
  return [...seen.values()]
}

function groupObjects(
  kind: 'secret' | 'config',
  objects: Meta[],
  services: EngineService[]
): SwarmObjectGroup[] {
  const source: SwarmObjectGroup['source'] = kind === 'config' ? 'service-specs' : 'swarm'
  const refs = refsFor(services, kind)
  const groups = new Map<string, SwarmObjectVersion[]>()
  for (const o of objects) {
    const { base, version } = splitVersion(o.Name)
    const used = [...(refs.byId.get(o.ID) ?? []), ...(refs.byName.get(o.Name) ?? [])]
    const list = groups.get(base) ?? []
    list.push({
      id: o.ID,
      name: o.Name,
      version,
      created_at: iso(o.CreatedAt),
      updated_at: iso(o.UpdatedAt),
      stack: o.stack,
      used_by: dedupeRefs(used).sort((a, b) => a.service.localeCompare(b.service)),
      unused: used.length === 0,
      latest: false
    })
    groups.set(base, list)
  }
  return [...groups.entries()]
    .map(([base, versions]) => {
      // Newest first: by version number, then by creation time.
      versions.sort(
        (a, b) =>
          (b.version ?? -1) - (a.version ?? -1) ||
          (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0)
      )
      versions[0].latest = true
      const newest = versions[0]
      const stale = versions.slice(1).flatMap((v) =>
        versions.length > 1
          ? v.used_by.map((r) => ({
              service_id: r.service_id,
              service: r.service,
              uses: v.name,
              latest: newest.name
            }))
          : []
      )
      return { kind, source, base, versions, stale }
    })
    .sort((a, b) => a.base.localeCompare(b.base))
}

export function deriveSecrets(input: {
  secrets: Array<EngineSecret> | null
  services: EngineService[]
}): HostSecrets {
  const secrets = (input.secrets ?? []).map(stripObject)
  const configs = configsFromServices(input.services)
  const groups = [
    ...groupObjects('secret', secrets, input.services),
    ...groupObjects('config', configs, input.services)
  ]
  return {
    manager: true,
    unavailable: [],
    groups,
    counts: {
      secrets: secrets.length,
      configs: configs.length,
      unused: groups.reduce((n, g) => n + g.versions.filter((v) => v.unused).length, 0),
      stale: groups.reduce((n, g) => n + g.stale.length, 0)
    }
  }
}

export async function loadSecrets(host: DockerHost): Promise<HostSecrets> {
  const info = await dockerGet<{ Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean } }>(
    host,
    '/info',
    { cacheMs: 10_000 }
  )
  const swarm = await loadSwarmObjects(host, info)
  if (!swarm)
    return {
      manager: false,
      groups: [],
      counts: { secrets: 0, configs: 0, unused: 0, stale: 0 },
      unavailable: []
    }
  const off: string[] = []
  const secrets = await dockerGet<EngineSecret[]>(host, '/secrets', { cacheMs: 15_000 }).catch(
    () => {
      off.push('secrets')
      return null
    }
  )
  return { ...deriveSecrets({ secrets, services: swarm.services }), unavailable: off }
}
