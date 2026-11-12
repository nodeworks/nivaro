// What the assistant is told about dates and about downloading an answer.
// On production it wrote "created today" as the UTC day and, asked for an
// Excel, said it could not make files — while the Excel button sat under its
// own answer.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNull', 'orderBy', 'select', 'limit'])
      b[m] = () => b
    b.first = async () => undefined
    b.catch = (rej: (e: unknown) => unknown) => Promise.resolve([]).catch(rej)
    // biome-ignore lint/suspicious/noThenProperty: a thenable knex builder stand-in
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(res, rej)
    return b
  }
  return { db: () => chain() }
})
vi.mock('../../../services/ai-client.js', () => ({ settingsRow: async () => ({}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: async () => true,
  getRowFilter: async () => null
}))
vi.mock('../../../services/user-time.js', () => ({
  userTimeZone: async () => 'America/New_York',
  timeInstructions: () => 'Times are Eastern.'
}))
vi.mock('../../../services/ai-knowledge.js', () => ({
  knowledgeForPrompt: async () => ({ stable: '', perQuestion: 'GUIDES' })
}))
vi.mock('../../../services/ai-queue-summary.js', () => ({ queueCatalogue: async () => [] }))
vi.mock('../../../services/ai-panel.js', () => ({ savedViewCatalogue: async () => [] }))

import {
  buildChatSystemParts,
  downloadInstructions,
  EXPORT_MAX_ROWS
} from '../../../services/ai-chat.js'
import type { User } from '../../../types.js'

const asker = { id: 'u', role: 'R', preferences: null } as unknown as User

afterEach(() => vi.useRealTimers())

describe('the date rule in the prompt', () => {
  it('gives "today" as the asker’s local day, with tomorrow as its end', async () => {
    // 8:00 PM Eastern on Nov 9 — UTC is already on the 10th.
    vi.useFakeTimers({ now: new Date('2026-11-10T01:00:00Z'), toFake: ['Date'] })
    const { stable } = await buildChatSystemParts(asker, {})
    expect(stable).toContain('Today is 2026-11-09 ')
    expect(stable).toContain('{"_gte": "2026-11-09T00:00:00", "_lt": "2026-11-10T00:00:00"}')
    expect(stable).toContain('never describe a day as a UTC day')
  })
})

describe('downloadInstructions', () => {
  it('points at the CSV and Excel buttons on the page that has them', () => {
    const text = downloadInstructions('buttons')
    expect(text).toContain('two buttons, CSV and Excel')
    expect(text).toContain('/export xlsx')
    expect(text).toContain(EXPORT_MAX_ROWS.toLocaleString('en-US'))
    expect(text).toContain('Never say you cannot make a file')
    expect(text).toContain('never send them to another screen to export')
  })

  it('sends the side panel to the page that has the buttons', () => {
    const text = downloadInstructions('ask_page')
    expect(text).toContain('Open in Ask AI')
    expect(text).toContain('CSV and Excel buttons')
  })

  it('is honest where nothing can be downloaded, and invents no button', () => {
    const text = downloadInstructions('none')
    expect(text).toContain('cannot create or attach a file')
    expect(text).toContain('Never describe an export button')
    expect(text).not.toContain('two buttons')
  })
})

describe('where the download rule rides', () => {
  it('goes with the per-question part, before the guides, and only when a screen says', async () => {
    const withButtons = await buildChatSystemParts(asker, { downloads: 'buttons' })
    expect(withButtons.perQuestion).toContain(downloadInstructions('buttons'))
    expect(withButtons.perQuestion.indexOf('Downloads:')).toBeLessThan(
      withButtons.perQuestion.indexOf('GUIDES')
    )
    // The long cached prefix is the same whatever the screen can do.
    const silent = await buildChatSystemParts(asker, {})
    expect(silent.perQuestion).not.toContain('Downloads:')
    expect(silent.stable).toBe(withButtons.stable)
  })
})
