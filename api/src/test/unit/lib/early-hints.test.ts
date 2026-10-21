import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fastify from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import {
  applyEarlyHints,
  earlyHintsMode,
  hintLinksFromHtml,
  loadEarlyHints,
  wantsDocument
} from '../../../lib/early-hints.js'

const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans&display=swap" rel="stylesheet" />
    <script type="module" crossorigin src="/assets/index-B4rIJsRM.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/react-D3tBxehk.js">
    <link rel="stylesheet" crossorigin href="/assets/index-CPC35z_q.css">
  </head>
  <body><div id="root"></div><script src="/legacy.js"></script></body>
</html>`

describe('earlyHintsMode', () => {
  it('is off unless asked', () => {
    expect(earlyHintsMode(undefined)).toBe('off')
    expect(earlyHintsMode('')).toBe('off')
    expect(earlyHintsMode('nope')).toBe('off')
    expect(earlyHintsMode('ON')).toBe('on')
    expect(earlyHintsMode('true')).toBe('on')
    expect(earlyHintsMode(' link ')).toBe('link')
  })
})

describe('hintLinksFromHtml', () => {
  it('lists preconnects, stylesheets, module scripts and entry fonts in fetch order', () => {
    const links = hintLinksFromHtml(BUILT, (p) =>
      p === '/assets/index-CPC35z_q.css'
        ? '@font-face{src:url(/assets/inter-Ab12Cd34.woff2) format("woff2")}' +
          '@font-face{src:url("/assets/inter-Ab12Cd34.woff2")}.x{background:url(/assets/a.png)}'
        : null
    )
    expect(links).toEqual([
      '<https://fonts.googleapis.com>; rel=preconnect',
      '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
      '<https://fonts.googleapis.com/css2?family=DM+Sans&display=swap>; rel=preload; as=style',
      '</assets/index-CPC35z_q.css>; rel=preload; as=style; crossorigin',
      '</assets/react-D3tBxehk.js>; rel=modulepreload',
      '</assets/index-B4rIJsRM.js>; rel=modulepreload',
      '</assets/inter-Ab12Cd34.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin'
    ])
  })

  it('skips the icon, classic scripts and anything a Link header cannot carry', () => {
    const links = hintLinksFromHtml(
      '<head><link rel="stylesheet" href="javascript:alert(1)">' +
        '<link rel="stylesheet" href="/a.css, </evil>">' +
        '<link rel="preconnect" href="//proto-relative.example">' +
        '<script type="module" src="/ok.js"></script></head>'
    )
    expect(links).toEqual(['</ok.js>; rel=modulepreload'])
  })

  it('is empty for a page with nothing to hint', () => {
    expect(hintLinksFromHtml('<html><head><title>x</title></head></html>')).toEqual([])
  })
})

describe('loadEarlyHints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nvr-hints-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the built index.html and its entry stylesheet', () => {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), BUILT)
    writeFileSync(
      join(dir, 'assets', 'index-CPC35z_q.css'),
      '@font-face{src:url(/assets/dm-XyZ12345.woff2)}'
    )
    const links = loadEarlyHints(dir)
    expect(links).toContain('</assets/index-B4rIJsRM.js>; rel=modulepreload')
    expect(links.at(-1)).toBe(
      '</assets/dm-XyZ12345.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin'
    )
  })

  it('is empty without a build', () => {
    expect(loadEarlyHints(join(dir, 'missing'))).toEqual([])
  })
})

function fakes(opts: { method?: string; accept?: string; major?: number; minor?: number }) {
  const headers: Record<string, string> = {}
  const early: Array<Record<string, string | string[]>> = []
  const req = {
    method: opts.method ?? 'GET',
    headers: { accept: opts.accept ?? 'text/html,application/xhtml+xml' },
    raw: { httpVersionMajor: opts.major ?? 1, httpVersionMinor: opts.minor ?? 1 }
  }
  const reply = {
    header: (k: string, v: string) => {
      headers[k] = v
    },
    raw: {
      headersSent: false,
      writeEarlyHints: (h: Record<string, string | string[]>) => early.push(h)
    }
  }
  return { req, reply, headers, early }
}

const LINKS = ['</assets/index-B4rIJsRM.js>; rel=modulepreload']

describe('applyEarlyHints', () => {
  it('sends nothing when off', () => {
    const f = fakes({})
    expect(applyEarlyHints(f.req, f.reply, LINKS, 'off')).toBe('none')
    expect(f.headers).toEqual({})
    expect(f.early).toEqual([])
  })

  it('link mode sets only the Link header', () => {
    const f = fakes({})
    expect(applyEarlyHints(f.req, f.reply, LINKS, 'link')).toBe('link')
    expect(f.headers.Link).toBe(LINKS[0])
    expect(f.early).toEqual([])
  })

  it('on mode sends a 103 to HTTP/1.1 and HTTP/2 navigations', () => {
    const a = fakes({})
    expect(applyEarlyHints(a.req, a.reply, LINKS, 'on')).toBe('early')
    expect(a.early).toEqual([{ link: LINKS }])
    const b = fakes({ major: 2, minor: 0 })
    expect(applyEarlyHints(b.req, b.reply, LINKS, 'on')).toBe('early')
  })

  it('never sends a 103 to an HTTP/1.0 client', () => {
    const f = fakes({ major: 1, minor: 0 })
    expect(applyEarlyHints(f.req, f.reply, LINKS, 'on')).toBe('link')
    expect(f.early).toEqual([])
  })

  it('skips requests that are not navigations', () => {
    expect(wantsDocument({ method: 'POST', headers: { accept: 'text/html' } })).toBe(false)
    expect(wantsDocument({ method: 'GET', headers: { accept: 'application/json' } })).toBe(false)
    const f = fakes({ accept: '*/*' })
    expect(applyEarlyHints(f.req, f.reply, LINKS, 'on')).toBe('none')
  })

  it('never throws when the socket refuses the hint', () => {
    const f = fakes({})
    f.reply.raw.writeEarlyHints = () => {
      throw new Error('socket gone')
    }
    expect(applyEarlyHints(f.req, f.reply, LINKS, 'on')).toBe('none')
  })
})

describe('over a real socket', async () => {
  const app = fastify()
  app.get('/', async (req, reply) => {
    applyEarlyHints(req, reply, LINKS, 'on')
    return reply.type('text/html').send('<html>ok</html>')
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as net.AddressInfo).port
  afterAll(() => app.close())

  it('an HTTP/1.1 client sees the 103, then the page', async () => {
    const info: Array<{ statusCode: number; headers: http.IncomingHttpHeaders }> = []
    const res = await new Promise<{ status: number; link: string | undefined; body: string }>(
      (resolve, reject) => {
        const r = http.get(
          { host: '127.0.0.1', port, path: '/', headers: { accept: 'text/html' } },
          (m) => {
            let body = ''
            m.on('data', (c) => {
              body += c
            })
            m.on('end', () =>
              resolve({ status: m.statusCode ?? 0, link: m.headers.link as string, body })
            )
          }
        )
        r.on('information', (i) => info.push({ statusCode: i.statusCode, headers: i.headers }))
        r.on('error', reject)
      }
    )
    expect(info[0]?.statusCode).toBe(103)
    expect(String(info[0]?.headers.link)).toContain('/assets/index-B4rIJsRM.js')
    expect(res.status).toBe(200)
    expect(res.link).toBe(LINKS[0])
    expect(res.body).toBe('<html>ok</html>')
  })

  it('an HTTP/1.0 client gets the page with no informational response', async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('GET / HTTP/1.0\r\nHost: localhost\r\nAccept: text/html\r\n\r\n')
      })
      let out = ''
      s.on('data', (c) => {
        out += c
      })
      s.on('end', () => resolve(out))
      s.on('error', reject)
    })
    expect(raw).not.toContain(' 103 ')
    expect(raw.startsWith('HTTP/1.1 200') || raw.startsWith('HTTP/1.0 200')).toBe(true)
    expect(raw).toContain('<html>ok</html>')
  })
})
