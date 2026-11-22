import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  HUB_APP_ENV_KEYS,
  HUB_APP_SECRET_VARS,
  HUB_SECRET_FILES
} from '../../../services/hub/create/app-config.js'

// Nivaro Hub phase 3: the reference deploy-repository template (deploy/hub-app-template/) the
// operator imports into GitLab once. The Hub forks it per app; these tests pin the contract
// between the template and app-config.ts (setting names, secret names, the deploy job).

const ROOT = join(import.meta.dirname, '../../../../../deploy/hub-app-template')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** The file without comment lines, so a name only mentioned in a comment does not count. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

function allFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...allFiles(p))
    else out.push(p)
  }
  return out
}

/** A compose interpolation as written in the stack file: ${NAME}. */
const compose = (name: string) => `\${${name}}`

type Job = {
  environment?: { name?: string }
  rules?: Array<{ if?: string; exists?: string[]; when?: string }>
  script?: string[]
  image?: unknown
}

describe('hub-app-template files', () => {
  it('has every file of the contract', () => {
    for (const f of [
      '.gitlab-ci.yml',
      'docker-stack.yml',
      'scripts/deploy.sh',
      '.hub/README.md',
      'README.md'
    ]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true)
    }
    // main never deploys: the template ships no .hub/app.env
    expect(existsSync(join(ROOT, '.hub/app.env'))).toBe(false)
  })
})

describe('.gitlab-ci.yml', () => {
  const ci = yaml.load(read('.gitlab-ci.yml')) as Record<string, Job>
  const job = ci.deploy

  it('has a deploy job whose environment is the branch', () => {
    expect(job).toBeTruthy()
    expect(job.environment?.name).toBe('$CI_COMMIT_REF_NAME')
  })

  it('runs only on branch pushes that have .hub/app.env', () => {
    expect(job.rules?.length).toBeGreaterThan(0)
    const run = (job.rules ?? []).filter((r) => r.when !== 'never')
    expect(run.length).toBeGreaterThan(0)
    for (const r of run) {
      expect(r.if).toContain('$CI_COMMIT_BRANCH')
      expect(r.exists).toEqual(['.hub/app.env'])
    }
  })

  it('refuses a missing pin and a latest pin before deploying', () => {
    const script = (job.script ?? []).join('\n')
    expect(script).toMatch(/test -s/)
    expect(script).toMatch(/!= latest/)
    expect(script).toContain('scripts/deploy.sh')
  })

  it('is the only job (nothing else runs on an environment branch)', () => {
    const jobs = Object.keys(ci).filter(
      (k) =>
        !['stages', 'variables', 'default', 'workflow', 'include'].includes(k) && !k.startsWith('.')
    )
    expect(jobs).toEqual(['deploy'])
  })
})

describe('docker-stack.yml', () => {
  const text = read('docker-stack.yml')
  const stack = yaml.load(text) as {
    services: Record<
      string,
      {
        image?: string
        environment?: Record<string, string>
        secrets?: Array<{ source: string; target: string }>
        networks?: string[] | Record<string, unknown>
        volumes?: string[]
        privileged?: boolean
        cap_add?: string[]
        deploy?: { labels?: string[]; update_config?: { order?: string } }
      }
    >
    secrets: Record<string, { external?: boolean; name?: string }>
    networks: Record<string, { external?: boolean; name?: string }>
    volumes?: Record<string, unknown>
  }

  it('references every app setting', () => {
    for (const k of HUB_APP_ENV_KEYS) expect(code(text), k).toContain(`\${${k}}`)
  })

  it('names every secret variable and reads each secret through <SETTING>_FILE', () => {
    for (const k of HUB_APP_SECRET_VARS) expect(text, k).toContain(k)
    for (const svc of ['web', 'worker']) {
      const s = stack.services[svc]
      expect(s, svc).toBeTruthy()
      for (const { env, secret } of Object.values(HUB_SECRET_FILES)) {
        expect(s.environment?.[`${env}_FILE`], `${svc} ${env}_FILE`).toBe(`/run/secrets/${secret}`)
        expect(s.secrets, `${svc} ${secret}`).toContainEqual({ source: secret, target: secret })
      }
    }
    for (const { secret } of Object.values(HUB_SECRET_FILES)) {
      expect(stack.secrets[secret]?.external).toBe(true)
      expect(stack.secrets[secret]?.name).toMatch(/^\$\{SECRET_[A-Z_]+\}$/)
    }
  })

  it('web and worker run the pinned image, start-first', () => {
    for (const svc of ['web', 'worker']) {
      expect(stack.services[svc].image).toBe(compose('NIVARO_IMAGE_REF'))
      expect(stack.services[svc].deploy?.update_config?.order).toBe('start-first')
    }
    expect(stack.services.web.environment?.NIVARO_ROLE).toBe('web')
    expect(stack.services.worker.environment?.NIVARO_ROLE).toBe('worker')
  })

  it('routes through Traefik on the proxy network with a Host() rule', () => {
    const labels = stack.services.web.deploy?.labels ?? []
    expect(labels).toContain('traefik.enable=true')
    expect(labels.some((l) => /\.rule=\$\{TRAEFIK_RULE\}$/.test(l))).toBe(true)
    expect(stack.networks.proxy).toEqual({ external: true, name: compose('PROXY_NETWORK') })
    expect(stack.services.web.networks).toContain('proxy')
    // the worker is never on the edge network
    expect(stack.services.worker.deploy?.labels ?? []).not.toContain('traefik.enable=true')
  })

  it('has no host bind mounts and no privileged settings', () => {
    for (const [name, s] of Object.entries(stack.services)) {
      expect(s.privileged, name).toBeUndefined()
      expect(s.cap_add, name).toBeUndefined()
      for (const v of s.volumes ?? []) {
        const src = String(v).split(':')[0]
        expect(src, `${name}: ${v}`).toMatch(/^[a-z][a-z0-9_-]*$/)
        expect(Object.keys(stack.volumes ?? {}), `${name}: ${v}`).toContain(src)
      }
    }
    expect(code(text)).not.toMatch(
      /docker\.sock|\bprivileged\b|cap_add|network_mode:\s*host|pid:\s*host/
    )
  })
})

describe('scripts/deploy.sh', () => {
  const sh = read('scripts/deploy.sh')

  it('parses as POSIX sh', () => {
    expect(() => execFileSync('sh', ['-n', join(ROOT, 'scripts/deploy.sh')])).not.toThrow()
  })

  it('references every app setting and every secret variable', () => {
    for (const k of [...HUB_APP_ENV_KEYS, ...HUB_APP_SECRET_VARS]) expect(code(sh), k).toContain(k)
  })

  it('reads .hub/app.env against an allow-list equal to the app settings (never sources it)', () => {
    const m = sh.match(/APP_ENV_KEYS="([^"]+)"/)
    expect(m).toBeTruthy()
    const listed = (m?.[1] ?? '').trim().split(/\s+/).sort()
    expect(listed).toEqual([...HUB_APP_ENV_KEYS].sort())
    expect(code(sh)).not.toMatch(/(^|[\s;])(\.|source)\s+[^\s]*app\.env/m)
    expect(code(sh)).not.toMatch(/\beval\b/)
  })

  it('names each swarm secret <STACK_NAME>_<name>_<sha8>', () => {
    expect(sh).toMatch(/\$\{STACK_NAME\}_\$\{?\w+\}?_\$\{?\w+\}?/)
    for (const { secret } of Object.values(HUB_SECRET_FILES)) expect(code(sh)).toContain(secret)
  })

  it('treats DEPLOY_HOST strictly as an ssh destination', () => {
    // every ssh call ends its options with -- before the quoted destination
    const calls = code(sh)
      .split('\n')
      .filter((l) => /(^|\s)ssh\s/.test(l))
    expect(calls.length).toBeGreaterThan(0)
    for (const l of calls) expect(l, l).toMatch(/ -- "\$(DEST|\{DEST\})"/)
    // and refuses a value that could read as an option or carry shell text
    expect(code(sh)).toMatch(/case "\$DEPLOY_HOST" in/)
  })

  it('never puts a secret value in argv or the log', () => {
    expect(code(sh)).not.toMatch(/set -x/)
    expect(code(sh)).toMatch(/docker secret create[^\n]* -\s*$/m)
  })

  it('waits for /api/version of the pinned version', () => {
    expect(code(sh)).toContain('/api/version')
  })
})

describe('the whole template', () => {
  it('names no NIVARO_*_B64 variable other than the five', () => {
    const allowed = new Set<string>(HUB_APP_SECRET_VARS)
    for (const f of allFiles(ROOT)) {
      const names = readFileSync(f, 'utf8').match(/NIVARO_[A-Z0-9_]*_B64\b/g) ?? []
      for (const n of names) expect(allowed.has(n), `${relative(ROOT, f)}: ${n}`).toBe(true)
    }
  })
})

// ── deploy.sh run against fake ssh + docker ──────────────────────────────────

describe('scripts/deploy.sh run', () => {
  const SECRETS: Record<string, string> = {
    NIVARO_DB_URL_B64: 'sqlserver://demo_staging:Pw-1.secret@db1.example.com/nivaro_demo_staging',
    NIVARO_HUB_TOKEN_B64: 'h'.repeat(48),
    NIVARO_SESSION_SECRET_B64: 'a1'.repeat(32),
    NIVARO_ENCRYPTION_KEY_B64: 'b2'.repeat(32),
    NIVARO_OIDC_CLIENT_SECRET_B64: 'oidc~secret~value~123'
  }
  const APP_ENV = [
    'ADMIN_URL=https://demo-staging.apps.example.com',
    'APP_HOSTS=demo-staging.apps.example.com',
    'APP_KEY=demo',
    'DB_CLIENT=mssql',
    'ENV_KEY=staging',
    'HUB_URL=https://hub.example.com',
    'NIVARO_ENVIRONMENT=staging',
    'OIDC_CLIENT_ID=abc',
    'OIDC_ISSUER=https://login.microsoftonline.com/t/v2.0',
    'OIDC_REDIRECT_URI=https://demo-staging.apps.example.com/api/auth/callback',
    'PROXY_NETWORK=proxy',
    'PUBLIC_URL=https://demo-staging.apps.example.com',
    'STACK_NAME=demo-staging',
    'TRUST_PROXY=1'
  ]
  const DIGEST = `sha256:${'c'.repeat(64)}`

  function setup(o: { appEnv?: string[]; pin?: string; env?: Record<string, string> } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'hub-tpl-'))
    const bin = join(dir, 'bin')
    const log = join(dir, 'calls.log')
    mkdirSync(join(dir, 'repo/.hub'), { recursive: true })
    mkdirSync(join(dir, 'repo/scripts'), { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(dir, 'repo/docker-stack.yml'), read('docker-stack.yml'))
    writeFileSync(join(dir, 'repo/scripts/deploy.sh'), read('scripts/deploy.sh'))
    writeFileSync(join(dir, 'repo/.hub/app.env'), `${(o.appEnv ?? APP_ENV).join('\n')}\n`)
    writeFileSync(join(dir, 'repo/.hub/nivaro-version'), o.pin ?? `0.3.300\n${DIGEST}\n`)
    // fake ssh: records argv, answers at once
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf 'ssh %s\\n' "$*" >> "${log}"\nexit 0\n`)
    // fake docker: records argv (+ stdin of secret create, + the stack's interpolated env)
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${log}"
case "$1 $2" in
  "info --format") echo "active true" ;;
  "network inspect") exit 0 ;;
  "service ls") exit 0 ;;
  "secret inspect") exit 1 ;;
  "secret create") for a; do last=$a; prev2=$prev; prev=$a; done; printf 'stdin %s=' "$prev2" >> "${log}"; cat >> "${log}"; printf '\\n' >> "${log}" ;;
  "stack deploy") printf 'env DOCKER_HOST=%s RULE=%s TLS=%s EP=%s IMAGE=%s DB=%s\\n' "$DOCKER_HOST" "$TRAEFIK_RULE" "$TRAEFIK_TLS" "$TRAEFIK_ENTRYPOINT" "$NIVARO_IMAGE_REF" "$SECRET_DB_URL" >> "${log}" ;;
  "run --rm") echo '{"version":"0.3.300","react":"x"}' ;;
esac
exit 0
`
    )
    const shimSha =
      spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0
        ? 'exec shasum -a 256 "$@"'
        : null
    if (shimSha) writeFileSync(join(bin, 'sha256sum'), `#!/bin/sh\n${shimSha}\n`)
    for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755)
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      CI_COMMIT_REF_NAME: 'staging',
      DEPLOY_HOST: 'deploy@swarm1.example.com',
      DEPLOY_SSH_KEY: 'not-a-real-key',
      DEPLOY_WAIT_TRIES: '1',
      ...Object.fromEntries(
        Object.entries(SECRETS).map(([k, v]) => [k, Buffer.from(v).toString('base64')])
      ),
      ...o.env
    }
    const r = spawnSync('sh', ['scripts/deploy.sh'], {
      cwd: join(dir, 'repo'),
      env,
      encoding: 'utf8'
    })
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
    rmSync(dir, { recursive: true, force: true })
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls }
  }

  it('deploys: one ssh with -- before the destination, immutable secrets, the pinned image', () => {
    const r = setup()
    expect(r.out).toContain('done')
    expect(r.status).toBe(0)
    const ssh = r.calls.split('\n').filter((l) => l.startsWith('ssh '))
    expect(ssh.length).toBe(1)
    expect(ssh[0]).toMatch(/ -- ssh:\/\/deploy@swarm1\.example\.com$/)
    for (const [k, v] of Object.entries(SECRETS)) {
      const short = HUB_SECRET_FILES[k].secret
      const sha8 = createHash('sha256').update(v).digest('hex').slice(0, 8)
      expect(r.calls).toContain(`stdin demo-staging_${short}_${sha8}=${v}\n`)
    }
    expect(r.calls).toContain('RULE=Host(`demo-staging.apps.example.com`) TLS=true EP=websecure')
    expect(r.calls).toContain(`IMAGE=nodeworks/nivaro@${DIGEST}`)
    expect(r.calls).toMatch(
      /docker stack deploy --detach=false .* -c docker-stack\.yml demo-staging/
    )
    expect(r.calls).toContain('http://web:3055/api/version')
    // no secret value in any argv, nor in the job output
    const argv = r.calls
      .split('\n')
      .filter((l) => l.startsWith('ssh ') || l.startsWith('docker '))
      .join('\n')
    for (const v of Object.values(SECRETS)) {
      expect(argv).not.toContain(v)
      expect(r.out).not.toContain(v)
      expect(r.out).not.toContain(Buffer.from(v).toString('base64'))
    }
  })

  it('several hosts make one Host() || Host() rule', () => {
    const appEnv = APP_ENV.map((l) =>
      l.startsWith('APP_HOSTS=') ? 'APP_HOSTS=demo-staging.apps.example.com,portal.example.org' : l
    )
    const r = setup({ appEnv })
    expect(r.status).toBe(0)
    expect(r.calls).toContain(
      'RULE=Host(`demo-staging.apps.example.com`) || Host(`portal.example.org`) TLS'
    )
  })

  const refused = (r: { status: number | null; calls: string }) => {
    expect(r.status).not.toBe(0)
    expect(r.calls).not.toMatch(/^ssh /m)
    expect(r.calls).not.toMatch(/^docker /m)
  }

  it('refuses a key that is not an app setting, before any connection', () => {
    for (const extra of [
      'LD_PRELOAD=/tmp/x.so',
      'NODE_OPTIONS=--require=/tmp/x',
      'DOCKER_HOST=tcp://evil:2375'
    ]) {
      const r = setup({ appEnv: [...APP_ENV, extra] })
      refused(r)
      expect(r.out).toContain('is not an app setting')
    }
  })

  it('refuses a missing setting, a duplicate and a branch mismatch', () => {
    refused(setup({ appEnv: APP_ENV.filter((l) => !l.startsWith('HUB_URL=')) }))
    refused(setup({ appEnv: [...APP_ENV, 'APP_KEY=other'] }))
    const r = setup({ env: { CI_COMMIT_REF_NAME: 'production' } })
    refused(r)
    expect(r.out).toContain('does not match branch')
  })

  it('never runs a value as shell', () => {
    const appEnv = APP_ENV.map((l) =>
      l.startsWith('OIDC_CLIENT_ID=') ? 'OIDC_CLIENT_ID=$(touch /tmp/hub-pwned-x)`id`' : l
    )
    const r = setup({ appEnv })
    expect(r.status).toBe(0)
    expect(existsSync('/tmp/hub-pwned-x')).toBe(false)
  })

  it('refuses hostile hosts in APP_HOSTS (Traefik rule injection)', () => {
    for (const h of ['a.example.com`) || PathPrefix(`/', 'a.example.com,-x', 'A.example.com']) {
      const appEnv = APP_ENV.map((l) => (l.startsWith('APP_HOSTS=') ? `APP_HOSTS=${h}` : l))
      refused(setup({ appEnv }))
    }
  })

  it('refuses a missing pin, latest and a bad digest', () => {
    refused(setup({ pin: '' }))
    refused(setup({ pin: 'latest\n' }))
    refused(setup({ pin: '0.3.300\nsha256:xyz\n' }))
  })

  it('treats DEPLOY_HOST strictly as an ssh destination', () => {
    for (const h of ['-oProxyCommand=touch /tmp/x', 'a b', 'host;id', 'x@y@z', '']) {
      const r = setup({ env: { DEPLOY_HOST: h } })
      refused(r)
      expect(r.out).toContain('DEPLOY_HOST must be')
    }
  })

  it('refuses a missing secret variable', () => {
    const r = setup({ env: { NIVARO_HUB_TOKEN_B64: '' } })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('NIVARO_HUB_TOKEN_B64 is not set')
    expect(r.calls).not.toMatch(/stack deploy/)
  })
})
