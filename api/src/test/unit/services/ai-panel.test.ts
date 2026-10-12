import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  can: async () => true,
  getAllowedFields: async () => null,
  getRowFilter: async () => null
}))

const panel = await import('../../../services/ai-panel.js')
const tools = await import('../../../services/ai-panel-tools.js')

describe('extractFollowUps', () => {
  it('splits a trailing followups block off the answer', () => {
    const r = panel.extractFollowUps(
      'There are 12.\n\n```followups\n["Which are over 30 days?", "Show by region", "Compare to Q1"]\n```'
    )
    expect(r.text).toBe('There are 12.')
    expect(r.followups).toEqual(['Which are over 30 days?', 'Show by region', 'Compare to Q1'])
  })
  it('drops an unparseable block from the text and caps at three', () => {
    expect(panel.extractFollowUps('Done.\n```followups\nnot json\n```').text).toBe('Done.')
    const r = panel.extractFollowUps('x\n```followups\n["a1?","b2?","c3?","d4?"]\n```')
    expect(r.followups).toHaveLength(3)
  })
  it('leaves text without a block alone', () => {
    expect(panel.extractFollowUps('plain')).toEqual({ text: 'plain', followups: [] })
  })
})

describe('slash commands', () => {
  it('only the four server-side commands parse', () => {
    expect(panel.parseAnswerCommand('chart')).toBe('chart')
    expect(panel.parseAnswerCommand('export')).toBeNull()
    expect(panel.parseAnswerCommand(5)).toBeNull()
    expect(panel.commandDirective('table')).toContain('table')
  })
})

describe('starters', () => {
  it('classifies pages', () => {
    expect(panel.pageKindOf('/collections/workflows/:id')).toBe('record')
    expect(panel.pageKindOf('/collections/workflows')).toBe('list')
    expect(panel.pageKindOf('/queues/:id')).toBe('queue')
    expect(panel.pageKindOf('/')).toBe('home')
  })
  it('names a record only when one was given', () => {
    expect(panel.pageStarters('record', {})).toEqual([])
    expect(panel.pageStarters('record', { ref: 'workflows #5' })[0]).toBe(
      'Why is workflows #5 late?'
    )
  })
})

describe('saved views', () => {
  const views = [{ name: 'My late IRs' }, { name: 'Late IRs - Zone 1' }, { name: 'Open POs' }]
  it('matches exact, then unique partial', () => {
    expect(panel.matchViewName(views, 'my late irs').match?.name).toBe('My late IRs')
    expect(panel.matchViewName(views, 'open').match?.name).toBe('Open POs')
    const amb = panel.matchViewName(views, 'late irs')
    expect(amb.match).toBeNull()
    expect(amb.candidates).toHaveLength(2)
  })
  it('compiles view conditions into the chat filter dialect', () => {
    const ops = new Set(['_eq', '_gte', '_lte'])
    expect(
      panel.conditionsToChatFilter(
        [
          { path: ['status'], op: '_eq', value: 'late' },
          { path: ['due'], op: '_gte', value: 'a' },
          { path: ['due'], op: '_lte', value: 'b' },
          { path: ['$state'], op: '_in', value: ['x'] }
        ],
        ops
      )
    ).toEqual({
      status: { _eq: 'late' },
      due: { _gte: 'a', _lte: 'b' },
      $state: { _in: ['x'] }
    })
    expect(() =>
      panel.conditionsToChatFilter([{ path: ['a'], op: '_weird', value: 1 }], ops)
    ).toThrow()
  })
})

describe('compareGroups', () => {
  it('computes deltas and sorts by size', () => {
    const rows = tools.compareGroups(
      [
        { group: 'Z1', value: 100 },
        { group: 'Z2', value: 50 }
      ],
      [
        { group: 'Z1', value: 150 },
        { group: 'Z3', value: 10 }
      ]
    )
    expect(rows[0]).toMatchObject({ group: 'Z1', delta: 50, pct: 50 })
    expect(rows.find((r) => r.group === 'Z2')).toMatchObject({ a: 50, b: null, delta: -50 })
    expect(rows.find((r) => r.group === 'Z3')).toMatchObject({
      a: null,
      b: 10,
      delta: 10,
      pct: null
    })
  })
})
