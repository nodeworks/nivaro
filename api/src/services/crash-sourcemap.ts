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
 * file, and it is looked up inside admin/dist/assets only. Maps are decoded on demand (a crash
 * that opens a NEW issue row), a few at a time, and the last four are kept.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CrashFrame } from './crash-signature.js'

const ASSETS_DIR = join(import.meta.dirname, '../../../admin/dist/assets')
const KEEP = 4
const MAX_MAP_BYTES = 60 * 1024 * 1024

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

const cache = new Map<string, Promise<DecodedMap | null>>()

/** The base name of a bundle file a frame names, when it looks like one; else null. */
export function bundleBaseName(rawFile: string): string | null {
  const base = basename(String(rawFile ?? '').split(/[?#]/)[0])
  return /^[\w.-]{1,120}\.m?js$/.test(base) ? base : null
}

async function loadMap(base: string, dir: string): Promise<DecodedMap | null> {
  const key = `${dir}|${base}`
  const hit = cache.get(key)
  if (hit) return hit
  const p = (async () => {
    const file = join(dir, `${base}.map`)
    if (!existsSync(file)) return null
    const text = await readFile(file, 'utf8')
    if (text.length > MAX_MAP_BYTES) return null
    const raw = JSON.parse(text) as { sources?: string[]; names?: string[]; mappings?: string }
    if (typeof raw.mappings !== 'string') return null
    return {
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      names: Array.isArray(raw.names) ? raw.names : [],
      lines: decodeMappings(raw.mappings)
    }
  })().catch(() => null)
  cache.set(key, p)
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as string)
  return p
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
    for (const f of frames.slice(0, opts.max ?? 10)) {
      const base = bundleBaseName(f.rawFile)
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
}
