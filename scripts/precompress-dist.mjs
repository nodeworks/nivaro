#!/usr/bin/env node
// Pre-compress a built SPA directory (#2437): writes <file>.br (brotli q11) and
// <file>.gz (gzip 9) beside every .js/.css/.svg/.html/.json/.txt/.xml/.webmanifest
// over 1 KB, so @fastify/static (preCompressed) / nginx (gzip_static) serve
// them with zero per-request CPU. Source maps are skipped. A variant is kept
// only when it is actually smaller. No dependencies: node:zlib only.
//
//   node scripts/precompress-dist.mjs admin/dist [--gzip-only]
import { constants, brotliCompressSync, gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const EXTS = new Set(['.js', '.mjs', '.css', '.svg', '.html', '.json', '.txt', '.xml', '.webmanifest'])
const MIN_BYTES = 1024

const args = process.argv.slice(2)
const gzipOnly = args.includes('--gzip-only')
const dir = args.find((a) => !a.startsWith('--'))
if (!dir) {
  console.error('usage: precompress-dist.mjs <dir> [--gzip-only]')
  process.exit(1)
}

function* walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

let files = 0
let raw = 0
let br = 0
let gz = 0
for (const p of walk(resolve(dir))) {
  if (!EXTS.has(extname(p).toLowerCase())) continue
  if (statSync(p).size <= MIN_BYTES) continue
  const src = readFileSync(p)
  files++
  raw += src.length
  const g = gzipSync(src, { level: 9 })
  if (g.length < src.length) writeFileSync(`${p}.gz`, g)
  gz += Math.min(g.length, src.length)
  if (gzipOnly) continue
  const b = brotliCompressSync(src, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: src.length
    }
  })
  if (b.length < src.length) writeFileSync(`${p}.br`, b)
  br += Math.min(b.length, src.length)
}
const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(
  `precompress: ${files} files, ${kb(raw)} raw -> ${kb(gz)} gzip${gzipOnly ? '' : `, ${kb(br)} brotli`}`
)
