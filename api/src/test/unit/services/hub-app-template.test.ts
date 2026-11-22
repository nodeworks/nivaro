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
  renderAppCi,
  stackName
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

  it('every script parses as POSIX sh (sh -n, and dash -n where dash is installed)', () => {
    const hasDash = spawnSync('sh', ['-c', 'command -v dash']).status === 0
    for (const f of SCRIPTS) {
      expect(() => execFileSync('sh', ['-n', join(ROOT, f)]), f).not.toThrow()
      if (hasDash) expect(() => execFileSync('dash', ['-n', join(ROOT, f)]), f).not.toThrow()
    }
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
const STACK = 'demo--staging'
const KEYID = 'SHA256:TestKeyFingerprint0123456789abcdefABCDEF+/x'
const OTHER_KEYID = 'SHA256:SomeoneElsesKeyFingerprint0123456789'
/** What the wrapper binds stacks and secrets to: <app key line name>:<keyid>. */
const BIND = `demo:${KEYID}`
const OTHER_BIND = `demo:${OTHER_KEYID}`
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
  `STACK_NAME=${STACK}`,
  'TRUST_PROXY=1'
]
const DIGEST = `sha256:${'c'.repeat(64)}`
const KNOWN = `swarm1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`
const KEY_CONF = [
  `stack=${STACK}`,
  'stack=demo--production',
  'host=demo--staging.apps.example.com',
  'host=demo.apps.example.com',
  'network=proxy',
  'image=nodeworks/nivaro',
  ''
].join('\n')
const shim = (tool: string, alt: string) =>
  spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0 ? `exec ${alt} "$@"` : null
const SHIMS: Record<string, string | null> = {
  sha256sum: shim('sha256sum', 'shasum -a 256'),
  sha1sum: shim('sha1sum', 'shasum -a 1')
}

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface Box {
  dir: string
  bin: string
  log: string
  state: string
  etc: string
  wrapper: string
  calls: () => string
}

/**
 * A manager in a temp dir: the real wrapper (ROOT/PATH patched), key configuration `demo`, and
 * a fake docker. `services` lines: name|stack|key label|hosts label. `secrets`: name → labels.
 */
function manager(
  o: {
    conf?: string
    services?: string[]
    secrets?: Record<string, string>
    stackFile?: string
  } = {}
): Box {
  const dir = mkdtempSync(join(tmpdir(), 'hub-tpl-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  const log = join(dir, 'calls.log')
  const state = join(dir, 'state')
  const etc = join(dir, 'etc')
  for (const d of [bin, join(state, 'secrets'), join(etc, 'keys')])
    mkdirSync(d, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(join(etc, 'docker-stack.yml'), o.stackFile ?? read('manager/docker-stack.yml'))
  writeFileSync(join(etc, 'keys/demo.conf'), o.conf ?? KEY_CONF)
  writeFileSync(join(state, 'services'), (o.services ?? []).map((l) => `${l}\n`).join(''))
  for (const [name, labels] of Object.entries(o.secrets ?? {})) {
    writeFileSync(join(state, 'secrets', name), 'x')
    writeFileSync(join(state, 'secrets', `${name}.labels`), labels)
  }
  const original = read('manager/nivaro-hub-deploy')
  const patched = original
    .replace(/^ROOT=\/etc\/nivaro-hub-deploy$/m, `ROOT='${etc}'`)
    .replace(/^PATH=.*$/m, `PATH='${bin}':"$PATH"`)
  expect(patched).toContain(`ROOT='${etc}'`)
  expect(patched).toContain(`PATH='${bin}'`)
  const wrapper = join(dir, 'nivaro-hub-deploy')
  writeFileSync(wrapper, patched)
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf 'docker %s\\n' "$*" >> '${log}'
S='${state}'
last=''; prev=''; prev2=''; pa=''; filter=''; fmt=''; ls=''; lk=''
for a; do
  case "$pa" in
    --filter) filter=$a ;;
    --format) fmt=$a ;;
    --label) case "$a" in nivaro.hub.stack=*) ls=\${a#*=} ;; nivaro.hub.key=*) lk=\${a#*=} ;; esac ;;
  esac
  pa=$a; prev2=$prev; prev=$a; last=$a
done
case "$1 $2" in
  "service ls")
    case "$filter" in
      label=com.docker.stack.namespace=*) awk -F'|' -v w="\${filter#label=com.docker.stack.namespace=}" '$2==w{print $1}' "$S/services" ;;
      label=nivaro.hub.hosts) awk -F'|' '$4!=""{print $1}' "$S/services" ;;
    esac
    exit 0 ;;
  "service inspect")
    case "$fmt" in
      *namespace*) awk -F'|' -v n="$last" '$1==n{print $2" "$4}' "$S/services" ;;
      *) awk -F'|' -v n="$last" '$1==n{print $3}' "$S/services" ;;
    esac
    exit 0 ;;
  "secret inspect") [ -f "$S/secrets/$last.labels" ] || exit 1; cat "$S/secrets/$last.labels"; echo; exit 0 ;;
  "secret create") cat > "$S/secrets/$prev2"; printf '%s %s' "$ls" "$lk" > "$S/secrets/$prev2.labels"; exit 0 ;;
  "network inspect") [ "$last" = proxy ]; exit $? ;;
  "stack deploy") printf 'deployed RULE=%s TLS=%s EP=%s IMAGE=%s DB=%s KEY=%s FILE=%s STACK=%s\\n' "$TRAEFIK_RULE" "$TRAEFIK_TLS" "$TRAEFIK_ENTRYPOINT" "$NIVARO_IMAGE_REF" "$SECRET_DB_URL" "$NIVARO_HUB_KEY" "$prev2" "$last" >> '${log}'; exit 0 ;;
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
case "\${FAKE_SSH_FAIL:-}" in
  deny) echo 'deploy@swarm1.example.com: Permission denied (publickey).' >&2; exit 255 ;;
  hostkey) echo 'Host key verification failed.' >&2; exit 255 ;;
esac
prev=''
for a; do
  if [ "$prev" = -o ]; then case "$a" in UserKnownHostsFile=*) kh=\${a#UserKnownHostsFile=} ;; esac; fi
  prev=$a
done
[ -n "\${kh:-}" ] && { printf 'known_hosts='; tr '\\n' '|' < "$kh"; printf '\\n'; } >> '${log}'
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
shift 2
SSH_ORIGINAL_COMMAND="$*" exec sh '${wrapper}' demo 'keyid=${KEYID}'
`
  )
  writeFileSync(
    join(bin, 'ssh-keygen'),
    '#!/bin/sh\ncat > /dev/null\nprintf "256 %s nivaro-hub (ED25519)\\n" "$FAKE_FP"\n'
  )
  for (const [tool, body] of Object.entries(SHIMS))
    if (body) writeFileSync(join(bin, tool), `#!/bin/sh\n${body}\n`)
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755)
  return { dir, bin, log, state, etc, wrapper, calls: () => readFileSync(log, 'utf8') }
}

/** Run the wrapper as sshd would: forced command, SSH_ORIGINAL_COMMAND, stdin. */
function forced(
  box: Box,
  command: string,
  stdin = '',
  args: string[] = ['demo', `keyid=${KEYID}`],
  extraEnv: Record<string, string> = {}
) {
  const r = spawnSync('sh', [box.wrapper, ...args], {
    env: {
      PATH: `${box.bin}:${process.env.PATH}`,
      HOME: box.dir,
      SSH_ORIGINAL_COMMAND: command,
      ...extraEnv
    },
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
  kv.set('TEMPLATE_MAJOR', '1')
  for (const k of Object.keys(SECRETS))
    kv.set(`SECRET_${HUB_SECRET_FILES[k].secret.toUpperCase()}`, secretName(STACK, k))
  kv.set('WAIT_TRIES', '1')
  for (const [k, v] of Object.entries(over)) kv.set(k, v)
  for (const k of drop) kv.delete(k)
  return `${[...kv].map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

/** This stack's five secrets, made by `keyid`. */
const ownSecrets = (stack = STACK, bind = BIND): Record<string, string> =>
  Object.fromEntries(Object.keys(SECRETS).map((k) => [secretName(stack, k), `${stack} ${bind}`]))

describe('manager/nivaro-hub-deploy (forced command)', () => {
  it('the authorized_keys template binds one app key to the wrapper with its keyid', () => {
    const line = code(read('manager/authorized_keys.example')).trim()
    expect(line).toMatch(
      /^command="\/usr\/local\/bin\/nivaro-hub-deploy [a-z0-9_-]+ keyid=[^"\s]+",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict ssh-/
    )
  })

  it('runs under a fixed PATH and LC_ALL=C', () => {
    const w = code(read('manager/nivaro-hub-deploy'))
    expect(w).toMatch(/^PATH=\/usr\/local\/sbin:/m)
    expect(w).toMatch(/^LC_ALL=C\nexport LC_ALL$/m)
    expect(w).not.toMatch(/prefix=/)
  })

  it('the stack file major is the deploy job major', () => {
    const stackMajor = read('manager/docker-stack.yml').match(/^# nivaro-hub-stack-major: (\d+)$/m)
    const jobMajor = read('scripts/deploy.sh').match(/^HUB_TEMPLATE_MAJOR=(\d+)$/m)
    expect(stackMajor?.[1]).toBeTruthy()
    expect(stackMajor?.[1]).toBe(jobMajor?.[1])
  })

  it('refuses every other command and any shell metacharacter, before docker runs', () => {
    const box = manager()
    for (const cmd of [
      '',
      'ls',
      'sh',
      'deploy',
      `deploy ${STACK} extra`,
      `deploy ${STACK}; rm -rf /`,
      'deploy $(id)',
      'deploy `id`',
      `deploy ${STACK}|id`,
      `deploy ${STACK} && id`,
      `deploy ${STACK}\nid`,
      'stack-owner ../etc',
      `stack-owner ${STACK} > /tmp/x`,
      `DEPLOY ${STACK}`,
      'docker ps',
      `secret-rm ${STACK}_db_url_12345678`,
      'stack-owner demo_staging',
      `stack-owner ${'d'.repeat(41)}`
    ]) {
      const r = forced(box, cmd)
      expect(r.status, JSON.stringify(cmd)).not.toBe(0)
    }
    expect(dockerCalls(box)).toEqual([])
  })

  it('a key with stack=X refuses stack Y (exact names, no prefixes)', () => {
    const box = manager()
    for (const cmd of [
      'stack-owner other--staging',
      'deploy demo--qa',
      'stack-owner demo-x--staging', // app demo-x is not app demo
      'stack-owner demo--staging-x',
      'stack-owner demo',
      `secret-create demo-x--staging_db_url_${sha8(SECRETS.NIVARO_DB_URL_B64)}`
    ]) {
      expect(forced(box, cmd, SECRETS.NIVARO_DB_URL_B64).status, cmd).not.toBe(0)
    }
    expect(dockerCalls(box)).toEqual([])
    expect(forced(box, `stack-owner ${STACK}`)).toEqual({ status: 0, out: 'free\n' })
    expect(forced(box, 'stack-owner demo--production')).toEqual({ status: 0, out: 'free\n' })
  })

  it('refuses a bad key line: missing or malformed keyid, bad name, unknown key', () => {
    const box = manager()
    for (const args of [
      ['demo'],
      ['demo', 'SHA256:abc'],
      ['demo', 'keyid='],
      ['demo', 'keyid=short'],
      ['demo', 'keyid=bad id'],
      ['demo', `keyid=${KEYID}`, 'more'],
      ['../x', `keyid=${KEYID}`],
      ['nokey', `keyid=${KEYID}`],
      []
    ]) {
      expect(forced(box, `stack-owner ${STACK}`, '', args).status, args.join(' ')).not.toBe(0)
    }
    expect(dockerCalls(box)).toEqual([])
  })

  it('not installed or not bound: one marker line, exit 77; other refusals exit 2', () => {
    const none = manager()
    rmSync(join(none.etc, 'keys/demo.conf'))
    for (const r of [
      forced(none, `stack-owner ${STACK}`),
      forced(manager(), 'stack-owner demo--qa'),
      forced(
        manager({
          services: [`${STACK}_web|${STACK}|${OTHER_BIND}|demo--staging.apps.example.com`]
        }),
        `stack-owner ${STACK}`
      )
    ]) {
      expect(r.status).toBe(77)
      expect(r.out.split('\n').filter((l) => l === 'NIVARO_HUB_KEY_NOT_INSTALLED')).toHaveLength(1)
    }
    const other = forced(manager(), 'docker ps')
    expect(other.status).toBe(2)
    expect(other.out).not.toContain('NIVARO_HUB_KEY_NOT_INSTALLED')
  })

  it('a configuration still using prefix= is refused', () => {
    const box = manager({ conf: 'prefix=demo-\nhost=apps.example.com\n' })
    expect(forced(box, `stack-owner ${STACK}`).status).not.toBe(0)
  })

  it('stack-owner: "mine" when bound to this key; another key, or none, is refused', () => {
    const mine = manager({
      services: [`${STACK}_web|${STACK}|${BIND}|demo--staging.apps.example.com`]
    })
    expect(forced(mine, `stack-owner ${STACK}`)).toEqual({ status: 0, out: 'mine\n' })
    for (const key of [OTHER_BIND, `other:${KEYID}`, KEYID, '']) {
      const other = manager({
        services: [`${STACK}_web|${STACK}|${key}|demo--staging.apps.example.com`]
      })
      const r = forced(other, `stack-owner ${STACK}`)
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('bound to another deploy key')
    }
  })

  it('secret-create: only the five names, the hash must match the value, created once', () => {
    const box = manager()
    const k = 'NIVARO_DB_URL_B64'
    const name = secretName(STACK, k)
    for (const [cmd, stdin] of [
      [`secret-create ${STACK}_password_${sha8(SECRETS[k])}`, SECRETS[k]],
      [`secret-create ${STACK}_db_url_${sha8('other')}`, SECRETS[k]],
      [`secret-create ${STACK}_db_url_ZZZZZZZZ`, SECRETS[k]],
      [`secret-create other--staging_db_url_${sha8(SECRETS[k])}`, SECRETS[k]],
      [`secret-create ${STACK}_db_url`, SECRETS[k]],
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
    expect(readFileSync(join(box.state, 'secrets', `${name}.labels`), 'utf8')).toBe(
      `${STACK} ${BIND}`
    )
    expect(forced(box, `secret-create ${name}`, SECRETS[k])).toEqual({ status: 0, out: 'exists\n' })
    expect(dockerCalls(box).join('\n')).not.toContain(SECRETS[k])
  })

  it('secret-create: an existing secret of another key or stack is refused', () => {
    const k = 'NIVARO_DB_URL_B64'
    const name = secretName(STACK, k)
    for (const labels of [`${STACK} ${OTHER_BIND}`, `other--staging ${BIND}`, '']) {
      const box = manager({ secrets: { [name]: labels } })
      const r = forced(box, `secret-create ${name}`, SECRETS[k])
      expect(r.status, labels).not.toBe(0)
      expect(r.out).toContain('belongs to another stack or key')
    }
  })

  it('secret-create on a stack bound to another key is refused', () => {
    const box = manager({ services: [`${STACK}_web|${STACK}|${OTHER_BIND}|x.example.com`] })
    const k = 'NIVARO_DB_URL_B64'
    expect(forced(box, `secret-create ${secretName(STACK, k)}`, SECRETS[k]).status).not.toBe(0)
    expect(dockerCalls(box).join('\n')).not.toContain('secret create')
  })

  it("deploy: first deploy binds the stack to this key; the stack file is the manager's", () => {
    const box = manager({ secrets: ownSecrets() })
    const r = forced(box, `deploy ${STACK}`, deploySettings())
    expect(r.out).toContain('web answers 0.3.300')
    expect(r.out).toContain(`deploying ${STACK} (free)`)
    expect(r.status).toBe(0)
    const line =
      box
        .calls()
        .split('\n')
        .find((l) => l.startsWith('deployed ')) ?? ''
    expect(line).toContain('RULE=Host(`demo--staging.apps.example.com`) TLS=true EP=websecure')
    expect(line).toContain(`IMAGE=nodeworks/nivaro@${DIGEST}`)
    expect(line).toContain(`KEY=${BIND}`)
    expect(line).toContain(`FILE=${join(box.etc, 'docker-stack.yml')}`)
    expect(line).toContain(`STACK=${STACK}`)
  })

  it('deploy: a later deploy by the same key is "mine"', () => {
    const box = manager({
      secrets: ownSecrets(),
      services: [`${STACK}_web|${STACK}|${BIND}|demo--staging.apps.example.com`]
    })
    const r = forced(box, `deploy ${STACK}`, deploySettings())
    expect(r.status).toBe(0)
    expect(r.out).toContain(`deploying ${STACK} (mine)`)
  })

  it('deploy: a key mismatch on an existing stack is refused', () => {
    for (const key of [OTHER_BIND, `other:${KEYID}`, KEYID, '']) {
      const box = manager({
        secrets: ownSecrets(),
        services: [`${STACK}_web|${STACK}|${key}|demo--staging.apps.example.com`]
      })
      const r = forced(box, `deploy ${STACK}`, deploySettings())
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('bound to another deploy key')
      expect(box.calls()).not.toContain('stack deploy')
    }
  })

  it('deploy: a host another stack already serves is refused', () => {
    const box = manager({
      secrets: ownSecrets(),
      services: [
        'other--prod_web|other--prod|SHA256:x0123456789|portal.example.org,demo--staging.apps.example.com'
      ]
    })
    const r = forced(box, `deploy ${STACK}`, deploySettings())
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('already served by another stack')
    expect(box.calls()).not.toContain('stack deploy')
  })

  it('deploy: ownership never comes from APP_KEY/ENV_KEY — they must name this stack', () => {
    // app ab / env cd-ef and app ab-cd / env ef are different stacks now
    const conf = 'stack=ab-cd--ef\nhost=x.apps.example.com\n'
    const box = manager({ conf, secrets: ownSecrets('ab-cd--ef') })
    const settings = (app: string, env: string) =>
      deploySettings({
        APP_KEY: app,
        ENV_KEY: env,
        STACK_NAME: 'ab-cd--ef',
        APP_HOSTS: 'x.apps.example.com',
        ...Object.fromEntries(
          Object.keys(SECRETS).map((k) => [
            `SECRET_${HUB_SECRET_FILES[k].secret.toUpperCase()}`,
            secretName('ab-cd--ef', k)
          ])
        )
      })
    const wrong = forced(box, 'deploy ab-cd--ef', settings('ab', 'cd-ef'))
    expect(wrong.status).not.toBe(0)
    expect(wrong.out).toContain('do not name stack')
    expect(forced(box, 'deploy ab-cd--ef', settings('ab-cd', 'ef')).status).toBe(0)
    // a caller claiming the owner's app/env for someone else's stack gets nothing either
    const theirs = manager({
      conf,
      services: ['ab-cd--ef_web|ab-cd--ef|SHA256:theirs0123456|x.apps.example.com']
    })
    expect(forced(theirs, 'deploy ab-cd--ef', settings('ab-cd', 'ef')).status).not.toBe(0)
  })

  it('deploy: template major must match the stack file on the manager', () => {
    const box = manager({ secrets: ownSecrets() })
    const r = forced(box, `deploy ${STACK}`, deploySettings({ TEMPLATE_MAJOR: '2' }))
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('update the stack file on the manager')
    const old = manager({
      secrets: ownSecrets(),
      stackFile: read('manager/docker-stack.yml').replace(/^# nivaro-hub-stack-major: \d+\n/m, '')
    })
    const r2 = forced(old, `deploy ${STACK}`, deploySettings())
    expect(r2.status).not.toBe(0)
    expect(r2.out).toContain('update the stack file on the manager')
    expect(box.calls() + old.calls()).not.toContain('stack deploy')
  })

  it('deploy refuses what this key may not do', () => {
    const cases: Array<[string, string]> = [
      ['other image', deploySettings({ NIVARO_IMAGE_REF: `evil/image@${DIGEST}` })],
      ['image by tag', deploySettings({ NIVARO_IMAGE_REF: 'nodeworks/nivaro:0.3.300' })],
      ['host not in conf', deploySettings({ APP_HOSTS: 'other.apps.example.com' })],
      ['host suffix trick', deploySettings({ APP_HOSTS: 'xdemo.apps.example.com' })],
      ['hostname -. ', deploySettings({ APP_HOSTS: 'a-.apps.example.com' })],
      ['rule injection', deploySettings({ APP_HOSTS: 'demo.apps.example.com`) || PathPrefix(`/' })],
      ['network', deploySettings({ PROXY_NETWORK: 'db-net' })],
      ['stack name', deploySettings({ STACK_NAME: 'demo--production' })],
      ['PATH', `${deploySettings()}PATH=/tmp\n`],
      ['LD_PRELOAD', `${deploySettings()}LD_PRELOAD=/tmp/x.so\n`],
      ['duplicate', `${deploySettings()}APP_KEY=other\n`],
      ['missing', deploySettings({}, ['HUB_URL'])],
      ['no major', deploySettings({}, ['TEMPLATE_MAJOR'])],
      [
        'foreign secret',
        deploySettings({ SECRET_DB_URL: secretName('demo--production', 'NIVARO_DB_URL_B64') })
      ],
      ['version latest', deploySettings({ NIVARO_VERSION: 'latest' })],
      ['wait too long', deploySettings({ WAIT_TRIES: '500' })]
    ]
    for (const [what, stdin] of cases) {
      const box = manager({ secrets: { ...ownSecrets(), ...ownSecrets('demo--production') } })
      const r = forced(box, `deploy ${STACK}`, stdin)
      expect(r.status, what).not.toBe(0)
      expect(box.calls(), what).not.toContain('stack deploy')
    }
  })

  it('deploy refuses secrets made by another key', () => {
    const box = manager({ secrets: ownSecrets(STACK, OTHER_BIND) })
    const r = forced(box, `deploy ${STACK}`, deploySettings())
    expect(r.status).not.toBe(0)
    expect(box.calls()).not.toContain('stack deploy')
  })
})

describe('manager/nivaro-hub-deploy: key identity and rotation', () => {
  it('with ExposeAuthInfo, the signed-in key must be the keyid= one', () => {
    const box = manager()
    const auth = join(box.dir, 'auth-info')
    writeFileSync(auth, `publickey ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}\n`)
    const ok = forced(box, `stack-owner ${STACK}`, '', undefined, {
      SSH_USER_AUTH: auth,
      FAKE_FP: KEYID
    })
    expect(ok).toEqual({ status: 0, out: 'free\n' })
    const bad = forced(box, `stack-owner ${STACK}`, '', undefined, {
      SSH_USER_AUTH: auth,
      FAKE_FP: OTHER_KEYID
    })
    expect(bad.status).not.toBe(0)
    expect(bad.out).toContain('not the keyid=')
    // without the auth info file (ExposeAuthInfo off) the keyid= line alone decides
    expect(
      forced(box, `stack-owner ${STACK}`, '', undefined, { FAKE_FP: OTHER_KEYID }).status
    ).toBe(0)
  })

  it('a stack bound to the same keyid under another key name is refused', () => {
    const box = manager({ services: [`${STACK}_web|${STACK}|other:${KEYID}|x.example.com`] })
    expect(forced(box, `stack-owner ${STACK}`).status).not.toBe(0)
  })

  it('after a rotation (stack relabelled to the new key) the old secrets are accepted', () => {
    const oldBind = `demo:${OTHER_KEYID}`
    const box = manager({
      secrets: ownSecrets(STACK, oldBind),
      services: [`${STACK}_web|${STACK}|${BIND}|demo--staging.apps.example.com`]
    })
    const k = 'NIVARO_DB_URL_B64'
    expect(forced(box, `secret-create ${secretName(STACK, k)}`, SECRETS[k])).toEqual({
      status: 0,
      out: 'exists\n'
    })
    const r = forced(box, `deploy ${STACK}`, deploySettings())
    expect(r.status).toBe(0)
    expect(r.out).toContain(`deploying ${STACK} (mine)`)
  })

  it('the README documents the rotation relabel', () => {
    const readme = read('README.md')
    expect(readme).toContain("## Rotating an app's deploy key")
    expect(readme).toContain("--label-add 'nivaro.hub.key=<app>:<new keyid>'")
  })
})

describe('scripts/deploy.sh run (through the real wrapper)', () => {
  function run(
    o: {
      appEnv?: string[]
      pin?: string
      env?: Record<string, string | undefined>
      services?: string[]
      removeConf?: boolean
    } = {}
  ) {
    const box = manager({ services: o.services })
    if (o.removeConf) rmSync(join(box.etc, 'keys/demo.conf'))
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
      CI_CONFIG_PATH: 'ci/deploy.yml@platform/nivaro-template:v1.4.0',
      DEPLOY_HOST: 'deploy@swarm1.example.com',
      DEPLOY_KNOWN_HOSTS: Buffer.from(`${KNOWN}\n`).toString('base64'),
      DEPLOY_SSH_KEY: Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nnot-real\n').toString(
        'base64'
      ),
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

  it('deploys: pinned host key, verbs only, immutable secrets bound to the key', () => {
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
      const name = secretName(STACK, k)
      expect(readFileSync(join(r.box.state, 'secrets', name), 'utf8')).toBe(SECRETS[k])
      expect(readFileSync(join(r.box.state, 'secrets', `${name}.labels`), 'utf8')).toBe(
        `${STACK} ${BIND}`
      )
    }
    expect(r.calls).toContain('RULE=Host(`demo--staging.apps.example.com`) TLS=true')
    expect(r.calls).toContain(`KEY=${BIND}`)
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

  it('a commit sha ref deploys, whatever digit it starts with', () => {
    for (const sha of [
      '3f2a5b6c7d8e9f00112233445566778899aabbcc',
      '0123456789abcdef0123456789abcdef01234567',
      '1a2b3c4d5e6f708192a3b4c5d6e7f80912345678'
    ]) {
      const r = run({ env: { CI_CONFIG_PATH: `ci/deploy.yml@platform/nivaro-template:${sha}` } })
      expect(r.status, `${sha}: ${r.out}`).toBe(0)
    }
  })

  it('a version tag of another major, a branch, or no ref is refused', () => {
    const tag = run({ env: { CI_CONFIG_PATH: 'ci/deploy.yml@platform/nivaro-template:v2.1.0' } })
    refusedBeforeSsh(tag)
    expect(tag.out).toContain('is major 2 but this deploy job is major 1')
    for (const path of [
      'ci/deploy.yml@platform/nivaro-template:main',
      'ci/deploy.yml@platform/nivaro-template:v1.0-RC1',
      'ci/deploy.yml@platform/nivaro-template:3f2a5b6',
      'ci/deploy.yml@platform/nivaro-template'
    ]) {
      refusedBeforeSsh(run({ env: { CI_CONFIG_PATH: path } }))
    }
    // the fallback include (no ci_config_path) has no ref to read
    expect(run({ env: { CI_CONFIG_PATH: '.gitlab-ci.yml' } }).status).toBe(0)
  })

  it('refuses a template ref of another major (ci_config_path)', () => {
    const r = run({ env: { CI_CONFIG_PATH: 'ci/deploy.yml@platform/nivaro-template:v2.0.0' } })
    refusedBeforeSsh(r)
    expect(r.out).toContain('major 2')
    expect(run({ env: { CI_CONFIG_PATH: 'ci/deploy.yml@platform/t:1.9' } }).status).toBe(0)
    expect(
      run({ env: { CI_CONFIG_PATH: `ci/deploy.yml@platform/t:${'a'.repeat(40)}` } }).status
    ).toBe(0)
  })

  it('requires STACK_NAME to be exactly <app>--<env>', () => {
    for (const name of ['demo-staging', 'demo--production', 'staging--demo']) {
      const appEnv = APP_ENV.map((l) => (l.startsWith('STACK_NAME=') ? `STACK_NAME=${name}` : l))
      const r = run({ appEnv })
      refusedBeforeSsh(r)
      expect(r.out).toContain(`STACK_NAME must be ${STACK}`)
    }
  })

  it('computes the hashed stack name like stackName()', () => {
    const app = `a${'b'.repeat(30)}`
    const stack = stackName(app, 'staging')
    const appEnv = APP_ENV.map((l) =>
      l.startsWith('APP_KEY=')
        ? `APP_KEY=${app}`
        : l.startsWith('STACK_NAME=')
          ? `STACK_NAME=${stack}`
          : l
    )
    // gets past the name check, then the manager refuses (the key has no such stack)
    const r = run({ appEnv, env: { CI_PROJECT_NAME: `${app}-deploy` } })
    expect(r.out).not.toContain('STACK_NAME must be')
    expect(r.calls).toContain(`stack-owner ${stack}`)
    expect(r.status).not.toBe(0)
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

  const markerLines = (out: string) =>
    out.split('\n').filter((l) => l === 'NIVARO_HUB_KEY_NOT_INSTALLED').length

  it('stops with the key marker (77) when the stack is bound to another key', () => {
    const r = run({
      services: [`${STACK}_web|${STACK}|${OTHER_BIND}|demo--staging.apps.example.com`]
    })
    expect(r.status).toBe(77)
    expect(r.out).toContain('bound to another deploy key')
    expect(markerLines(r.out)).toBe(1)
    expect(r.calls).not.toContain('secret-create')
  })

  it('a key sshd does not know (not installed) is the marker and 77', () => {
    const r = run({ env: { FAKE_SSH_FAIL: 'deny' } })
    expect(r.status).toBe(77)
    expect(markerLines(r.out)).toBe(1)
    expect(r.out).toContain('press Installed')
  })

  it('any other connection failure is a plain failure, never the marker', () => {
    const r = run({ env: { FAKE_SSH_FAIL: 'hostkey' } })
    expect(r.status).toBe(1)
    expect(markerLines(r.out)).toBe(0)
    expect(r.out).toContain('refused stack')
  })

  it('a key without its key.conf on the manager is the marker and 77', () => {
    const r = run({ removeConf: true })
    expect(r.status).toBe(77)
    expect(markerLines(r.out)).toBe(1)
  })

  it('refuses a missing secret variable', () => {
    const r = run({ env: { NIVARO_HUB_TOKEN_B64: '' } })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('NIVARO_HUB_TOKEN_B64 is not set')
    expect(r.calls).not.toMatch(/ deploy demo--staging/)
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
