import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #1089 — the loaded build's identity (≤64 chars, trimmed): the extension's own `build`
 * export, else the `.release-sha` beside it. A leaf module (node built-ins only) so it can be
 * read and tested without loading the extension loader's whole module graph.
 */
export function resolveExtensionBuild(declared: unknown, dirPath: string): string | null {
  const clean = (v: unknown) => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t ? t.slice(0, 64) : null
  }
  const fromExport = clean(declared)
  if (fromExport) return fromExport
  try {
    const p = join(dirPath, '.release-sha')
    return existsSync(p) ? clean(readFileSync(p, 'utf-8')) : null
  } catch {
    return null
  }
}
