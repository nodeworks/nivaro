// #2215 / #2273 timed rules: Redis sync, expiry, exactly one "ended" row.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIONS_KEY,
  activeRules,
  clearRule,
  onRuleEnded,
  parseRules,
  setRule,
  setTimedRulesForTest,
  stopTimedRules,
  sync,
  type TimedRule
} from './timed-rules.js'

function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>()
  const keys = new Map<string, string>()
  return {
    hashes,
    keys,
    async hgetall(k: string) {
      return Object.fromEntries(hashes.get(k) ?? new Map())
    },
    async hset(k: string, f: string, v: string) {
      const h = hashes.get(k) ?? new Map()
      h.set(f, v)
      hashes.set(k, h)
      return 1
    },
    async hdel(k: string, ...fs: string[]) {
      for (const f of fs) hashes.get(k)?.delete(f)
      return fs.length
    },
    async set(k: string, v: string, ...args: Array<string | number>) {
      if (args.includes('NX') && keys.has(k)) return null
      keys.set(k, v)
      return 'OK'
    }
  }
}

function rule(over: Partial<TimedRule> = {}): TimedRule {
  return {
    kind: 'debug',
    id: 'id-1',
    target: 'items/orders',
    until: Date.now() + 60_000,
    at: Date.now(),
    by: 'u1',
    by_name: 'Ann',
    ...over
  }
}

afterEach(() => stopTimedRules())

describe('parseRules', () => {
  it('splits live, expired and corrupt fields', () => {
    const now = 1000
    const r = parseRules(
      {
        'debug:a': JSON.stringify(rule({ id: 'a', until: 2000 })),
        'cache:b': JSON.stringify(rule({ id: 'b', kind: 'cache', until: 500 })),
        'debug:c': 'not json',
        'other:d': JSON.stringify({ kind: 'other', id: 'd', target: 'x', until: 5000 })
      },
      now
    )
    expect([...r.live.keys()]).toEqual(['debug:a'])
    expect(r.expired.map((x) => x.id)).toEqual(['b'])
    expect(r.corrupt.sort()).toEqual(['debug:c', 'other:d'])
  })
})

describe('set / clear / expire', () => {
  it('a set rule is active on the next read; a stop writes one "stopped" end', async () => {
    const redis = fakeRedis()
    setTimedRulesForTest([], redis)
    const ended = vi.fn()
    onRuleEnded('debug', ended)
    await setRule(rule())
    expect(activeRules('debug').map((r) => r.id)).toEqual(['id-1'])
    expect(activeRules('cache')).toEqual([])
    await clearRule('debug', 'id-1')
    expect(activeRules('debug')).toEqual([])
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended.mock.calls[0][1]).toBe('stopped')
    // another process noticing it gone later does not write a second row
    await sync()
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('an expired rule ends once, whoever notices first', async () => {
    const redis = fakeRedis()
    setTimedRulesForTest([], redis)
    const ended = vi.fn()
    onRuleEnded('debug', ended)
    await redis.hset(
      ACTIONS_KEY,
      'debug:old',
      JSON.stringify(rule({ id: 'old', until: Date.now() - 1 }))
    )
    await sync()
    await sync()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended.mock.calls[0][1]).toBe('expired')
    expect(redis.hashes.get(ACTIONS_KEY)?.has('debug:old')).toBe(false)
  })

  it('without Redis nothing can be set', async () => {
    setTimedRulesForTest([], null)
    await expect(setRule(rule())).rejects.toThrow(/Redis/)
  })
})
