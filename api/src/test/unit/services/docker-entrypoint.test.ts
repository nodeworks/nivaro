import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// #2792 — the release image's entrypoint sizes the Node heap from the
// container memory limit (75%), reading cgroup v2 memory.max, then v1
// memory.limit_in_bytes. Run for real with the cgroup files faked.

const SCRIPT = resolve(__dirname, '../../../../../deploy/image/docker-entrypoint.sh')
const MiB = 1024 * 1024

function run(
  files: { v2?: string; v1?: string; memTotalKb?: number },
  env: Record<string, string> = {}
): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-'))
  if (files.v2 !== undefined) writeFileSync(join(root, 'memory.max'), `${files.v2}\n`)
  if (files.v1 !== undefined) {
    mkdirSync(join(root, 'memory'))
    writeFileSync(join(root, 'memory', 'memory.limit_in_bytes'), `${files.v1}\n`)
  }
  const meminfo = join(root, 'meminfo')
  writeFileSync(
    meminfo,
    `MemTotal:       ${files.memTotalKb ?? 16 * 1024 * 1024} kB\nMemFree: 1 kB\n`
  )
  const work = join(root, 'work')
  return execFileSync('sh', [SCRIPT, 'sh', '-c', 'printf "%s" "$NODE_OPTIONS"'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NIVARO_CGROUP_ROOT: root,
      NIVARO_MEMINFO: meminfo,
      TMPDIR: join(work, 'tmp'),
      HOME: join(work, 'home'),
      ...env
    }
  }).toString()
}

describe('docker-entrypoint heap from the cgroup limit', () => {
  it('sets 75% of a cgroup v2 limit', () => {
    expect(run({ v2: String(2560 * MiB) })).toBe('--max-old-space-size=1920')
    expect(run({ v2: String(1536 * MiB) })).toBe('--max-old-space-size=1152')
    expect(run({ v2: String(1024 * MiB) })).toBe('--max-old-space-size=768')
  })

  it('reads cgroup v1 when there is no v2 file', () => {
    expect(run({ v1: String(2560 * MiB) })).toBe('--max-old-space-size=1920')
  })

  it('sets nothing without a limit', () => {
    expect(run({ v2: 'max' })).toBe('')
    expect(run({})).toBe('')
    // cgroup v1 "unlimited" (a page-rounded 2^63)
    expect(run({ v1: '9223372036854771712' })).toBe('')
    // more than the host has = no real limit
    expect(run({ v1: String(64 * 1024 * MiB), memTotalKb: 8 * 1024 * 1024 })).toBe('')
    // too small to take 75% from
    expect(run({ v2: String(200 * MiB) })).toBe('')
  })

  it('keeps NODE_OPTIONS and appends to it', () => {
    expect(run({ v2: String(1024 * MiB) }, { NODE_OPTIONS: '--enable-source-maps' })).toBe(
      '--enable-source-maps --max-old-space-size=768'
    )
  })

  it('never overrides a heap size already given, and can be turned off', () => {
    expect(run({ v2: String(1024 * MiB) }, { NODE_OPTIONS: '--max-old-space-size=300' })).toBe(
      '--max-old-space-size=300'
    )
    expect(run({ v2: String(1024 * MiB) }, { NODE_OPTIONS: '--max_old_space_size=300' })).toBe(
      '--max_old_space_size=300'
    )
    expect(run({ v2: String(1024 * MiB) }, { NIVARO_HEAP_FROM_CGROUP: 'off' })).toBe('')
  })

  it('creates TMPDIR and HOME and passes the command through (exec "$@")', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-dirs-'))
    const out = execFileSync(
      'sh',
      [SCRIPT, 'sh', '-c', 'test -d "$TMPDIR" && test -d "$HOME" && echo ok "$1"', 'x', 'arg'],
      {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          NIVARO_CGROUP_ROOT: root,
          TMPDIR: join(root, 'w', 'tmp'),
          HOME: join(root, 'w', 'home')
        }
      }
    ).toString()
    expect(out.trim()).toBe('ok arg')
  })
})
