import type { Collection, FolderOption } from './types'

export interface FolderSuggestion {
  folder: FolderOption
  collections: string[]
  reason: string
}

function singular(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('ses')) return word.slice(0, -2)
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** 'Inventory_Requests' -> ['inventory', 'request'] (singular, lower-case tokens). */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
}

function startsWithTokens(name: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || prefix.length > name.length) return false
  return prefix.every((t, i) => name[i] === t)
}

interface Match {
  folderKey: string
  /** The text the name starts with, shown in the reason. */
  prefix: string
  byCollection: boolean
  size: number
}

/**
 * Loose collections that look like they belong in an existing folder.
 * Pure and deterministic.
 */
export function suggestFolders(
  loose: Collection[],
  folders: FolderOption[],
  all: Collection[]
): FolderSuggestion[] {
  const folderByKey = new Map(folders.map((f) => [f.key, f]))
  const folderIdents = folders.map((f) => ({
    folder: f,
    idents: [
      { text: f.key, tokens: tokens(f.key) },
      { text: f.label, tokens: tokens(f.label) }
    ].filter((i) => i.tokens.length > 0)
  }))
  // Collections already in a folder (not the folder rows themselves).
  const members = all
    .filter((c) => c.group && folderByKey.has(c.group) && !folderByKey.has(c.collection))
    .map((c) => ({ name: c.collection, group: c.group as string, tokens: tokens(c.collection) }))

  const byFolder = new Map<string, { names: string[]; matches: Match[] }>()
  const sorted = [...loose].sort((a, b) => a.collection.localeCompare(b.collection))

  for (const c of sorted) {
    if (folderByKey.has(c.collection)) continue
    const nameTokens = tokens(c.collection)
    let best: Match | null = null

    // (b) starts with the name of a collection already in a folder — longest wins
    for (const m of members) {
      if (m.tokens.length >= nameTokens.length) continue
      if (!startsWithTokens(nameTokens, m.tokens)) continue
      if (!best || !best.byCollection || m.tokens.length > best.size) {
        best = {
          folderKey: m.group,
          prefix: `${m.name}_`,
          byCollection: true,
          size: m.tokens.length
        }
      }
    }

    // (a) first token(s) match a folder key or label — longest wins
    if (!best) {
      for (const { folder, idents } of folderIdents) {
        for (const i of idents) {
          if (!startsWithTokens(nameTokens, i.tokens)) continue
          if (!best || i.tokens.length > best.size) {
            best = {
              folderKey: folder.key,
              prefix: i.text,
              byCollection: false,
              size: i.tokens.length
            }
          }
        }
      }
    }

    if (!best) continue
    const slot = byFolder.get(best.folderKey) ?? { names: [], matches: [] }
    slot.names.push(c.collection)
    slot.matches.push(best)
    byFolder.set(best.folderKey, slot)
  }

  const out: FolderSuggestion[] = []
  for (const [key, { names, matches }] of byFolder) {
    const folder = folderByKey.get(key)
    if (!folder) continue
    if (names.length < 2 && !matches.some((m) => m.byCollection)) continue
    // Most common prefixes first (ties alphabetical), at most two named.
    const counts = new Map<string, number>()
    for (const m of matches) counts.set(m.prefix, (counts.get(m.prefix) ?? 0) + 1)
    const prefixes = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([p]) => p)
    const shown = prefixes.slice(0, 2).join(' or ')
    const more = prefixes.length > 2 ? ' …' : ''
    out.push({
      folder,
      collections: names,
      reason: `Starts with ${shown}${more} (in ${folder.label})`
    })
  }

  return out.sort(
    (a, b) =>
      b.collections.length - a.collections.length || a.folder.label.localeCompare(b.folder.label)
  )
}
