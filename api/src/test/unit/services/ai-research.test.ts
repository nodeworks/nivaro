import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2456 — "Ask in background": read-only, as the asker, bigger budget, answer to
// Ask history + inbox, cancellable from the Jobs tray.

const state = vi.hoisted(() => ({
  historyOff: false,
  running: 0,
  jobRow: null as Record<string, unknown> | null,
  loopOpts: null as Record<string, unknown> | null,
  loopResult: {
    text: 'Forty invoices are waiting.',
    trace: [{ tool: 'aggregate', input: {}, summary: 'count(*) = 40' }],
    proposals: [],
    plans: [],
    choices: [],
    rounds: 2,
    truncated: false,
    stopped: false,
    memorySuggestions: []
  } as Record<string, unknown>,
  recorded: [] as Array<Record<string, unknown>>,
  failed: 0,
  completed: [] as unknown[],
  notified: [] as unknown[],
  stops: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => {
  const chain = () => {
    const q: Record<string, unknown> = {}
    for (const k of ['where', 'count', 'select']) q[k] = () => q
    q.first = () => Promise.resolve(state.jobRow ?? { n: state.running })
    q.catch = () => q
    return q
  }
  return { db: Object.assign(() => chain(), { raw: () => '' }) }
})
vi.mock('../../../services/ai-memory.js', () => ({
  aiHistoryOff: async () => state.historyOff,
  readMemory: async () => [],
  memoryPromptBlock: () => ''
}))
vi.mock('../../../services/ai-client.js', () => ({
  getAiModelSettings: async () => ({ chatModel: 'm' }),
  getAiClient: async () => ({})
}))
vi.mock('../../../services/ai-chat.js', () => ({
  buildChatSystemPrompt: async () => 'SYSTEM'
}))
vi.mock('../../../services/ai-chat-loop.js', () => ({
  runChatLoop: async (opts: Record<string, unknown>) => {
    state.loopOpts = opts
    return state.loopResult
  }
}))
vi.mock('../../../services/ai-panel.js', () => ({
  extractFollowUps: (t: string) => ({ text: t, followups: [] })
}))
vi.mock('../../../services/ai-conversation-turn.js', () => ({
  openConversationTurn: async (_app: unknown, _u: unknown, o: Record<string, unknown>) => ({
    conversation: { id: 'conv-1' },
    history: [],
    questionMessageId: '7',
    participants: ['U1'],
    notifyAsker: o.notifyAsker,
    record: async (p: Record<string, unknown>) => {
      state.recorded.push(p)
      return {}
    },
    fail: async () => {
      state.failed++
    }
  })
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({
    id: 55,
    progress: () => {},
    log: () => {},
    complete: async (outcome: unknown) => {
      state.completed.push(outcome)
    },
    fail: async () => {}
  })
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: async (_app: unknown, uid: unknown, opts: unknown) => {
    state.notified.push({ uid, opts })
    return { id: 1 }
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: async () => {} }))
vi.mock('../../../services/live-progress.js', () => ({
  emitJobProgress: () => {},
  emitToUser: () => {}
}))
vi.mock('../../../services/ai-stream-delivery.js', () => ({
  registerStream: () => ({ stopped: () => false, dispose: () => {} }),
  requestStreamStop: async (_app: unknown, id: unknown, who: unknown) => {
    state.stops.push({ id, who })
    return 'stopped'
  }
}))

const { cancelResearch, RESEARCH_MAX_ROUNDS, startResearch } = await import(
  '../../../services/ai-research.js'
)

const app = {} as never
const user = { id: 'U1', role: 'R' } as never
const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  state.historyOff = false
  state.running = 0
  state.jobRow = null
  state.loopOpts = null
  state.recorded = []
  state.failed = 0
  state.completed = []
  state.notified = []
  state.stops = []
  state.loopResult = { ...state.loopResult, stopped: false, text: 'Forty invoices are waiting.' }
})

describe('startResearch', () => {
  it('runs read-only, as the asker, with the bigger budget, and answers into history + inbox', async () => {
    const out = await startResearch(app, user, { question: 'How many invoices wait?' })
    expect(out).toEqual({ run_id: 55, conversation_id: 'conv-1', question_message_id: '7' })
    await flush()
    expect(state.loopOpts?.readOnly).toBe(true)
    expect(state.loopOpts?.user).toBe(user)
    expect(state.loopOpts?.maxRounds).toBe(RESEARCH_MAX_ROUNDS)
    expect(String(state.loopOpts?.system)).toContain('Only reading tools exist in this run')
    expect(state.recorded[0]).toMatchObject({
      reply: 'Forty invoices are waiting.',
      research: true,
      proposals: []
    })
    expect(state.completed).toEqual(['Answered'])
    expect(state.notified).toHaveLength(1)
    expect((state.notified[0] as { uid: string }).uid).toBe('U1')
  })

  it('refuses when history is off (the answer has nowhere to land) and past the running cap', async () => {
    state.historyOff = true
    expect(await startResearch(app, user, { question: 'x' })).toMatchObject({ status: 409 })
    state.historyOff = false
    state.running = 2
    expect(await startResearch(app, user, { question: 'x' })).toMatchObject({ status: 429 })
    expect(await startResearch(app, user, { question: '  ' })).toMatchObject({ status: 400 })
  })

  it('a cancelled run with nothing written removes the question and tells nobody', async () => {
    state.loopResult = { ...state.loopResult, stopped: true, text: '' }
    await startResearch(app, user, { question: 'Long one' })
    await flush()
    expect(state.failed).toBe(1)
    expect(state.recorded).toEqual([])
    expect(state.notified).toEqual([])
    expect(state.completed).toEqual(['Cancelled'])
  })
})

describe('cancelResearch', () => {
  it('only the asker (or an admin) may cancel, and only a research run', async () => {
    state.jobRow = {
      id: 9,
      kind: 'ai',
      job_id: 'ask-research',
      triggered_by: 'u1',
      status: 'running'
    }
    expect(await cancelResearch(app, user, 9, false)).toBe('stopped')
    expect(state.stops[0]).toMatchObject({ id: 'research-9' })
    expect(await cancelResearch(app, { id: 'OTHER' } as never, 9, false)).toBe('not_found')
    expect(await cancelResearch(app, { id: 'OTHER' } as never, 9, true)).toBe('stopped')
    state.jobRow = { ...state.jobRow, job_id: 'document-autofill' }
    expect(await cancelResearch(app, user, 9, false)).toBe('not_found')
    state.jobRow = {
      id: 9,
      kind: 'ai',
      job_id: 'ask-research',
      triggered_by: 'U1',
      status: 'completed'
    }
    expect(await cancelResearch(app, user, 9, false)).toBe('finished')
  })
})
