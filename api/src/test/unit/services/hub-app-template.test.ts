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
import { afterAll, describe, expect, it } from 'vitest'
import {
  HUB_APP_ENV_KEYS,
  HUB_APP_SECRET_VARS,
  HUB_DEPLOY_CI_FILE,
  HUB_SECRET_FILES,
  renderAppCi
} from '../../../services/hub/create/app-config.js'
import type { HubTargetConfig } from '../../../services/hub/create/targets.js'

// Nivaro Hub phase 3: the reference deploy template (deploy/hub-app-template/). An app repository
// only includes ci/deploy.yml from the Hub-owned template at a pinned ref; the deploy key reaches
// the swarm manager only through the forced command manager/nivaro-hub-deploy. These tests pin
// that contract, then run deploy.sh end to end against the real wrapper with a fake docker.

const ROOT = join(import.meta.dirname, '../../../../../deploy/hub-app-template')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/** The file without comment lines, so a name only mentioned in a comment does not count. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
/** A compose interpolation as written in the stack file: ${NAME}. */
const compose = (name: string) => `\${${name}}`
const DIGEST_RE = /@sha256:[0-9a-f]{64}$/

function allFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...allFiles(p))
    else out.push(p)
  }
  return out
}

type Job = {
  environment?: { name?: string }
  rules?: Array<{ if?: string; exists?: string[]; when?: string }>
  script?: string[]
  image?: { name?: string; entrypoint?: string[] } | string
  before_script?: string[]
  variables?: Record<string, string>
}
const SCRIPTS = ['scripts/deploy.sh', 'scripts/sync-ci.sh', 'manager/nivaro-hub-deploy']

describe('hub-app-template files', () => {
  it('has every file of the contract and no deploy settings of its own', () => {
    for (const f of [
      '.gitlab-ci.yml',
      'ci/deploy.yml',
      'scripts/deploy.sh',
      'scripts/sync-ci.sh',
      'manager/nivaro-hub-deploy',
      'manager/docker-stack.yml',
      'manager/authorized_keys.example',
      'manager/key.conf.example',
      '.hub/README.md',
      'README.md'
    ]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true)
    }
    expect(existsSync(join(ROOT, '.hub/app.env'))).toBe(false)
    expect(existsSync(join(ROOT, 'docker-stack.yml'))).toBe(false)
  })

  it('every script parses as POSIX sh', () => {
    for (const f of SCRIPTS)
      expect(() => execFileSync('sh', ['-n', join(ROOT, f)]), f).not.toThrow()
  })

  it('ci/deploy.yml is in step with scripts/deploy.sh', () => {
    expect(() =>
      execFileSync('sh', [join(ROOT, 'scripts/sync-ci.sh'), '--check'], { stdio: 'pipe' })
    ).not.toThrow()
  })
})

describe('the app repository CI (renderAppCi)', () => {
  const target = {
    template_project: 'platform/nivaro-template',
    template_ref: 'v1.2.0'
  } as HubTargetConfig

  it('only includes the deploy job from the template at the pinned ref', () => {
    const ci = yaml.load(renderAppCi(target)) as Record<string, unknown>
    expect(Object.keys(ci)).toEqual(['include'])
    expect(ci.include).toEqual([
      { project: 'platform/nivaro-template', ref: 'v1.2.0', file: `/${HUB_DEPLOY_CI_FILE}` }
    ])
    expect(existsSync(join(ROOT, HUB_DEPLOY_CI_FILE))).toBe(true)
  })

  it('refuses a moving or malformed ref and a bad project path', () => {
    for (const bad of [
      { template_ref: "v1'\n  - local: x" },
      { template_ref: '' },
      { template_ref: 'a..b' },
      { template_project: "x'; y" },
      { template_project: '../x' }
    ]) {
      expect(() => renderAppCi({ ...target, ...bad } as HubTargetConfig)).toThrow()
    }
  })
})

describe('.gitlab-ci.yml (the template project itself)', () => {
  const ci = yaml.load(read('.gitlab-ci.yml')) as Record<string, Job>

  it('has no deploy job and never runs on a branch with .hub/app.env', () => {
    expect(ci.deploy).toBeUndefined()
    expect(ci.check.rules?.[0]).toEqual({ exists: ['.hub/app.env'], when: 'never' })
    expect((ci.check.script ?? []).join('\n')).toContain('sync-ci.sh --check')
    expect((ci.check.image as { name: string }).name).toMatch(DIGEST_RE)
  })
})

describe('ci/deploy.yml', () => {
  const ci = yaml.load(read('ci/deploy.yml')) as Record<string, Job>
  const job = ci.deploy

  it('has only the deploy job, whose environment is the branch', () => {
    const jobs = Object.keys(ci).filter(
      (k) => !['stages', 'variables', 'default', 'workflow', 'include'].includes(k)
    )
    expect(jobs).toEqual(['deploy'])
    expect(job.environment?.name).toBe('$CI_COMMIT_REF_NAME')
  })

  it('runs only on branch pushes that have .hub/app.env', () => {
    const run = (job.rules ?? []).filter((r) => r.when !== 'never')
    expect(run.length).toBeGreaterThan(0)
    for (const r of run) {
      expect(r.if).toContain('$CI_COMMIT_BRANCH')
      expect(r.exists).toEqual(['.hub/app.env'])
    }
  })

  it('runs a digest-pinned image that already has ssh (nothing installed at run time)', () => {
    const image = job.image as { name: string; entrypoint: string[] }
    expect(image.name).toMatch(DIGEST_RE)
    expect(image.entrypoint).toEqual([''])
    expect(job.before_script).toBeUndefined()
    expect(read('ci/deploy.yml')).not.toMatch(/apk add|apt-get|curl |wget /)
  })

  it('refuses a missing pin, latest and a pin without a digest before deploying', () => {
    const script = (job.script ?? []).join('\n')
    expect(script).toMatch(/test -s/)
    expect(script).toMatch(/!= latest/)
    expect(script).toContain("grep -E '^sha256:[0-9a-f]{64}$'")
  })

  it('embeds scripts/deploy.sh verbatim', () => {
    const last = (job.script ?? []).at(-1) ?? ''
    const m = last.match(/<<'HUB_DEPLOY_SH'\n([\s\S]*?)\nHUB_DEPLOY_SH\n/)
    expect(m).toBeTruthy()
    expect(`${m?.[1]}\n`).toBe(read('scripts/deploy.sh'))
    expect(last).toMatch(/sh "\$f"\n$/)
  })
})

describe('manager/docker-stack.yml', () => {
  const text = read('manager/docker-stack.yml')
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
        ports?: unknown
        deploy?: { labels?: string[]; update_config?: { order?: string } }
      }
    >
    secrets: Record<string, { external?: boolean; name?: string }>
    networks: Record<string, { external?: boolean; name?: string }>
    volumes?: Record<string, unknown>
  }

  it('references every app setting', () => {
    for (const k of HUB_APP_ENV_KEYS) expect(code(text), k).toContain(compose(k))
  })

  it('names every secret variable and reads each secret through <SETTING>_FILE', () => {
    for (const k of HUB_APP_SECRET_VARS) expect(text, k).toContain(k)
    for (const svc of ['web', 'worker']) {
      const s = stack.services[svc]
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

  it('web and worker run the pinned image, start-first; redis is pinned by digest', () => {
    for (const svc of ['web', 'worker']) {
      expect(stack.services[svc].image).toBe(compose('NIVARO_IMAGE_REF'))
      expect(stack.services[svc].deploy?.update_config?.order).toBe('start-first')
    }
    expect(stack.services.web.environment?.NIVARO_ROLE).toBe('web')
    expect(stack.services.worker.environment?.NIVARO_ROLE).toBe('worker')
    expect(stack.services.redis.image).toMatch(DIGEST_RE)
  })

  it('routes through Traefik on the proxy network with a Host() rule', () => {
    const labels = stack.services.web.deploy?.labels ?? []
    expect(labels).toContain('traefik.enable=true')
    expect(labels.some((l) => /\.rule=\$\{TRAEFIK_RULE\}$/.test(l))).toBe(true)
    expect(stack.networks.proxy).toEqual({ external: true, name: compose('PROXY_NETWORK') })
    expect(stack.services.web.networks).toContain('proxy')
    expect(stack.services.worker.deploy?.labels ?? []).not.toContain('traefik.enable=true')
  })

  it('has no host bind mounts, no privileged settings, no published ports', () => {
    for (const [name, s] of Object.entries(stack.services)) {
      expect(s.privileged, name).toBeUndefined()
      expect(s.cap_add, name).toBeUndefined()
      expect(s.ports, name).toBeUndefined()
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

describe('scripts/deploy.sh (static)', () => {
  const sh = read('scripts/deploy.sh')

  it('references every app setting and every secret variable', () => {
    for (const k of [...HUB_APP_ENV_KEYS, ...HUB_APP_SECRET_VARS]) expect(code(sh), k).toContain(k)
  })

  it('reads .hub/app.env against an allow-list equal to the app settings (never sources it)', () => {
    const m = sh.match(/APP_ENV_KEYS="([^"]+)"/)
    const listed = (m?.[1] ?? '').trim().split(/\s+/).sort()
    expect(listed).toEqual([...HUB_APP_ENV_KEYS].sort())
    expect(code(sh)).not.toMatch(/(^|[\s;])(\.|source)\s+[^\s]*app\.env/m)
    expect(code(sh)).not.toMatch(/\beval\b/)
  })

  it('names each swarm secret <STACK_NAME>_<name>_<sha8>', () => {
    expect(sh).toMatch(/\$\{STACK_NAME\}_\$\{?\w+\}?_\$\{?\w+\}?/)
    for (const { secret } of Object.values(HUB_SECRET_FILES)) expect(code(sh)).toContain(secret)
  })

  it('never forwards the Docker socket and never runs docker itself', () => {
    const c = code(sh)
    expect(c).not.toMatch(/\s-L\s|LocalForward|DOCKER_HOST|docker\.sock|ControlMaster|\s-M\s/)
    expect(c).not.toMatch(/(^|[\s;|(])docker\s/m)
  })

  it('every ssh call: -F /dev/null, pinned host key, -- before the quoted destination', () => {
    const calls = code(sh)
      .split('\n')
      .filter((l) => /(^|\s)ssh\s/.test(l))
    expect(calls).toHaveLength(1)
    for (const l of calls) {
      expect(l).toContain('-F /dev/null')
      expect(l).toContain('StrictHostKeyChecking=yes')
      expect(l).toMatch(/ -- "\$(DEST|\{DEST\})"/)
    }
    expect(sh).not.toMatch(/accept-new|StrictHostKeyChecking=no/)
    expect(code(sh)).toMatch(/case "\$\{DEPLOY_HOST:-\}" in/)
  })

  it('never puts a secret value in argv or the log', () => {
    expect(code(sh)).not.toMatch(/set -x/)
    expect(code(sh)).toMatch(/printf '%s' "\$value" \| remote secret-create "\$name"/)
  })
})

// ── shared harness: fake docker, the real wrapper behind a fake ssh ──────────

const SECRETS: Record<string, string> = {
  NIVARO_DB_URL_B64: 'sqlserver://demo_staging:Pw-1.secret@db1.example.com/nivaro_demo_staging',
  NIVARO_HUB_TOKEN_B64: 'h'.repeat(48),
  NIVARO_SESSION_SECRET_B64: 'a1'.repeat(32),
  NIVARO_ENCRYPTION_KEY_B64: 'b2'.repeat(32),
  NIVARO_OIDC_CLIENT_SECRET_B64: 'oidc~secret~value~123'
}
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8)
const secretName = (stack: string, k: string) =>
  `${stack}_${HUB_SECRET_FILES[k].secret}_${sha8(SECRETS[k])}`
const APP_ENV = [
  'ADMIN_URL=https://demo--staging.apps.example.com',
  'APP_HOSTS=demo--staging.apps.example.com',
  'APP_KEY=demo',
  'DB_CLIENT=mssql',
  'ENV_KEY=staging',
  'HUB_URL=https://hub.example.com',
  'NIVARO_ENVIRONMENT=staging',
  'OIDC_CLIENT_ID=abc',
  'OIDC_ISSUER=https://login.microsoftonline.com/t/v2.0',
  'OIDC_REDIRECT_URI=https://demo--staging.apps.example.com/api/auth/callback',
  'PROXY_NETWORK=proxy',
  'PUBLIC_URL=https://demo--staging.apps.example.com',
  'STACK_NAME=demo-staging',
  'TRUST_PROXY=1'
]
const DIGEST = `sha256:${'c'.repeat(64)}`
const KNOWN = `swarm1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`
const KEY_CONF = 'prefix=demo-\nhost=apps.example.com\nnetwork=proxy\nimage=nodeworks/nivaro\n'
const SHA_SHIM =
  spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0 ? 'exec shasum -a 256 "$@"' : null

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface Box {
  dir: string
  bin: string
  log: string
  state: string
  wrapper: string
  calls: () => string
}

/** A manager (wrapper + config + fake docker) in a temp dir. */
function manager(o: { conf?: string; services?: string } = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tpl-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  const log = join(dir, 'calls.log')
  const state = join(dir, 'state')
  const etc = join(dir, 'etc')
  for (const d of [bin, join(state, 'secrets'), join(etc, 'keys')])
    mkdirSync(d, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(join(etc, 'docker-stack.yml'), read('manager/docker-stack.yml'))
  writeFileSync(join(etc, 'keys/apps.conf'), o.conf ?? KEY_CONF)
  writeFileSync(join(state, 'services'), o.services ?? '')
  const original = read('manager/nivaro-hub-deploy')
  const patched = original
    .replace(/^ROOT=\/etc\/nivaro-hub-deploy$/m, `ROOT='${etc}'`)
    .replace(/^PATH=.*$/m, `PATH='${bin}':"$PATH"`)
  expect(patched).not.toBe(original)
  expect(patched).toContain(`ROOT='${etc}'`)
  const wrapper = join(dir, 'nivaro-hub-deploy')
  writeFileSync(wrapper, patched)
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf 'docker %s\\n' "$*" >> '${log}'
S='${state}'
last=''; prev=''; prev2=''
for a; do prev2=$prev; prev=$a; last=$a; done
case "$1 $2" in
  "service ls") cut -d' ' -f1 "$S/services"; exit 0 ;;
  "service inspect") grep "^$last " "$S/services" | cut -d' ' -f2; exit 0 ;;
  "secret inspect") [ -f "$S/secrets/$last" ]; exit $? ;;
  "secret create") cat > "$S/secrets/$prev2"; exit 0 ;;
  "network inspect") [ "$last" = proxy ]; exit $? ;;
  "stack deploy") printf 'deployed RULE=%s TLS=%s EP=%s IMAGE=%s DB=%s FILE=%s\\n' "$TRAEFIK_RULE" "$TRAEFIK_TLS" "$TRAEFIK_ENTRYPOINT" "$NIVARO_IMAGE_REF" "$SECRET_DB_URL" "$prev2" >> '${log}'; exit 0 ;;
  "run --rm") echo '{"version":"0.3.300","react":"x"}'; exit 0 ;;
esac
exit 0
`
  )
  // fake ssh: logs argv + the known_hosts it was given, then runs the forced command
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> '${log}'
prev=''
for a; do
  if [ "$prev" = -o ]; then case "$a" in UserKnownHostsFile=*) kh=\${a#UserKnownHostsFile=} ;; esac; fi
  prev=$a
done
[ -n "\${kh:-}" ] && { printf 'known_hosts='; tr '\\n' '|' < "$kh"; printf '\\n'; } >> '${log}'
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
shift 2
SSH_ORIGINAL_COMMAND="$*" exec sh '${wrapper}' apps
`
  )
  if (SHA_SHIM) writeFileSync(join(bin, 'sha256sum'), `#!/bin/sh\n${SHA_SHIM}\n`)
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755)
  return { dir, bin, log, state, wrapper, calls: () => readFileSync(log, 'utf8') }
}

/** Run the wrapper as sshd would: forced command, SSH_ORIGINAL_COMMAND, stdin. */
function forced(box: Box, command: string, stdin = '', args: string[] = ['apps']) {
  const r = spawnSync('sh', [box.wrapper, ...args], {
    env: { PATH: process.env.PATH, HOME: box.dir, SSH_ORIGINAL_COMMAND: command },
    input: stdin,
    encoding: 'utf8'
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const dockerCalls = (box: Box) =>
  box
    .calls()
    .split('\n')
    .filter((l) => l.startsWith('docker '))

function deploySettings(over: Record<string, string> = {}, drop: string[] = []): string {
  const kv = new Map<string, string>(
    APP_ENV.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )
  kv.set('NIVARO_IMAGE_REF', `nodeworks/nivaro@${DIGEST}`)
  kv.set('NIVARO_VERSION', '0.3.300')
  for (const k of Object.keys(SECRETS))
    kv.set(`SECRET_${HUB_SECRET_FILES[k].secret.toUpperCase()}`, secretName('demo-staging', k))
  kv.set('WAIT_TRIES', '1')
  for (const [k, v] of Object.entries(over)) kv.set(k, v)
  for (const k of drop) kv.delete(k)
  return `${[...kv].map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

function seedSecrets(box: Box, stack = 'demo-staging') {
  for (const [k, v] of Object.entries(SECRETS))
    writeFileSync(join(box.state, 'secrets', secretName(stack, k)), v)
}

describe('manager/nivaro-hub-deploy (forced command)', () => {
  it('the authorized_keys template binds the key to the wrapper with no pty or forwarding', () => {
    const line = code(read('manager/authorized_keys.example')).trim()
    expect(line).toMatch(
      /^command="\/usr\/local\/bin\/nivaro-hub-deploy [a-z0-9_-]+",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict ssh-/
    )
  })

  it('refuses every other command and any shell metacharacter, before docker runs', () => {
    const box = manager()
    for (const cmd of [
      '',
      'ls',
      'sh',
      'deploy',
      'deploy demo-staging extra',
      'deploy demo-staging; rm -rf /',
      'deploy $(id)',
      'deploy `id`',
      'deploy demo-staging|id',
      'deploy demo-staging && id',
      'deploy demo-staging\nid',
      'stack-owner ../etc',
      'stack-owner demo-staging > /tmp/x',
      'DEPLOY demo-staging',
      'docker ps',
      'secret-rm demo-staging_db_url_12345678',
      'stack-owner demo_staging',
      `stack-owner ${'d'.repeat(41)}`
    ]) {
      const r = forced(box, cmd)
      expect(r.status, JSON.stringify(cmd)).not.toBe(0)
    }
    expect(dockerCalls(box)).toEqual([])
  })

  it('refuses stacks outside the key prefixes and a bad key argument', () => {
    const box = manager()
    for (const cmd of ['stack-owner other-staging', 'deploy other-staging', 'stack-owner d']) {
      const r = forced(box, cmd)
      expect(r.status, cmd).not.toBe(0)
    }
    expect(forced(box, 'stack-owner demo-staging', '', ['../x']).status).not.toBe(0)
    expect(forced(box, 'stack-owner demo-staging', '', ['apps', 'more']).status).not.toBe(0)
    expect(forced(box, 'stack-owner demo-staging', '', ['nokey']).status).not.toBe(0)
    expect(dockerCalls(box)).toEqual([])
    const ok = forced(box, 'stack-owner demo-staging')
    expect(ok.status).toBe(0)
  })

  it('stack-owner prints the owner of the stack', () => {
    const box = manager({
      services: 'demo-staging_web demo/staging\ndemo-staging_worker demo/staging\n'
    })
    expect(forced(box, 'stack-owner demo-staging')).toEqual({ status: 0, out: 'demo/staging\n' })
  })

  it('secret-create: only the five names, the hash must match the value, created once', () => {
    const box = manager()
    const k = 'NIVARO_DB_URL_B64'
    const name = secretName('demo-staging', k)
    for (const [cmd, stdin] of [
      [`secret-create demo-staging_password_${sha8(SECRETS[k])}`, SECRETS[k]],
      [`secret-create demo-staging_db_url_${sha8('other')}`, SECRETS[k]],
      [`secret-create demo-staging_db_url_ZZZZZZZZ`, SECRETS[k]],
      [`secret-create other-staging_db_url_${sha8(SECRETS[k])}`, SECRETS[k]],
      [`secret-create demo-staging_db_url`, SECRETS[k]],
      [`secret-create ${name}`, '']
    ]) {
      expect(forced(box, cmd, stdin).status, cmd).not.toBe(0)
    }
    expect(dockerCalls(box)).toEqual([])
    expect(forced(box, `secret-create ${name}`, SECRETS[k])).toEqual({
      status: 0,
      out: 'created\n'
    })
    expect(readFileSync(join(box.state, 'secrets', name), 'utf8')).toBe(SECRETS[k])
    expect(forced(box, `secret-create ${name}`, SECRETS[k])).toEqual({ status: 0, out: 'exists\n' })
    // the value never reaches docker's argv
    expect(dockerCalls(box).join('\n')).not.toContain(SECRETS[k])
  })

  it('deploy: deploys the stack file installed on the manager with checked settings', () => {
    const box = manager()
    seedSecrets(box)
    const r = forced(box, 'deploy demo-staging', deploySettings())
    expect(r.out).toContain('web answers 0.3.300')
    expect(r.status).toBe(0)
    const line =
      box
        .calls()
        .split('\n')
        .find((l) => l.startsWith('deployed ')) ?? ''
    expect(line).toContain('RULE=Host(`demo--staging.apps.example.com`) TLS=true EP=websecure')
    expect(line).toContain(`IMAGE=nodeworks/nivaro@${DIGEST}`)
    expect(line).toContain(`FILE=${join(box.dir, 'etc/docker-stack.yml')}`)
    expect(box.calls()).toMatch(/docker stack deploy --detach=false .* demo-staging/)
  })

  it('deploy refuses what this key may not do', () => {
    const cases: Array<[string, string]> = [
      ['other image', deploySettings({ NIVARO_IMAGE_REF: `evil/image@${DIGEST}` })],
      ['image by tag', deploySettings({ NIVARO_IMAGE_REF: 'nodeworks/nivaro:0.3.300' })],
      ['host outside', deploySettings({ APP_HOSTS: 'demo.other.com' })],
      ['host suffix trick', deploySettings({ APP_HOSTS: 'xapps.example.com' })],
      ['hostname -. ', deploySettings({ APP_HOSTS: 'a-.apps.example.com' })],
      ['rule injection', deploySettings({ APP_HOSTS: 'a.apps.example.com`) || PathPrefix(`/' })],
      ['network', deploySettings({ PROXY_NETWORK: 'db-net' })],
      ['stack name', deploySettings({ STACK_NAME: 'demo-other' })],
      ['PATH', `${deploySettings()}PATH=/tmp\n`],
      ['LD_PRELOAD', `${deploySettings()}LD_PRELOAD=/tmp/x.so\n`],
      ['duplicate', `${deploySettings()}APP_KEY=other\n`],
      ['missing', deploySettings({}, ['HUB_URL'])],
      [
        'foreign secret',
        deploySettings({ SECRET_DB_URL: secretName('demo-production', 'NIVARO_DB_URL_B64') })
      ],
      ['version latest', deploySettings({ NIVARO_VERSION: 'latest' })],
      ['wait too long', deploySettings({ WAIT_TRIES: '500' })]
    ]
    for (const [what, stdin] of cases) {
      const box = manager()
      seedSecrets(box)
      seedSecrets(box, 'demo-production')
      const r = forced(box, 'deploy demo-staging', stdin)
      expect(r.status, what).not.toBe(0)
      expect(box.calls(), what).not.toContain('stack deploy')
    }
  })

  it('deploy refuses a stack another app owns', () => {
    const box = manager({ services: 'demo-staging_web other/staging\n' })
    seedSecrets(box)
    const r = forced(box, 'deploy demo-staging', deploySettings())
    expect(r.status).not.toBe(0)
    expect(box.calls()).not.toContain('stack deploy')
  })
})

describe('scripts/deploy.sh run (through the real wrapper)', () => {
  function run(
    o: {
      appEnv?: string[]
      pin?: string
      env?: Record<string, string | undefined>
      services?: string
    } = {}
  ) {
    const box = manager({ services: o.services })
    const repo = join(box.dir, 'repo')
    mkdirSync(join(repo, '.hub'), { recursive: true })
    writeFileSync(join(repo, 'deploy.sh'), read('scripts/deploy.sh'))
    writeFileSync(join(repo, '.hub/app.env'), `${(o.appEnv ?? APP_ENV).join('\n')}\n`)
    writeFileSync(join(repo, '.hub/nivaro-version'), o.pin ?? `0.3.300\n${DIGEST}\n`)
    const env: Record<string, string> = {
      PATH: `${box.bin}:${process.env.PATH}`,
      HOME: box.dir,
      CI_COMMIT_REF_NAME: 'staging',
      CI_PROJECT_NAME: 'demo-deploy',
      DEPLOY_HOST: 'deploy@swarm1.example.com',
      DEPLOY_KNOWN_HOSTS: Buffer.from(`${KNOWN}\n`).toString('base64'),
      DEPLOY_SSH_KEY: 'not-a-real-key',
      HUB_HOST_SUFFIX: 'apps.example.com',
      DEPLOY_WAIT_TRIES: '1',
      ...Object.fromEntries(
        Object.entries(SECRETS).map(([k, v]) => [k, Buffer.from(v).toString('base64')])
      )
    }
    for (const [k, v] of Object.entries(o.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const r = spawnSync('sh', ['deploy.sh'], { cwd: repo, env, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: box.calls(), box }
  }

  it('deploys: pinned host key, verbs only, immutable secrets, the pinned image', () => {
    const r = run()
    expect(r.out).toContain('done: web answers 0.3.300')
    expect(r.status).toBe(0)
    const ssh = r.calls.split('\n').filter((l) => l.startsWith('ssh '))
    expect(ssh.length).toBe(7) // stack-owner, five secrets, deploy
    for (const l of ssh) {
      expect(l).toContain('-F /dev/null')
      expect(l).toContain('StrictHostKeyChecking=yes')
      expect(l).toMatch(
        / -- ssh:\/\/deploy@swarm1\.example\.com (stack-owner|secret-create|deploy) /
      )
      expect(l).not.toMatch(/ -L | -M |DOCKER_HOST/)
    }
    expect(r.calls).toContain(`known_hosts=${KNOWN}|`)
    for (const k of Object.keys(SECRETS)) {
      const name = secretName('demo-staging', k)
      expect(readFileSync(join(r.box.state, 'secrets', name), 'utf8')).toBe(SECRETS[k])
    }
    expect(r.calls).toContain('RULE=Host(`demo--staging.apps.example.com`) TLS=true')
    expect(r.calls).toContain(`IMAGE=nodeworks/nivaro@${DIGEST}`)
    const argv = r.calls
      .split('\n')
      .filter((l) => l.startsWith('ssh ') || l.startsWith('docker '))
      .join('\n')
    for (const v of Object.values(SECRETS)) {
      expect(argv).not.toContain(v)
      expect(r.out).not.toContain(v)
      expect(r.out).not.toContain(Buffer.from(v).toString('base64'))
      expect(r.out).not.toContain(sha8(v))
    }
  })

  const refusedBeforeSsh = (r: { status: number | null; calls: string }) => {
    expect(r.status).not.toBe(0)
    expect(r.calls).not.toMatch(/^ssh /m)
    expect(r.calls).not.toMatch(/^docker /m)
  }

  it('refuses without DEPLOY_KNOWN_HOSTS (no trust on first use)', () => {
    for (const v of [undefined, '']) {
      const r = run({ env: { DEPLOY_KNOWN_HOSTS: v } })
      refusedBeforeSsh(r)
      expect(r.out).toContain('DEPLOY_KNOWN_HOSTS is not set')
    }
  })

  it('refuses a pin without a digest, latest and a missing pin', () => {
    const r = run({ pin: '0.3.300\n' })
    refusedBeforeSsh(r)
    expect(r.out).toContain('line 2 must be the image digest')
    refusedBeforeSsh(run({ pin: `latest\n${DIGEST}\n` }))
    refusedBeforeSsh(run({ pin: '' }))
    refusedBeforeSsh(run({ pin: '0.3.300\nsha256:xyz\n' }))
  })

  it('refuses outside the GitLab job, another branch or another repository', () => {
    const a = run({ env: { CI_COMMIT_REF_NAME: undefined } })
    refusedBeforeSsh(a)
    expect(a.out).toContain('CI_COMMIT_REF_NAME is not set')
    const b = run({ env: { CI_COMMIT_REF_NAME: 'production' } })
    refusedBeforeSsh(b)
    expect(b.out).toContain('does not match branch')
    const c = run({ env: { CI_PROJECT_NAME: 'other-deploy' } })
    refusedBeforeSsh(c)
    expect(c.out).toContain('not demo-deploy')
  })

  it('refuses a stack name that is not <app>-<env>', () => {
    const appEnv = APP_ENV.map((l) =>
      l.startsWith('STACK_NAME=') ? 'STACK_NAME=demo-production' : l
    )
    refusedBeforeSsh(run({ appEnv }))
  })

  it('refuses hosts outside HUB_HOST_SUFFIX and labels with .- or -.', () => {
    for (const h of [
      'demo.other.com',
      'xapps.example.com',
      'a-.apps.example.com',
      'a.-b.apps.example.com',
      'a.apps.example.com`) || PathPrefix(`/'
    ]) {
      const appEnv = APP_ENV.map((l) => (l.startsWith('APP_HOSTS=') ? `APP_HOSTS=${h}` : l))
      refusedBeforeSsh(run({ appEnv }))
    }
  })

  it('refuses a key that is not an app setting, before any connection', () => {
    for (const extra of [
      'LD_PRELOAD=/tmp/x.so',
      'NODE_OPTIONS=--require=/tmp/x',
      'DOCKER_HOST=tcp://evil:2375'
    ]) {
      const r = run({ appEnv: [...APP_ENV, extra] })
      refusedBeforeSsh(r)
      expect(r.out).toContain('is not an app setting')
    }
  })

  it('never runs a value as shell', () => {
    const marker = join(tmpdir(), `hub-pwned-${process.pid}`)
    const appEnv = APP_ENV.map((l) =>
      l.startsWith('OIDC_CLIENT_ID=') ? `OIDC_CLIENT_ID=$(touch ${marker})\`touch ${marker}\`` : l
    )
    run({ appEnv })
    expect(existsSync(marker)).toBe(false)
  })

  it('treats DEPLOY_HOST strictly as an ssh destination', () => {
    for (const h of ['-oProxyCommand=touch /tmp/x', 'a b', 'host;id', 'x@y@z', '']) {
      const r = run({ env: { DEPLOY_HOST: h } })
      refusedBeforeSsh(r)
      expect(r.out).toContain('DEPLOY_HOST must be')
    }
    refusedBeforeSsh(run({ env: { DEPLOY_HOST: undefined } }))
  })

  it('stops when the stack belongs to another app', () => {
    const r = run({ services: 'demo-staging_web other/staging\n' })
    expect(r.status).not.toBe(0)
    expect(r.calls).not.toContain('secret-create')
  })

  it('refuses a missing secret variable', () => {
    const r = run({ env: { NIVARO_HUB_TOKEN_B64: '' } })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('NIVARO_HUB_TOKEN_B64 is not set')
    expect(r.calls).not.toMatch(/ deploy demo-staging/)
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
