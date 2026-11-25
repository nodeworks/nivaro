import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guard (security review of 052dffe48, MEDIUM 2–4): every code path that leaves a nivaro_users
// row ACTIVE runs the ONE offboard guard (services/hub/people/block.ts assertEmailNotOffboarded /
// emailOffboarded) on the row as it will be — or is listed below with the reason it may not.
// The scan finds every `status: 'active'` literal in api/src that sits in a nivaro_users
// insert/update (a `.where(...)` read on the same line is not a write), plus the computed
// writers named in COMPUTED. A new writer fails until it is guarded or listed; a stale entry
// (the writer moved or went away) fails too.

const SRC = resolve(import.meta.dirname, '../../..')

/** file → reason it may write an active account without the guard. */
const ALLOWED: Record<string, string> = {
  'routes/admin/provision.ts':
    'cloud provisioning of a tenant’s first administrator: cloud mode only, a Hub is refused in cloud mode (no offboard block can exist there)',
  'services/hub-link/first-admin.ts':
    'APP side of the Hub link (POST /api/hub-link/first-admin, never mounted on a Hub): the block lives on the Hub; the app’s own copy is suspended by the offboard run itself',
  'services/hub/people/offboard.ts':
    'liftOffboardBlock: reactivates the Hub account only after this run’s block is lifted, under the admin lock, when its own suspension marker still matches'
}

/** Writers whose status is computed (no literal): each must run the guard. */
const COMPUTED = ['routes/scim.ts', 'services/users.ts', 'routes/users.ts']

const GUARD_RE = /\b(assertEmailNotOffboarded|emailOffboarded)\b/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'test' || name === 'migrations' || name === 'node_modules') continue
      walk(p, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}

function activeUserWriters(): Map<string, number[]> {
  const found = new Map<string, number[]>()
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/status:\s*'active'/.test(line) || /\bwhere/i.test(line)) return
      const win = lines.slice(Math.max(0, i - 30), i + 1).join('\n')
      if (!/nivaro_users/.test(win)) return
      if (!/\.update\(|\.insert\(|insertReturning|\.merge\(/.test(win)) return
      const rel = relative(SRC, file).split('\\').join('/')
      found.set(rel, [...(found.get(rel) ?? []), i + 1])
    })
  }
  return found
}

describe('every active-account writer runs the offboard guard', () => {
  const writers = activeUserWriters()

  it('finds the known writers (the scan works)', () => {
    expect(writers.has('routes/users.ts')).toBe(true)
    expect(writers.has('services/users.ts')).toBe(true)
  })

  it('each writer is guarded or listed with a reason', () => {
    const bad: string[] = []
    for (const [file, lines] of writers) {
      if (ALLOWED[file]) continue
      const text = readFileSync(join(SRC, file), 'utf8')
      if (!GUARD_RE.test(text)) bad.push(`${file}:${lines.join(',')}`)
    }
    expect(bad).toEqual([])
  })

  it('every computed writer runs the guard', () => {
    for (const file of COMPUTED)
      expect(GUARD_RE.test(readFileSync(join(SRC, file), 'utf8')), file).toBe(true)
  })

  it('no stale allow-list entry', () => {
    for (const file of Object.keys(ALLOWED)) expect(writers.has(file), file).toBe(true)
  })

  it('a guarded file guards each of its writers (the count of guard calls covers them)', () => {
    for (const [file, lines] of writers) {
      if (ALLOWED[file]) continue
      const calls = readFileSync(join(SRC, file), 'utf8').match(
        /\b(assertEmailNotOffboarded|emailOffboarded)\(/g
      )
      expect(calls?.length ?? 0, file).toBeGreaterThanOrEqual(lines.length)
    }
  })
})
