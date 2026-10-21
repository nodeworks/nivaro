import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./huddle-settings.js', async (orig) => ({
  ...(await orig<typeof import('./huddle-settings.js')>()),
  getHuddleSettings: async () => ({})
}))

import { HUDDLE_DEFAULTS } from './huddle-settings.js'
import {
  huddleProbeStatus,
  PROBE_FAILURES_TO_RAISE,
  type ProbeRedis,
  runHuddleProbe
} from './huddle-turn-monitor.js'

function redis(): ProbeRedis {
  const kv = new Map<string, string>()
  const lists = new Map<string, string[]>()
  return {
    async lpush(k, ...v) {
      lists.set(k, [...v.reverse(), ...(lists.get(k) ?? [])])
    },
    async ltrim(k, a, b) {
      lists.set(k, (lists.get(k) ?? []).slice(a, b + 1))
    },
    async lrange(k, a, b) {
      return (lists.get(k) ?? []).slice(a, b + 1)
    },
    async get(k) {
      return kv.get(k) ?? null
    },
    async set(k, v) {
      kv.set(k, v)
    }
  }
}

const settings = {
  ...HUDDLE_DEFAULTS,
  turn_urls: ['turn:t.example.com'],
  turn_secret: 's'
}

import type { ProbeResult } from './huddle-turn-probe.js'

const bad: ProbeResult[] = [
  { url: 'turn:t.example.com', kind: 'turn', ok: false, ms: 5, address: null, error: 'x' }
]
const good: ProbeResult[] = [{ ...bad[0], ok: true, ms: 40, address: '1.2.3.4:5', error: null }]

describe('runHuddleProbe', () => {
  it('skips when nothing is configured', async () => {
    const r = await runHuddleProbe({ redis: redis(), settings: async () => HUDDLE_DEFAULTS })
    expect(r).toEqual({ skipped: true })
  })

  it('raises one issue on the third failure in a row and resets on recovery', async () => {
    const rd = redis()
    const raise = vi.fn(async () => 7)
    let results = bad
    const run = () =>
      runHuddleProbe({
        redis: rd,
        settings: async () => settings,
        probe: async () => results,
        raise
      })
    await run()
    await run()
    expect(raise).not.toHaveBeenCalled()
    await run()
    expect(raise).toHaveBeenCalledTimes(1)
    expect(PROBE_FAILURES_TO_RAISE).toBe(3)
    let st = await huddleProbeStatus(rd, settings)
    expect(st).toMatchObject({
      consecutive_failures: 3,
      issue_id: 7,
      credential_kind: 'rest-secret'
    })
    results = good
    await run()
    st = await huddleProbeStatus(rd, settings)
    expect(st.consecutive_failures).toBe(0)
    expect(st.issue_id).toBeNull()
    expect(st.history).toHaveLength(4)
    expect(st.last?.ok).toBe(true)
  })
})
