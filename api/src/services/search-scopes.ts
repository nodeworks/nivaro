import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { normalizeScopes, PEOPLE_SCOPE } from './search-query.js'
import { overlaySettings } from './settings-overrides.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Search prefix scopes (`wf: canton`, `@jane`) — CONFIG, never collection names
 * written into core. Layers, later wins:
 *
 *  1. `@` → people (always).
 *  2. Defaults an extension registers (`registerSearchScopes({ wf: 'workflows' })`).
 *  3. `nivaro_settings.search_scopes` (JSON `{ "wf": "workflows", … }`) — read only
 *     when an instance has added that column; no migration ships it.
 *  4. The `search_scopes` key of this instance's `nivaro_settings_overrides` row or
 *     NIVARO_SETTINGS_OVERRIDES (the ordinary overlay, settings-overrides.ts).
 *
 * A value of "" removes a prefix a lower layer set. Cached 30 s per tenant.
 */

const registered: Record<string, string> = {}

export function registerSearchScopes(map: Record<string, string>): void {
  Object.assign(registered, normalizeScopes(map))
  cache.clear()
}

const cache = new Map<string, { at: number; value: Promise<Record<string, string>> }>()

function removals(raw: unknown): string[] {
  let obj = raw
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj)
    } catch {
      return []
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  return Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v === '' || v === null)
    .map(([k]) => k.trim().toLowerCase().replace(/:$/, ''))
}

export function mergeScopeLayers(layers: unknown[]): Record<string, string> {
  const out: Record<string, string> = { '@': PEOPLE_SCOPE }
  for (const layer of layers) {
    for (const k of removals(layer)) if (k !== '@') delete out[k]
    Object.assign(out, normalizeScopes(layer))
  }
  return out
}

export function loadSearchScopes(): Promise<Record<string, string>> {
  const key = currentTenantKey()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  const value = (async () => {
    let row: Record<string, unknown> = {}
    try {
      if (await hasColumn('nivaro_settings', 'search_scopes')) {
        row =
          ((await db('nivaro_settings').where('id', 1).first('search_scopes')) as
            | Record<string, unknown>
            | undefined) ?? {}
      }
    } catch {
      row = {}
    }
    const shared = row.search_scopes ?? null
    const overlaid = (await overlaySettings({ search_scopes: shared })) as {
      search_scopes?: unknown
    }
    const instance = overlaid.search_scopes !== shared ? overlaid.search_scopes : null
    return mergeScopeLayers([registered, shared, instance])
  })().catch(() => mergeScopeLayers([registered]))
  cache.set(key, { at: Date.now(), value })
  return value
}
