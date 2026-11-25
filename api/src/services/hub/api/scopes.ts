import { hubModeEnabled } from '../mode.js'

/**
 * The Hub's API-key scope family (Hub mode only). Stored like the chat scope: one scope entry on
 * the key, `{ collection: '$hub', actions: ['read'] }` (= hub:read) or `['read', 'write']`
 * (= hub:write). `*` on a key never implies it: a key reaches the Hub only when it was given
 * Hub access on purpose.
 */
export const HUB_KEY_SCOPE = '$hub'

export type HubScopeLevel = 'none' | 'read' | 'write'

interface ScopeLike {
  collection: string
  actions: string[]
}

/** What a key's scope list allows on the Hub. write implies read. */
export function hubScopeLevel(scopes: ScopeLike[] | null | undefined): HubScopeLevel {
  const entry = (scopes ?? []).find((s) => s?.collection === HUB_KEY_SCOPE)
  const actions = Array.isArray(entry?.actions) ? entry.actions : []
  if (actions.includes('*') || actions.includes('write')) return 'write'
  return actions.includes('read') ? 'read' : 'none'
}

/** The scope entry for a level (none = no entry). */
export function hubScopeEntry(level: HubScopeLevel): ScopeLike | null {
  if (level === 'none') return null
  return { collection: HUB_KEY_SCOPE, actions: level === 'write' ? ['read', 'write'] : ['read'] }
}

/**
 * Refusal for a key's scope list on save (POST/PATCH /api/api-keys), else null: a Hub scope only
 * on a Hub, and only the actions `read` / `write`.
 */
export function hubScopeRefusal(
  scopes: ScopeLike[],
  env: NodeJS.ProcessEnv = process.env,
  stored: ScopeLike[] | null = null
): { code: string; error: string } | null {
  const entries = scopes.filter((s) => s.collection === HUB_KEY_SCOPE)
  if (entries.length === 0) return null
  // A key that already carries this Hub scope (made while the install was a Hub) keeps it when
  // another of its scopes is edited; nothing new is granted.
  const same = (a: ScopeLike[]) =>
    JSON.stringify(a.filter((s) => s.collection === HUB_KEY_SCOPE)) === JSON.stringify(entries)
  if (!hubModeEnabled(env) && stored && same(stored)) return null
  if (!hubModeEnabled(env))
    return {
      code: 'HUB_SCOPE_NOT_HERE',
      error: 'Hub scopes exist only on a Nivaro Hub (HUB=on).'
    }
  if (entries.length > 1) return { code: 'BAD_HUB_SCOPE', error: 'Give a key one Hub scope entry.' }
  if (!entries[0].actions.length || entries[0].actions.some((a) => a !== 'read' && a !== 'write'))
    return { code: 'BAD_HUB_SCOPE', error: 'Hub scope actions are read and write.' }
  return null
}
