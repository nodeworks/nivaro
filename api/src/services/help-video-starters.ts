import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  HelpVideoContextDecl,
  HelpVideoPageDecl,
  HelpVideoStarterDef
} from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import type { PackageContext } from './help-video-package-manifest.js'

// ctx.helpVideos (#1514): what an extension declares about help videos.
//
//   declarePage      → a row in nivaro_help_video_pages (the registry the
//                      Videos button and the editor's "Where" picker use).
//   registerStarter  → a help-video package (tar) inside the extension folder;
//                      each video in it is imported ONCE per database as a
//                      DRAFT (never published, authors only, never required).
//   addContexts      → more screens for one starter video, added when it is
//                      imported.
//
// Declarations are validated here and a bad one is logged and skipped —
// never a throw out of register(). The writes happen after register()
// returns (`applyExtensionHelpVideos`), in the background, self-hosted only.
//
// Once per database: a video id that is already here is left alone, and so
// is one that was imported before and deleted since (the import leaves a
// `help-video-starter-import` activity row naming the id — that row is the
// ledger, so a second boot reads it and does nothing).
//
// The extension loader imports this module, so the help-video services are
// loaded lazily, only when there is something to write.

const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const STARTER_ACTIVITY = 'help-video-starter-import'

interface Starter {
  def: HelpVideoStarterDef
  path: string
  extDir: string
}
interface ExtRegs {
  pages: Array<{ key: string; label: string; app: string | null }>
  starters: Starter[]
  contexts: Map<string, PackageContext[]>
}
const regs = new Map<string, ExtRegs>()
const running = new Set<string>()

function regsFor(extId: string): ExtRegs {
  let r = regs.get(extId)
  if (!r) {
    r = { pages: [], starters: [], contexts: new Map() }
    regs.set(extId, r)
  }
  return r
}

/** Forget an extension's declarations (before it registers again). */
export function clearHelpVideoRegistrations(extId: string): void {
  regs.delete(extId)
}

export function declareHelpVideoPage(extId: string, def: HelpVideoPageDecl): string {
  const key = String(def?.key ?? '')
  if (!KEY_RE.test(key)) throw new Error(`Invalid page key: ${key}`)
  const label = String(def?.label ?? '').trim()
  if (!label) throw new Error(`Page ${key} needs a label`)
  const app = def.app ? String(def.app).slice(0, 50) : null
  const r = regsFor(extId)
  r.pages = r.pages.filter((p) => p.key !== key)
  r.pages.push({ key, label: label.slice(0, 200), app })
  return key
}

/** The package path resolved inside the extension folder; anything that
 *  climbs out of it (or is absolute) is refused. */
export function resolveStarterPath(extDir: string, file: string): string {
  const raw = String(file ?? '')
  if (!raw || isAbsolute(raw)) throw new Error('The package path must be relative to the extension')
  const abs = resolve(extDir, raw)
  const rel = relative(extDir, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`The package path must stay inside the extension folder: ${raw}`)
  }
  return abs
}

export function registerHelpVideoStarter(
  extId: string,
  extDir: string | undefined,
  def: HelpVideoStarterDef
): string {
  if (!extDir) throw new Error('Starter videos need the extension folder')
  const path = resolveStarterPath(extDir, def?.package)
  const ids =
    def.ids === undefined ? undefined : (def.ids ?? []).map((i) => String(i).toLowerCase())
  if (ids?.some((i) => !UUID_RE.test(i))) throw new Error('Starter ids must be video ids (uuids)')
  const contexts = def.contexts === undefined ? [] : toPackageContexts(def.contexts)
  regsFor(extId).starters.push({ def: { ...def, ids, contexts }, path, extDir })
  return def.package
}

/** The same rules as the editor's "Where": kinds, key shape, at most 50. */
export function toPackageContexts(input: HelpVideoContextDecl[]): PackageContext[] {
  if (!Array.isArray(input)) throw new Error('contexts must be a list')
  if (input.length > 50) throw new Error('A video can show on at most 50 screens')
  const out: PackageContext[] = []
  const seen = new Set<string>()
  for (const c of input) {
    const kind = c?.kind
    const key = String(c?.key ?? '')
    if (kind !== 'collection' && kind !== 'page') throw new Error(`Unknown context kind: ${kind}`)
    if (!KEY_RE.test(key)) throw new Error(`Invalid key: ${key}`)
    const state = kind === 'collection' && c.state_key ? String(c.state_key) : null
    if (state !== null && !KEY_RE.test(state)) throw new Error(`Invalid state: ${state}`)
    const sig = `${kind}|${key}|${state ?? ''}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push({ kind, key, state_key: state })
  }
  return out
}

export function addHelpVideoStarterContexts(
  extId: string,
  videoId: string,
  contexts: HelpVideoContextDecl[]
): string {
  const id = String(videoId ?? '').toLowerCase()
  if (!UUID_RE.test(id)) throw new Error(`Invalid video id: ${videoId}`)
  const r = regsFor(extId)
  r.contexts.set(id, [...(r.contexts.get(id) ?? []), ...toPackageContexts(contexts)])
  return id
}

export function describeHelpVideoRegistrations(extId: string): {
  pages: string[]
  starters: string[]
  contexts: string[]
} {
  const r = regs.get(extId)
  return {
    pages: r?.pages.map((p) => p.key) ?? [],
    starters: r?.starters.map((s) => s.def.package) ?? [],
    contexts: r ? [...r.contexts.keys()] : []
  }
}

/** Ids among `ids` that were imported before (the activity ledger) or that
 *  already exist here. */
async function alreadyHandled(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const done = new Set<string>()
  const existing = (await db('nivaro_help_videos').whereIn('id', ids).select('id')) as Array<{
    id: string
  }>
  for (const r of existing) done.add(String(r.id).toLowerCase())
  const logged = (await db('nivaro_activity')
    .where({ action: STARTER_ACTIVITY, collection: 'nivaro_help_videos' })
    .whereIn('item', ids)
    .select('item')) as Array<{ item: string }>
  for (const r of logged) done.add(String(r.item).toLowerCase())
  return done
}

type Log = {
  info: (o: object, m?: string) => void
  warn: (o: object, m?: string) => void
}

/** Writes an extension's declarations: pages into the page registry, then
 *  each starter package's not-yet-imported videos as drafts. Never throws. */
export async function applyExtensionHelpVideos(extId: string, log: Log): Promise<void> {
  const r = regs.get(extId)
  if (!r || running.has(extId)) return
  running.add(extId)
  try {
    const { registerPage } = await import('./help-videos.js')
    const { importStarterPackage, packageVideoIds } = await import('./help-video-package.js')
    const { logActivity } = await import('./activity.js')
    for (const p of r.pages) {
      await registerPage(p.key, p.label, p.app).catch((err: unknown) =>
        log.warn({ extension: extId, page: p.key, err: (err as Error).message }, 'help-video page')
      )
    }
    for (const st of r.starters) {
      try {
        // A symlink must not lead out of the extension folder either.
        const [real, realDir] = await Promise.all([realpath(st.path), realpath(st.extDir)])
        const rel = relative(realDir, real)
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error('The package leads outside the extension folder')
        }
        if (!(await stat(real)).isFile()) throw new Error('The package is not a file')
        const inPackage = await packageVideoIds(real)
        const wanted = st.def.ids ? inPackage.filter((id) => st.def.ids?.includes(id)) : inPackage
        const done = await alreadyHandled(wanted)
        const todo = wanted.filter((id) => !done.has(id))
        if (!todo.length) continue
        const extra = (st.def.contexts ?? []) as PackageContext[]
        const results = await importStarterPackage(real, {
          onlyIds: todo,
          extraContexts: (id) => [...extra, ...(r.contexts.get(id) ?? [])]
        })
        for (const res of results) {
          if (res.outcome === 'created') {
            await logActivity({
              action: STARTER_ACTIVITY,
              user: null,
              collection: 'nivaro_help_videos',
              item: res.id.toLowerCase(),
              origin: 'machine',
              comment: `${extId} · ${st.def.package} · imported as a draft`.slice(0, 500)
            })
            log.info(
              { extension: extId, video: res.id, title: res.title },
              'Imported a starter help video as a draft'
            )
          } else {
            log.warn(
              { extension: extId, video: res.id, error: res.error ?? res.outcome },
              'Starter help video not imported'
            )
          }
        }
      } catch (err) {
        log.warn(
          { extension: extId, package: st.def.package, err: (err as Error).message },
          'Starter help videos not imported'
        )
      }
    }
  } finally {
    running.delete(extId)
  }
}
