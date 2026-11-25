import { afterEach, describe, expect, it } from 'vitest'
import { _setConfigFetchForTests, postConfig } from '../../../services/hub/config/channel.js'
import { ConfigPromotionError } from '../../../services/hub/config/types.js'

// Hub config promotion: the Hub's call to an app's config link — bearer only in its header, no
// redirects, the app's short code kept, raw text of a server error never passed on, a capped answer.

afterEach(() => _setConfigFetchForTests(null))

const answer = (status: number, body: unknown) =>
  _setConfigFetchForTests(async (_url, init) => {
    seen.push(init as RequestInit)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
const seen: RequestInit[] = []

async function code(p: Promise<unknown>) {
  try {
    await p
    return 'OK'
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigPromotionError)
    return (e as InstanceType<typeof ConfigPromotionError>).code
  }
}

describe('postConfig', () => {
  it('sends the bearer in its header only and refuses redirects', async () => {
    answer(200, { ok: 1 })
    expect(
      await postConfig('https://a.test/api/hub-link/config/plan', 'tok', 'plan', { x: 1 })
    ).toEqual({
      ok: 1
    })
    const init = seen.at(-1)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(init?.redirect).toBe('error')
    expect(init?.body).toBe('{"x":1}')
  })

  it('keeps an app refusal’s code, words and items', async () => {
    answer(409, { code: 'PROD_ONLY_CHANGES', message: '2 changes made here', items: [{ id: 1 }] })
    try {
      await postConfig('https://a.test/x', 't', 'apply', {})
    } catch (e) {
      const err = e as InstanceType<typeof ConfigPromotionError>
      expect(err.code).toBe('PROD_ONLY_CHANGES')
      expect(err.message).toBe('2 changes made here')
      expect(err.status).toBe(409)
      expect(err.extra.items).toEqual([{ id: 1 }])
    }
  })

  it('a server error’s text is never passed on; a bare 404 is a missing link', async () => {
    answer(500, { code: 'CONFIG_PROMOTE_FAILED', message: 'SELECT secret FROM x' })
    try {
      await postConfig('https://a.test/x', 't', 'plan', {})
    } catch (e) {
      expect((e as Error).message).not.toContain('SELECT')
    }
    answer(404, 'Not Found')
    expect(await code(postConfig('https://a.test/x', 't', 'plan', {}))).toBe('LINK_MISSING')
    answer(501, { code: 'NOT_SUPPORTED_ON_DATABASE', message: 'Needs SQL Server' })
    expect(await code(postConfig('https://a.test/x', 't', 'plan', {}))).toBe(
      'NOT_SUPPORTED_ON_DATABASE'
    )
  })

  it('an unreachable app is APP_UNREACHABLE', async () => {
    _setConfigFetchForTests(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await code(postConfig('https://a.test/x', 't', 'snapshot', {}))).toBe('APP_UNREACHABLE')
  })
})
