import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Realtime gaps 2026-11-17, batch B1 — write paths that change what an open screen shows but
 * bypass the items service (raw writes, pipeline moves outside applyTransition, task / comment /
 * link rows) must announce it. Most of these are route bodies over a real database, so this
 * guard pins each announcement to its write path: removing one fails here, by name.
 * Each entry: [file, gap id, pattern, minimum count].
 */
const SITES: Array<[string, string, RegExp, number]> = [
  ['hooks/cross-triggers.ts', 'S1', /announceRawWrites\(target,/g, 2],
  ['routes/imports.ts', 'S2', /announceImportWrites\(touched,/g, 1],
  ['routes/imports.ts', 'S2 rollback', /source: `import-rollback:job-/g, 1],
  ['extensions/loader.ts', 'S3', /realtime: \{\s*announceAspect:/g, 1],
  ['extensions/loader.ts', 'E1 enabler', /queues: \{\s*syncRecord:/g, 1],
  ['graphql/resolvers.ts', 'S4', /void announceStateMoved\(collection, String\(item\)\)/g, 4],
  ['services/workflow-mutations.ts', 'S4', /void announceStateMoved\(collection, item\)/g, 1],
  ['routes/pipelines.ts', 'S5 start', /void announceStateMoved\(collection, item\)/g, 1],
  ['routes/pipelines.ts', 'S5 bulk', /announceStatesMoved\(/g, 2],
  ['routes/workflows.ts', 'S6', /void announceStateMoved\(/g, 3],
  ['routes/record-links.ts', 'S7', /queueForeignAspect\([\s\S]{0,120}?'\$related'\)/g, 4],
  [
    'services/workflow-actions.ts',
    'S7',
    /queueForeignAspect\(target, String\(targetId\), '\$related'\)/g,
    2
  ],
  ['routes/sub-rows.ts', 'S8', /queueForeignAspect\([\s\S]{0,120}?'\$related'\)/g, 4],
  [
    'routes/items.ts',
    'S8 clone',
    /queueForeignAspect\(collection, String\(newId\), '\$related'\)/g,
    1
  ],
  ['routes/sla.ts', 'S9', /announceRecordAspect\([\s\S]{0,120}?'\$sla'\)/g, 3],
  ['services/change-proposals.ts', 'S10', /announceProposalChange\(/g, 5],
  ['services/task-delegation.ts', 'S11', /announceAspectOnRecords\(open, \['\$tasks'\]\)/g, 1],
  ['routes/config-conformance.ts', 'S11', /announceRecordAspect\([\s\S]{0,120}?'\$tasks'\)/g, 1],
  ['routes/offboarding.ts', 'S11', /announceAspectOnRecords\(taskRecords, \['\$tasks'\]\)/g, 1],
  ['services/inactive-user-links.ts', 'S11', /announceAspectOnRecords\(/g, 1],
  ['services/record-merge/apply.ts', 'S12', /announceMerge\(deps, log\)/g, 3],
  ['routes/attributes.ts', 'S13', /'\$attributes'/g, 1],
  ['routes/collection-snapshots.ts', 'Low 1', /announceRawWrites\(collection, null/g, 2],
  ['routes/record-promotion.ts', 'Low 1', /announceTouched\(touched,/g, 1],
  ['routes/data-model.ts', 'Low 1', /source: 'auto-id-backfill'/g, 1],
  ['routes/geocode-backfill.ts', 'Low 1', /source: 'geocode-backfill'/g, 1],
  ['routes/record-merge.ts', 'Low 1', /source: 'record-merge'/g, 1],
  ['routes/offboarding.ts', 'Low 1', /source: 'user-merge'/g, 1],
  ['routes/presets.ts', 'Low 2', /announceMineChanged\(String\(req\.user\.id\), 'presets'\)/g, 1],
  [
    'routes/queues.ts',
    'minor: triage labels',
    /broadcastCollectionUpdate\(app\.io, collection, itemId\)/g,
    2
  ],
  [
    'routes/chat.ts',
    'minor: chat → Notes',
    /announceRecordAspect\(rec\.collection, rec\.id, '\$comments'\)/g,
    1
  ],
  [
    'services/session-replay-notes.ts',
    'minor: replay note',
    /announceRecordAspect\('nivaro_issues'/g,
    1
  ],
  ['routes/notifications.ts', 'minor: snooze end', /scheduleSnoozeWake\(/g, 2],
  [
    'routes/import-templates.ts',
    'minor: compensation',
    /source: 'import-template:compensation'/g,
    2
  ],
  ['services/action-writes.ts', 'minor: raw fallback', /source: 'transition-action'/g, 1],
  ['services/workflow-actions.ts', 'minor: raw fallback', /source: 'transition-action'/g, 2],
  ['routes/submission-forms.ts', 'minor: submissions', /pokeOps\('submissions'\)/g, 1]
]

const SRC = join(import.meta.dirname, '..', '..')

/**
 * B1 review ruling: every raw-write announcement B1 added is NOTICE-ONLY — the write it reports
 * was the app's own (a rule, an import, a backfill, a merge), so it must not run the outside-write
 * side effects (webhooks, flows, alerts, approval bursts, "set by" sources, catalog nudges).
 * Every announceRawWrites call in these files must say `noticeOnly: true`.
 */
const NOTICE_ONLY_FILES = [
  'hooks/cross-triggers.ts',
  'routes/imports.ts',
  'routes/data-model.ts',
  'routes/geocode-backfill.ts',
  'routes/record-promotion.ts',
  'routes/collection-snapshots.ts',
  'routes/record-merge.ts',
  'routes/offboarding.ts',
  'routes/import-templates.ts',
  'services/record-merge/apply.ts',
  'services/action-writes.ts',
  'services/workflow-actions.ts',
  'services/state-moved.ts'
]

/** The text of each announceRawWrites(...) call in a file (balanced parentheses). */
function rawCalls(text: string): string[] {
  const out: string[] = []
  let i = text.indexOf('announceRawWrites(')
  while (i >= 0) {
    if (!/import\s*\{[^}]*$/.test(text.slice(Math.max(0, i - 80), i))) {
      let depth = 0
      let j = i + 'announceRawWrites'.length
      do {
        if (text[j] === '(') depth++
        else if (text[j] === ')') depth--
        j++
      } while (depth > 0 && j < text.length)
      out.push(text.slice(i, j))
    }
    i = text.indexOf('announceRawWrites(', i + 1)
  }
  return out
}

describe('realtime announcements on raw write paths (batch B1)', () => {
  for (const [file, id, re, min] of SITES) {
    it(`${id}: ${file}`, () => {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect((text.match(re) ?? []).length).toBeGreaterThanOrEqual(min)
    })
  }
})

describe('B1 raw-write announcements are notice-only', () => {
  for (const file of NOTICE_ONLY_FILES) {
    it(file, () => {
      const calls = rawCalls(readFileSync(join(SRC, file), 'utf8'))
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call).toMatch(/noticeOnly: true/)
    })
  }
})
