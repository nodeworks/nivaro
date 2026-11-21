import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageDigest, pinText } from '../../../services/hub/registry.js'

const D1 = `sha256:${'a'.repeat(64)}`
const D2 = `sha256:${'b'.repeat(64)}`

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  )
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.HUB_IMAGE
})

describe('imageDigest', () => {
  it('returns the digest and asks Docker Hub for the tag', async () => {
    const f = mockFetch(200, { digest: D1 })
    expect(await imageDigest('nodeworks/nivaro', '0.3.5')).toBe(D1)
    expect(String(f.mock.calls[0][0])).toBe(
      'https://hub.docker.com/v2/repositories/nodeworks/nivaro/tags/0.3.5'
    )
  })
  it('null when the tag is missing', async () => {
    mockFetch(404, { message: 'not found' })
    expect(await imageDigest('nodeworks/nivaro', '9.9.9')).toBeNull()
  })
  it("'present' when the registry gives no digest", async () => {
    mockFetch(200, { name: '0.3.5' })
    expect(await imageDigest('nodeworks/nivaro', '0.3.5')).toBe('present')
  })
  it('null when the call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      })
    )
    expect(await imageDigest('nodeworks/nivaro', '0.3.5')).toBeNull()
  })
})

describe('pinText', () => {
  it('version, digest and slim digest', () => {
    expect(pinText('0.3.5', D1, D2)).toBe(`0.3.5\n${D1}\n${D2}\n`)
  })
  it('two-line pin when slim is absent', () => {
    expect(pinText('0.3.5', D1, null)).toBe(`0.3.5\n${D1}\n`)
    expect(pinText('0.3.5', D1, 'present')).toBe(`0.3.5\n${D1}\n`)
  })
  it('slim dropped unless both are real', () => {
    expect(pinText('0.3.5', 'present', D2)).toBe('0.3.5\n')
    expect(pinText('0.3.5', null, D2)).toBe('0.3.5\n')
  })
})
