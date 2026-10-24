import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registrationMembers } from '../../../extensions/loader.js'
import { holdsReadSlot, readGateStats, resetReadGate } from '../../../services/read-gate.js'

function members() {
  return registrationMembers(
    'efp-test',
    {
      app: { cron: { schedule: vi.fn(), unschedule: vi.fn(), annotate: vi.fn() } } as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      database: {} as never
    },
    { note: () => {}, own: () => {}, cronPrefix: 'ext:efp-test:' }
  )
}

function fakeReply() {
  const raw = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false })
  const reply: any = {
    raw,
    sent: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    code(c: number) {
      reply.statusCode = c
      return reply
    },
    send(body: unknown) {
      reply.sent = true
      reply.body = body
      return reply
    },
    getHeader: (n: string) => reply.headers[n.toLowerCase()],
    header(n: string, v: string) {
      reply.headers[n.toLowerCase()] = v
      return reply
    }
  }
  return reply
}

afterEach(() => resetReadGate())

describe('ctx.reads.route — extension heavy reads hold a gate slot', () => {
  it('runs the handler inside a held slot and lets it go after', async () => {
    resetReadGate({ global: 2 })
    const route = members().reads!.route(async (_req: any, reply: any) => {
      expect(holdsReadSlot()).toBe(true)
      return reply.send({ ok: true })
    })
    const reply = fakeReply()
    await route({ user: { id: 'u1' } }, reply)
    expect(reply.body).toEqual({ ok: true })
    expect(holdsReadSlot()).toBe(false)
    expect(readGateStats().active).toBe(0)
  })

  it('queues past the slot count and answers in order', async () => {
    resetReadGate({ global: 1 })
    const order: string[] = []
    let release!: () => void
    const first = new Promise<void>((r) => (release = r))
    const route = members().reads!.route(async (req: any, reply: any) => {
      order.push(`start ${req.n}`)
      if (req.n === 1) await first
      return reply.send(req.n)
    })
    const a = route({ n: 1, user: { id: 'a' } }, fakeReply())
    const bReply = fakeReply()
    const b = route({ n: 2, user: { id: 'b' } }, bReply)
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['start 1'])
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['start 1', 'start 2'])
    expect(String(bReply.headers['server-timing'])).toMatch(/^gate;dur=\d+/)
  })

  it('answers 499 and never runs the handler when the client left while queued', async () => {
    resetReadGate({ global: 1 })
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const ran: number[] = []
    const route = members().reads!.route(async (req: any, reply: any) => {
      ran.push(req.n)
      if (req.n === 1) await hold
      return reply.send(req.n)
    })
    const a = route({ n: 1, user: { id: 'a' } }, fakeReply())
    const gone = fakeReply()
    const b = route({ n: 2, user: { id: 'b' } }, gone)
    gone.raw.emit('close')
    await b
    expect(gone.statusCode).toBe(499)
    release()
    await a
    expect(ran).toEqual([1])
  })
})
