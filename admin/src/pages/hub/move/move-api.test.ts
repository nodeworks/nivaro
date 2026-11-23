import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  KEY_CHECK_REASON_WORDS,
  MOVE_BLOCKER_COPY,
  MOVE_CODE_COPY,
  MOVE_WARNING_COPY,
  moveChecklistOf,
  moveIssueCopy,
  moveStepRows,
  pastRelease
} from './move-api'

// Nivaro Hub (phase 6, Task 18): the move panel's plain words cover every code the planner and
// the app's readiness report can answer, and the step states follow the stored run.

const API = join(process.cwd(), '..', 'api', 'src')

/** The string literals of one exported union type in a source file. */
function unionCodes(file: string, type: string): string[] {
  let src = ''
  try {
    src = readFileSync(join(API, file), 'utf8')
  } catch {
    return []
  }
  const start = src.indexOf(`export type ${type} =`)
  if (start < 0) return []
  const rest = src.slice(start + type.length + 14)
  const end = rest.search(/\n(?:export|\/\*\*|interface|type)\b/)
  const body = end < 0 ? rest : rest.slice(0, end)
  return [...body.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1])
}

describe('move copy covers every code', () => {
  const readiness = unionCodes('services/hub-link/shared-readiness.ts', 'SharedReadinessCode')
  const blockers = unionCodes('services/hub/move/types.ts', 'MoveBlockerCode')
  const warnings = unionCodes('services/hub/move/types.ts', 'MoveWarningCode')

  it('finds the codes in the API sources', () => {
    // A broken pattern would pass the next tests with nothing to check.
    expect(readiness.length).toBeGreaterThan(12)
    expect(blockers.length).toBeGreaterThan(20)
    expect(warnings).toContain('SIGNED_LINKS_RESET')
  })

  it('every blocker (and readiness blocker) has plain words', () => {
    const missing = [...blockers, ...readiness].filter(
      (c) => !MOVE_BLOCKER_COPY[c] && !MOVE_WARNING_COPY[c]
    )
    expect(missing).toEqual([])
  })

  it('every warning (and readiness warning) has plain words', () => {
    const missing = [...warnings, ...readiness].filter(
      (c) => !MOVE_WARNING_COPY[c] && !MOVE_BLOCKER_COPY[c]
    )
    expect(missing).toEqual([])
  })

  it('no title names a raw code', () => {
    for (const table of [MOVE_BLOCKER_COPY, MOVE_WARNING_COPY, MOVE_CODE_COPY])
      for (const [code, c] of Object.entries(table)) {
        expect(c.title.trim(), code).not.toBe('')
        expect(c.title, code).not.toMatch(/[A-Z]{2,}_[A-Z]/)
      }
  })

  it('every blocker and warning says what to do', () => {
    for (const table of [MOVE_BLOCKER_COPY, MOVE_WARNING_COPY])
      for (const [code, c] of Object.entries(table)) expect(c.hint?.trim(), code).toBeTruthy()
    expect(moveIssueCopy({ code: 'SOMETHING_NEW', text: '' }, 'blocker').hint).toBeTruthy()
  })

  it('an unknown code keeps the planner sentence', () => {
    expect(moveIssueCopy({ code: 'SOMETHING_NEW', text: 'Plain sentence.' }, 'blocker').title).toBe(
      'Plain sentence.'
    )
  })
})

describe('place-on-shared and app-key refusals', () => {
  it('every code the place and app-key routes refuse with has plain words', async () => {
    const { BLOCKER_COPY, CODE_COPY_KEYS } = await import('../hub-api')
    const found = new Set<string>()
    // promote-lock.ts: the lock-holder refusals both routes answer when the env or the shared
    // lock is held (MOVE_RUNNING, APP_KEY_BUSY, SHARED_UPGRADE_RUNNING …).
    for (const f of [
      'services/hub/shared/place.ts',
      'services/hub/shared/app-key-check.ts',
      'services/hub/promote-lock.ts'
    ]) {
      const src = readFileSync(join(API, f), 'utf8')
      for (const m of src.matchAll(/(?:refuse\(\s*|code: )'([A-Z][A-Z0-9_]+)'/g)) found.add(m[1])
    }
    expect(found.has('ALREADY_PLACED')).toBe(true)
    expect(found.has('MOVE_RUNNING')).toBe(true)
    const missing = [...found].filter(
      (c) =>
        !MOVE_CODE_COPY[c] &&
        !MOVE_BLOCKER_COPY[c] &&
        !MOVE_WARNING_COPY[c] &&
        !BLOCKER_COPY[c] &&
        !CODE_COPY_KEYS.has(c) &&
        !KEY_CHECK_REASON_WORDS[c]
    )
    expect(missing).toEqual([])
  })
})

describe('move route refusals (Task 16)', () => {
  it('every code a move route refuses with has plain words', () => {
    const found = new Set<string>()
    for (const f of [
      'services/hub/move/run.ts',
      'routes/hub-move.ts',
      // Start-time address refusals, answered through run.ts as MoveError.
      'services/hub/move/addresses.ts'
    ]) {
      const src = readFileSync(join(API, f), 'utf8')
      for (const m of src.matchAll(
        /(?:(?:Move|Address)Error\(\s*|refuse\(reply,\s*\d+,\s*)'([A-Z][A-Z0-9_]+)'/g
      ))
        found.add(m[1])
    }
    for (const c of ['CONFIRM_MISMATCH', 'MOVE_ENDED', 'ROLLING_BACK', 'LINK_URL_NOT_PULLABLE'])
      expect(found.has(c), c).toBe(true)
    const missing = [...found].filter(
      (c) => !MOVE_CODE_COPY[c] && !MOVE_BLOCKER_COPY[c] && !MOVE_WARNING_COPY[c]
    )
    expect(missing).toEqual([])
  })
})

describe('steps of a stored move', () => {
  const steps = JSON.stringify(['check', 'maintenance_on', 'release', 'retire_source', 'done'])
  it('derives each step state from the current step', () => {
    const rows = moveStepRows({ steps, step: 'release', status: 'running', plan: null })
    expect(rows.map((r) => r.state)).toEqual(['done', 'done', 'running', 'pending', 'pending'])
  })
  it('a rolled back run marks what it undid', () => {
    const rows = moveStepRows({ steps, step: 'release', status: 'rolled_back', plan: null })
    expect(rows.map((r) => r.state)).toEqual(['undone', 'undone', 'undone', 'pending', 'pending'])
  })
  it('takes {key, status} rows as they are', () => {
    const rows = moveStepRows({
      steps: [
        { key: 'check', status: 'done' },
        { key: 'route', status: 'waiting' }
      ],
      step: 'route',
      status: 'waiting',
      plan: null
    })
    expect(rows.map((r) => r.state)).toEqual(['done', 'waiting'])
  })
  it('reads the Task 16 stored shape: {list, phase} steps and per-copy file summaries', async () => {
    const { moveFilesOf, isRollingBack } = await import('./move-api')
    const stored = {
      list: [
        { key: 'check', state: 'done' },
        { key: 'maintenance_on', state: 'undone' },
        { key: 'release', state: 'undo_failed' },
        { key: 'done', state: 'pending' }
      ],
      phase: 'rollback'
    }
    const rows = moveStepRows({
      steps: JSON.stringify(stored),
      step: 'release',
      status: 'running',
      plan: null
    })
    expect(rows.map((r) => r.state)).toEqual(['done', 'undone', 'failed', 'pending'])
    expect(isRollingBack({ steps: stored })).toBe(true)
    const files = moveFilesOf({
      files: {
        warm: {
          mode: 'full',
          state: 'done',
          total: 10,
          copied: 10,
          skipped: 0,
          failed: 0,
          bytes: 1,
          at: '2026-11-22T10:00:00Z'
        },
        delta: {
          mode: 'delta',
          state: 'running',
          total: 4,
          copied: 1,
          skipped: 0,
          failed: 0,
          bytes: 1,
          at: '2026-11-22T10:05:00Z'
        }
      }
    })
    expect(files?.total).toBe(4)
  })

  it('knows when the run is past release', () => {
    expect(pastRelease({ steps, step: 'maintenance_on', status: 'running', plan: null })).toBe(
      false
    )
    expect(pastRelease({ steps, step: 'retire_source', status: 'running', plan: null })).toBe(true)
  })
  it('reads the checklist in either stored form', () => {
    const plan = JSON.stringify({
      checklist: [{ id: 'old_stack_stopped', text: 'Stop the old stack.', required: false }]
    })
    expect(moveChecklistOf({ checklist: '{"old_stack_stopped":true}', plan })[0].done).toBe(true)
    expect(
      moveChecklistOf({ checklist: [{ id: 'retire_source', done: false }], plan: null })[0].text
    ).toMatch(/Retire the old home/)
  })
})

describe('route answers (Task 16 routes/hub-move.ts)', () => {
  it('takes the {data} answer and a bare one alike', async () => {
    const { answerOf, changedMovePlanOf } = await import('./move-api')
    expect(answerOf<{ move_id: number }>({ data: { move_id: 7 } })?.move_id).toBe(7)
    expect(answerOf<{ serving: boolean }>({ serving: true })?.serving).toBe(true)
    const plan = { blockers: [], plan_hash: 'h' }
    const err = (data: unknown) => ({ response: { status: 409, data } })
    expect(changedMovePlanOf(err({ code: 'PLAN_CHANGED', plan }))?.plan_hash).toBe('h')
    expect(changedMovePlanOf(err({ code: 'PLAN_CHANGED', data: { plan } }))?.plan_hash).toBe('h')
    expect(changedMovePlanOf(err({ code: 'BUSY', plan }))).toBeNull()
  })
})

describe('stored run errors', () => {
  it('splits a one-word code as well as an underscored one', async () => {
    const { splitRunError, runErrorCopy } = await import('./move-api')
    expect(splitRunError('INTERRUPTED: The environment lock was lost; place it again.')).toEqual({
      code: 'INTERRUPTED',
      sentence: 'The environment lock was lost; place it again.'
    })
    expect(splitRunError('ROUTE_UNSUPPORTED: x').code).toBe('ROUTE_UNSUPPORTED')
    expect(splitRunError('Plain words: no code here.').code).toBeNull()
    expect(runErrorCopy('INTERRUPTED')?.title).toBe('The run stopped before it finished')
  })
})
