import { beforeEach, describe, expect, it, vi } from 'vitest'

const finished: string[] = []
const delays: Record<string, number> = {}

vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: async () => [{ id: 'F1', name: 'LinX — status write-back' }] })
}))

vi.mock('../../../services/flow-executor.js', () => ({
  executeFlow: async (ctx: { payload: Record<string, unknown> }) => {
    const tag = String(ctx.payload.tag)
    await new Promise((r) => setTimeout(r, delays[tag] ?? 0))
    finished.push(tag)
    return {}
  }
}))

const { emitTrigger, orderedTriggerKeyCount } = await import('../../../flows/registry.js')
const log = { error: vi.fn() } as unknown as Parameters<typeof emitTrigger>[2]

async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('emitTrigger orderKey', () => {
  beforeEach(() => {
    finished.length = 0
    for (const k of Object.keys(delays)) delete delays[k]
  })

  it('runs events for one key in emission order even when the first is slower', async () => {
    delays.waiting_on_po = 80
    delays.completed = 0
    emitTrigger('workflow-transition', { tag: 'waiting_on_po' }, log, undefined, {
      orderKey: 'workflows:1'
    })
    emitTrigger('workflow-transition', { tag: 'completed' }, log, undefined, {
      orderKey: 'workflows:1'
    })
    await settle()
    expect(finished).toEqual(['waiting_on_po', 'completed'])
    expect(orderedTriggerKeyCount()).toBe(0)
  })

  it('does not hold back a different key', async () => {
    delays['a-slow'] = 80
    delays['b-fast'] = 0
    emitTrigger('workflow-transition', { tag: 'a-slow' }, log, undefined, {
      orderKey: 'workflows:1'
    })
    emitTrigger('workflow-transition', { tag: 'b-fast' }, log, undefined, {
      orderKey: 'workflows:2'
    })
    await settle()
    expect(finished).toEqual(['b-fast', 'a-slow'])
  })

  it('without an orderKey the runs stay unordered (historic behaviour)', async () => {
    delays.first = 80
    delays.second = 0
    emitTrigger('workflow-transition', { tag: 'first' }, log)
    emitTrigger('workflow-transition', { tag: 'second' }, log)
    await settle()
    expect(finished).toEqual(['second', 'first'])
  })

  it('a hung event releases its key after the timeout', async () => {
    delays.hung = 400
    delays.next = 0
    emitTrigger('workflow-transition', { tag: 'hung' }, log, undefined, {
      orderKey: 'k',
      orderTimeoutMs: 50
    })
    emitTrigger('workflow-transition', { tag: 'next' }, log, undefined, {
      orderKey: 'k',
      orderTimeoutMs: 50
    })
    await settle(200)
    expect(finished).toEqual(['next'])
    await settle(300)
  })
})
