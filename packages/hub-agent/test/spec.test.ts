import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KNOWN_ENV_KEYS } from '../src/known-env.js'
import {
  SECRET_NAME_MAX,
  STACK_NAME_RE,
  secretName,
  specHash,
  specHashInput
} from '../src/names.js'
import {
  AGENT_SET_ENV_KEYS,
  acceptedEnvKey,
  allowedEnvKey,
  forbiddenEnvKey,
  MAX_FIELD_ERRORS,
  NIVARO_ENV_ALLOWED,
  operatorPrefixConflict,
  type SpecConfig,
  type StackSpec,
  validateStackSpec
} from '../src/spec.js'

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
    expect(codeOf({ ...base(), env: { MAIL_FROM: 1 } }, 'env.MAIL_FROM')).toBe('REQUIRED')
  })
  it('B5: takes an empty hostname list in traefik mode for an app owner (no router rendered)', () => {
    // Phase 6 ruling B5 changes this on purpose: a stack update with no names (move drop_host,
    // a to_dedicated target deployed before its route step) must apply.
    const r = validateStackSpec({ ...base(), hostnames: [] }, cfg())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.hostnames).toEqual([])
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
  for (const key of ['lower', '1A', 'A-B', 'A=B', 'A B', '', '../A']) {
    it(`refuses env key ${JSON.stringify(key)}`, () => {
      expect(codeOf({ ...base(), env: { [key]: 'x' } }, `env.${key}`)).toBe('BAD_KEY')
    })
    it(`refuses secret key ${JSON.stringify(key)}`, () => {
      expect(codeOf({ ...base(), secrets: { [key]: 'x' } }, `secrets.${key}`)).toBe('BAD_KEY')
    })
  }
  it('refuses a 65-character key, echoing at most 64 characters of it', () => {
    const key = `A${'B'.repeat(64)}`
    const echoed = `${key.slice(0, 64)}…`
    expect(codeOf({ ...base(), env: { [key]: 'x' } }, `env.${echoed}`)).toBe('BAD_KEY')
    expect(codeOf({ ...base(), secrets: { [key]: 'x' } }, `secrets.${echoed}`)).toBe('BAD_KEY')
  })
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
  it('P4-34: takes repo:tag@sha256 (the digest pins it); the tag never stands in for the repo', () => {
    expect(
      codeOf({ ...base(), image: `nodeworks/nivaro:0.3.208@${DIGEST}` }, 'image')
    ).toBeUndefined()
    expect(
      codeOf({ ...base(), extensions: { x: `nodeworks/nivaro:1.0@${DIGEST}` } }, 'extensions.x')
    ).toBeUndefined()
    expect(codeOf({ ...base(), image: `evil/nivaro:0.3.208@${DIGEST}` }, 'image')).toBe(
      'IMAGE_NOT_ALLOWED'
    )
    expect(codeOf({ ...base(), image: 'nodeworks/nivaro:0.3.208' }, 'image')).toBe(
      'IMAGE_NOT_PINNED'
    )
  })
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

describe('validateStackSpec — one-line values (SETTING_INVALID)', () => {
  for (const key of ['SAMBA_USER', 'SAMBA_PASS', 'SAMBA_WORKGROUP']) {
    for (const v of ['a\nusername = root', 'a\r', '\nb', 'a\r\nb']) {
      it(`refuses ${key} = ${JSON.stringify(v)}, as env and as a secret`, () => {
        expect(codeOf({ ...base(), env: { [key]: v } }, `env.${key}`)).toBe('SETTING_INVALID')
        expect(codeOf({ ...base(), secrets: { [key]: v } }, `secrets.${key}`)).toBe(
          'SETTING_INVALID'
        )
      })
    }
    it(`accepts ${key} on one line`, () => {
      expect(validateStackSpec({ ...base(), env: { [key]: 'CABLE' } }, cfg()).ok).toBe(true)
    })
  }
  it('other keys may still hold several lines', () => {
    expect(validateStackSpec({ ...base(), secrets: { SAML_CERT: 'a\nb' } }, cfg()).ok).toBe(true)
  })
})

describe('validateStackSpec — Hub-owned and secret-only keys (ruling X-2)', () => {
  it('HUB_SHARED_DEPLOYMENT and HUB_DEPLOYMENT_TOKEN are refused as env and as a secret, field named', () => {
    for (const key of ['HUB_SHARED_DEPLOYMENT', 'HUB_DEPLOYMENT_TOKEN']) {
      expect(codeOf({ ...base(), env: { [key]: 'x' } }, `env.${key}`)).toBe('ENV_FORBIDDEN')
      expect(
        codeOf(
          { ...base(), secrets: { ...base().secrets, [key]: 'x'.repeat(40) } },
          `secrets.${key}`
        )
      ).toBe('ENV_FORBIDDEN')
    }
  })

  it('HUB_TOKEN and HUB_CLIENT_SECRET only as a secret, never as env', () => {
    for (const key of ['HUB_TOKEN', 'HUB_CLIENT_SECRET']) {
      const env = { ...base().env, [key]: 'x'.repeat(40) }
      const secrets = { ...base().secrets }
      delete secrets[key]
      expect(codeOf({ ...base(), env, secrets }, `env.${key}`)).toBe('ENV_FORBIDDEN')
      const asSecret = { ...base(), secrets: { ...base().secrets, [key]: 'x'.repeat(40) } }
      expect(validateStackSpec(asSecret, cfg()).ok).toBe(true)
    }
  })

  it('an operator prefix over a Hub-owned key is refused (HUB_)', () => {
    expect(operatorPrefixConflict('HUB_')).toBe(true)
    expect(operatorPrefixConflict('HUB_SHARED_')).toBe(true)
  })
})

describe('validateStackSpec — ENV_FORBIDDEN', () => {
  const families: Record<string, string[]> = {
    'process and loader': ['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT'],
    'NODE_* except NODE_ENV': [
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_ANYTHING'
    ],
    'OPENSSL_*': ['OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'OPENSSL_ANYTHING'],
    'SSL_CERT_*': ['SSL_CERT_FILE', 'SSL_CERT_DIR'],
    'temp folders the entrypoint chowns as root': ['TMPDIR', 'TMP', 'TEMP'],
    'programs the app runs, and what they read (ruling P4-20)': [
      'FFMPEG_PATH',
      'FFPROBE_PATH',
      'FFREPORT',
      'CHROMIUM_FLAGS',
      'CHROMIUM_USER_FLAGS',
      'PUPPETEER_EXECUTABLE_PATH',
      'PUPPETEER_CACHE_DIR',
      'PUPPETEER_ANYTHING',
      'HELP_VIDEO_WHISPER_CMD',
      'HELP_VIDEO_WHISPER_MODEL',
      'HELP_VIDEO_WHISPER_ANYTHING'
    ],
    'a path spliced into SQL': ['SAMBA_SERVER_PATH'],
    'library loader paths (ruling P4-22)': [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'VK_ICD_FILENAMES',
      'VK_LAYER_PATH',
      'LIBGL_DRIVERS_PATH',
      'LIBGL_ALWAYS_SOFTWARE'
    ],
    'more loader and module paths the scan named (ruling P4-23)': [
      'GCONV_PATH',
      'LOCPATH',
      'GIO_MODULE_DIR',
      'GTK_PATH',
      'LIBVA_DRIVERS_PATH',
      'LIBVA_DRIVER_NAME',
      'MESA_LOADER_DRIVER_OVERRIDE',
      'MESA_ANYTHING',
      'GBM_BACKENDS_PATH',
      'VDPAU_DRIVER_PATH',
      'OCL_ICD_VENDORS',
      'OCL_ICD_FILENAMES',
      'GST_PLUGIN_PATH',
      'GST_PLUGIN_SYSTEM_PATH',
      'GST_PLUGIN_SCANNER',
      'GIO_EXTRA_MODULES',
      'GTK_MODULES',
      'GDK_PIXBUF_MODULEDIR',
      'GLIBC_TUNABLES',
      'QT_PLUGIN_PATH',
      'PYTHONPATH',
      'CLASSPATH',
      'PERL5LIB',
      'GDK_PIXBUF_MODULE_FILE',
      'XDG_DATA_DIRS',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH'
    ],
    'NIVARO_* outside the allow set (entrypoint inputs)': [
      'NIVARO_APP_UID',
      'NIVARO_APP_GID',
      'NIVARO_RUN_AS',
      'NIVARO_CGROUP_ROOT',
      'NIVARO_MEMINFO',
      'NIVARO_RUNNING_AS_ROOT',
      'NIVARO_ROOT_REASON',
      'NIVARO_SECRETS_DIR',
      'NIVARO_IMAGE_VARIANT',
      'NIVARO_DOTENV',
      'NIVARO_ANYTHING'
    ],
    'agent-set keys': AGENT_SET_ENV_KEYS as string[],
    'every <KEY>_FILE, allowed key or not (secrets mount at /run/secrets/<KEY>)': [
      'MAIL_FROM_FILE',
      'DB_HOST_FILE',
      'DB_PASSWORD_FILE',
      'SMTP_PASS_FILE',
      'X_FILE',
      'NODE_ENV_FILE',
      'NIVARO_ENVIRONMENT_FILE',
      'HELP_VIDEO_WHISPER_CMD_FILE'
    ],
    '<KEY>_FILE of a refused key': [
      'NODE_OPTIONS_FILE',
      'TMPDIR_FILE',
      'FFMPEG_PATH_FILE',
      'PUPPETEER_EXECUTABLE_PATH_FILE',
      'NIVARO_APP_UID_FILE',
      'OPENSSL_CONF_FILE',
      'STORAGE_LOCAL_ROOT_FILE',
      'NIVARO_ROLE_FILE',
      'REDIS_URL_FILE',
      'SOCKETS_FILE',
      'CRON_TICKS_FILE'
    ]
  }
  for (const [family, keys] of Object.entries(families)) {
    describe(family, () => {
      for (const key of keys) {
        it(`refuses env ${key}`, () => {
          expect(codeOf({ ...base(), env: { [key]: 'x' } }, `env.${key}`)).toBe('ENV_FORBIDDEN')
        })
        it(`refuses secret ${key} (the /run/secrets file would win)`, () => {
          expect(codeOf({ ...base(), secrets: { [key]: 'x' } }, `secrets.${key}`)).toBe(
            'ENV_FORBIDDEN'
          )
        })
      }
    })
  }
  it('the agent-set list holds every key the renderer sets', () => {
    expect([...AGENT_SET_ENV_KEYS].sort()).toEqual(
      [
        'CRON_TICKS',
        'IMPORT_WORKER',
        'MEDIA_WORKER',
        'NIVARO_ROLE',
        'REDIS_URL',
        'SOCKETS',
        'STORAGE_LOCAL_ROOT',
        'VIDEO_RENDER'
      ].sort()
    )
  })
  it('accepts NODE_ENV and the NIVARO_* allow set', () => {
    expect(NIVARO_ENV_ALLOWED).toEqual([
      'NIVARO_ENVIRONMENT',
      'NIVARO_INSTANCE',
      'NIVARO_EXPECTED_DB',
      'NIVARO_HEAP_FROM_CGROUP'
    ])
    const env = { ...base().env, NODE_ENV: 'production' }
    for (const k of NIVARO_ENV_ALLOWED) env[k] = 'x'
    expect(validateStackSpec({ ...base(), env }, cfg()).ok).toBe(true)
  })
  it('refuses the agent-set keys whatever the redis mode, except REDIS_URL when external', () => {
    const ext = { ...base(), redis: 'external' }
    expect(codeOf({ ...ext, env: { STORAGE_LOCAL_ROOT: '/' } }, 'env.STORAGE_LOCAL_ROOT')).toBe(
      'ENV_FORBIDDEN'
    )
    expect(codeOf({ ...ext, secrets: { SOCKETS: 'on' } }, 'secrets.SOCKETS')).toBe('ENV_FORBIDDEN')
    expect(
      validateStackSpec({ ...ext, secrets: { REDIS_URL: 'redis://u:p@r:6379' } }, cfg()).ok
    ).toBe(true)
  })
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
  for (const role of ['canary', 'admin', 'redis', 'WEB', 'Exporter', '', 7]) {
    it(`refuses role ${JSON.stringify(role)}`, () => {
      expect(codeOf(roles([{ role, replicas: 1 }]), 'roles[0].role')).toBe('ROLE_BAD')
    })
  }
  it('Task 15: accepts an exporter role (NIVARO_ROLE=exporter) beside the others, optional', () => {
    const large = [
      { role: 'web', replicas: 3, env: { SOCKETS: 'off' } },
      { role: 'worker', replicas: 1 },
      { role: 'realtime', replicas: 2 },
      { role: 'importer', replicas: 1 },
      { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }
    ]
    const r = validateStackSpec(roles(large), cfg())
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.spec.roles).toEqual(large)
    // Without one, as before.
    expect(validateStackSpec(roles(large.slice(0, 4)), cfg()).ok).toBe(true)
  })
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
    expect(codeOf({ ...base(), env: { MAIL_FROM: 'é'.repeat(2049) } }, 'env.MAIL_FROM')).toBe(
      'TOO_LONG'
    )
    expect(validateStackSpec({ ...base(), env: { MAIL_FROM: 'x'.repeat(4096) } }, cfg()).ok).toBe(
      true
    )
  })
  it('refuses a secret value over 64 KB', () => {
    expect(
      codeOf({ ...base(), secrets: { SMTP_PASSWORD: 'x'.repeat(65537) } }, 'secrets.SMTP_PASSWORD')
    ).toBe('TOO_LONG')
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
  it('caps echoed key text at 64 characters for every keyed field', () => {
    const k = `X${'y'.repeat(999)}`
    const b = base()
    b.owner = { app: 'acme', [k]: 1 }
    b.roles[0][k] = 1
    b.roles[0].env = { [k]: 'x' }
    const f = fields({
      ...b,
      [k]: 1,
      env: { [k]: 'x' },
      secrets: { [k]: 'x' },
      extensions: { [k]: 'x' }
    })
    expect(f.length).toBe(7)
    for (const e of f) {
      expect(e.field).toContain(`${k.slice(0, 64)}…`)
      expect(e.field.length).toBeLessThan(90)
    }
  })
  it(`answers at most ${MAX_FIELD_ERRORS} field errors`, () => {
    const extra = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`junk${i}`, 1]))
    expect(fields({ ...base(), ...extra }).length).toBe(MAX_FIELD_ERRORS)
  })
  it('never echoes a value in the answer', () => {
    const f = fields({ ...base(), secrets: { 'bad key': 'hunter2-secret' } })
    expect(JSON.stringify(f)).not.toContain('hunter2')
  })
})

describe('validateStackSpec — ENV_NOT_ALLOWED (ruling P4-23: an allow-list)', () => {
  it('the contract example passes with no operator prefixes', () => {
    expect(validateStackSpec(base(), cfg({ envPrefixes: [] })).ok).toBe(true)
  })
  it('refuses an env key Nivaro does not read, naming the key and never the value', () => {
    const f = fields({ ...base(), env: { GREETING: 'hunter2-value' } })
    expect(f).toEqual([{ field: 'env.GREETING', code: 'ENV_NOT_ALLOWED' }])
    expect(JSON.stringify(f)).not.toContain('hunter2')
  })
  it('refuses a secret key Nivaro does not read', () => {
    expect(fields({ ...base(), secrets: { EFP_API_SECRET: 'hunter2' } })).toEqual([
      { field: 'secrets.EFP_API_SECRET', code: 'ENV_NOT_ALLOWED' }
    ])
  })
  it("allows keys under the operator's HUB_AGENT_ENV_PREFIXES", () => {
    const c = cfg({ envPrefixes: ['EFP_'] })
    const b = { ...base(), env: { EFP_REGION: 'east' }, secrets: { EFP_API_SECRET: 'x' } }
    expect(validateStackSpec(b, c).ok).toBe(true)
    expect(codeOf({ ...base(), env: { ACME_X: '1' } }, 'env.ACME_X', c)).toBe('ENV_NOT_ALLOWED')
  })
  it('a prefix never opens a key the deny rules refuse (second layer)', () => {
    const c = cfg({ envPrefixes: ['LD_', 'GCONV_', 'MESA_', 'NODE_', 'NIVARO_', 'GST_'] })
    for (const k of ['LD_PRELOAD', 'GCONV_PATH', 'MESA_X', 'NODE_OPTIONS', 'NIVARO_RUN_AS']) {
      expect(codeOf({ ...base(), env: { [k]: 'x' } }, `env.${k}`, c)).toBe('ENV_FORBIDDEN')
      expect(acceptedEnvKey(k, 'external', c.envPrefixes)).toBe(false)
    }
    expect(codeOf({ ...base(), env: { GST_PLUGIN_PATH: 'x' } }, 'env.GST_PLUGIN_PATH', c)).toBe(
      'ENV_FORBIDDEN'
    )
  })
  it('a denied key is ENV_FORBIDDEN even when it is not on the allow-list', () => {
    expect(codeOf({ ...base(), env: { LD_PRELOAD: 'x' } }, 'env.LD_PRELOAD')).toBe('ENV_FORBIDDEN')
  })
  it('the known list holds the keys Nivaro reads and no key the deny rules refuse', () => {
    for (const k of ['DB_HOST', 'MAIL_FROM', 'TRUST_PROXY', 'PUBLIC_URL', 'SESSION_SECRET'])
      expect([k, allowedEnvKey(k)]).toEqual([k, true])
    for (const k of KNOWN_ENV_KEYS) expect([k, forbiddenEnvKey(k, 'external')]).toEqual([k, false])
    expect([...KNOWN_ENV_KEYS]).toEqual([...KNOWN_ENV_KEYS].sort())
  })
  it('REDIS_URL is allowed, and still refused while redis is bundled', () => {
    expect(allowedEnvKey('REDIS_URL')).toBe(true)
    expect(acceptedEnvKey('REDIS_URL', 'bundled')).toBe(false)
    expect(acceptedEnvKey('REDIS_URL', 'external')).toBe(true)
  })
  it('operatorPrefixConflict: a prefix of, or prefixed by, a deny key or prefix', () => {
    for (const p of [
      'GIO_',
      'GTK_',
      'GST_',
      'GST_PLUGIN_X_',
      'MESA_',
      'LD_',
      'LD_X_',
      'NODE_',
      'NIVARO_',
      'NIVARO_X_',
      'HELP_',
      'SAMBA_',
      'QT_',
      'GLIBC_',
      'GDK_',
      'DYLD_',
      'DYLD_X_',
      'XDG_'
    ])
      expect([p, operatorPrefixConflict(p)]).toEqual([p, true])
    // Only starting with an exact deny key (TEMP, HOME, PATH) opens nothing denied.
    for (const p of [
      'EFP_',
      'EFP_OPS_',
      'ACME2_',
      'LIB_',
      'G_',
      'S_',
      'TEMPLATE_',
      'TEMPO_',
      'HOMEPAGE_',
      'PATHWAY_',
      'PATH_',
      'TMP_',
      'PYTHON_'
    ])
      expect([p, operatorPrefixConflict(p)]).toEqual([p, false])
  })
  it('role env keeps its own fixed list', () => {
    const b = base()
    b.roles[0].env = { SOCKETS: 'off' }
    expect(validateStackSpec(b, cfg()).ok).toBe(true)
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

describe('validateStackSpec — shared deployment owners (phase 6)', () => {
  const PATTERN = '*.apps.example.com'
  /** A shared owner as the Hub renderer sends it: no app secrets the app needs, a pattern. */
  const shared = (over: Record<string, any> = {}): Record<string, any> => ({
    ...base(),
    owner: { shared: 'tools' },
    environment: 'shared',
    host_pattern: PATTERN,
    ...over
  })

  it('an app owner with HUB_SHARED_DEPLOYMENT is still refused (X-2)', () => {
    const b = { ...base(), env: { ...base().env, HUB_SHARED_DEPLOYMENT: 'acme' } }
    expect(codeOf(b, 'env.HUB_SHARED_DEPLOYMENT')).toBe('ENV_FORBIDDEN')
    const t = { ...base(), secrets: { ...base().secrets, HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40) } }
    expect(codeOf(t, 'secrets.HUB_DEPLOYMENT_TOKEN')).toBe('ENV_FORBIDDEN')
  })

  it('R12: a shared owner sets HUB_SHARED_DEPLOYMENT as env equal to its key (deny AND allow pass)', () => {
    const b = shared({ env: { ...base().env, HUB_SHARED_DEPLOYMENT: 'tools' } })
    const r = validateStackSpec(b, cfg())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.env.HUB_SHARED_DEPLOYMENT).toBe('tools')
  })

  it('a shared owner whose HUB_SHARED_DEPLOYMENT names another deployment → SHARED_KEY_MISMATCH', () => {
    const b = shared({ env: { ...base().env, HUB_SHARED_DEPLOYMENT: 'other' } })
    expect(codeOf(b, 'env.HUB_SHARED_DEPLOYMENT')).toBe('SHARED_KEY_MISMATCH')
  })

  it('HUB_SHARED_DEPLOYMENT is env only, even on a shared owner', () => {
    const b = shared({ secrets: { ...base().secrets, HUB_SHARED_DEPLOYMENT: 'tools' } })
    expect(codeOf(b, 'secrets.HUB_SHARED_DEPLOYMENT')).toBe('ENV_FORBIDDEN')
  })

  it('R12: the deployment token is a secret only on a shared owner', () => {
    const asEnv = shared({ env: { ...base().env, HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40) } })
    expect(codeOf(asEnv, 'env.HUB_DEPLOYMENT_TOKEN')).toBe('ENV_FORBIDDEN')
    const asSecret = shared({
      secrets: { ...base().secrets, HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40) }
    })
    const r = validateStackSpec(asSecret, cfg())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.secrets.HUB_DEPLOYMENT_TOKEN).toBe('x'.repeat(40))
  })

  it('the owned keys stay refused through *_FILE on a shared owner', () => {
    const b = shared({ env: { ...base().env, HUB_DEPLOYMENT_TOKEN_FILE: '/run/secrets/X' } })
    expect(codeOf(b, 'env.HUB_DEPLOYMENT_TOKEN_FILE')).toBe('ENV_FORBIDDEN')
  })

  it('host_pattern is refused on an app owner', () => {
    expect(codeOf({ ...base(), host_pattern: PATTERN }, 'host_pattern')).toBe(
      'HOSTNAME_NOT_ALLOWED'
    )
  })

  it('accepts *.apps.example.com on a shared owner and returns it', () => {
    const r = validateStackSpec(shared(), cfg())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec.host_pattern).toBe(PATTERN)
  })

  it('accepts a pattern one level under a suffix', () => {
    expect(validateStackSpec(shared({ host_pattern: '*.team.apps.example.com' }), cfg()).ok).toBe(
      true
    )
  })

  for (const p of [
    '*.bad_name',
    '*.apps.example.org',
    '*.example.com',
    'apps.example.com',
    'x.apps.example.com',
    '**.apps.example.com',
    '*.*.apps.example.com',
    '*.Apps.example.com',
    '*.apps.example.com`) || Host(`evil.com',
    '*..apps.example.com',
    '*.apps.example.com.',
    '*.',
    '*',
    '',
    7,
    null
  ]) {
    it(`refuses the pattern ${JSON.stringify(p)}`, () => {
      expect(codeOf(shared({ host_pattern: p }), 'host_pattern')).toBe('HOSTNAME_NOT_ALLOWED')
    })
  }

  it('E2E B1: refuses a pattern for Traefik v2 (the HostRegexp router is v3 syntax)', () => {
    expect(codeOf(shared(), 'host_pattern', cfg({ traefikVersion: 2 }))).toBe(
      'HOSTNAME_NOT_ALLOWED'
    )
    expect(validateStackSpec(shared(), cfg({ traefikVersion: 3 })).ok).toBe(true)
  })

  it('refuses a pattern in publish mode (no edge to route it)', () => {
    const c = cfg({ edge: 'publish', publishPorts: [31000, 31010] })
    expect(codeOf(shared({ publish_port: 31000 }), 'host_pattern', c)).toBe('HOSTNAME_NOT_ALLOWED')
  })

  it('B5: a shared owner needs a pattern or at least one hostname on the traefik edge', () => {
    const none = shared({ hostnames: [] })
    delete none.host_pattern
    expect(codeOf(none, 'hostnames')).toBe('REQUIRED')
    expect(validateStackSpec(shared({ hostnames: [] }), cfg()).ok).toBe(true)
    const hostOnly = shared()
    delete hostOnly.host_pattern
    expect(validateStackSpec(hostOnly, cfg()).ok).toBe(true)
  })

  it('a realtime role on a shared owner → ROLE_NOT_SHARED', () => {
    const roles = [
      { role: 'web', replicas: 2 },
      { role: 'realtime', replicas: 1 }
    ]
    expect(codeOf(shared({ roles }), 'roles[1].role')).toBe('ROLE_NOT_SHARED')
    // An app owner keeps its realtime role.
    expect(validateStackSpec({ ...base(), roles }, cfg()).ok).toBe(true)
  })

  it('Task 14: a shared owner takes the role split the Hub sends (web, worker, importer) and all alone', () => {
    const limits = { cpus: 2, memory_mb: 4096 }
    for (const roles of [
      [{ role: 'all', replicas: 1, ...limits }],
      [
        { role: 'web', replicas: 2, ...limits, env: { CRON_TICKS: 'off' } },
        { role: 'worker', replicas: 1, ...limits },
        { role: 'importer', replicas: 1, ...limits }
      ],
      [
        { role: 'web', replicas: 3, ...limits, env: { CRON_TICKS: 'off' } },
        { role: 'worker', replicas: 1, ...limits },
        { role: 'importer', replicas: 1, ...limits }
      ]
    ]) {
      const r = validateStackSpec(shared({ roles }), cfg())
      expect(r, JSON.stringify(roles)).toMatchObject({ ok: true })
      if (r.ok) expect(r.spec.roles).toEqual(roles)
    }
  })

  it('Task 14: a shared split without a web or a worker → ROLE_NOT_SHARED (nobody serves, or no app ticks)', () => {
    const noWorker = [
      { role: 'web', replicas: 2 },
      { role: 'importer', replicas: 1 }
    ]
    const noWeb = [
      { role: 'worker', replicas: 1 },
      { role: 'importer', replicas: 1 }
    ]
    expect(codeOf(shared({ roles: noWorker }), 'roles')).toBe('ROLE_NOT_SHARED')
    expect(codeOf(shared({ roles: noWeb }), 'roles')).toBe('ROLE_NOT_SHARED')
    expect(codeOf(shared({ roles: [{ role: 'importer', replicas: 1 }] }), 'roles')).toBe(
      'ROLE_NOT_SHARED'
    )
    // An app owner is not held to it (a dedicated stack's roles are the Hub template's).
    expect(validateStackSpec({ ...base(), roles: noWorker }, cfg()).ok).toBe(true)
  })

  it('Task 15: a shared split may add an exporter; it is optional, and never enough alone', () => {
    const limits = { cpus: 2, memory_mb: 4096 }
    for (const roles of [
      [
        { role: 'web', replicas: 2, ...limits, env: { CRON_TICKS: 'off' } },
        { role: 'worker', replicas: 1, ...limits },
        { role: 'importer', replicas: 1, ...limits },
        { role: 'exporter', replicas: 1, ...limits }
      ],
      [
        { role: 'web', replicas: 2, ...limits, env: { CRON_TICKS: 'off' } },
        { role: 'worker', replicas: 1, ...limits },
        { role: 'exporter', replicas: 1, ...limits }
      ]
    ]) {
      const r = validateStackSpec(shared({ roles }), cfg())
      expect(r, JSON.stringify(roles)).toMatchObject({ ok: true })
      if (r.ok) expect(r.spec.roles).toEqual(roles)
    }
    expect(codeOf(shared({ roles: [{ role: 'exporter', replicas: 1 }] }), 'roles')).toBe(
      'ROLE_NOT_SHARED'
    )
    expect(
      codeOf(
        shared({
          roles: [
            { role: 'web', replicas: 2 },
            { role: 'exporter', replicas: 1 }
          ]
        }),
        'roles'
      )
    ).toBe('ROLE_NOT_SHARED')
  })

  it('Task 14: a role outside the set is still refused on a shared owner', () => {
    for (const role of ['canary', 'admin', 'WEB', '', 7]) {
      const roles = [
        { role: 'web', replicas: 1 },
        { role: 'worker', replicas: 1 },
        { role, replicas: 1 }
      ]
      expect(codeOf(shared({ roles }), 'roles[2].role'), String(role)).toBe('ROLE_BAD')
    }
  })

  it('final review E-1: a realtime role on Traefik v2 → ROLE_NEEDS_TRAEFIK_V3 (its router is v3 PathRegexp)', () => {
    const roles = [
      { role: 'web', replicas: 2 },
      { role: 'realtime', replicas: 1 }
    ]
    expect(codeOf({ ...base(), roles }, 'roles[1].role', cfg({ traefikVersion: 2 }))).toBe(
      'ROLE_NEEDS_TRAEFIK_V3'
    )
    expect(validateStackSpec({ ...base(), roles }, cfg({ traefikVersion: 3 })).ok).toBe(true)
    // The publish edge routes no paths: v2 does not matter there.
    const pub = cfg({ edge: 'publish', publishPorts: [31000, 31010], traefikVersion: 2 })
    const r = validateStackSpec({ ...base(), roles, hostnames: [], publish_port: 31000 }, pub)
    expect(r.ok ? [] : r.fields.filter((f) => f.code === 'ROLE_NEEDS_TRAEFIK_V3')).toEqual([])
  })

  it('the spec hash of a spec without a pattern is unchanged (no host_pattern key)', () => {
    const r = validateStackSpec(base(), cfg())
    expect(r.ok && 'host_pattern' in r.spec).toBe(false)
  })
})
