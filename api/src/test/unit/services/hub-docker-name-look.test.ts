import { describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 4, Task 9: the Docker verify step's look at its name and the copy a
// manual-DNS admin passes on. Since the phase 3 merge the look IS phase 3's name check
// (create/name-check.ts checkName, tested in hub-name-check.test.ts) answered as three states;
// phase 3 owns the waiting_for_name status, its cron and the Check name button.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { lookName, nameRequest } = await import('../../../services/hub/docker/name-check.js')
const { NAME_CHECK_TIMEOUT_MS } = await import('../../../services/hub/create/name-check.js')

const env = { base_url: 'https://acme.apps.example.com', hostnames: ['acme-alt.example.org'] }

function reader(value: string | null) {
  const urls: string[] = []
  return {
    urls,
    read: async (url: string) => {
      urls.push(url)
      return { value, error: value ? null : 'no answer' }
    }
  }
}

describe('lookName', () => {
  it('a name that does not resolve is not_resolving, and nothing is fetched', async () => {
    const r = reader('0.3.10')
    const looked: string[] = []
    const state = await lookName(env, '0.3.10', {
      lookup: async (h) => {
        looked.push(h)
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
      },
      readServedField: r.read
    })
    expect(state).toBe('not_resolving')
    expect(looked).toEqual(['acme.apps.example.com'])
    expect(r.urls).toEqual([])
  })

  it('resolves but answers another version (or nothing) = not_serving', async () => {
    const lookup = async () => ({ address: '10.0.0.1' })
    expect(await lookName(env, '0.3.10', { lookup, readServedField: reader('0.3.9').read })).toBe(
      'not_serving'
    )
    expect(await lookName(env, '0.3.10', { lookup, readServedField: reader(null).read })).toBe(
      'not_serving'
    )
  })

  it('answers the version at /api/version = serving; a null version takes any answer', async () => {
    const lookup = async () => ({ address: '10.0.0.1' })
    const r = reader('0.3.10')
    expect(await lookName(env, '0.3.10', { lookup, readServedField: r.read })).toBe('serving')
    expect(r.urls).toEqual(['https://acme.apps.example.com/api/version'])
    expect(await lookName(env, null, { lookup, readServedField: reader('0.1.0').read })).toBe(
      'serving'
    )
  })

  it("a DNS look that hangs counts as not_resolving after phase 3's timeout", async () => {
    vi.useFakeTimers()
    try {
      const r = reader('0.3.10')
      const p = lookName(env, '0.3.10', {
        lookup: () => new Promise(() => {}),
        readServedField: r.read
      })
      await vi.advanceTimersByTimeAsync(NAME_CHECK_TIMEOUT_MS)
      expect(await p).toBe('not_resolving')
      expect(r.urls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unusable base_url never throws', async () => {
    expect(await lookName({ base_url: 'not a url' }, null, { lookup: async () => ({}) })).toBe(
      'not_resolving'
    )
  })
})

describe('nameRequest', () => {
  const manual = {
    agent_url: 'https://agent.example.com',
    dns_mode: 'manual' as const,
    wildcard_domain: null,
    edge_target: 'edge.example.com'
  }

  it('manual DNS: one DNS name and one TLS certificate line per name the stack routes', () => {
    expect(nameRequest(env, manual)).toEqual([
      'Ask for DNS name acme.apps.example.com pointing at edge.example.com',
      'and a TLS certificate for acme.apps.example.com',
      'Ask for DNS name acme-alt.example.org pointing at edge.example.com',
      'and a TLS certificate for acme-alt.example.org'
    ])
  })

  it('P4-34: an IP address base asks for no DNS name and no certificate', () => {
    expect(nameRequest({ base_url: 'http://127.0.0.1:18081', hostnames: [] }, manual)).toEqual([
      '127.0.0.1 is an IP address — no DNS name or TLS certificate is needed'
    ])
    expect(
      nameRequest({ base_url: 'http://[::1]:18081', hostnames: ['acme.example.org'] }, manual)
    ).toEqual([
      '[::1] is an IP address — no DNS name or TLS certificate is needed',
      'Ask for DNS name acme.example.org pointing at edge.example.com',
      'and a TLS certificate for acme.example.org'
    ])
  })

  it('automatic DNS asks for nothing', () => {
    expect(
      nameRequest(env, { ...manual, dns_mode: 'automatic', wildcard_domain: 'apps.example.com' })
    ).toEqual([])
  })
})
