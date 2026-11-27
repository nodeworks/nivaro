import { createPrivateKey } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AgentConfig, ConfigError, loadAgentConfig } from '../src/config.js'
import {
  certFingerprint,
  checkEdgeTls,
  defaultEdgeTlsFs,
  EDGE_TLS_MAX_CERTS,
  type EdgeTlsFs,
  edgeTlsFileName,
  edgeTlsFileText,
  pemBlocks
} from '../src/edge-tls.js'
import type { EngineCallOptions, EngineMethod } from '../src/engine.js'
import { baseHandlers } from '../src/main.js'
import { specHash, specHashInput } from '../src/names.js'
import { type RenderConfig, renderServices } from '../src/render.js'
import { type StackSpec, validateStackSpec } from '../src/spec.js'
import { applyStack, removeStack, StackError, stackHash } from '../src/stacks.js'
import { FakeEngine } from './fake-engine.js'

// Agent 0.2.5: a stack's own certificate (edge_tls) served by Traefik's file provider.
// The PEM fixtures in test/fixtures/edge-tls are throwaway self-signed test certificates made
// for these tests only (names under .apps.corp, 100-year validity); their keys protect nothing.
const FIX = resolve(import.meta.dirname, 'fixtures/edge-tls')
const read = (f: string) => readFileSync(join(FIX, f), 'utf8')
const A = { cert: read('a.crt'), key: read('a.key') } // EC P-256, PKCS#8 "PRIVATE KEY"
const B = { cert: read('b.crt'), key: read('b.key') } // RSA 2048, "RSA PRIVATE KEY"
const WILD = { cert: read('wild.crt'), key: read('wild.key') } // *.apps.corp
const NAMES = ['acme-staging.apps.corp', 'www.acme-staging.apps.corp']
/** The base64 body lines of a key: what must never show up anywhere. */
const keyBody = (k: string) =>
  k
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('')

const IMAGE = `nodeworks/nivaro@sha256:${'1'.repeat(64)}`
const REDIS = `redis@sha256:${'c'.repeat(64)}`
const TOKEN = 'agent-token-0123456789-abcdefghij'
const NODE = 'node-agent-1'
const S = 'acme-st'

describe('checkEdgeTls', () => {
  it('takes a chain and its key (PKCS#8 EC, traditional RSA) and normalises them', () => {
    // The fixtures are already one LF-ended PEM each: normalising keeps them as they are.
    for (const tls of [A, B]) expect(checkEdgeTls(tls, NAMES)).toEqual({ ok: true, tls })
  })

  it('CRLF line ends and blank lines around blocks normalise to LF', () => {
    const crlf = {
      cert: `\n\n${A.cert.replace(/\n/g, '\r\n')}\n`,
      key: A.key.replace(/\n/g, '\r\n')
    }
    const r = checkEdgeTls(crlf, NAMES)
    expect(r).toEqual({ ok: true, tls: { cert: A.cert, key: A.key } })
  })

  it('a SEC1 EC key with its EC PARAMETERS block: the parameters are dropped', () => {
    const sec1 = createPrivateKey(A.key).export({ type: 'sec1', format: 'pem' }) as string
    const withParams = `-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n${sec1}`
    const r = checkEdgeTls({ cert: A.cert, key: withParams }, NAMES)
    expect(r).toEqual({ ok: true, tls: { cert: A.cert, key: sec1 } })
  })

  it('a chain of two certificates keeps both, leaf first', () => {
    const r = checkEdgeTls({ cert: `${A.cert}${WILD.cert}`, key: A.key }, NAMES)
    expect(r.ok && pemBlocks(r.tls.cert)?.length).toBe(2)
  })

  it('a name the certificate does not cover: TLS_NAME_NOT_COVERED on that hostname', () => {
    expect(checkEdgeTls(A, [...NAMES, 'other.apps.corp'])).toEqual({
      ok: false,
      fields: [{ field: 'hostnames[2]', code: 'TLS_NAME_NOT_COVERED' }]
    })
  })

  // Security review 2026-11-27: Traefik's file-provider store is one store for every router and
  // picks by SNI, so a leaf naming another stack's host would take over TLS for that stack.
  describe('every name the leaf answers for is one of the stack’s own (TLS_NAME_OUTSIDE_STACK)', () => {
    const OUT = { field: 'edge_tls.cert', code: 'TLS_NAME_OUTSIDE_STACK' }
    const FOREIGN = { cert: read('foreign.crt'), key: read('foreign.key') }
    const WILD_OWN = { cert: read('wild-own.crt'), key: read('wild-own.key') }
    const CN_FOREIGN = { cert: read('cn-foreign.crt'), key: read('cn-foreign.key') }
    const CN_OWN = { cert: read('cn-own.crt'), key: read('cn-own.key') }
    const IP = { cert: read('ip.crt'), key: read('ip.key') }

    it('a SAN for a foreign host is refused', () => {
      expect(checkEdgeTls(FOREIGN, NAMES)).toEqual({ ok: false, fields: [OUT] })
    })

    it('a wildcard SAN covering a foreign host is refused (also beside the own names)', () => {
      expect(checkEdgeTls(WILD_OWN, NAMES)).toEqual({ ok: false, fields: [OUT] })
      expect(checkEdgeTls(WILD, ['acme-staging.apps.corp'])).toEqual({ ok: false, fields: [OUT] })
    })

    it('a CN-only leaf naming a foreign host is refused; one naming the stack passes', () => {
      expect(checkEdgeTls(CN_FOREIGN, ['acme-staging.apps.corp'])).toMatchObject({
        ok: false,
        fields: expect.arrayContaining([OUT])
      })
      expect(checkEdgeTls(CN_OWN, ['acme-staging.apps.corp']).ok).toBe(true)
    })

    it('an IP SAN is refused', () => {
      expect(checkEdgeTls(IP, NAMES)).toEqual({ ok: false, fields: [OUT] })
    })

    it('a leaf naming more than the stack routes is refused (a name another stack may own)', () => {
      expect(checkEdgeTls(A, ['acme-staging.apps.corp'])).toEqual({ ok: false, fields: [OUT] })
    })

    it('an exact-match leaf passes; case and a trailing dot are the same name', () => {
      expect(checkEdgeTls(A, NAMES).ok).toBe(true)
      expect(checkEdgeTls(A, ['ACME-Staging.apps.corp.', 'www.acme-staging.APPS.corp']).ok).toBe(
        true
      )
    })

    it('with host suffixes, every name must sit under one of them', () => {
      expect(checkEdgeTls(A, NAMES, { hostSuffixes: ['.apps.corp'] }).ok).toBe(true)
      expect(checkEdgeTls(A, NAMES, { hostSuffixes: ['.other.corp'] })).toEqual({
        ok: false,
        fields: [OUT]
      })
    })

    it('through the validator: a foreign SAN is refused before anything is written', () => {
      const r = validateStackSpec({ ...appSpec(), edge_tls: FOREIGN }, specCfg())
      expect(r).toEqual({ ok: false, fields: [OUT] })
    })
  })

  it('a key of another certificate: TLS_KEY_MISMATCH', () => {
    expect(checkEdgeTls({ cert: A.cert, key: B.key }, NAMES)).toEqual({
      ok: false,
      fields: [{ field: 'edge_tls.key', code: 'TLS_KEY_MISMATCH' }]
    })
  })

  it('refuses every other shape with codes only', () => {
    const cert = A.cert
    const key = A.key
    const cases: Array<[unknown, string, string]> = [
      ['x', 'edge_tls', 'REQUIRED'],
      [{ cert }, 'edge_tls.key', 'REQUIRED'],
      [{ cert, key: '' }, 'edge_tls.key', 'REQUIRED'],
      [{ cert, key, chain: 'x' }, 'edge_tls.chain', 'UNKNOWN_FIELD'],
      [{ cert: 'hello', key }, 'edge_tls.cert', 'TLS_BAD'],
      [{ cert: `subject=CN=x\n${cert}`, key }, 'edge_tls.cert', 'TLS_BAD'],
      [{ cert: `${cert}{{ env "X" }}`, key }, 'edge_tls.cert', 'TLS_BAD'],
      [{ cert: key, key }, 'edge_tls.cert', 'TLS_BAD'],
      [{ cert: `${cert}${key}`, key }, 'edge_tls.cert', 'TLS_BAD'],
      [{ cert, key: cert }, 'edge_tls.key', 'TLS_BAD'],
      [{ cert, key: `${key}${key}` }, 'edge_tls.key', 'TLS_BAD'],
      [{ cert, key: `${key}${cert}` }, 'edge_tls.key', 'TLS_BAD'],
      [
        { cert, key: key.replace(/PRIVATE KEY/g, 'ENCRYPTED PRIVATE KEY') },
        'edge_tls.key',
        'TLS_BAD'
      ],
      [
        { cert, key: key.replace('-----\n', '-----\nProc-Type: 4,ENCRYPTED\n\n') },
        'edge_tls.key',
        'TLS_BAD'
      ],
      [{ cert: cert.repeat(EDGE_TLS_MAX_CERTS + 1), key }, 'edge_tls.cert', 'TLS_BAD'],
      [{ cert: `${cert}\n${'#'.repeat(65536)}`, key }, 'edge_tls.cert', 'TOO_LONG'],
      // Well-formed PEM that is not a certificate / not a key.
      [
        { cert: '-----BEGIN CERTIFICATE-----\nQUFBQQ==\n-----END CERTIFICATE-----\n', key },
        'edge_tls.cert',
        'TLS_BAD'
      ],
      [
        { cert, key: '-----BEGIN PRIVATE KEY-----\nQUFBQQ==\n-----END PRIVATE KEY-----\n' },
        'edge_tls.key',
        'TLS_BAD'
      ]
    ]
    for (const [v, field, code] of cases) {
      const r = checkEdgeTls(v, NAMES)
      expect(r.ok, `${field} ${code}`).toBe(false)
      if (r.ok) continue
      expect(r.fields, `${field} ${code}`).toContainEqual({ field, code })
      expect(JSON.stringify(r)).not.toContain(keyBody(key))
    }
  })
})

// ── the spec ─────────────────────────────────────────────────────────────

const appSpec = (over: Partial<StackSpec> = {}): StackSpec => ({
  owner: { app: 'acme' },
  environment: 'staging',
  image: IMAGE,
  roles: [
    { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
    { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
  ],
  env: { DB_HOST: 'db.internal', NODE_ENV: 'production' },
  secrets: { DB_PASSWORD: 'pw-one', SESSION_SECRET: 's'.repeat(64) },
  hostnames: [...NAMES],
  redis: 'bundled',
  extensions: {},
  ...over
})

const specCfg = (over: Record<string, unknown> = {}) => ({
  images: ['nodeworks/nivaro'],
  edge: 'traefik' as const,
  hostSuffixes: ['.apps.corp'],
  publishPorts: null,
  redisImage: REDIS,
  traefikDynamicDir: '/srv/traefik/dynamic',
  ...over
})

describe('validateStackSpec: edge_tls', () => {
  it('accepts it on an app stack with the folder set, normalised', () => {
    const crlf = { cert: A.cert.replace(/\n/g, '\r\n'), key: A.key }
    const r = validateStackSpec({ ...appSpec(), edge_tls: crlf }, specCfg())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.edge_tls).toEqual({ cert: A.cert, key: A.key })
  })

  it('an agent without HUB_AGENT_TRAEFIK_DYNAMIC_DIR: TLS_NOT_CONFIGURED', () => {
    for (const dir of [null, undefined, ''])
      expect(
        validateStackSpec({ ...appSpec(), edge_tls: A }, specCfg({ traefikDynamicDir: dir }))
      ).toEqual({ ok: false, fields: [{ field: 'edge_tls', code: 'TLS_NOT_CONFIGURED' }] })
  })

  it('the publish edge: TLS_NEEDS_TRAEFIK; a shared owner: TLS_NOT_FOR_SHARED', () => {
    const pub = validateStackSpec(
      { ...appSpec({ publish_port: 31000 }), edge_tls: A },
      specCfg({ edge: 'publish', publishPorts: [31000, 31099], hostSuffixes: [] })
    )
    expect(pub.ok).toBe(false)
    if (!pub.ok) expect(pub.fields).toContainEqual({ field: 'edge_tls', code: 'TLS_NEEDS_TRAEFIK' })
    const shared = validateStackSpec(
      {
        ...appSpec({ owner: { shared: 'pool-a' }, env: { HUB_SHARED_DEPLOYMENT: 'pool-a' } }),
        edge_tls: A
      },
      specCfg()
    )
    expect(shared.ok).toBe(false)
    if (!shared.ok)
      expect(shared.fields).toContainEqual({ field: 'edge_tls', code: 'TLS_NOT_FOR_SHARED' })
  })

  it('names not covered and a key mismatch are field errors that never carry the key', () => {
    const r = validateStackSpec(
      { ...appSpec({ hostnames: ['other.apps.corp'] }), edge_tls: { cert: A.cert, key: A.key } },
      specCfg()
    )
    expect(r).toEqual({
      ok: false,
      fields: [
        { field: 'hostnames[0]', code: 'TLS_NAME_NOT_COVERED' },
        { field: 'edge_tls.cert', code: 'TLS_NAME_OUTSIDE_STACK' }
      ]
    })
    const m = validateStackSpec({ ...appSpec(), edge_tls: { cert: A.cert, key: B.key } }, specCfg())
    expect(m).toEqual({ ok: false, fields: [{ field: 'edge_tls.key', code: 'TLS_KEY_MISMATCH' }] })
    expect(JSON.stringify(m)).not.toContain(keyBody(B.key))
  })

  it('a spec without edge_tls validates exactly as before', () => {
    const r = validateStackSpec(appSpec(), specCfg({ traefikDynamicDir: null }))
    expect(r.ok && 'edge_tls' in r.spec).toBe(false)
  })
})

// ── the hash ─────────────────────────────────────────────────────────────

describe('spec hash: the certificate counts by fingerprint, the key never in clear', () => {
  const HMAC = 'hmac-key-0123456789-abcdefghijklmnop'

  it('no edge_tls = the hash a spec had before 0.2.5', () => {
    const s = appSpec()
    expect(specHashInput(s, HMAC)).toBe(specHashInput({ ...s, edge_tls: undefined }, HMAC))
    expect(specHashInput(s, HMAC)).not.toContain('edge_tls')
  })

  it('the hash text holds the chain sha256 and a keyed digest of the key, never either PEM', () => {
    const text = specHashInput(appSpec({ edge_tls: A }), HMAC)
    expect(text).toContain(certFingerprint(A.cert))
    expect(text).not.toContain(keyBody(A.key))
    expect(text).not.toContain(keyBody(A.cert))
    expect(text).not.toContain('PRIVATE KEY')
  })

  it('a renewal (new chain, new key) or a new key alone changes the hash; the same pair does not', () => {
    const h = (tls?: { cert: string; key: string }) =>
      specHash(appSpec(tls ? { edge_tls: tls } : {}), HMAC)
    expect(h(A)).toBe(h({ ...A }))
    expect(h(A)).not.toBe(h())
    expect(h(B)).not.toBe(h(A))
    expect(h({ cert: A.cert, key: B.key })).not.toBe(h(A))
  })
})

// ── labels ───────────────────────────────────────────────────────────────

const renderCfg = (over: Partial<RenderConfig> = {}): RenderConfig => ({
  edge: 'traefik',
  edgeNetwork: 'edge',
  entrypoints: ['websecure'],
  certResolver: 'le',
  extensionsShared: false,
  extensionsHostRoot: '/srv/ext',
  volumeDriver: 'local',
  volumeOpts: null,
  redisImage: REDIS,
  ...over
})
const renderCtx = {
  hash: 'h'.repeat(64),
  secretIds: {
    DB_PASSWORD: { id: 'sec0', name: 'nvh_st_DB_PASSWORD_0123456789ab' },
    SESSION_SECRET: { id: 'sec1', name: 'nvh_st_SESSION_SECRET_0123456789ab' }
  },
  extensionPaths: {},
  agentNodeId: NODE,
  network: 'nvh_st'
}
const largeRoles: StackSpec['roles'] = [
  { role: 'web', replicas: 3, env: { SOCKETS: 'off' } },
  { role: 'worker', replicas: 1 },
  { role: 'realtime', replicas: 2 }
]

describe('router labels with a stack certificate (v2 and v3)', () => {
  for (const v of [2, 3] as const) {
    it(`Traefik v${v}: tls=true, no certresolver, exactly one network label`, () => {
      const svcs = renderServices(
        'st',
        appSpec({ roles: largeRoles, edge_tls: A }),
        renderCfg({ traefikVersion: v }),
        renderCtx
      )
      for (const role of ['web', 'realtime']) {
        const l = svcs.find((s) => s.Name === `st_${role}`)?.Labels ?? {}
        const r = role === 'web' ? 'nvh_web_st' : 'nvh_rt_st'
        expect(l[`traefik.http.routers.${r}.tls`]).toBe('true')
        expect(l[`traefik.http.routers.${r}.entrypoints`]).toBe('websecure')
        expect(Object.keys(l).filter((k) => k.includes('certresolver'))).toEqual([])
        const net = Object.keys(l).filter((k) => /^traefik\.(docker|swarm)\.network$/.test(k))
        expect(net).toEqual([v === 2 ? 'traefik.docker.network' : 'traefik.swarm.network'])
      }
      // Nothing of the certificate reaches a service: no label, env, secret or mount.
      const all = JSON.stringify(svcs)
      expect(all).not.toContain(keyBody(A.key))
      expect(all).not.toContain(keyBody(A.cert))
    })

    it(`Traefik v${v}: without one, the cert resolver stays`, () => {
      const svcs = renderServices(
        'st',
        appSpec({ roles: largeRoles }),
        renderCfg({ traefikVersion: v }),
        renderCtx
      )
      const web = svcs.find((s) => s.Name === 'st_web')?.Labels ?? {}
      expect(web['traefik.http.routers.nvh_web_st.tls.certresolver']).toBe('le')
    })
  }

  it('the task templates are the same with or without the certificate', () => {
    const tasks = (s: StackSpec) =>
      renderServices('st', s, renderCfg(), renderCtx).map((x) => x.TaskTemplate)
    expect(tasks(appSpec({ edge_tls: A }))).toEqual(tasks(appSpec()))
    expect(tasks(appSpec({ edge_tls: B }))).toEqual(tasks(appSpec({ edge_tls: A })))
  })

  it('a shared owner never renders one', () => {
    expect(() =>
      renderServices(
        'sh',
        appSpec({ owner: { shared: 'pool-a' }, edge_tls: A }),
        renderCfg(),
        renderCtx
      )
    ).toThrow(/app stack only/)
  })
})

// ── the file ─────────────────────────────────────────────────────────────

describe('the Traefik dynamic file', () => {
  it('nvh-<stack>.yml with the chain and key inline under tls.certificates', () => {
    expect(edgeTlsFileName(S)).toBe('nvh-acme-st.yml')
    const text = edgeTlsFileText(S, A)
    const lines = text.split('\n')
    expect(lines[0]).toBe(
      '# Written by the Nivaro Hub agent for stack acme-st. Replaced on every apply; do not edit.'
    )
    expect(lines[1]).toBe(`# certificate sha256: ${certFingerprint(A.cert)}`)
    expect(lines.slice(2, 5)).toEqual(['tls:', '  certificates:', '    - certFile: |'])
    const keyAt = lines.indexOf('      keyFile: |')
    expect(lines.slice(5, keyAt).join('\n')).toBe(
      A.cert
        .trimEnd()
        .split('\n')
        .map((l) => `        ${l}`)
        .join('\n')
    )
    expect(
      lines
        .slice(keyAt + 1)
        .filter(Boolean)
        .map((l) => l.slice(8))
        .join('\n')
    ).toBe(A.key.trimEnd())
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('defaultEdgeTlsFs (a real folder)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-agent-edge-tls-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes 0600 through a temp file renamed in place; reads it back; removes it', async () => {
    const p = join(dir, 'nvh-x.yml')
    expect(await defaultEdgeTlsFs.read(p)).toBeNull()
    await defaultEdgeTlsFs.writeAtomic(p, 'one')
    expect(lstatSync(p).mode & 0o777).toBe(0o600)
    await defaultEdgeTlsFs.writeAtomic(p, 'two')
    expect(await defaultEdgeTlsFs.read(p)).toBe('two')
    expect(readdirSync(dir)).toEqual(['nvh-x.yml'])
    expect(await defaultEdgeTlsFs.remove(p)).toBe(true)
    expect(await defaultEdgeTlsFs.remove(p)).toBe(false)
  })

  it('a link at the file is replaced, never followed', async () => {
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'keep me')
    const p = join(dir, 'nvh-x.yml')
    symlinkSync(outside, p)
    expect(await defaultEdgeTlsFs.read(p)).not.toBe('keep me')
    await defaultEdgeTlsFs.writeAtomic(p, 'new')
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(readFileSync(p, 'utf8')).toBe('new')
  })
})

// ── apply / renew / unbind / remove ──────────────────────────────────────

class FakeTlsFs implements EdgeTlsFs {
  files = new Map<string, string>()
  writes: string[] = []
  removes: string[] = []
  fail = false
  constructor(private readonly order: string[]) {}
  async read(p: string) {
    return this.files.get(p) ?? null
  }
  async writeAtomic(p: string, text: string) {
    if (this.fail) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    this.order.push(`file:write ${p}`)
    this.writes.push(p)
    this.files.set(p, text)
  }
  async remove(p: string) {
    this.order.push(`file:remove ${p}`)
    this.removes.push(p)
    return this.files.delete(p)
  }
}

class OrderedEngine extends FakeEngine {
  order: string[] = []
  override async call<T = unknown>(
    method: EngineMethod,
    path: string,
    opts: EngineCallOptions = {}
  ): Promise<{ status: number; body: T }> {
    if (method !== 'GET') this.order.push(`${method} ${path}`)
    return super.call<T>(method, path, opts)
  }
}

describe('applyStack with a stack certificate', () => {
  let root: string
  let cfg: AgentConfig
  let fake: OrderedEngine
  let fs: FakeTlsFs
  const DIR = '/srv/traefik/dynamic'
  const FILE = `${DIR}/nvh-${S}.yml`
  const deps = () => ({ nodeId: NODE, sleep: async () => {}, edgeTlsFs: fs })

  const makeCfg = (over: Record<string, string> = {}) =>
    loadAgentConfig(
      {
        HUB_AGENT_TOKEN_FILE: '/t',
        HUB_AGENT_EDGE_NETWORK: 'edge',
        HUB_AGENT_HOST_SUFFIXES: '.apps.corp',
        HUB_AGENT_REDIS_IMAGE: REDIS,
        HUB_AGENT_CERT_RESOLVER: 'le',
        HUB_AGENT_EXTENSIONS_ROOT: root,
        HUB_AGENT_EXTENSIONS_HOST_ROOT: '/srv/ext',
        HUB_AGENT_TRAEFIK_DYNAMIC_DIR: DIR,
        ...over
      },
      () => TOKEN
    )

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hub-agent-edge-apply-'))
    cfg = makeCfg()
    fake = new OrderedEngine(cfg)
    fs = new FakeTlsFs(fake.order)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const webLabels = () => fake.service(`${S}_web`)?.Spec.Labels as Record<string, string>

  it('writes the file before any Docker write; the routers use it (no resolver)', async () => {
    const r = await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    expect(r.edge_tls).toBe('written')
    expect(fake.order[0]).toBe(`file:write ${FILE}`)
    expect(fs.files.get(FILE)).toBe(edgeTlsFileText(S, A))
    expect(webLabels()['traefik.http.routers.nvh_web_acme-st.tls']).toBe('true')
    expect(webLabels()['traefik.http.routers.nvh_web_acme-st.tls.certresolver']).toBeUndefined()
    // The certificate went into the file only: no swarm secret, label or env holds it.
    const engine = JSON.stringify([...fake.secrets.values(), ...fake.services.values()])
    expect(engine).not.toContain(keyBody(A.key))
    expect(engine).not.toContain(Buffer.from(A.key).toString('base64').slice(0, 40))
    expect(r.spec_hash).toBe(stackHash(appSpec({ edge_tls: A }), cfg, NODE))
  })

  it('a renewal rewrites the file and relabels the stack hash only: nothing restarts', async () => {
    await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    fake.completeUpdates()
    const restarts = new Map(fake.restarts)
    const tasks = [...fake.services.values()].map((s) => structuredClone(s.Spec.TaskTemplate))
    fake.order.length = 0
    const r = await applyStack(fake, cfg, S, appSpec({ edge_tls: B }), deps())
    expect(r.edge_tls).toBe('written')
    expect(r.changed).toEqual([])
    expect(r.unchanged).toEqual([`${S}_redis`, `${S}_web`, `${S}_worker`])
    expect(fake.restarts).toEqual(restarts)
    expect([...fake.services.values()].map((s) => s.Spec.TaskTemplate)).toEqual(tasks)
    for (const s of fake.services.values()) expect(s.UpdateStatus?.State).not.toBe('updating')
    expect(fs.files.get(FILE)).toBe(edgeTlsFileText(S, B))
    expect(fake.order[0]).toBe(`file:write ${FILE}`)
    // Only label updates were sent (the new stack hash); no create, no secret, no network.
    expect(
      fake.order.filter((o) => !o.startsWith('file:') && !/\/services\/[^/]+\/update$/.test(o))
    ).toEqual([])
    for (const s of fake.services.values())
      expect(s.Spec.Labels['nivaro.hub.spec-hash']).toBe(r.spec_hash)
  })

  it('the same certificate again: the file is not rewritten', async () => {
    await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    const r = await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    expect(r.edge_tls).toBe('unchanged')
    expect(fs.writes).toEqual([FILE])
  })

  it('unbinding goes back to the cert resolver first, then removes the file', async () => {
    await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    fake.completeUpdates()
    const restarts = new Map(fake.restarts)
    fake.order.length = 0
    const r = await applyStack(fake, cfg, S, appSpec(), deps())
    expect(r.edge_tls).toBe('removed')
    expect(webLabels()['traefik.http.routers.nvh_web_acme-st.tls.certresolver']).toBe('le')
    expect(fake.order.at(-1)).toBe(`file:remove ${FILE}`)
    expect(fake.order.some((o) => o.endsWith('/update'))).toBe(true)
    // Labels only: the web service changes (its routers), its tasks do not restart.
    expect(r.changed).toEqual([`${S}_web`])
    expect(fake.restarts).toEqual(restarts)
    expect(fs.files.has(FILE)).toBe(false)
    // A stack that never had one: no answer field.
    const again = await applyStack(fake, cfg, S, appSpec(), deps())
    expect(again.edge_tls).toBeUndefined()
  })

  it('removeStack removes the file after the services', async () => {
    await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    fake.order.length = 0
    await removeStack(
      fake,
      cfg,
      S,
      { removeVolumes: false, owner: { app: 'acme', environment: 'staging' } },
      { sleep: async () => {}, edgeTlsFs: fs }
    )
    expect(fs.files.has(FILE)).toBe(false)
    const at = fake.order.indexOf(`file:remove ${FILE}`)
    const lastServiceDelete = fake.order
      .map((o) => o.startsWith('DELETE /services/'))
      .lastIndexOf(true)
    expect(lastServiceDelete).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(lastServiceDelete)
  })

  it('a file that cannot be written refuses EDGE_TLS_WRITE_FAILED before any Docker write', async () => {
    fs.fail = true
    let err: unknown
    try {
      await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StackError)
    expect((err as StackError).code).toBe('EDGE_TLS_WRITE_FAILED')
    expect((err as StackError).status).toBe(500)
    expect(String((err as Error).message)).not.toContain(DIR)
    expect(fake.order).toEqual([])
  })

  it('an agent without the folder refuses TLS_NOT_CONFIGURED, nothing written', async () => {
    cfg = makeCfg({ HUB_AGENT_TRAEFIK_DYNAMIC_DIR: '' })
    fake = new OrderedEngine(cfg)
    fs = new FakeTlsFs(fake.order)
    let code = ''
    try {
      await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), deps())
    } catch (e) {
      code = (e as StackError).code
    }
    expect(code).toBe('TLS_NOT_CONFIGURED')
    expect(fake.order).toEqual([])
    // And a stack without a certificate never touches the folder on such an agent.
    await applyStack(fake, cfg, S, appSpec(), deps())
    expect(fake.order.some((o) => o.startsWith('file:'))).toBe(false)
  })

  it('the real folder: the file appears 0600 with the PEM inline, gone after unbinding', async () => {
    const real = mkdtempSync(join(tmpdir(), 'hub-agent-edge-real-'))
    try {
      cfg = makeCfg({ HUB_AGENT_TRAEFIK_DYNAMIC_DIR: real })
      fake = new OrderedEngine(cfg)
      await applyStack(fake, cfg, S, appSpec({ edge_tls: A }), { nodeId: NODE })
      const p = join(real, `nvh-${S}.yml`)
      expect(readFileSync(p, 'utf8')).toBe(edgeTlsFileText(S, A))
      expect(lstatSync(p).mode & 0o777).toBe(0o600)
      await applyStack(fake, cfg, S, appSpec(), { nodeId: NODE })
      expect(existsSync(p)).toBe(false)
      expect(readdirSync(real)).toEqual([])
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })
})

// ── config + health ──────────────────────────────────────────────────────

describe('HUB_AGENT_TRAEFIK_DYNAMIC_DIR', () => {
  const env = {
    HUB_AGENT_TOKEN_FILE: '/t',
    HUB_AGENT_EDGE_NETWORK: 'edge',
    HUB_AGENT_HOST_SUFFIXES: '.apps.corp'
  }
  const load = (over: Record<string, string>) => loadAgentConfig({ ...env, ...over }, () => TOKEN)
  const code = (over: Record<string, string>) => {
    try {
      load(over)
      return null
    } catch (e) {
      return e instanceof ConfigError ? e.code : 'OTHER'
    }
  }

  it('unset = null; an absolute folder of two segments or more, trailing slash dropped', () => {
    expect(load({}).traefikDynamicDir).toBeNull()
    expect(load({ HUB_AGENT_TRAEFIK_DYNAMIC_DIR: ' ' }).traefikDynamicDir).toBeNull()
    expect(load({ HUB_AGENT_TRAEFIK_DYNAMIC_DIR: '/srv/traefik/dynamic/' }).traefikDynamicDir).toBe(
      '/srv/traefik/dynamic'
    )
  })

  it('refuses a relative path, / or one segment, a dot segment, and the publish edge', () => {
    for (const v of ['dynamic', '/', '/srv', '/srv/../etc', '/srv/./x'])
      expect(code({ HUB_AGENT_TRAEFIK_DYNAMIC_DIR: v }), v).toBe('TRAEFIK_DYNAMIC_DIR_BAD')
    expect(
      code({
        HUB_AGENT_EDGE: 'publish',
        HUB_AGENT_PUBLISH_PORTS: '31000-31099',
        HUB_AGENT_TRAEFIK_DYNAMIC_DIR: '/srv/traefik/dynamic'
      })
    ).toBe('TRAEFIK_DYNAMIC_DIR_BAD')
  })

  it('health answers edge_tls (true / false), never the path', async () => {
    const facts = { engineApi: '1.45', nodeId: NODE }
    const on = await baseHandlers(
      load({ HUB_AGENT_TRAEFIK_DYNAMIC_DIR: '/srv/traefik/dynamic' }),
      facts
    ).health()
    expect((on.body as Record<string, unknown>).edge_tls).toBe(true)
    expect((on.body as Record<string, unknown>).agent_version).toBe('0.2.5')
    expect(JSON.stringify(on.body)).not.toContain('/srv/traefik')
    const off = await baseHandlers(load({}), facts).health()
    expect((off.body as Record<string, unknown>).edge_tls).toBe(false)
  })
})
