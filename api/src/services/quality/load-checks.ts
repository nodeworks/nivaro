import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { QualityCheck, QualityCheckModule } from '@nivaro/extension-kit'

/**
 * Collects the quality checks every extension declares. An extension's default
 * export names its module in `quality_checks` (a path from the api root, inside
 * its own folder); that module exports the checks as `default` or `qualityChecks`.
 * Mirrors how the runbook agent reads `runbooks`.
 */

export const QUALITY_CHECK_ID = /^[a-z][a-z0-9_.-]{1,80}$/
const MODULE_PATH = /^extensions\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_./-]+\.(ts|js)$/

/** The file to import for a declared path: the declared one, else its .ts/.js twin (built image). */
function resolveModule(apiRoot: string, declared: string): string | null {
  const full = resolve(apiRoot, declared)
  if (existsSync(full)) return full
  const twin = full.replace(/\.(ts|js)$/, (m) => (m === '.ts' ? '.js' : '.ts'))
  return existsSync(twin) ? twin : null
}

function isCheck(c: unknown): c is QualityCheck {
  const q = c as Partial<QualityCheck> | null
  return (
    !!q &&
    typeof q.id === 'string' &&
    typeof q.baseline === 'function' &&
    typeof q.current === 'function'
  )
}

export async function loadQualityChecks(
  extensionsDir: string,
  log: (message: string) => void = (m) => process.stderr.write(`[quality] ${m}\n`)
): Promise<QualityCheck[]> {
  const out: QualityCheck[] = []
  const seen = new Set<string>()
  const apiRoot = dirname(resolve(extensionsDir))
  let entries: string[] = []
  try {
    entries = (await readdir(extensionsDir)).sort()
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || /\.(next|prev)$/.test(entry)) continue
    const index = ['index.ts', 'index.js']
      .map((n) => join(extensionsDir, entry, n))
      .find(existsSync)
    if (!index) continue
    let declared: unknown
    try {
      const mod = (await import(index)) as { default?: { quality_checks?: unknown } }
      declared = mod.default?.quality_checks
    } catch (err) {
      log(`could not read ${entry}: ${(err as Error).message}`)
      continue
    }
    if (declared === undefined || declared === null) continue
    const m = typeof declared === 'string' ? MODULE_PATH.exec(declared) : null
    if (!m || declared.toString().split('/').includes('..') || m[1] !== entry) {
      log(`${entry}: quality_checks must be a path inside extensions/${entry}/ (.ts or .js)`)
      continue
    }
    const file = resolveModule(apiRoot, declared as string)
    if (!file?.startsWith(resolve(extensionsDir, entry) + sep)) {
      log(`${entry}: quality_checks module not found: ${declared}`)
      continue
    }
    let list: unknown
    try {
      const mod = (await import(file)) as QualityCheckModule
      list = mod.default ?? mod.qualityChecks
    } catch (err) {
      log(`${entry}: could not load ${declared}: ${(err as Error).message}`)
      continue
    }
    if (!Array.isArray(list)) {
      log(`${entry}: ${declared} exports no check list`)
      continue
    }
    for (const c of list) {
      if (!isCheck(c) || !QUALITY_CHECK_ID.test(c.id)) {
        log(`${entry}: skipped a check with a bad id or no baseline/current`)
        continue
      }
      if (seen.has(c.id)) {
        log(`${entry}: duplicate check id ${c.id} — keeping the first`)
        continue
      }
      seen.add(c.id)
      out.push(c)
    }
  }
  return out
}
