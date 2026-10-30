import { describe, expect, it } from 'vitest'
import { boundedRaw, StatementCancelled } from '../../../services/bounded-sql.js'
import { SearchBudget } from '../../../services/search-budget.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('SearchBudget.run', () => {
  it('returns the part when it finishes in time', async () => {
    const b = new SearchBudget(500)
    expect(await b.run('people', [], async () => ['jane'])).toEqual(['jane'])
    expect([...b.timedOut]).toEqual([])
    b.finish()
  })

  it('answers the fallback at the deadline and names the part', async () => {
    const b = new SearchBudget(40)
    const t = Date.now()
    const out = await b.run('files', ['fallback'], () => sleep(1_000).then(() => ['late']))
    expect(out).toEqual(['fallback'])
    expect(Date.now() - t).toBeLessThan(500)
    expect(b.timedOut.has('files')).toBe(true)
    b.finish()
  })

  it('a part asked for after the deadline does not run', async () => {
    const b = new SearchBudget(0)
    await sleep(5)
    let ran = false
    const out = await b.run('x', 'none', async () => {
      ran = true
      return 'ran'
    })
    expect(out).toBe('none')
    expect(ran).toBe(false)
    b.finish()
  })

  it('shorten brings the deadline in (an exact hit), never pushes it out', async () => {
    const b = new SearchBudget(5_000)
    b.shorten(30)
    expect(b.remaining()).toBeLessThanOrEqual(30)
    b.shorten(10_000)
    expect(b.remaining()).toBeLessThanOrEqual(30)
    const out = await b.run('units', [], () => sleep(1_000).then(() => [1]))
    expect(out).toEqual([])
    expect(b.timedOut.has('units')).toBe(true)
    b.finish()
  })

  it('a cancelled statement is a timeout, other errors propagate', async () => {
    const b = new SearchBudget(1_000)
    expect(await b.run('a', 'fb', () => Promise.reject(new StatementCancelled('timeout')))).toBe(
      'fb'
    )
    await expect(b.run('b', 'fb', () => Promise.reject(new Error('bad column')))).rejects.toThrow(
      'bad column'
    )
    b.finish()
  })

  it('finish aborts the signal', () => {
    const b = new SearchBudget(10_000)
    expect(b.signal.aborted).toBe(false)
    b.finish()
    expect(b.signal.aborted).toBe(true)
    expect(b.expired()).toBe(true)
  })
})

describe('boundedRaw (other dialects: knex.raw, abandoned at the deadline)', () => {
  const fakeKnex = (result: Promise<unknown>) =>
    ({ client: { config: { client: 'pg' } }, raw: () => result }) as never

  it('returns the rows', async () => {
    const rows = await boundedRaw('select 1', [], {
      timeoutMs: 1_000,
      knex: fakeKnex(Promise.resolve({ rows: [{ a: 1 }] }))
    })
    expect(rows).toEqual([{ a: 1 }])
  })

  it('times out with StatementCancelled', async () => {
    await expect(
      boundedRaw('select 1', [], { timeoutMs: 20, knex: fakeKnex(new Promise(() => {})) })
    ).rejects.toBeInstanceOf(StatementCancelled)
  })

  it('an aborted signal cancels before and during the statement', async () => {
    const before = new AbortController()
    before.abort()
    await expect(
      boundedRaw('select 1', [], {
        timeoutMs: 1_000,
        signal: before.signal,
        knex: fakeKnex(Promise.resolve([]))
      })
    ).rejects.toBeInstanceOf(StatementCancelled)
    const during = new AbortController()
    const p = boundedRaw('select 1', [], {
      timeoutMs: 1_000,
      signal: during.signal,
      knex: fakeKnex(new Promise(() => {}))
    })
    during.abort()
    await expect(p).rejects.toBeInstanceOf(StatementCancelled)
  })
})
