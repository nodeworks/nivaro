import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoredObjectMissing } from '../../../services/storage/missing.js'
import { buildDriver } from '../../../services/storage-drivers.js'

// R6-I-1 (ruling P6-33): a saved-settings driver says "not there" only for a real 404; any other
// failed read (throttling, a refused credential) stays an error with its status, so a move's file
// route answers 5xx (the row fails) and never reports the object missing.

const drivers = {
  s3: () =>
    buildDriver('s3', {
      bucket: 'b',
      access_key_id: 'AK',
      secret_access_key: 'SK',
      endpoint: 'https://s3.example.com'
    }),
  azure: () =>
    buildDriver('azure-blob', {
      account: 'acct',
      container: 'c',
      account_key: Buffer.from('k').toString('base64')
    })
}

afterEach(() => vi.unstubAllGlobals())

describe('saved-settings driver read errors', () => {
  for (const [name, make] of Object.entries(drivers)) {
    it(`${name}: a 404 is StoredObjectMissing`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('NoSuchKey', { status: 404 })))
      await expect(make().get('a/b.pdf')).rejects.toBeInstanceOf(StoredObjectMissing)
    })

    for (const status of [503, 403, 500])
      it(`${name}: a ${status} is an error with that status, never "missing"`, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })))
        const err = await make()
          .get('a/b.pdf')
          .catch((e) => e)
        expect(err).not.toBeInstanceOf(StoredObjectMissing)
        expect(err.status).toBe(status)
      })
  }
})
