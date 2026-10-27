import type { Profile } from '@node-saml/node-saml'
import { describe, expect, it, vi } from 'vitest'

// Security audit 2026-10-27, auth Lows: provisioning secret compared in constant time; the
// request log masks credentials in stored bodies; a SAML assertion works once; a push
// notification's Reply token works once.

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

import { consumeAssertionId, resetSaml, samlAssertionId } from '../../../auth/saml.js'
import { maskLoggedBody } from '../../../plugins/api-logger.js'
import { provisionSecretMatches } from '../../../routes/admin/provision.js'
import { mintReplyToken, REPLY_TOKEN_TTL_S, redeemReplyToken } from '../../../services/chat-send.js'

describe('provisionSecretMatches', () => {
  it('matches only the configured secret; nothing matches when none is set', () => {
    expect(provisionSecretMatches('s3cret-value', 's3cret-value')).toBe(true)
    expect(provisionSecretMatches('s3cret-valuX', 's3cret-value')).toBe(false)
    expect(provisionSecretMatches('short', 's3cret-value')).toBe(false)
    expect(provisionSecretMatches(['s3cret-value'], 's3cret-value')).toBe(false)
    expect(provisionSecretMatches('anything', undefined)).toBe(false)
    expect(provisionSecretMatches(undefined, 's3cret-value')).toBe(false)
  })
})

describe('maskLoggedBody', () => {
  it('masks credential-named values at any depth and keeps business fields', () => {
    const raw = JSON.stringify({
      item_key: 'K-1',
      password: 'hunter2',
      nested: { client_secret: 'abc', api_key: 'k', rows: [{ token: 't', qty: 2 }] }
    })
    const out = JSON.parse(maskLoggedBody(raw))
    expect(out.item_key).toBe('K-1')
    expect(out.password).toBe('••••••')
    expect(out.nested.client_secret).toBe('••••••')
    expect(out.nested.api_key).toBe('••••••')
    expect(out.nested.rows[0]).toEqual({ token: '••••••', qty: 2 })
  })

  it('returns a body with nothing to mask byte for byte', () => {
    const raw = '{ "a": 1,  "b": [2] }'
    expect(maskLoggedBody(raw)).toBe(raw)
  })
})

describe('SAML assertion replay', () => {
  const profile = (id: string | null) =>
    ({
      issuer: 'https://idp.test',
      nameID: 'n@x.test',
      nameIDFormat: 'email',
      getAssertionXml: () =>
        id
          ? `<saml:Assertion xmlns:saml="x" Version="2.0" ID="${id}"><x/></saml:Assertion>`
          : '<x/>'
    }) as unknown as Profile

  it('reads the assertion id and accepts it once', async () => {
    resetSaml()
    expect(samlAssertionId(profile('_abc123'))).toBe('_abc123')
    expect(await consumeAssertionId(profile('_abc123'))).toBe(true)
    expect(await consumeAssertionId(profile('_abc123'))).toBe(false)
    expect(await consumeAssertionId(profile('_other'))).toBe(true)
  })

  it('refuses an assertion without an id', async () => {
    expect(await consumeAssertionId(profile(null))).toBe(false)
  })
})

describe('push Reply token', () => {
  it('works once and lives a day', async () => {
    const kv = new Map<string, string>()
    const setArgs: unknown[][] = []
    const app = {
      redis: {
        set: async (...a: unknown[]) => {
          setArgs.push(a)
          kv.set(String(a[0]), String(a[1]))
          return 'OK'
        },
        getdel: async (k: string) => {
          const v = kv.get(k) ?? null
          kv.delete(k)
          return v
        }
      }
    }
    const token = await mintReplyToken(app as never, 'U1', 'dm:1')
    expect(setArgs[0][3]).toBe(REPLY_TOKEN_TTL_S)
    expect(REPLY_TOKEN_TTL_S).toBe(24 * 3600)
    expect(await redeemReplyToken(app as never, String(token))).toEqual({
      user: 'U1',
      room: 'dm:1'
    })
    expect(await redeemReplyToken(app as never, String(token))).toBe(null)
  })
})
