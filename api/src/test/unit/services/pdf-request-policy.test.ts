import { describe, expect, it, vi } from 'vitest'

// What a PDF's browser may load (#2789 security review): inline data, this
// instance's own origins, public http(s) — never the server's disk, loopback,
// private networks or the cloud metadata endpoint.

vi.mock('../../../config.js', () => ({
  config: { PUBLIC_URL: 'https://efp.example.com', ADMIN_URL: 'http://localhost:3056' }
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { pdfOwnOrigins, pdfRequestAllowed } from '../../../services/pdf-layout.js'

describe('pdfRequestAllowed', () => {
  const own = pdfOwnOrigins(['http://10.0.0.5:3055', 'not a url'])

  it('own origins come from PUBLIC_URL, ADMIN_URL and the caller', () => {
    expect(own).toEqual([
      'https://efp.example.com',
      'http://localhost:3056',
      'http://10.0.0.5:3055'
    ])
  })

  it('allows inline data and this instance itself', async () => {
    for (const url of [
      'about:blank',
      'data:image/png;base64,iVBORw0KGgo=',
      'blob:https://efp.example.com/5d1f',
      'https://efp.example.com/api/files/abc/raw',
      'http://localhost:3056/logo.svg',
      'http://10.0.0.5:3055/api/files/1'
    ])
      expect(await pdfRequestAllowed(url, own), url).toBe(true)
  })

  it('allows a public http(s) address (a logo on a CDN)', async () => {
    expect(await pdfRequestAllowed('https://93.184.216.34/logo.png', own)).toBe(true)
  })

  it('blocks the disk, metadata, loopback and private networks', async () => {
    for (const url of [
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:3055/api/version',
      'http://localhost:9000/',
      'http://10.1.2.3/',
      'http://192.168.0.1/',
      'http://metadata.internal/',
      'ftp://example.com/x',
      'chrome://settings',
      'ws://example.com/'
    ])
      expect(await pdfRequestAllowed(url, own), url).toBe(false)
  })
})
