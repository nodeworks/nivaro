import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// The scanner behind slim-parity-guard.test.ts: every call site of a media or
// browser primitive in api/src (tests excluded). Kept apart so the inventory
// can be printed when the reviewed list is updated.

/** The primitives that need a binary the slim image does not have. */
export const PRIMITIVES: Record<string, RegExp> = {
  // ffmpeg.ts runners that always run the local binary
  runFfmpeg: /(?<!function\s)\brunFfmpeg\(/g,
  ffmpegOutput: /(?<!function\s)\bffmpegOutput\(/g,
  probeVideoLocal: /(?<!function\s)\bprobeVideoLocal\(/g,
  probeStreamsLocal: /(?<!function\s)\bprobeStreamsLocal\(/g,
  remuxToFileLocal: /(?<!function\s)\bremuxToFileLocal\(/g,
  // Chromium
  getBrowser: /(?<!function\s)\bgetBrowser\(/g,
  htmlToPdfLocal: /(?<!function\s)\bhtmlToPdfLocal\(/g,
  'puppeteer.launch': /\bpuppeteer\.launch\(/g,
  'import puppeteer': /from\s+'puppeteer'|import\(\s*'puppeteer'\s*\)/g,
  // Any process spawn (ffmpeg, ffprobe, chromium or anything else)
  child_process: /from\s+'(node:)?child_process'|import\(\s*'(node:)?child_process'\s*\)/g,
  // The local-only entry points built on those (one level up): calling one
  // from a new place is calling the binary.
  captureCards: /(?<!function\s)\bcaptureCards\(/g,
  rasterizeAnnotations: /(?<!function\s)\brasterizeAnnotations\(/g,
  captureWithPuppeteer: /(?<!function\s)\bcaptureWithPuppeteer\b/g,
  runWebmExport: /(?<!function\s)\brunWebmExport\(/g,
  buildMediaExtras: /(?<!function\s)\bbuildMediaExtras\(/g,
  renderClip: /(?<!function\s)\brenderClip\(/g,
  processCaptionJob: /(?<!function\s)\bprocessCaptionJob\(/g,
  renderOne: /(?<!function\s)\brenderOne\(/g,
  musicForRender: /(?<!function\s)\bmusicForRender\(/g,
  convertUploadedFile: /(?<!function\s)\bconvertUploadedFile\(/g,
  convertMusicFile: /(?<!function\s)\bconvertMusicFile\(/g,
  detectHardwareEncoders: /(?<!function\s)\bdetectHardwareEncoders\(/g
}

/** Comments out: a primitive named in a comment is not a call. Block
 *  comments, and line comments that start a line or follow whitespace (a
 *  URL's `://` is left alone). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'test' || name === 'node_modules') continue
      walk(p, out)
    } else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p)
    }
  }
}

/** { 'services/x.ts': { runFfmpeg: 2 } } for every file with a primitive. */
export function scanPrimitives(srcRoot: string): Record<string, Record<string, number>> {
  const files: string[] = []
  walk(srcRoot, files)
  const out: Record<string, Record<string, number>> = {}
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'))
    for (const [name, re] of Object.entries(PRIMITIVES)) {
      const n = code.match(re)?.length ?? 0
      if (!n) continue
      const rel = relative(srcRoot, f).split(sep).join('/')
      out[rel] ??= {}
      out[rel][name] = n
    }
  }
  return out
}
