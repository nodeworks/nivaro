import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pack } from 'tar-stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/config.js'
import { EXTENSION_MAX_BYTES, ensureExtension, sweepUnpackContainers } from '../src/extensions.js'
import { StackError } from '../src/stacks.js'
import { FakeEngine } from './fake-engine.js'

const TOKEN = 'agent-token-0123456789-abcdefghij'
const HEX = 'ab12cd34ef56'.padEnd(64, '7')
const REF = `nodeworks/nivaro@sha256:${HEX}`
const PRIVATE_REF = `registry.example.com/acme/tools-ext@sha256:${HEX}`

let root: string
let cfg: AgentConfig
let fake: FakeEngine

function makeCfg(
  over: Record<string, string> = {},
  files: Record<string, string> = {}
): AgentConfig {
  return loadAgentConfig(
    {
      HUB_AGENT_TOKEN_FILE: '/t',
      HUB_AGENT_EDGE_NETWORK: 'edge',
      HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
      HUB_AGENT_EXTENSIONS_ROOT: root,
      HUB_AGENT_EXTENSIONS_HOST_ROOT: '/srv/ext',
      ...over
    },
    (p) => files[p] ?? TOKEN
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hub-agent-ext-'))
  cfg = makeCfg()
  fake = new FakeEngine(cfg)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

type Entry = {
  name: string
  type?: 'file' | 'directory' | 'symlink' | 'link' | 'fifo' | 'character-device' | 'block-device'
  body?: string
  linkname?: string
  mode?: number
}

function makeTar(entries: Entry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = pack()
    const chunks: Buffer[] = []
    p.on('data', (c: Buffer) => chunks.push(c))
    p.on('end', () => resolve(Buffer.concat(chunks)))
    p.on('error', reject)
    for (const e of entries) {
      const type = e.type ?? 'file'
      p.entry(
        { name: e.name, type, linkname: e.linkname, mode: e.mode },
        type === 'file' ? (e.body ?? '') : undefined
      )
    }
    p.finalize()
  })
}

/** A bare ustar header claiming `size` bytes: the agent must refuse it without reading them. */
function rawHeader(name: string, size: number, type = '0'): Buffer {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100)
  b.write('0000644\0', 100)
  b.write('0000000\0', 108)
  b.write('0000000\0', 116)
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  b.write('00000000000\0', 136)
  b.write('        ', 148)
  b.write(type, 156)
  b.write('ustar\0', 257)
  b.write('00', 263)
  let sum = 0
  for (const x of b) sum += x
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return b
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])

/** A GNU long-name record (typeflag L) naming the next entry. */
function gnuLongName(longName: string, body: string): Buffer {
  const name = Buffer.from(`${longName}\0`)
  const data = Buffer.from(body)
  return Buffer.concat([
    rawHeader('././@LongLink', name.length, 'L'),
    pad(name),
    rawHeader('extension/short.js', data.length),
    pad(data),
    Buffer.alloc(1024)
  ])
}

const good = () =>
  makeTar([
    { name: 'extension/', type: 'directory' },
    { name: 'extension/index.js', body: 'export default {}', mode: 0o4755 },
    { name: 'extension/lib/util.js', body: 'module.exports = 1' },
    { name: 'extension/templates/mail/', type: 'directory' }
  ])

function leftovers(stack: string): string[] {
  const dir = join(root, stack)
  return existsSync(dir) ? readdirSync(dir) : []
}

describe('ensureExtension', () => {
  it('pulls by digest, unpacks /extension to <id>@<digest12> and deletes the container', async () => {
    fake.archive(REF, await good())
    const host = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF)
    expect(host).toBe('/srv/ext/acme-st/efp-ops@ab12cd34ef56')
    const dir = join(root, 'acme-st', 'efp-ops@ab12cd34ef56')
    expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe('export default {}')
    expect(readFileSync(join(dir, 'lib/util.js'), 'utf8')).toBe('module.exports = 1')
    expect(statSync(join(dir, 'templates/mail')).isDirectory()).toBe(true)
    // No setuid survives.
    expect(statSync(join(dir, 'index.js')).mode & 0o7000).toBe(0)
    expect(leftovers('acme-st')).toEqual(['efp-ops@ab12cd34ef56'])

    const pull = fake.calls.find((c) => c.path === '/images/create')
    expect(pull?.query).toEqual({ fromImage: 'nodeworks/nivaro', tag: `sha256:${HEX}` })
    const create = fake.calls.find((c) => c.path === '/containers/create')
    expect(create?.body).toEqual({
      Image: REF,
      Cmd: ['/bin/true'],
      Labels: { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 'acme-st' },
      HostConfig: {}
    })
    expect(fake.calls.some((c) => c.method === 'POST' && /start/.test(c.path))).toBe(false)
    expect(fake.calls.find((c) => c.path.endsWith('/archive'))?.query).toEqual({
      path: '/extension'
    })
    expect(fake.containers.size).toBe(0)
    expect(fake.refused).toEqual([])
  })

  it('an existing folder is reused: no pull, no container', async () => {
    fake.archive(REF, await good())
    await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF)
    fake.calls.length = 0
    const host = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF)
    expect(host).toBe('/srv/ext/acme-st/efp-ops@ab12cd34ef56')
    expect(fake.calls).toEqual([])
  })

  const BAD: Array<[string, () => Promise<Buffer>]> = [
    ['a `..` entry', () => makeTar([{ name: 'extension/../x', body: 'x' }])],
    ['a nested `..` entry', () => makeTar([{ name: 'extension/a/../../../x', body: 'x' }])],
    ['an absolute path', () => makeTar([{ name: '/etc/x', body: 'x' }])],
    ['an entry outside /extension', () => makeTar([{ name: 'other/x', body: 'x' }])],
    [
      'a symlink',
      () => makeTar([{ name: 'extension/l', type: 'symlink', linkname: '/etc/passwd' }])
    ],
    [
      'a hardlink',
      () => makeTar([{ name: 'extension/h', type: 'link', linkname: 'extension/index.js' }])
    ],
    ['a fifo', () => makeTar([{ name: 'extension/f', type: 'fifo' }])],
    ['a character device', () => makeTar([{ name: 'extension/c', type: 'character-device' }])],
    ['a block device', () => makeTar([{ name: 'extension/b', type: 'block-device' }])],
    [
      'the same file twice',
      () =>
        makeTar([
          { name: 'extension/a.js', body: '1' },
          { name: 'extension/a.js', body: '2' }
        ])
    ],
    [
      'a file where a folder is needed',
      () =>
        makeTar([
          { name: 'extension/a', body: '1' },
          { name: 'extension/a/b.js', body: '2' }
        ])
    ],
    [
      'a pax long name with `..`',
      () => makeTar([{ name: `extension/../${'b'.repeat(120)}`, body: 'x' }])
    ],
    ['a GNU long name with `..`', async () => gnuLongName('extension/../../escape.js', 'x')],
    ['a GNU long absolute name', async () => gnuLongName('/etc/escape.js', 'x')],
    [
      'a symlink, then a file through it',
      () =>
        makeTar([
          { name: 'extension/d', type: 'symlink', linkname: '/tmp' },
          { name: 'extension/d/x.js', body: 'x' }
        ])
    ],
    [
      '201 MB',
      async () =>
        Buffer.concat([rawHeader('extension/big.bin', 201 * 1024 * 1024), Buffer.alloc(4096)])
    ],
    [
      'a corrupt archive',
      async () => Buffer.concat([Buffer.from('not a tar at all'), Buffer.alloc(1024, 1)])
    ]
  ]

  it.each(
    BAD
  )('%s → EXTENSION_INVALID, temp folder removed, container deleted', async (_n, make) => {
    fake.archive(REF, await make())
    const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
    expect(err).toBeInstanceOf(StackError)
    expect(err.code).toBe('EXTENSION_INVALID')
    expect(err.status).toBe(422)
    expect(leftovers('acme-st')).toEqual([])
    expect(fake.containers.size).toBe(0)
    expect(existsSync(join(root, 'x'))).toBe(false)
    expect(existsSync(join(root, 'acme-st', 'x'))).toBe(false)
  })

  it('a GNU long name inside /extension unpacks (the long-name records are understood)', async () => {
    const long = `extension/${'c'.repeat(150)}.js`
    fake.archive(REF, gnuLongName(long, 'ok'))
    await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF)
    expect(
      readFileSync(join(root, 'acme-st', 'efp-ops@ab12cd34ef56', `${'c'.repeat(150)}.js`), 'utf8')
    ).toBe('ok')
  })

  it('a stack folder that is a symlink is refused before any call; nothing lands behind it', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'hub-agent-elsewhere-'))
    try {
      symlinkSync(elsewhere, join(root, 'acme-st'))
      fake.archive(REF, await good())
      const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
      expect(err).toMatchObject({ code: 'EXTENSION_ROOT_UNSAFE' })
      expect(readdirSync(elsewhere)).toEqual([])
      expect(fake.calls).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('a target folder that is a symlink is refused, never reused', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'hub-agent-elsewhere-'))
    try {
      mkdirSync(join(root, 'acme-st'))
      symlinkSync(elsewhere, join(root, 'acme-st', 'efp-ops@ab12cd34ef56'))
      fake.archive(REF, await good())
      const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
      expect(err).toMatchObject({ code: 'EXTENSION_ROOT_UNSAFE' })
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('a failure while a file is being written leaves no temp folder (the write is awaited)', async () => {
    const big = 'y'.repeat(300_000)
    const tar = await makeTar([
      { name: 'extension/big.js', body: big },
      { name: 'extension/l', type: 'symlink', linkname: '/etc' }
    ])
    // Cut the archive short: tar-stream fails while the first file may still be written.
    fake.archive(REF, tar.subarray(0, 512 + 200_000))
    const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
    expect(err.code).toBe('EXTENSION_INVALID')
    await new Promise((r) => setTimeout(r, 50))
    expect(leftovers('acme-st')).toEqual([])
  })

  it.each([
    'nextTick',
    'setImmediate',
    '10 ms'
  ])('reviewer probe: header + 512 bytes, then ECONNRESET (%s) settles, container gone, no .tmp', async (when) => {
    fake.archive(REF, () => {
      const r = new Readable({ read() {} })
      r.push(Buffer.concat([rawHeader('extension/a/b/c/file.js', 1024), Buffer.alloc(512, 0x61)]))
      const reset = () =>
        r.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      if (when === 'nextTick') process.nextTick(reset)
      else if (when === 'setImmediate') setImmediate(reset)
      else setTimeout(reset, 10)
      return r
    })
    const started = Date.now()
    const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(err).toBeInstanceOf(StackError)
    expect(err.code).toBe('EXTENSION_INVALID')
    expect(fake.containers.size).toBe(0)
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/containers/'))).toBe(
      true
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(leftovers('acme-st')).toEqual([])
  })

  it('the start-up sweep deletes only labelled unpack containers named for their stack', async () => {
    fake.leftoverContainer('nvh_acme-st_unpack_0123abcd', {
      'nivaro.hub.managed': '1',
      'nivaro.hub.unpack': 'acme-st'
    })
    fake.leftoverContainer('nvh_acme-st_unpack_deadbeef', { 'nivaro.hub.unpack': 'acme-st' })
    fake.leftoverContainer('nvh_acme-st_unpack_feedface', {
      'nivaro.hub.managed': '1',
      'nivaro.hub.unpack': 'other'
    })
    fake.leftoverContainer('efp_tools', { 'nivaro.hub.managed': '1', 'nivaro.hub.unpack': 'efp' })
    fake.leftoverContainer('efp_web.1.abc', { 'com.docker.stack.namespace': 'efp' })
    const removed = await sweepUnpackContainers(fake)
    expect(removed).toEqual(['nvh_acme-st_unpack_0123abcd'])
    expect([...fake.containers.keys()].sort()).toEqual([
      'efp_tools',
      'efp_web.1.abc',
      'nvh_acme-st_unpack_deadbeef',
      'nvh_acme-st_unpack_feedface'
    ])
    expect(fake.refused).toEqual([])
    const del = fake.calls.filter((c) => c.method === 'DELETE')
    expect(del).toEqual([
      {
        method: 'DELETE',
        path: '/containers/nvh_acme-st_unpack_0123abcd',
        query: { force: true, v: true }
      }
    ])
  })

  it('the default size limit is 200 MB', () => {
    expect(EXTENSION_MAX_BYTES).toBe(200 * 1024 * 1024)
  })

  it('too many entries → EXTENSION_INVALID', async () => {
    const entries: Entry[] = []
    for (let i = 0; i < 30; i++) entries.push({ name: `extension/f${i}.js`, body: 'x' })
    fake.archive(REF, await makeTar(entries))
    const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF, {
      maxEntries: 20
    }).catch((e) => e)
    expect(err.code).toBe('EXTENSION_INVALID')
    expect(leftovers('acme-st')).toEqual([])
  })

  it('an image without /extension → EXTENSION_INVALID', async () => {
    const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
    expect(err.code).toBe('EXTENSION_INVALID')
    expect(fake.containers.size).toBe(0)
  })

  it('a failed pull → IMAGE_PULL_FAILED (422), no container', async () => {
    fake.failPull(REF)
    const err = await ensureExtension(fake, cfg, 'acme-st', 'efp-ops', REF).catch((e) => e)
    expect(err).toMatchObject({ code: 'IMAGE_PULL_FAILED', status: 422 })
    expect(fake.calls.some((c) => c.path === '/containers/create')).toBe(false)
    expect(JSON.stringify(err)).not.toContain('denied')
  })

  it('sends registry auth for a matching registry only', async () => {
    const auth = Buffer.from('robot:pa55word-xyz').toString('base64')
    const c2 = makeCfg(
      {
        HUB_AGENT_IMAGES: 'nodeworks/nivaro,registry.example.com/acme/tools-ext',
        HUB_AGENT_REGISTRY_AUTH_FILE: '/auth'
      },
      { '/auth': JSON.stringify({ auths: { 'registry.example.com': { auth } } }) }
    )
    const f2 = new FakeEngine(c2)
    f2.archive(PRIVATE_REF, await good())
    f2.archive(REF, await good())
    await ensureExtension(f2, c2, 'acme-st', 'tools', PRIVATE_REF)
    const pull = f2.calls.find((c) => c.path === '/images/create')
    const header = pull?.headers?.['X-Registry-Auth'] as string
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      username: 'robot',
      password: 'pa55word-xyz',
      serveraddress: 'registry.example.com'
    })
    f2.calls.length = 0
    await ensureExtension(f2, c2, 'acme-st', 'efp-ops', REF)
    expect(f2.calls.find((c) => c.path === '/images/create')?.headers).toBeUndefined()
  })

  it('refuses a bad id, stack or reference before any call', async () => {
    for (const [stack, id, ref] of [
      ['acme-st', '../x', REF],
      ['acme-st', 'efp-ops', 'nodeworks/nivaro:latest'],
      ['../st', 'efp-ops', REF],
      ['Acme', 'efp-ops', REF]
    ]) {
      await expect(ensureExtension(fake, cfg, stack, id, ref)).rejects.toThrow()
    }
    expect(fake.calls).toEqual([])
  })
})
