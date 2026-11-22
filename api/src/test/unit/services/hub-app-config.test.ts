import { describe, expect, it } from 'vitest'
import {
  AppConfigError,
  appEnvKeyRefusal,
  baseUrlFor,
  deployProjectVariables,
  HUB_APP_ENV_KEYS,
  HUB_APP_SECRET_VARS,
  HUB_SECRET_FILES,
  hostnameFor,
  hubOwnHostnames,
  isCreatableKey,
  KEEP_ONCE_VARS,
  manualTicket,
  nivaroEnvironmentFor,
  redirectUriFor,
  renderAppEnv,
  STACK_NAME_MAX,
  stackName
} from '../../../services/hub/create/app-config.js'
import type { HubTargetConfig } from '../../../services/hub/create/targets.js'

// Nivaro Hub phase 3: the settings a created app's deploy repository gets (.hub/app.env),
// hostnames, base URLs and the manual DNS ticket. Pure functions.

const auto: HubTargetConfig = {
  api: 'https://gitlab.example.com',
  namespace: 'apps',
  template_project: 'apps/nivaro-template',
  template_ref: 'v1.0.0',
  pin_file: '.hub/nivaro-version',
  deploy_job: 'deploy',
  deploy_host: 'deploy@swarm1.example.com',
  manager_known_hosts: `swarm1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`,
  proxy_network: 'proxy',
  dns_mode: 'automatic',
  wildcard_domain: 'apps.example.com',
  edge_address: null,
  scheme: 'https',
  port: null,
  cert_note: null
}
const manual: HubTargetConfig = {
  ...auto,
  dns_mode: 'manual',
  wildcard_domain: null,
  edge_address: 'edge-lb.example.com (10.0.0.5)',
  cert_note: 'Ask the PKI team for a certificate from the internal CA.'
}

describe('hostnameFor — automatic', () => {
  it('production gets <app>.<wildcard>, others <app>--<env>.<wildcard>', () => {
    expect(hostnameFor(auto, 'demo', 'production')).toEqual({
      ok: true,
      hostname: 'demo.apps.example.com'
    })
    expect(hostnameFor(auto, 'demo', 'staging')).toEqual({
      ok: true,
      hostname: 'demo--staging.apps.example.com'
    })
  })

  it('names never collide: app ab-cd production vs app ab env cd', () => {
    const one = hostnameFor(auto, 'ab-cd', 'production')
    const two = hostnameFor(auto, 'ab', 'cd')
    expect(one).toEqual({ ok: true, hostname: 'ab-cd.apps.example.com' })
    expect(two).toEqual({ ok: true, hostname: 'ab--cd.apps.example.com' })
    // and a key holding -- (which could fake that split) is never creatable
    expect(hostnameFor(auto, 'ab--cd', 'production')).toMatchObject({
      ok: false,
      code: 'HOSTNAME_INVALID'
    })
    expect(hostnameFor(auto, 'ab', 'cd--ef')).toMatchObject({ ok: false, code: 'HOSTNAME_INVALID' })
    expect(hostnameFor(auto, 'xn', 'staging')).toMatchObject({
      ok: false,
      code: 'HOSTNAME_INVALID'
    })
  })

  it('isCreatableKey: Hub keys without -- or a trailing dash', () => {
    for (const k of ['demo', 'a-b', 'app2']) expect(isCreatableKey(k), k).toBe(true)
    for (const k of ['a--b', 'demo-', 'Demo', '1demo', 'd', '', 7, null])
      expect(isCreatableKey(k), String(k)).toBe(false)
  })

  it('a given hostname directly under the wildcard is kept (normalised)', () => {
    expect(hostnameFor(auto, 'demo', 'staging', ' Demo-Test.Apps.Example.com. ')).toEqual({
      ok: true,
      hostname: 'demo-test.apps.example.com'
    })
  })

  it('refuses a given hostname outside the wildcard', () => {
    for (const h of [
      'demo.other.com',
      'apps.example.com',
      'a.b.apps.example.com',
      'demoapps.example.com',
      'demo.apps.example.com.evil.com'
    ]) {
      const r = hostnameFor(auto, 'demo', 'staging', h)
      expect(r.ok, h).toBe(false)
      if (!r.ok) expect(r.code, h).toBe('HOSTNAME_OUTSIDE_WILDCARD')
    }
  })

  it('a label over 63 characters is HOSTNAME_INVALID', () => {
    const app = `a${'b'.repeat(40)}`
    const env = `e${'f'.repeat(30)}`
    const r = hostnameFor(auto, app, env)
    expect(r).toMatchObject({ ok: false, code: 'HOSTNAME_INVALID' })
  })

  it('refuses keys that are not Hub keys (nothing but validated keys reach a name)', () => {
    for (const [a, e] of [
      ['Demo', 'staging'],
      ['demo', 'stag ing'],
      ['demo', '../x'],
      ['demo.evil.com', 'staging'],
      ['demo-', 'staging'],
      ['demo', 'staging-']
    ]) {
      const r = hostnameFor(auto, a, e)
      expect(r.ok, `${a}/${e}`).toBe(false)
      if (!r.ok) expect(r.code).toBe('HOSTNAME_INVALID')
    }
  })

  it('refuses malformed given hostnames', () => {
    for (const h of [
      '*.apps.example.com',
      'de mo.apps.example.com',
      '-x.apps.example.com',
      'http://x'
    ]) {
      const r = hostnameFor(auto, 'demo', 'staging', h)
      expect(r.ok, h).toBe(false)
      if (!r.ok) expect(['HOSTNAME_INVALID', 'HOSTNAME_OUTSIDE_WILDCARD']).toContain(r.code)
    }
  })

  it('an automatic target without a wildcard cannot make a name', () => {
    const r = hostnameFor({ ...auto, wildcard_domain: null }, 'demo', 'staging')
    expect(r).toMatchObject({ ok: false, code: 'HOSTNAME_INVALID' })
  })
})

describe('hostnameFor — manual', () => {
  it('needs a hostname', () => {
    expect(hostnameFor(manual, 'demo', 'staging')).toMatchObject({
      ok: false,
      code: 'HOSTNAME_REQUIRED'
    })
    expect(hostnameFor(manual, 'demo', 'staging', '  ')).toMatchObject({
      ok: false,
      code: 'HOSTNAME_REQUIRED'
    })
  })

  it('accepts any valid name', () => {
    expect(hostnameFor(manual, 'demo', 'staging', 'Portal.Corp.Example.org')).toEqual({
      ok: true,
      hostname: 'portal.corp.example.org'
    })
  })

  it('refuses IP addresses and single labels', () => {
    for (const h of ['10.0.0.5', 'portal', '[::1]']) {
      expect(hostnameFor(manual, 'demo', 'staging', h).ok, h).toBe(false)
    }
  })

  it('stays under the wildcard when the manual target names one', () => {
    const t = { ...manual, wildcard_domain: 'apps.example.com' }
    expect(hostnameFor(t, 'demo', 'staging', 'x.other.com')).toMatchObject({
      ok: false,
      code: 'HOSTNAME_OUTSIDE_WILDCARD'
    })
    expect(hostnameFor(t, 'demo', 'staging', 'x.apps.example.com')).toMatchObject({ ok: true })
  })

  it('plain http only for localhost and .test names (the hub token goes there)', () => {
    const http = { ...manual, scheme: 'http' as const }
    expect(hostnameFor(http, 'demo', 'staging', 'portal.example.com')).toMatchObject({
      ok: false,
      code: 'HOSTNAME_INVALID'
    })
    expect(hostnameFor(http, 'demo', 'staging', 'demo.localhost')).toMatchObject({ ok: true })
    expect(hostnameFor(http, 'demo', 'staging', 'demo.apps.test')).toMatchObject({ ok: true })
    expect(hostnameFor(http, 'demo', 'staging', 'demo.localhost.evil.com')).toMatchObject({
      ok: false
    })
  })
})

describe('baseUrlFor / redirectUriFor', () => {
  it('scheme://host[:port]', () => {
    expect(baseUrlFor(auto, 'demo.apps.example.com')).toBe('https://demo.apps.example.com')
    expect(baseUrlFor({ ...auto, port: 8443 }, 'demo.apps.example.com')).toBe(
      'https://demo.apps.example.com:8443'
    )
    expect(baseUrlFor({ ...auto, port: 443 }, 'demo.apps.example.com')).toBe(
      'https://demo.apps.example.com'
    )
    const local = { ...auto, scheme: 'http' as const, wildcard_domain: 'localhost', port: 3100 }
    expect(baseUrlFor(local, 'demo.localhost')).toBe('http://demo.localhost:3100')
  })

  it('throws for http on a public name or a malformed host', () => {
    expect(() => baseUrlFor({ ...auto, scheme: 'http' }, 'demo.apps.example.com')).toThrow()
    expect(() => baseUrlFor(auto, 'demo.apps.example.com/evil')).toThrow()
    expect(() => baseUrlFor(auto, 'user@demo.apps.example.com')).toThrow()
  })

  it('redirect URI is <base>/api/auth/callback', () => {
    expect(redirectUriFor('https://demo.apps.example.com')).toBe(
      'https://demo.apps.example.com/api/auth/callback'
    )
    expect(redirectUriFor('https://demo.apps.example.com/')).toBe(
      'https://demo.apps.example.com/api/auth/callback'
    )
  })
})

describe('nivaroEnvironmentFor', () => {
  it('maps common keys', () => {
    expect(nivaroEnvironmentFor('production')).toBe('production')
    expect(nivaroEnvironmentFor('prod')).toBe('production')
    expect(nivaroEnvironmentFor('staging')).toBe('staging')
    expect(nivaroEnvironmentFor('uat')).toBe('staging')
    expect(nivaroEnvironmentFor('dev')).toBe('development')
    expect(nivaroEnvironmentFor('development')).toBe('development')
    expect(nivaroEnvironmentFor('test')).toBe('test')
    expect(nivaroEnvironmentFor('qa')).toBe('test')
    expect(nivaroEnvironmentFor('sandbox-2')).toBe('other')
  })
})

describe('stackName', () => {
  it('is <app>-<env>', () => {
    expect(stackName('demo', 'staging')).toBe('demo-staging')
  })

  it('long names fit the cap with a stable hash suffix', () => {
    const a = stackName(`a${'b'.repeat(50)}`, 'production')
    expect(a.length).toBeLessThanOrEqual(STACK_NAME_MAX)
    expect(a).toMatch(/^[a-z][a-z0-9-]*-[0-9a-f]{4}$/)
    expect(stackName(`a${'b'.repeat(50)}`, 'production')).toBe(a)
    expect(stackName(`a${'b'.repeat(50)}`, 'staging')).not.toBe(a)
  })

  it('the cap leaves room for swarm secret names (64) and service names (63)', () => {
    const longestSecret = Math.max(...Object.values(HUB_SECRET_FILES).map((s) => s.secret.length))
    expect(STACK_NAME_MAX + 1 + longestSecret + 1 + 8).toBeLessThanOrEqual(64)
    expect(STACK_NAME_MAX + '_worker'.length).toBeLessThanOrEqual(63)
    expect(STACK_NAME_MAX).toBeLessThanOrEqual(63)
  })
})

describe('secret variables', () => {
  it('are the five of decision 8, base64-wrapped', () => {
    expect([...HUB_APP_SECRET_VARS].sort()).toEqual(
      [
        'NIVARO_DB_URL_B64',
        'NIVARO_ENCRYPTION_KEY_B64',
        'NIVARO_HUB_TOKEN_B64',
        'NIVARO_OIDC_CLIENT_SECRET_B64',
        'NIVARO_SESSION_SECRET_B64'
      ].sort()
    )
    expect([...KEEP_ONCE_VARS].sort()).toEqual(
      ['NIVARO_ENCRYPTION_KEY_B64', 'NIVARO_SESSION_SECRET_B64'].sort()
    )
    for (const k of KEEP_ONCE_VARS) expect(HUB_APP_SECRET_VARS).toContain(k)
  })

  it('each maps to one app setting read through <SETTING>_FILE', () => {
    expect(Object.keys(HUB_SECRET_FILES).sort()).toEqual([...HUB_APP_SECRET_VARS].sort())
    expect(HUB_SECRET_FILES.NIVARO_DB_URL_B64.env).toBe('DB_URL')
    expect(HUB_SECRET_FILES.NIVARO_HUB_TOKEN_B64.env).toBe('HUB_TOKEN')
    expect(HUB_SECRET_FILES.NIVARO_SESSION_SECRET_B64.env).toBe('SESSION_SECRET')
    expect(HUB_SECRET_FILES.NIVARO_ENCRYPTION_KEY_B64.env).toBe('ENCRYPTION_KEY')
    expect(HUB_SECRET_FILES.NIVARO_OIDC_CLIENT_SECRET_B64.env).toBe('OIDC_CLIENT_SECRET')
    for (const s of Object.values(HUB_SECRET_FILES)) expect(s.secret).toMatch(/^[a-z][a-z_]*$/)
  })
})

describe('appEnvKeyRefusal', () => {
  it('lets every app setting through', () => {
    for (const k of HUB_APP_ENV_KEYS) expect(appEnvKeyRefusal(k), k).toBeNull()
  })

  it('refuses secrets and anything that changes the runtime or the user', () => {
    for (const k of [
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
      'DB_URL',
      'DB_PASSWORD',
      'HUB_TOKEN',
      'OIDC_CLIENT_SECRET',
      'NIVARO_DB_URL_B64',
      'API_TOKEN',
      'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'OPENSSL_CONF',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'TMPDIR',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'NIVARO_RUN_AS',
      'NIVARO_SECRETS_DIR',
      'DB_URL_FILE',
      'ANY_SETTING_FILE',
      'PATH',
      'HOME',
      'USER',
      'DOCKER_HOST',
      'DEPLOY_HOST',
      'lowercase'
    ]) {
      expect(appEnvKeyRefusal(k), k).not.toBeNull()
    }
  })

  it('allows the named NIVARO_ exceptions and NODE_ENV', () => {
    for (const k of [
      'NODE_ENV',
      'NIVARO_ENVIRONMENT',
      'NIVARO_INSTANCE',
      'NIVARO_EXPECTED_DB',
      'NIVARO_HEAP_FROM_CGROUP'
    ]) {
      expect(appEnvKeyRefusal(k), k).toBeNull()
    }
  })
})

describe('renderAppEnv', () => {
  const secrets = {
    db: 'mssql://demo_staging:Sup3r-Secret.pw@db1.example.com/nivaro_demo_staging',
    password: 'Sup3r-Secret.pw',
    hubToken: 'h'.repeat(48),
    session: 'a1'.repeat(32),
    encryption: 'b2'.repeat(32),
    oidcSecret: 'oidc~secret~value~123'
  }
  const input = {
    app: {
      key: 'demo',
      oidc: {
        issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
        client_id: '11111111-2222-3333-4444-555555555555'
      }
    },
    envKey: 'staging',
    hostname: 'demo--staging.apps.example.com',
    baseUrl: 'https://demo--staging.apps.example.com',
    hubUrl: 'https://hub.example.com',
    engine: 'mssql' as const,
    target: auto
  }

  function parse(text: string): Map<string, string[]> {
    const m = new Map<string, string[]>()
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const i = line.indexOf('=')
      const k = line.slice(0, i)
      m.set(k, [...(m.get(k) ?? []), line.slice(i + 1)])
    }
    return m
  }

  it('holds every app setting exactly once, sorted, and nothing else', () => {
    const text = renderAppEnv(input)
    const m = parse(text)
    expect([...m.keys()].sort()).toEqual([...HUB_APP_ENV_KEYS].sort())
    for (const [k, v] of m) expect(v.length, k).toBe(1)
    const keys = text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0])
    expect(keys).toEqual([...keys].sort())
    expect(text.endsWith('\n')).toBe(true)
  })

  it('carries the values the deploy needs', () => {
    const m = parse(renderAppEnv(input))
    const v = (k: string) => m.get(k)?.[0]
    expect(v('APP_KEY')).toBe('demo')
    expect(v('ENV_KEY')).toBe('staging')
    expect(v('STACK_NAME')).toBe('demo-staging')
    expect(v('APP_HOSTS')).toBe('demo--staging.apps.example.com')
    expect(v('PUBLIC_URL')).toBe('https://demo--staging.apps.example.com')
    expect(v('ADMIN_URL')).toBe('https://demo--staging.apps.example.com')
    expect(v('HUB_URL')).toBe('https://hub.example.com')
    expect(v('NIVARO_ENVIRONMENT')).toBe('staging')
    expect(v('DB_CLIENT')).toBe('mssql')
    expect(v('OIDC_ISSUER')).toBe(input.app.oidc.issuer)
    expect(v('OIDC_CLIENT_ID')).toBe(input.app.oidc.client_id)
    expect(v('OIDC_REDIRECT_URI')).toBe('https://demo--staging.apps.example.com/api/auth/callback')
    expect(v('PROXY_NETWORK')).toBe('proxy')
    expect(v('TRUST_PROXY')).toBe('1')
  })

  it('holds no secret value, whatever extra fields the input carries', () => {
    const text = renderAppEnv({
      ...input,
      ...(secrets as object),
      app: { ...input.app, oidc_secret: secrets.oidcSecret } as typeof input.app
    } as typeof input)
    for (const s of Object.values(secrets)) expect(text).not.toContain(s)
    for (const k of HUB_APP_SECRET_VARS) expect(text).not.toContain(k)
    expect(text).not.toMatch(/SECRET|PASSWORD|TOKEN|ENCRYPTION/)
  })

  it('refuses a value with a line break (no key can be smuggled in)', () => {
    expect(() =>
      renderAppEnv({
        ...input,
        app: { ...input.app, oidc: { ...input.app.oidc, client_id: 'x\nLD_PRELOAD=/tmp/x.so' } }
      })
    ).toThrow()
    expect(() =>
      renderAppEnv({ ...input, hubUrl: 'https://hub.example.com\nNODE_OPTIONS=--require=x' })
    ).toThrow()
  })

  it('refuses bad inputs', () => {
    expect(() => renderAppEnv({ ...input, hubUrl: 'ftp://hub.example.com' })).toThrow()
    expect(() => renderAppEnv({ ...input, hubUrl: 'http://hub.example.com' })).toThrow()
    expect(() => renderAppEnv({ ...input, envKey: 'Staging!' })).toThrow()
    expect(() => renderAppEnv({ ...input, hostname: 'x y' })).toThrow()
    expect(() =>
      renderAppEnv({ ...input, app: { ...input.app, oidc: { ...input.app.oidc, issuer: 'x' } } })
    ).toThrow()
    expect(() => renderAppEnv({ ...input, engine: 'sqlite' as never })).toThrow()
  })
})

describe('manualTicket', () => {
  it('names the hostname, the edge address, the certificate and the note', () => {
    const t = manualTicket(manual, 'portal.corp.example.org')
    expect(t).toContain('portal.corp.example.org')
    expect(t).toContain('edge-lb.example.com (10.0.0.5)')
    expect(t.toLowerCase()).toContain('certificate')
    expect(t).toContain('Ask the PKI team')
  })

  it('says so when no edge address is configured, and no certificate for http', () => {
    const t = manualTicket({ ...manual, edge_address: null, scheme: 'http' }, 'demo.localhost')
    expect(t).toContain('demo.localhost')
    expect(t.toLowerCase()).toContain('edge')
    expect(t.toLowerCase()).not.toContain('tls certificate')
  })
})

describe('non-string input', () => {
  it('raises AppConfigError (never a TypeError)', () => {
    const calls: Array<() => unknown> = [
      () => baseUrlFor(auto, 42 as never),
      () => baseUrlFor(null as never, 'demo.apps.example.com'),
      () => redirectUriFor(null as never),
      () => stackName(1 as never, 'staging'),
      () => nivaroEnvironmentFor({} as never),
      () => manualTicket(manual, 5 as never),
      () => renderAppEnv(null as never),
      () =>
        renderAppEnv({
          app: { key: 'demo', oidc: { issuer: 'https://x.example.com', client_id: 12 as never } },
          envKey: 'staging',
          hostname: 'demo--staging.apps.example.com',
          baseUrl: 'https://demo--staging.apps.example.com',
          hubUrl: 'https://hub.example.com',
          engine: 'mssql',
          target: auto
        }),
      () => deployProjectVariables(undefined as never)
    ]
    for (const c of calls) expect(c).toThrow(AppConfigError)
    expect(hostnameFor(auto, 5 as never, 'staging')).toMatchObject({ ok: false })
    expect(hostnameFor(auto, 'demo', 'staging', 7 as never)).toMatchObject({ ok: true })
  })
})

describe('deployProjectVariables', () => {
  it('DEPLOY_HOST, the masked base64 DEPLOY_KNOWN_HOSTS, HUB_HOST_SUFFIX', () => {
    const vars = deployProjectVariables(auto)
    expect(vars.map((v) => v.key)).toEqual(['DEPLOY_HOST', 'DEPLOY_KNOWN_HOSTS', 'HUB_HOST_SUFFIX'])
    for (const v of vars) {
      expect(v.scope).toBe('*')
      expect(v.protected).toBe(true)
    }
    const kh = vars[1]
    expect(kh.masked).toBe(true)
    expect(kh.value).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(kh.value, 'base64').toString()).toBe(`${auto.manager_known_hosts}\n`)
    expect(vars[2].value).toBe('apps.example.com')
  })

  it('refuses a target without host keys or with a hostile deploy host', () => {
    expect(() => deployProjectVariables({ ...auto, manager_known_hosts: '' })).toThrow(
      AppConfigError
    )
    expect(() => deployProjectVariables({ ...auto, deploy_host: '-oProxyCommand=x' })).toThrow(
      AppConfigError
    )
  })
})

describe('hubOwnHostnames', () => {
  it("the Hub's own hosts, lower case, de-duplicated, junk skipped", () => {
    expect(
      hubOwnHostnames([
        'https://Hub.Example.com',
        'https://hub.example.com:8443/admin',
        'http://localhost:3055',
        null,
        undefined,
        '',
        'not a url'
      ])
    ).toEqual(['hub.example.com', 'localhost'])
  })
})
