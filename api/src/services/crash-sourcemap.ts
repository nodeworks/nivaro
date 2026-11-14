/**
 * Source-mapped crash stacks (Issue Log → Crashes), server side only.
 *
 * The admin build writes its source maps 'hidden' (admin/vite.config.ts: no sourceMappingURL,
 * and the API never serves *.map unless ADMIN_SOURCEMAPS=public), so a browser's stack names
 * minified frames (`nn (assets/LinesGrid-Ab12cd34.js:1:2345)`). The maps sit beside the bundle on
 * the API's own disk: a frame whose hashed file is there was built from exactly that map (the
 * hash names the build), so no version check is needed. Frames of any other app, or of a build
 * this process does not carry, stay as they are.
 *
 * The client's file name is untrusted: only its base name is used, it must look like a bundle
 * file, and its map must be a plain file directly inside admin/dist/assets (no path segments,
 * no symlink) no larger than 30 MB, checked with lstat BEFORE it is read. Only reports from the
 * admin build this server carries are mapped (crash-tracking.ts), only after the per-person rate
 * limit (routes/issues.ts), only for a NEW issue row, one map decoded at a time, at most 6
 * different bundles per report. Decoded maps stay for the life of the process (a hashed name
 * never changes meaning), at most 12 of them and about 192 MB.
 */
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { CrashFrame } from './crash-signature.js'

const ASSETS_DIR = join(import.meta.dirname, '../../../admin/dist/assets')
const MAX_FRAMES = 10
const MAX_MAPS_PER_REPORT = 6
const KEEP = 12
const MAX_MAP_FILE_BYTES = 30 * 1024 * 1024
const CACHE_BYTE_CAP = 192 * 1024 * 1024

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

/** One generated line: segments [genCol, srcIdx, srcLine, srcCol, nameIdx | -1], by genCol. */
type Line = Int32Array[]

interface DecodedMap {
  sources: string[]
  names: string[]
  lines: Line[]
}

/** Decode a source map v3 `mappings` string (Base64 VLQ). Exported for tests. */
export function decodeMappings(mappings: string): Line[] {
  const lines: Line[] = []
  let line: Line = []
  let srcIdx = 0
  let srcLine = 0
  let srcCol = 0
  let nameIdx = 0
  let genCol = 0
  let i = 0
  const n = mappings.length
  const values: number[] = []
  while (i <= n) {
    const c = mappings[i]
    if (i === n || c === ';' || c === ',') {
      if (values.length >= 1) {
        genCol += values[0]
        if (values.length >= 4) {
          srcIdx += values[1]
          srcLine += values[2]
          srcCol += values[3]
          if (values.length >= 5) nameIdx += values[4]
          line.push(
            Int32Array.of(genCol, srcIdx, srcLine, srcCol, values.length >= 5 ? nameIdx : -1)
          )
        }
      }
      values.length = 0
      if (i === n || c === ';') {
        lines.push(line)
        line = []
        genCol = 0
      }
      i++
      continue
    }
    // One VLQ value.
    let result = 0
    let shift = 0
    let cont = true
    while (cont && i < n) {
      const digit = B64_INDEX.get(mappings[i])
      if (digit == null) return lines
      i++
      cont = (digit & 32) !== 0
      result += (digit & 31) << shift
      shift += 5
    }
    const negative = (result & 1) === 1
    result >>>= 1
    values.push(negative ? -result : result)
  }
  return lines
}

/** The original position of generated (1-based line, 1-based column), or null. */
export function lookup(
  map: DecodedMap,
  line: number,
  column: number | null
): { source: string; line: number; column: number; name: string | null } | null {
  const segs = map.lines[line - 1]
  if (!segs || segs.length === 0) return null
  const col = Math.max(0, (column ?? 1) - 1)
  let best: Int32Array | null = null
  for (const s of segs) {
    if (s[0] <= col) best = s
    else break
  }
  best ??= segs[0]
  const source = map.sources[best[1]]
  if (source == null) return null
  return {
    source: cleanSource(source),
    line: best[2] + 1,
    column: best[3] + 1,
    name: best[4] >= 0 ? (map.names[best[4]] ?? null) : null
  }
}

/** `../../src/pages/Lines.tsx` → `src/pages/Lines.tsx`; node_modules paths keep the package. */
function cleanSource(source: string): string {
  let s = source.replace(/^webpack:\/\/\/?|^file:\/\//, '').replace(/\\/g, '/')
  s = s.replace(/^(?:\.\.?\/)+/, '')
  const nm = s.lastIndexOf('node_modules/')
  if (nm >= 0) s = s.slice(nm)
  return s.slice(0, 200)
}

/**
 * Decoded maps, kept for the life of the process: the hashed file name names one build, so an
 * entry never goes stale. Bounded by count (KEEP) and by an estimate of the memory it holds
 * (CACHE_BYTE_CAP); the oldest go first.
 */
const cache = new Map<string, { value: Promise<DecodedMap | null>; bytes: number }>()
let cachedBytes = 0

function remember(key: string, value: Promise<DecodedMap | null>, bytes: number): void {
  cache.set(key, { value, bytes })
  cachedBytes += bytes
  evict()
}

function evict(): void {
  while (cache.size > KEEP || (cachedBytes > CACHE_BYTE_CAP && cache.size > 1)) {
    const oldest = cache.keys().next().value as string
    cachedBytes -= cache.get(oldest)?.bytes ?? 0
    cache.delete(oldest)
  }
}

/** The base name of a bundle file a frame names, when it looks like one; else null. */
export function bundleBaseName(rawFile: string): string | null {
  const base = basename(String(rawFile ?? '').split(/[?#]/)[0])
  return /^[\w.-]{1,120}\.m?js$/.test(base) && !base.startsWith('.') ? base : null
}

/**
 * The map file for a bundle base name, only when it is a plain file directly inside `dir` (no
 * path segments, no symlink out of it) and not over MAX_MAP_FILE_BYTES; else null.
 */
export async function mapFileFor(
  base: string,
  dir: string
): Promise<{ path: string; size: number } | null> {
  if (bundleBaseName(base) !== base) return null
  const root = resolve(dir)
  const path = resolve(root, `${base}.map`)
  if (dirname(path) !== root) return null
  const st = await lstat(path).catch(() => null)
  if (!st?.isFile() || st.size > MAX_MAP_FILE_BYTES) return null
  return { path, size: st.size }
}

// One map is read and decoded at a time, whatever the number of reports in flight.
let decodeChain: Promise<unknown> = Promise.resolve()

function loadMap(base: string, dir: string): Promise<DecodedMap | null> {
  const key = `${resolve(dir)}|${base}`
  const hit = cache.get(key)
  if (hit) return hit.value
  let size = 0
  const run = decodeChain.then(async () => {
    const file = await mapFileFor(base, dir)
    if (!file) return null
    size = file.size
    const raw = JSON.parse(await readFile(file.path, 'utf8')) as {
      sources?: string[]
      names?: string[]
      mappings?: string
    }
    if (typeof raw.mappings !== 'string') return null
    return {
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      names: Array.isArray(raw.names) ? raw.names : [],
      lines: decodeMappings(raw.mappings)
    }
  })
  const value = run.catch(() => null)
  decodeChain = value
  // Decoded segments take a few times the file's mappings text; sources text is dropped.
  void value.then((m) => {
    const entry = cache.get(key)
    if (!entry || entry.value !== value) return
    const bytes = m ? Math.max(1024, size * 3) : 1024
    cachedBytes += bytes - entry.bytes
    entry.bytes = bytes
    evict()
  })
  remember(key, value, 1024)
  return value
}

/**
 * The frames mapped back to the admin's source, as stack lines (`at Lines (src/pages/Lines.tsx:
 * 12:5)`), or null when no frame could be mapped. Never throws.
 */
export async function resolveCrashFrames(
  frames: CrashFrame[],
  opts: { dir?: string; max?: number } = {}
): Promise<string | null> {
  try {
    const dir = opts.dir ?? ASSETS_DIR
    if (!existsSync(dir)) return null
    const out: string[] = []
    let mapped = 0
    // At most MAX_MAPS_PER_REPORT different bundles per report (≤ KEEP, so one report can never
    // churn the cache it is reading from); frames of further bundles stay minified.
    const bundles = new Set<string>()
    for (const f of frames.slice(0, Math.min(opts.max ?? MAX_FRAMES, MAX_FRAMES))) {
      let base = bundleBaseName(f.rawFile)
      if (base && !bundles.has(base)) {
        if (bundles.size >= MAX_MAPS_PER_REPORT) base = null
        else bundles.add(base)
      }
      const map = base ? await loadMap(base, dir) : null
      const pos = map ? lookup(map, f.line, f.column) : null
      if (pos) {
        mapped++
        out.push(
          `  at ${pos.name ?? f.fn ?? '<anonymous>'} (${pos.source}:${pos.line}:${pos.column})`
        )
      } else {
        out.push(
          `  at ${f.fn || '<anonymous>'} (${f.file}:${f.line}${f.column ? `:${f.column}` : ''})`
        )
      }
    }
    return mapped > 0 ? out.join('\n') : null
  } catch {
    return null
  }
}

/** Tests only. */
export function resetSourceMapCache(): void {
  cache.clear()
  cachedBytes = 0
}

/** Tests only: what the cache holds. */
export function sourceMapCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cachedBytes }
}
