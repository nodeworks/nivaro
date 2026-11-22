import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SECRET_NAME_MAX,
  STACK_NAME_RE,
  secretName,
  specHash,
  specHashInput
} from '../src/names.js'
import { type SpecConfig, type StackSpec, validateStackSpec } from '../src/spec.js'

const EXAMPLE = JSON.parse(
  readFileSync(new URL('../contract/stack-spec.example.json', import.meta.url), 'utf8')
)
const DIGEST = `sha256:${'a'.repeat(64)}`

const cfg = (over: Partial<SpecConfig> = {}): SpecConfig => ({
  images: ['nodeworks/nivaro', 'registry.example.com/acme/tools-ext'],
  edge: 'traefik',
  hostSuffixes: ['.apps.example.com', '.apps.corp'],
  publishPorts: null,
  redisImage: `redis@${DIGEST}`,
  ...over
})

const base = (): Record<string, any> => JSON.parse(JSON.stringify(EXAMPLE))

function fields(body: unknown, c: SpecConfig = cfg()) {
  const r = validateStackSpec(body, c)
  if (r.ok) return []
  return r.fields
}
function codeOf(body: unknown, field: string, c: SpecConfig = cfg()) {
  return fields(body, c).find((f) => f.field === field)?.code
}

describe('validateStackSpec — the contract example', () => {
  it('accepts the committed example and returns it unchanged', () => {
    const r = validateStackSpec(base(), cfg())
    expect(r).toEqual({ ok: true, spec: EXAMPLE })
  })

  it('returns a fresh object, never the caller body', () => {
    const body = base()
    const r = validateStackSpec(body, cfg())
    if (!r.ok) throw new Error('expected ok')
    expect(r.spec).not.toBe(body)
    expect(r.spec.env).not.toBe(body.env)
    expect(r.spec.roles[0]).not.toBe(body.roles[0])
  })
})

describe('validateStackSpec — closed schema (UNKNOWN_FIELD)', () => {
  const hostile: Array<[string, unknown]> = [
    ['binds', ['/:/host']],
    ['privileged', true],
    ['ports', [{ published: 22, target: 22 }]],
    ['labels', { 'nivaro.hub.app': 'other' }],
    ['cap_add', ['SYS_ADMIN']],
    ['capabilities', ['ALL']],
    ['network_mode', 'host'],
    ['networks', ['host']],
    ['volumes', ['/var/run/docker.sock:/var/run/docker.sock']],
    ['mounts', [{ type: 'bind', source: '/var/run/docker.sock' }]],
    ['user', 'root'],
    ['devices', ['/dev/sda']],
    ['pid', 'host'],
    ['ipc', 'host'],
    ['security_opt', ['apparmor:unconfined']],
    ['command', ['sh', '-c', 'id']],
    ['entrypoint', ['sh']]
  ]
  for (const [key, value] of hostile) {
    it(`refuses top-level ${key}`, () => {
      expect(codeOf({ ...base(), [key]: value }, key)).toBe('UNKNOWN_FIELD')
    })
    it(`refuses ${key} inside a role`, () => {
      const b = base()
      b.roles[0][key] = value
      expect(codeOf(b, `roles[0].${key}`)).toBe('UNKNOWN_FIELD')
    })
  }

  it('refuses an extra key in owner (ownership cannot be widened)', () => {
    const b = base()
    b.owner = { app: 'acme', managed: '0' }
    expect(codeOf(b, 'owner.managed')).toBe('UNKNOWN_FIELD')
  })

  it('refuses an owner naming both an app and a shared key', () => {
    const b = base()
    b.owner = { app: 'acme', shared: 'other' }
    expect(codeOf(b, 'owner.shared')).toBe('UNKNOWN_FIELD')
  })

  it('treats __proto__ as an unknown field and pollutes nothing', () => {
    const body = JSON.parse(
      `{"__proto__": {"privileged": true}, ${JSON.stringify(base()).slice(1)}`
    )
    expect(codeOf(body, '__proto__')).toBe('UNKNOWN_FIELD')
    expect(({} as any).privileged).toBeUndefined()
  })

  it('treats a constructor/prototype key as unknown', () => {
    expect(codeOf({ ...base(), constructor: {} }, 'constructor')).toBe('UNKNOWN_FIELD')
  })
})

describe('validateStackSpec — REQUIRED', () => {
  for (const body of [null, undefined, 'x', 42, [], [base()]]) {
    it(`refuses a non-object body (${JSON.stringify(body)})`, () => {
      expect(codeOf(body, '')).toBe('REQUIRED')
    })
  }
  for (const key of [
    'owner',
    'environment',
    'image',
    'roles',
    'env',
    'secrets',
    'hostnames',
    'redis',
    'extensions'
  ]) {
    it(`requires ${key}`, () => {
      const b = base()
      delete b[key]
      expect(codeOf(b, key)).toBe('REQUIRED')
    })
  }
  it('requires at least one role', () => {
    expect(codeOf({ ...base(), roles: [] }, 'roles')).toBe('REQUIRED')
  })
  it('requires an owner key', () => {
    expect(codeOf({ ...base(), owner: {} }, 'owner')).toBe('REQUIRED')
  })
  it('refuses a redis mode outside the two', () => {
    expect(codeOf({ ...base(), redis: 'host' }, 'redis')).toBe('REQUIRED')
  })
  it('refuses a non-string env value', () => {
    expect(codeOf({ ...base(), env: { A: 1 } }, 'env.A')).toBe('REQUIRED')
  })
  it('requires a hostname in traefik mode', () => {
    expect(codeOf({ ...base(), hostnames: [] }, 'hostnames')).toBe('REQUIRED')
  })
  it('requires publish_port in publish mode for a web role', () => {
    const c = cfg({ edge: 'publish', publishPorts: [31000, 31010] })
    expect(codeOf({ ...base(), hostnames: [] }, 'publish_port', c)).toBe('REQUIRED')
  })
})

describe('validateStackSpec — BAD_KEY (names cannot escape)', () => {
  for (const name of ['Acme', '../etc', 'a/b', 'a', 'a_b', '-a', 'a'.repeat(64), 'acme\n', 'a b']) {
    it(`refuses owner app ${JSON.stringify(name)}`, () => {
      expect(codeOf({ ...base(), owner: { app: name } }, 'owner.app')).toBe('BAD_KEY')
    })
    it(`refuses shared owner ${JSON.stringify(name)}`, () => {
      expect(codeOf({ ...base(), owner: { shared: name } }, 'owner.shared')).toBe('BAD_KEY')
    })
    it(`refuses environment ${JSON.stringify(name)}`, () => {
      expect(codeOf({ ...base(), environment: name }, 'environment')).toBe('BAD_KEY')
    })
  }
  it('accepts a shared owner', () => {
    expect(validateStackSpec({ ...base(), owner: { shared: 'tools' } }, cfg()).ok).toBe(true)
  })
  for (const key of ['lower', '1A', 'A-B', 'A=B', 'A B', '', `A${'B'.repeat(64)}`, '../A']) {
    it(`refuses env key ${JSON.stringify(key)}`, () => {
      expect(codeOf({ ...base(), env: { [key]: 'x' } }, `env.${key}`)).toBe('BAD_KEY')
    })
    it(`refuses secret key ${JSON.stringify(key)}`, () => {
      expect(codeOf({ ...base(), secrets: { [key]: 'x' } }, `secrets.${key}`)).toBe('BAD_KEY')
    })
  }
})

describe('validateStackSpec — images', () => {
  it('refuses a tag (IMAGE_NOT_PINNED)', () => {
    expect(codeOf({ ...base(), image: 'nodeworks/nivaro:0.3.208' }, 'image')).toBe(
      'IMAGE_NOT_PINNED'
    )
  })
  for (const image of [
    'nodeworks/nivaro',
    `nodeworks/nivaro@sha256:${'A'.repeat(64)}`,
    `nodeworks/nivaro@sha256:${'a'.repeat(63)}`,
    `nodeworks/nivaro@sha512:${'a'.repeat(64)}`,
    `nodeworks/nivaro:0.3.208@${DIGEST}`,
    `nodeworks/nivaro@${DIGEST} `
  ]) {
    it(`refuses ${image.slice(0, 40)}… as not pinned`, () => {
      expect(codeOf({ ...base(), image }, 'image')).toBe('IMAGE_NOT_PINNED')
    })
  }
  for (const image of [
    `evil/nivaro@${DIGEST}`,
    `nodeworks/nivaro-evil@${DIGEST}`,
    `docker.io/nodeworks/nivaro@${DIGEST}`,
    `evil.example.com/nodeworks/nivaro@${DIGEST}`,
    `nodeworks/nivaro/../evil@${DIGEST}`,
    'evil/nivaro:latest',
    `redis@${DIGEST}`
  ]) {
    it(`refuses ${image.slice(0, 40)}… as not allowed`, () => {
      expect(codeOf({ ...base(), image }, 'image')).toBe('IMAGE_NOT_ALLOWED')
    })
  }
  it('refuses a non-string image', () => {
    expect(codeOf({ ...base(), image: { repo: 'nodeworks/nivaro' } }, 'image')).toBe('REQUIRED')
  })
  it('checks extension images against the same allow-list', () => {
    expect(codeOf({ ...base(), extensions: { x: `evil/ext@${DIGEST}` } }, 'extensions.x')).toBe(
      'IMAGE_NOT_ALLOWED'
    )
    expect(
      codeOf(
        { ...base(), extensions: { x: 'registry.example.com/acme/tools-ext:1.0' } },
        'extensions.x'
      )
    ).toBe('IMAGE_NOT_PINNED')
  })
})

describe('validateStackSpec — ENV_FORBIDDEN', () => {
  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'PATH',
    'HOME',
    'NIVARO_RUN_AS',
    'NIVARO_SECRETS_DIR',
    'NIVARO_ROLE',
    'NIVARO_ROLE_FILE',
    'NODE_OPTIONS_FILE',
    'REDIS_URL',
    'REDIS_URL_FILE'
  ]) {
    it(`refuses env ${key}`, () => {
      expect(codeOf({ ...base(), env: { [key]: 'x' } }, `env.${key}`)).toBe('ENV_FORBIDDEN')
    })
    it(`refuses secret ${key} (a secret file would override it)`, () => {
      expect(codeOf({ ...base(), secrets: { [key]: 'x' } }, `secrets.${key}`)).toBe('ENV_FORBIDDEN')
    })
  }
  it('allows REDIS_URL when redis is external', () => {
    const r = validateStackSpec(
      { ...base(), redis: 'external', env: { ...base().env, REDIS_URL: 'redis://r:6379' } },
      cfg()
    )
    expect(r.ok).toBe(true)
  })
  it('refuses an env key that is also a secret (it would show the value in plain env)', () => {
    expect(codeOf({ ...base(), env: { SESSION_SECRET: 'x' } }, 'env.SESSION_SECRET')).toBe(
      'ENV_FORBIDDEN'
    )
  })
  for (const key of ['NODE_OPTIONS', 'DB_HOST', 'NIVARO_ROLE', 'REDIS_URL']) {
    it(`refuses role env ${key} (only the five role keys)`, () => {
      const b = base()
      b.roles[0].env = { [key]: 'x' }
      expect(codeOf(b, `roles[0].env.${key}`)).toBe('ENV_FORBIDDEN')
    })
  }
  it('accepts the five role env keys', () => {
    const b = base()
    b.roles[0].env = {
      SOCKETS: 'off',
      CRON_TICKS: 'off',
      IMPORT_WORKER: 'off',
      MEDIA_WORKER: 'off',
      VIDEO_RENDER: 'off'
    }
    expect(validateStackSpec(b, cfg()).ok).toBe(true)
  })
})

describe('validateStackSpec — roles, replicas, limits', () => {
  const roles = (r: any[]) => ({ ...base(), roles: r })
  it("refuses 'all' with another role", () => {
    expect(
      codeOf(
        roles([
          { role: 'all', replicas: 1 },
          { role: 'web', replicas: 1 }
        ]),
        'roles'
      )
    ).toBe('ROLE_BAD')
  })
  it('refuses a duplicate role', () => {
    expect(
      codeOf(
        roles([
          { role: 'web', replicas: 1 },
          { role: 'web', replicas: 1 }
        ]),
        'roles[1].role'
      )
    ).toBe('ROLE_BAD')
  })
  for (const role of ['exporter', 'admin', 'redis', 'WEB', '', 7]) {
    it(`refuses role ${JSON.stringify(role)}`, () => {
      expect(codeOf(roles([{ role, replicas: 1 }]), 'roles[0].role')).toBe('ROLE_BAD')
    })
  }
  for (const replicas of [-1, 11, 1.5, '2', null]) {
    it(`refuses replicas ${JSON.stringify(replicas)}`, () => {
      expect(codeOf(roles([{ role: 'web', replicas }]), 'roles[0].replicas')).toBe('REPLICAS_BAD')
    })
  }
  it('refuses more than 30 replicas in total', () => {
    expect(
      codeOf(
        roles([
          { role: 'web', replicas: 10 },
          { role: 'worker', replicas: 10 },
          { role: 'realtime', replicas: 10 },
          { role: 'importer', replicas: 1 }
        ]),
        'roles'
      )
    ).toBe('REPLICAS_BAD')
  })
  it('accepts 0 replicas', () => {
    expect(validateStackSpec(roles([{ role: 'all', replicas: 0 }]), cfg()).ok).toBe(true)
  })
  for (const [k, v] of [
    ['cpus', 0.05],
    ['cpus', 17],
    ['cpus', '2'],
    ['memory_mb', 64],
    ['memory_mb', 70000],
    ['memory_mb', 1024.5]
  ] as const) {
    it(`refuses ${k} ${JSON.stringify(v)}`, () => {
      expect(codeOf(roles([{ role: 'web', replicas: 1, [k]: v }]), `roles[0].${k}`)).toBe(
        'LIMIT_BAD'
      )
    })
  }
})

describe('validateStackSpec — hostnames', () => {
  const c = cfg({ hostSuffixes: ['.apps.corp'] })
  const host = (h: unknown) => ({ ...base(), hostnames: [h] })
  it('refuses a hostname outside the agent suffixes', () => {
    expect(codeOf(host('x.example.org'), 'hostnames[0]', c)).toBe('HOSTNAME_NOT_ALLOWED')
  })
  for (const h of [
    'apps.corp',
    '.apps.corp',
    'evil.apps.corp.attacker.com',
    'evilapps.corp',
    'A.apps.corp',
    'x..apps.corp',
    'a`) || Host(`evil.com',
    'x.apps.corp`)',
    '-x.apps.corp',
    'x .apps.corp',
    '*.apps.corp',
    `${'a'.repeat(64)}.apps.corp`,
    42
  ]) {
    it(`refuses ${JSON.stringify(h)}`, () => {
      expect(codeOf(host(h), 'hostnames[0]', c)).toBe('HOSTNAME_NOT_ALLOWED')
    })
  }
  it('accepts a name under the suffix', () => {
    expect(validateStackSpec(host('acme-1.apps.corp'), c).ok).toBe(true)
  })
  it('accepts a suffix configured without its leading dot', () => {
    expect(validateStackSpec(host('acme.apps.corp'), cfg({ hostSuffixes: ['apps.corp'] })).ok).toBe(
      true
    )
  })
  it('refuses a duplicate hostname', () => {
    expect(
      codeOf({ ...base(), hostnames: ['a.apps.corp', 'a.apps.corp'] }, 'hostnames[1]', c)
    ).toBe('HOSTNAME_NOT_ALLOWED')
  })
  it('refuses more than 10 hostnames', () => {
    const hs = Array.from({ length: 11 }, (_, i) => `h${i}.apps.corp`)
    expect(codeOf({ ...base(), hostnames: hs }, 'hostnames', c)).toBe('TOO_MANY')
  })
  it('ignores suffixes in publish mode but still checks the DNS form', () => {
    const p = cfg({ edge: 'publish', publishPorts: [31000, 31010], hostSuffixes: [] })
    expect(validateStackSpec({ ...host('x.example.org'), publish_port: 31000 }, p).ok).toBe(true)
    expect(codeOf({ ...host('a`b'), publish_port: 31000 }, 'hostnames[0]', p)).toBe(
      'HOSTNAME_NOT_ALLOWED'
    )
  })
})

describe('validateStackSpec — sizes', () => {
  it('refuses more than 200 env keys', () => {
    const env = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`K${i}`, 'v']))
    expect(codeOf({ ...base(), env }, 'env')).toBe('TOO_MANY')
  })
  it('refuses more than 50 secrets', () => {
    const secrets = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`S${i}`, 'v']))
    expect(codeOf({ ...base(), secrets }, 'secrets')).toBe('TOO_MANY')
  })
  it('refuses more than 20 extensions', () => {
    const extensions = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [
        `e${i}`,
        `registry.example.com/acme/tools-ext@${DIGEST}`
      ])
    )
    expect(codeOf({ ...base(), extensions }, 'extensions')).toBe('TOO_MANY')
  })
  it('refuses an env value over 4 KB (bytes, not characters)', () => {
    expect(codeOf({ ...base(), env: { A: 'é'.repeat(2049) } }, 'env.A')).toBe('TOO_LONG')
    expect(validateStackSpec({ ...base(), env: { A: 'x'.repeat(4096) } }, cfg()).ok).toBe(true)
  })
  it('refuses a secret value over 64 KB', () => {
    expect(codeOf({ ...base(), secrets: { S: 'x'.repeat(65537) } }, 'secrets.S')).toBe('TOO_LONG')
  })
  it('refuses a role env value over 4 KB', () => {
    const b = base()
    b.roles[0].env = { SOCKETS: 'x'.repeat(4097) }
    expect(codeOf(b, 'roles[0].env.SOCKETS')).toBe('TOO_LONG')
  })
})

describe('validateStackSpec — ports, redis, extensions', () => {
  const pub = cfg({ edge: 'publish', publishPorts: [31000, 31010] })
  it('accepts a port inside the range in publish mode', () => {
    expect(validateStackSpec({ ...base(), publish_port: 31010 }, pub).ok).toBe(true)
  })
  for (const port of [30999, 31011, 22, 31000.5, '31000']) {
    it(`refuses publish_port ${JSON.stringify(port)}`, () => {
      expect(codeOf({ ...base(), publish_port: port }, 'publish_port', pub)).toBe(
        'PORT_NOT_ALLOWED'
      )
    })
  }
  it('refuses publish_port in traefik mode', () => {
    expect(codeOf({ ...base(), publish_port: 31000 }, 'publish_port')).toBe('PORT_NOT_ALLOWED')
  })
  it('refuses bundled redis when the agent has no redis image', () => {
    expect(codeOf(base(), 'redis', cfg({ redisImage: null }))).toBe('REDIS_NOT_CONFIGURED')
  })
  it('accepts external redis without a redis image', () => {
    expect(validateStackSpec({ ...base(), redis: 'external' }, cfg({ redisImage: null })).ok).toBe(
      true
    )
  })
  for (const id of ['../x', 'Ext', '-x', 'a/b', '.', '..', 'a.b', 'a_b', '', 'a'.repeat(64)]) {
    it(`refuses extension id ${JSON.stringify(id)}`, () => {
      const b = { ...base(), extensions: { [id]: `registry.example.com/acme/tools-ext@${DIGEST}` } }
      expect(codeOf(b, `extensions.${id}`)).toBe('EXTENSION_ID_BAD')
    })
  }
})

describe('validateStackSpec — every problem at once', () => {
  it('names each bad field', () => {
    const f = fields({
      ...base(),
      privileged: true,
      image: 'nodeworks/nivaro:latest',
      env: { NODE_OPTIONS: '--require /x' },
      hostnames: ['x.example.org']
    })
    expect(f).toEqual(
      expect.arrayContaining([
        { field: 'privileged', code: 'UNKNOWN_FIELD' },
        { field: 'image', code: 'IMAGE_NOT_PINNED' },
        { field: 'env.NODE_OPTIONS', code: 'ENV_FORBIDDEN' },
        { field: 'hostnames[0]', code: 'HOSTNAME_NOT_ALLOWED' }
      ])
    )
  })
  it('never echoes a value in the answer', () => {
    const f = fields({ ...base(), secrets: { 'bad key': 'hunter2-secret' } })
    expect(JSON.stringify(f)).not.toContain('hunter2')
  })
})

describe('STACK_NAME_RE', () => {
  it('accepts stack names', () => {
    for (const n of ['ab', 'acme-staging', `a${'b'.repeat(40)}`])
      expect(STACK_NAME_RE.test(n)).toBe(true)
  })
  it('refuses traversal and odd names', () => {
    for (const n of [
      'a',
      '../x',
      'a/b',
      'A',
      'a_b',
      '1a',
      `a${'b'.repeat(41)}`,
      'a\n',
      'efp ',
      '.'
    ]) {
      expect(STACK_NAME_RE.test(n)).toBe(false)
    }
  })
})

describe('secretName', () => {
  const K = 'k'.repeat(40)
  it('is deterministic and has the documented shape', () => {
    const a = secretName('acme-staging', 'SESSION_SECRET', 'v1', K)
    expect(a).toBe(secretName('acme-staging', 'SESSION_SECRET', 'v1', K))
    expect(a).toMatch(/^nvh_acme-staging_SESSION_SECRET_[0-9a-f]{12}$/)
  })
  it('differs per value, per key and per hmac key', () => {
    const a = secretName('acme', 'S', 'v1', K)
    expect(secretName('acme', 'S', 'v2', K)).not.toBe(a)
    expect(secretName('acme', 'S', 'v1', `${K}x`)).not.toBe(a)
    expect(secretName('acme', 'T', 'v1', K).slice(-12)).not.toBe(a.slice(-12))
  })
  it('never contains the value', () => {
    const v = 'abcdef012345'
    expect(secretName('acme', 'S', v, K)).not.toContain(v)
  })
  it('stays within 64 characters by truncating the key, never the hmac', () => {
    const stack = `a${'b'.repeat(40)}`
    const key = `A${'B'.repeat(63)}`
    const n = secretName(stack, key, 'v', K)
    expect(n.length).toBeLessThanOrEqual(SECRET_NAME_MAX)
    expect(n).toMatch(new RegExp(`^nvh_${stack}_AB+_[0-9a-f]{12}$`))
    expect(n.length).toBe(64)
  })
  it('refuses a bad stack or key', () => {
    expect(() => secretName('../x', 'S', 'v', K)).toThrow()
    expect(() => secretName('acme', 'a/b', 'v', K)).toThrow()
  })
})

describe('specHash', () => {
  const K = 'k'.repeat(40)
  const spec = (): StackSpec => {
    const r = validateStackSpec(base(), cfg())
    if (!r.ok) throw new Error('example invalid')
    return r.spec
  }
  it('is a sha256 hex and stable', () => {
    expect(specHash(spec(), K)).toMatch(/^[0-9a-f]{64}$/)
    expect(specHash(spec(), K)).toBe(specHash(spec(), K))
  })
  it('ignores object key order', () => {
    const s = spec()
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as StackSpec
    reordered.env = Object.fromEntries(Object.entries(s.env).reverse())
    reordered.secrets = Object.fromEntries(Object.entries(s.secrets).reverse())
    expect(specHash(reordered, K)).toBe(specHash(s, K))
  })
  it('changes when a secret value changes', () => {
    const s = spec()
    const t = { ...s, secrets: { ...s.secrets, DB_PASSWORD: 'another' } }
    expect(specHash(t, K)).not.toBe(specHash(s, K))
  })
  it('changes when anything else changes', () => {
    const s = spec()
    expect(specHash({ ...s, env: { ...s.env, X: '1' } }, K)).not.toBe(specHash(s, K))
  })
  it('hashes an input that holds no secret value', () => {
    const s = spec()
    const input = specHashInput(s, K)
    for (const v of Object.values(s.secrets)) expect(input).not.toContain(v)
    expect(input).toContain('SESSION_SECRET')
  })
})
