import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { describeExtensionEnv, extensionEnvDecls } from '../extensions/loader.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { instanceKey } from '../services/settings-overrides.js'

/**
 * #1047 — environment variable PRESENCE compared across environments.
 *
 * The class of bug: a variable set on staging and missing on production
 * (EFP_NUVOLO_USER, EFP_OPS_TAKEOVER) — the deploy is healthy and the feature
 * behind the variable silently does nothing. Every loaded extension declares
 * the variables it reads (its `env` manifest, #805); this answers, per
 * registered API component, which of them are set — names and set / unset
 * only, NEVER a value, not even masked (a mask still says "same length").
 *
 *   GET /environments/env-presence/local   this instance's answer (what the
 *                                          comparison asks every other one)
 *   GET /environments/env-presence         every API component side by side,
 *                                          with a sentence per variable whose
 *                                          presence differs
 */

export interface PresenceVar {
  extension: string
  name: string
  required: boolean
  secret: boolean
  description?: string
  set: boolean
}

/** This process: every declared variable of every loaded extension. */
export function localPresence(): PresenceVar[] {
  const out: PresenceVar[] = []
  for (const ext of [...extensionEnvDecls.keys()].sort()) {
    for (const d of describeExtensionEnv(ext)) {
      out.push({
        extension: ext,
        name: d.name,
        required: d.required === true,
        secret: d.secret === true,
        ...(d.description ? { description: d.description } : {}),
        set: d.set
      })
    }
  }
  return out
}

export interface PresenceColumn {
  id: number | 'local'
  name: string
  environment: string | null
  state: 'ok' | 'no-token' | 'unreachable' | 'not-supported'
  note?: string
  /** `<extension>/<NAME>` → set? Only for state 'ok'. */
  set: Record<string, boolean>
  /** Extensions loaded there (a missing extension is not a missing variable). */
  extensions: string[]
}

export interface PresenceRow {
  key: string
  extension: string
  name: string
  required: boolean
  secret: boolean
  description?: string
  differs: boolean
}

const label = (c: PresenceColumn) => c.environment ?? c.name

/**
 * Pure: rows + one sentence per variable whose presence differs between the
 * columns that answered and that load the extension. "set on staging, missing
 * on production" is the sentence the page leads with.
 */
export function comparePresence(
  columns: PresenceColumn[],
  declared: PresenceVar[]
): { rows: PresenceRow[]; warnings: string[] } {
  const byKey = new Map<string, PresenceRow>()
  const add = (v: Omit<PresenceVar, 'set'>) => {
    const key = `${v.extension}/${v.name}`
    if (!byKey.has(key))
      byKey.set(key, {
        key,
        extension: v.extension,
        name: v.name,
        required: v.required,
        secret: v.secret,
        ...(v.description ? { description: v.description } : {}),
        differs: false
      })
  }
  for (const v of declared) add(v)
  for (const c of columns)
    for (const key of Object.keys(c.set)) {
      const [extension, name] = key.split('/')
      if (extension && name) add({ extension, name, required: false, secret: false })
    }

  const warnings: string[] = []
  const rows = [...byKey.values()].sort(
    (a, b) => a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name)
  )
  for (const r of rows) {
    // Only columns that DECLARE the variable are judged: an instance without
    // the extension, or on a build that does not read the variable yet, has
    // nothing to be missing.
    const judged = columns.filter((c) => c.state === 'ok' && r.key in c.set)
    const on = judged.filter((c) => c.set[r.key] === true)
    const off = judged.filter((c) => c.set[r.key] !== true)
    r.differs = on.length > 0 && off.length > 0
    if (r.differs) {
      warnings.push(
        `${r.name} (${r.extension}) is set on ${on.map(label).join(', ')}, missing on ${off.map(label).join(', ')}${r.required ? ' — the extension requires it' : ''}`
      )
    }
  }
  return { rows, warnings }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { ok: res.ok, status: res.status, body }
}

export async function envPresenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/env-presence/local', async () => ({
    data: { instance: instanceKey(), vars: localPresence() }
  }))

  app.get('/env-presence', async () => {
    const envs = (await db('nivaro_environments').orderBy('sort').orderBy('id')) as Array<{
      id: number
      name: string
    }>
    const comps = (
      (await db('nivaro_environment_components')
        .where('kind', 'api')
        .orderBy('sort')
        .orderBy('id')) as Array<{
        id: number
        environment: number
        name: string
        base_url: string | null
        api_token: string | null
      }>
    ).filter((c) => !!c.base_url)

    const mine = localPresence()
    const toSet = (vars: PresenceVar[]) =>
      Object.fromEntries(vars.map((v) => [`${v.extension}/${v.name}`, v.set === true]))
    const columns: PresenceColumn[] = [
      {
        id: 'local',
        name: 'This instance',
        environment: instanceKey(),
        state: 'ok',
        set: toSet(mine),
        extensions: [...extensionEnvDecls.keys()]
      }
    ]
    await Promise.all(
      comps.map(async (c) => {
        const col: PresenceColumn = {
          id: c.id,
          name: c.name,
          environment: envs.find((e) => e.id === c.environment)?.name ?? null,
          state: 'ok',
          set: {},
          extensions: []
        }
        columns.push(col)
        if (!c.api_token) {
          col.state = 'no-token'
          col.note = 'No API token on this component'
          return
        }
        const base = String(c.base_url).replace(/\/+$/, '')
        try {
          const res = await fetchJson(`${base}/api/environments/env-presence/local`, {
            authorization: `Bearer ${c.api_token}`
          })
          if (res.status === 404) {
            col.state = 'not-supported'
            col.note = 'That instance runs a version without this check'
            return
          }
          if (!res.ok) {
            col.state = 'unreachable'
            col.note =
              res.status === 401 || res.status === 403
                ? `The component's API token was refused (HTTP ${res.status})`
                : `HTTP ${res.status}`
            return
          }
          const vars = (res.body as { data?: { vars?: PresenceVar[] } })?.data?.vars ?? []
          col.set = toSet(vars)
          col.extensions = [...new Set(vars.map((v) => v.extension))]
        } catch (err) {
          col.state = 'unreachable'
          col.note = err instanceof Error ? err.message : String(err)
        }
      })
    )
    // Stable column order: this instance, then the registry's order.
    const order = new Map<number | 'local', number>([['local', -1]])
    for (const [i, c] of comps.entries()) order.set(c.id, i)
    columns.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    const { rows, warnings } = comparePresence(columns, mine)
    return { data: { rows, columns, warnings } }
  })
}
