import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  ACK_WHO_PREFIX,
  ackedByForSeqs,
  noteAckedBy
} from '../../../services/realtime-delivery-slo.js'

function fakeRedis() {
  const sets = new Map<string, Set<string>>()
  const calls: string[] = []
  const redis = {
    multi() {
      const ops: Array<() => void> = []
      const m = {
        sadd(k: string, v: string) {
          ops.push(() => {
            const s = sets.get(k) ?? new Set<string>()
            s.add(v)
            sets.set(k, s)
          })
          return m
        },
        expire(k: string) {
          calls.push(`expire ${k}`)
          return m
        },
        async exec() {
          for (const o of ops) o()
          return []
        }
      }
      return m
    },
    pipeline() {
      const keys: string[] = []
      const p = {
        smembers(k: string) {
          keys.push(k)
          return p
        },
        async exec() {
          return keys.map((k) => [null, [...(sets.get(k) ?? [])]])
        }
      }
      return p
    }
  }
  return { redis: redis as never, sets, calls }
}

describe('who acknowledged which sampled event', () => {
  afterEach(() => {
    process.env.CLOUD_META_DB_URL = ''
    delete process.env.CLOUD_META_DB_URL
  })

  it('remembers people per sequence and reads them back', async () => {
    const { redis, sets, calls } = fakeRedis()
    noteAckedBy(100, 'u1', redis)
    noteAckedBy(100, 'u2', redis)
    noteAckedBy(101, 'u1', redis)
    await new Promise((r) => setTimeout(r, 0))
    expect([...(sets.get(`${ACK_WHO_PREFIX}100`) ?? [])].sort()).toEqual(['u1', 'u2'])
    expect(calls.some((c) => c.includes(`${ACK_WHO_PREFIX}100`))).toBe(true)
    const got = await ackedByForSeqs([100, 101, 102], redis)
    expect(got.get(100)?.sort()).toEqual(['u1', 'u2'])
    expect(got.get(101)).toEqual(['u1'])
    expect(got.has(102)).toBe(false)
  })

  it('does nothing without Redis and never throws', async () => {
    expect(() => noteAckedBy(1, 'u1', null)).not.toThrow()
    expect((await ackedByForSeqs([1], null)).size).toBe(0)
  })
})
