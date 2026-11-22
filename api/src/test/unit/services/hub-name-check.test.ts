import { describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 4, Task 9: the one-look name check of a Docker deploy's verify step and the
// copy a manual-DNS admin passes on. (Phase 3 owns the waiting_for_name status, its cron and
// the Check name button.)

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { checkName, nameRequest } = await import('../../../services/hub/docker/name-check.js')

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

describe('checkName', () => {
  it('a name that does not resolve is not_resolving, and nothing is fetched', async () => {
    const r = reader('0.3.10')
    const looked: string[] = []
    const state = await checkName(env, '0.3.10', {
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
    expect(await checkName(env, '0.3.10', { lookup, readServedField: reader('0.3.9').read })).toBe(
      'not_serving'
    )
    expect(await checkName(env, '0.3.10', { lookup, readServedField: reader(null).read })).toBe(
      'not_serving'
    )
  })

  it('answers the version at /api/version = serving; a null version takes any answer', async () => {
    const lookup = async () => ({ address: '10.0.0.1' })
    const r = reader('0.3.10')
    expect(await checkName(env, '0.3.10', { lookup, readServedField: r.read })).toBe('serving')
    expect(r.urls).toEqual(['https://acme.apps.example.com/api/version'])
    expect(await checkName(env, null, { lookup, readServedField: reader('0.1.0').read })).toBe(
      'serving'
    )
  })

  it('an unusable base_url never throws', async () => {
    expect(await checkName({ base_url: 'not a url' }, null, { lookup: async () => ({}) })).toBe(
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

  it('automatic DNS asks for nothing', () => {
    expect(
      nameRequest(env, { ...manual, dns_mode: 'automatic', wildcard_domain: 'apps.example.com' })
    ).toEqual([])
  })
})
