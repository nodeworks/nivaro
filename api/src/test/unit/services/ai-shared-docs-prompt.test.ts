import { describe, expect, it, vi } from 'vitest'

// #2455 security: a docs answer shared between people must come from a prompt
// with nothing of the asker's in it. Two people who can read different
// collections get DIFFERENT full prompts (each names their own catalogue) but
// the SAME catalogue-free prompt — the only one a shareable answer is built on.

const COLLECTIONS = [
  { collection: 'payroll_runs', display_name: 'Payroll runs', hidden: false },
  { collection: 'vendors', display_name: 'Vendors', hidden: false }
]

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const rows = table === 'nivaro_collections' ? COLLECTIONS : []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNull', 'orderBy', 'select', 'limit'])
      b[m] = () => b
    b.first = async () => undefined
    b.catch = (rej: (e: unknown) => unknown) => Promise.resolve(rows).catch(rej)
    // biome-ignore lint/suspicious/noThenProperty: a thenable knex builder stand-in
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    return b
  }
  return { db: (t: string) => chain(t) }
})
vi.mock('../../../services/ai-client.js', () => ({ settingsRow: async () => ({}) }))
vi.mock('../../../services/permissions.js', () => ({
  // Ana reads payroll; Ben reads vendors.
  can: async (u: { id: string }, _a: string, c: string) =>
    (u.id === 'ana' && c === 'payroll_runs') || (u.id === 'ben' && c === 'vendors'),
  getRowFilter: async () => null
}))
vi.mock('../../../services/user-time.js', () => ({
  userTimeZone: async () => 'America/New_York',
  timeInstructions: () => 'Times are Eastern.'
}))
vi.mock('../../../services/ai-knowledge.js', () => ({
  knowledgeForPrompt: async () => ({ stable: '', perQuestion: '' })
}))
vi.mock('../../../services/ai-queue-summary.js', () => ({
  queueCatalogue: async (u: { id: string }) => [`- ${u.id}'s private queue`]
}))
vi.mock('../../../services/ai-panel.js', () => ({
  savedViewCatalogue: async (u: { id: string }) => [
    { collection: u.id === 'ana' ? 'payroll_runs' : 'vendors', line: `- ${u.id}'s view` }
  ]
}))

import { sharedDocsCandidate } from '../../../services/ai-answer-cache.js'
import { buildChatSystemPrompt } from '../../../services/ai-chat.js'
import type { User } from '../../../types.js'

const ana = { id: 'ana', role: 'R1', preferences: null } as unknown as User
const ben = { id: 'ben', role: 'R2', preferences: null } as unknown as User
const question = 'How do I add a delegate?'

describe('the prompt a shared docs answer is written from (#2455)', () => {
  it('the full prompt carries each asker’s own catalogue', async () => {
    const a = await buildChatSystemPrompt(ana, { question })
    const b = await buildChatSystemPrompt(ben, { question })
    expect(a).toContain('payroll_runs')
    expect(a).toContain("ana's private queue")
    expect(b).toContain('vendors')
    expect(b).not.toContain('payroll_runs')
    expect(a).not.toBe(b)
  })

  it('the catalogue-free prompt is identical for both and names nothing of either', async () => {
    const a = await buildChatSystemPrompt(ana, { question, catalogues: false })
    const b = await buildChatSystemPrompt(ben, { question, catalogues: false })
    expect(a).toBe(b)
    for (const leak of ['payroll_runs', 'vendors', 'private queue', "'s view"])
      expect(a).not.toContain(leak)
  })

  it('only a standalone docs-style question with nothing attached is a candidate', () => {
    const base = { standalone: true, pageContext: false, memoryNotes: 0, cacheOn: true }
    expect(sharedDocsCandidate({ ...base, question })).toBe(true)
    expect(sharedDocsCandidate({ ...base, question: 'What does On Hold mean?' })).toBe(true)
    expect(sharedDocsCandidate({ ...base, question: 'How many payroll runs failed?' })).toBe(false)
    expect(sharedDocsCandidate({ ...base, question: 'Total spend for Zone 3 in 2025' })).toBe(false)
    expect(sharedDocsCandidate({ ...base, question: 'list my open tasks' })).toBe(false)
    expect(sharedDocsCandidate({ ...base, standalone: false, question })).toBe(false)
    expect(sharedDocsCandidate({ ...base, pageContext: true, question })).toBe(false)
    expect(sharedDocsCandidate({ ...base, memoryNotes: 1, question })).toBe(false)
    expect(sharedDocsCandidate({ ...base, cacheOn: false, question })).toBe(false)
  })
})
