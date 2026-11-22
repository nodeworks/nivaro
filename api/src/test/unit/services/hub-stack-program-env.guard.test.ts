import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentRefusesEnvKey } from '../../../services/hub/docker/stack-env.js'

// Guard (Hub phase 4, ruling P4-20): a Hub stack spec never chooses a program to run, or what a
// program reads as code. Every `process.env.X` read in a served-app file that runs a program
// (imports child_process or puppeteer, or hands a path to ffmpeg/Chromium) must be either
// refused by the agent's env rules (so no spec can set it) or listed below as reviewed: read
// there, but never the program, its code or its flags. A new env read in such a file fails here
// until someone decides which.

const SRC = resolve(import.meta.dirname, '../../..')

/** Read in a program-running file, reviewed as data the program does not run as code. */
const REVIEWED_NOT_PROGRAM: Record<string, string> = {
  IMPORT_LOADER: 'staged-imports: chooses insert vs bulk loader (a fixed list)',
  IMPORT_STATEMENT_TIMEOUT_MS: 'staged-imports: a number',
  SAMBA_IP: 'staged-imports: the share host in smbclient argv (no shell), never a program',
  SAMBA_SHARE: 'staged-imports: the share name in smbclient argv (no shell)',
  SAMBA_USER: 'staged-imports: written to a 0600 smbclient auth file as the user name',
  SAMBA_PASS: 'staged-imports: written to a 0600 smbclient auth file as the password',
  SAMBA_WORKGROUP: 'staged-imports: written to the smbclient auth file as the domain',
  VIDEO_WORK_DIR: 'session-replay-export: scratch folder for output files'
}

/**
 * Read by the child, not by Nivaro (ruling P4-22): the dynamic loader, Vulkan, EGL and Mesa
 * load a library from these paths inside Chromium / ffmpeg. They never appear as
 * `process.env.X` in api/src, so the scan cannot find them; each must stay refused.
 */
const READ_BY_THE_CHILD = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'VK_ICD_FILENAMES',
  'VK_LAYER_PATH',
  'VK_DRIVER_FILES',
  '__EGL_VENDOR_LIBRARY_FILENAMES',
  '__EGL_VENDOR_LIBRARY_DIRS',
  'LIBGL_DRIVERS_PATH',
  'LIBGL_ALWAYS_SOFTWARE',
  // ruling P4-23: glibc, GLib/GTK/GStreamer modules, VA-API, Mesa, GBM, VDPAU and OpenCL loaders
  'GCONV_PATH',
  'LOCPATH',
  'GIO_MODULE_DIR',
  'GTK_PATH',
  'LIBVA_DRIVERS_PATH',
  'LIBVA_DRIVER_NAME',
  'MESA_LOADER_DRIVER_OVERRIDE',
  'GBM_BACKENDS_PATH',
  'VDPAU_DRIVER_PATH',
  'OCL_ICD_VENDORS',
  'OCL_ICD_FILENAMES',
  'GST_PLUGIN_PATH',
  'GST_PLUGIN_SYSTEM_PATH',
  'GST_PLUGIN_SCANNER'
]

/** The known program-choosing keys (seed): each must stay refused by the agent. */
const SEED = [
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'PUPPETEER_CACHE_DIR',
  'HELP_VIDEO_WHISPER_CMD',
  'HELP_VIDEO_WHISPER_MODEL',
  'SAMBA_SERVER_PATH',
  'FFREPORT',
  'CHROMIUM_FLAGS',
  'CHROMIUM_USER_FLAGS',
  'PATH'
]

const RUNS_A_PROGRAM =
  /from '(node:)?child_process'|require\('(node:)?child_process'\)|import\('(node:)?child_process'\)|from 'puppeteer|import\('puppeteer|\bffmpegPath\b|\bexecutablePath\b/
const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      // Tests and host-run scripts are not the served app a stack runs.
      if (name === 'test' || name === 'scripts' || name === 'node_modules') continue
      files(p, out)
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function programEnvReads(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const f of files(SRC)) {
    const text = readFileSync(f, 'utf8')
    if (!RUNS_A_PROGRAM.test(text)) continue
    for (const m of text.matchAll(ENV_READ)) {
      const key = m[1] ?? m[2]
      const at = found.get(key) ?? new Set<string>()
      at.add(relative(SRC, f))
      found.set(key, at)
    }
  }
  return found
}

describe('stack specs never pick a program (P4-20)', () => {
  it('finds the known program-choosing env reads (the scan works)', () => {
    const found = programEnvReads()
    for (const k of [
      'FFMPEG_PATH',
      'FFPROBE_PATH',
      'PUPPETEER_EXECUTABLE_PATH',
      'HELP_VIDEO_WHISPER_CMD',
      'SAMBA_SERVER_PATH'
    ])
      expect([k, found.has(k)]).toEqual([k, true])
  })

  it.each([
    'bundled',
    'external'
  ])('every env read in a program-running file is refused or reviewed (redis %s)', (redis) => {
    const unreviewed = [...programEnvReads()]
      .filter(([k]) => !agentRefusesEnvKey(k, redis) && !(k in REVIEWED_NOT_PROGRAM))
      .map(([k, at]) => `${k} (${[...at].join(', ')})`)
    expect(unreviewed).toEqual([])
  })

  it.each(['bundled', 'external'])('the seed list is refused (redis %s)', (redis) => {
    for (const k of SEED) expect([k, agentRefusesEnvKey(k, redis)]).toEqual([k, true])
  })

  it.each(['bundled', 'external'])('keys read by the child are refused (redis %s)', (redis) => {
    for (const k of READ_BY_THE_CHILD) expect([k, agentRefusesEnvKey(k, redis)]).toEqual([k, true])
  })

  it('a reviewed key is never also refused (the list stays honest)', () => {
    for (const k of Object.keys(REVIEWED_NOT_PROGRAM))
      expect([k, agentRefusesEnvKey(k, 'external')]).toEqual([k, false])
  })
})
