import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Final fix wave (FW-1 merged): every code the shared deployment routes, the shared store, the
// upgrade plan and run, the open-move guard and the Hub agent's spec check can answer has plain
// words in the admin, so a new code on the server fails here instead of reaching people raw.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

const { AGENT_FIELD_COPY, BLOCKER_COPY, CODE_COPY_KEYS } = await import('./hub-api')
const { SHARED_COPY, WARNING_COPY } = await import('./shared/shared-api')
const { SILENT_WARNINGS, UPGRADE_COPY } = await import('./shared/shared-upgrade-api')
const { MOVE_BLOCKER_COPY, MOVE_CODE_COPY, MOVE_WARNING_COPY } = await import('./move/move-api')

const ROOT = join(import.meta.dirname, '../../../..')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const codes = (f: string, res: RegExp[]) => {
  const s = read(f)
  const out = new Set<string>()
  for (const re of res) for (const m of s.matchAll(re)) out.add(m[1] as string)
  return [...out]
}
const C = "'([A-Z][A-Z0-9_]{3,})'"
const re = (pre: string) => new RegExp(`${pre}${C}`, 'g')

/** describeError already words a missing record; SILENT_WARNINGS are said elsewhere on the page. */
const GENERIC = new Set(['NOT_FOUND'])
const worded = (c: string) =>
  GENERIC.has(c) ||
  !!SHARED_COPY[c] ||
  !!WARNING_COPY[c] ||
  !!UPGRADE_COPY[c] ||
  SILENT_WARNINGS.has(c) ||
  !!MOVE_CODE_COPY[c] ||
  !!MOVE_BLOCKER_COPY[c] ||
  !!MOVE_WARNING_COPY[c] ||
  !!BLOCKER_COPY[c] ||
  CODE_COPY_KEYS.has(c)

describe('every code FW-1 can answer has plain words', () => {
  it.each([
    ['api/src/routes/hub-shared.ts', [re('code: '), re('\\d{3},\\s*')]],
    ['api/src/services/hub/shared/store.ts', [re('\\(\\s*').source.replace(/$/, ',')]],
    [
      'api/src/services/hub/shared/upgrade-plan.ts',
      [re('block\\(\\s*'), re('codes\\.push\\('), re('code: ')]
    ],
    ['api/src/services/hub/shared/upgrade-run.ts', [re('SharedUpgradeError\\(\\s*')]],
    ['api/src/services/hub/move-open.ts', [re('code: ')]]
  ] as const)('%s', (file, patterns) => {
    const list = codes(
      file,
      patterns.map((p) => (typeof p === 'string' ? new RegExp(p, 'g') : p))
    )
    expect(list.length).toBeGreaterThan(0)
    expect(list.filter((c) => !worded(c))).toEqual([])
  })

  it("the Hub agent's spec refusals, field by field", () => {
    const spec = read('packages/hub-agent/src/spec.ts')
    const union = spec.slice(
      spec.indexOf('export type FieldCode'),
      spec.indexOf('export type FieldError')
    )
    const fields = [...union.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] as string)
    expect(fields).toContain('ROLE_NEEDS_TRAEFIK_V3')
    expect(fields.filter((c) => !AGENT_FIELD_COPY[c])).toEqual([])
  })

  it('the new codes read as plain words, never a code', () => {
    const all: Record<string, { title: string; hint?: string } | undefined> = {
      NAME_NOT_ROUTED: BLOCKER_COPY.NAME_NOT_ROUTED,
      SERVING_UNKNOWN: BLOCKER_COPY.SERVING_UNKNOWN,
      MOVE_OPEN: BLOCKER_COPY.MOVE_OPEN,
      UPGRADE_MOVE_OPEN: UPGRADE_COPY.MOVE_OPEN,
      EXTENSION_MISSING: UPGRADE_COPY.EXTENSION_MISSING,
      EXTENSION_IN_USE: SHARED_COPY.EXTENSION_IN_USE,
      ROLLBACK_SCHEMA_AHEAD: WARNING_COPY.ROLLBACK_SCHEMA_AHEAD,
      TOKEN_NOT_APPLIED: WARNING_COPY.TOKEN_NOT_APPLIED,
      SPEC_INVALID: BLOCKER_COPY.SPEC_INVALID
    }
    for (const [code, c] of Object.entries(all)) {
      expect(c?.title, code).toBeTruthy()
      expect(c?.hint, code).toBeTruthy()
      expect(`${c?.title} ${c?.hint}`, code).not.toMatch(/\b[A-Z]{3,}_[A-Z0-9_]+\b/)
    }
    expect(AGENT_FIELD_COPY.ROLE_NEEDS_TRAEFIK_V3).toMatch(/Traefik v3/)
  })
})
