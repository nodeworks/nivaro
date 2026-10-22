import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// js-yaml is an api dependency; resolve it from there
const yaml = createRequire(new URL('../api/package.json', import.meta.url))('js-yaml')

const dir = new URL('../deploy/staging/mailpit/', import.meta.url)
const read = (f) => readFileSync(new URL(f, dir), 'utf8')
const base = read('stack.yml')
const overlay = read('stack.relay.yml')
const compose = base + '\n' + overlay
const relay = read('relay.example.yml')
const env = read('.env.example')
const stacks = { base: yaml.load(base), overlay: yaml.load(overlay) }
const svc = (st) => st.services.mailpit

// secrets a service attaches (short or long syntax) -> { source, target }
const attached = (st) =>
  (svc(st).secrets ?? []).map((x) => (typeof x === 'string' ? { source: x, target: x } : { source: x.source, target: x.target ?? x.source }))

// structural checks on a parsed stack: the service publishes no port at all. The UI is reached
// through the private reverse proxy; host mode is a commented-out alternative (editing this test on purpose)
const portProblems = (st) => {
  const out = []
  const s = svc(st)
  if (s.network_mode) out.push('network_mode')
  for (const p of s.ports ?? []) out.push(`published port ${typeof p === 'string' ? p : JSON.stringify(p)}`)
  return out
}

const live = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

test('relay-all is not set anywhere', () => {
  for (const s of [live(compose), live(relay), live(env)]) {
    assert.doesNotMatch(s, /relay[-_]all(?![a-z])/i)
  }
})

test('compose carries no relay username/password as flag or literal', () => {
  const c = live(compose)
  assert.doesNotMatch(c, /--smtp-relay-(username|password|secret)/i)
  assert.doesNotMatch(c, /^\s*(command|entrypoint):/m)
  assert.doesNotMatch(c, /MP_SMTP_RELAY_(USERNAME|PASSWORD|SECRET)\s*[:=]/)
})

test('no relay username or password key is written into the stack files', () => {
  assert.doesNotMatch(live(compose), /^\s*(-\s+)?(username|password)\s*:/m)
})

test('relay.example.yml and .env.example hold placeholders only', () => {
  assert.match(relay, /^password:\s*RELAY_PASSWORD\s*$/m)
  assert.match(relay, /^username:\s*RELAY_USERNAME\s*$/m)
  assert.match(relay, /^host:\s*\S+\.invalid\s*$/m)
  for (const line of live(env).split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && /SECRET|PASSWORD|USER/i.test(m[1])) assert.equal(m[2], '', m[1])
  }
})

test('ui-auth-file and relay config are external Swarm secrets mounted under /run/secrets', () => {
  const check = (st, envName) => {
    const path = svc(st).environment[envName]
    assert.match(path, /^\/run\/secrets\/[^/]+$/, envName)
    const target = path.split('/').pop()
    const hit = attached(st).find((x) => x.target === target)
    assert.ok(hit, `${envName}: no service secret with target ${target}`)
    assert.equal(st.secrets?.[hit.source]?.external, true, `${hit.source} must be external: true`)
  }
  check(stacks.base, 'MP_UI_AUTH_FILE')
  check(stacks.overlay, 'MP_SMTP_RELAY_CONFIG')
})

test('stack file uses only stack-deploy keys and the Swarm service rules', () => {
  const c = live(compose)
  assert.doesNotMatch(c, /container_name:|profiles:|depends_on:|env_file:|build:|^\s*restart:/m)
  assert.match(c, /replicas: 1\b/)
  assert.match(c, /constraints:\n\s+- node\./)
  assert.match(c, /restart_policy:/)
  assert.match(c, /^\s*volumes:\n\s+- mailpit-data:\/data/m)
})

test('SMTP 1025 and the UI 8025 are never published through the ingress', () => {
  for (const st of Object.values(stacks)) assert.deepEqual(portProblems(st), [])
  assert.doesNotMatch(live(compose), /0\.0\.0\.0/)
  // a host-mode publish, if someone enables it, must be 8025 only and mode: host
  const commented = compose.match(/^#\s+ports:[\s\S]*?mode: host/m)?.[0] ?? ''
  assert.doesNotMatch(commented, /1025/)
})

test('port check catches any live publish, ingress or host mode, with or without an address (regression)', () => {
  const bad = (txt) => portProblems(yaml.load(txt))
  assert.ok(bad('services:\n  mailpit:\n    "ports": ["8025:8025"]').length)
  assert.ok(bad('services:\n  mailpit:\n    "ports":\n      - {"target": 8025, "published": 8025}').length)
  assert.ok(bad('services:\n  mailpit:\n    ports:\n      - {target: 1025, published: 1025, mode: host}').length)
  assert.ok(bad('services:\n  mailpit:\n    ports:\n      - {target: 8025, published: 8025, mode: host}').length)
  assert.ok(bad('services:\n  mailpit:\n    ports:\n      - {target: 8025, published: 8025, mode: host, host_ip: 10.0.0.5}').length)
  assert.deepEqual(bad('services:\n  mailpit:\n    environment: {}'), [])
})

test('secret check catches a service with no attached secret (regression)', () => {
  const st = yaml.load('services:\n  mailpit:\n    environment: {}\nsecrets:\n  s: {external: true}')
  assert.deepEqual(attached(st), [])
})

test('allowed/blocked recipients exist, as settings not hard-coded in compose', () => {
  assert.match(live(relay), /^allowed-recipients:/m)
  assert.match(live(relay), /^blocked-recipients:/m)
  assert.match(relay, /^# [^\n]*MP_SMTP_RELAY_MATCHING[^\n]*\n# [^\n]*NOT a key in this YAML/m)
  assert.doesNotMatch(live(relay), /^\s*matching:/m)
  assert.match(relay, /allowed-recipients does NOT apply to auto-relay/)
  assert.doesNotMatch(live(compose), /RECIPIENTS|MATCHING/)
})

test('recipient regexes release our domains and block customers and probed admins', () => {
  // Mailpit uses Go regexp: a leading (?i) is the JS "i" flag.
  const regex = (key) => {
    const src = relay.match(new RegExp(`^${key}: '(.*)'$`, 'm'))[1]
    return src.startsWith('(?i)') ? new RegExp(src.slice(4), 'i') : new RegExp(src)
  }
  const allowed = regex('allowed-recipients')
  const blocked = regex('blocked-recipients')
  assert.match('ana@nivaro.dev', allowed)
  assert.doesNotMatch('ana@evil.example', allowed)
  assert.match('ana@customer-one.example', blocked)
  assert.match('probed-admin-one@nivaro.dev', blocked)
  assert.doesNotMatch('ana@nivaro.dev', blocked)
  // case-insensitive: uppercase and mixed-case addresses are still guarded
  assert.match('ANA@CUSTOMER-ONE.EXAMPLE', blocked)
  assert.match('ana@Customer-Two.Example', blocked)
  assert.match('PROBED-ADMIN-ONE@NIVARO.DEV', blocked)
  assert.match('ANA@NIVARO.DEV', allowed)
  assert.doesNotMatch('ANA@NIVARO.DEV', blocked)
  assert.doesNotMatch('ANA@EVIL.EXAMPLE', allowed)
})

test('blocked-recipients also blocks subdomains of customer domains', () => {
  const src = relay.match(/^blocked-recipients: '\(\?i\)(.*)'$/m)[1]
  const blocked = new RegExp(src, 'i')
  assert.match('ana@mail.customer-one.example', blocked)
  assert.match('ANA@EU.CUSTOMER-TWO.EXAMPLE', blocked)
})

test('only MP_SMTP_RELAY_CONFIG is set as an MP_SMTP_RELAY_* env var in the stack file', () => {
  const names = [...live(compose).matchAll(/MP_SMTP_RELAY_\w+/g)].map((m) => m[0])
  assert.ok(names.includes('MP_SMTP_RELAY_CONFIG'))
  assert.deepEqual(names.filter((n) => n !== 'MP_SMTP_RELAY_CONFIG'), [])
})

test('image is axllent/mailpit with a pinned tag, never latest', () => {
  const m = compose.match(/^\s*image:\s*axllent\/mailpit:(\S+)/m)
  assert.ok(m, 'axllent/mailpit image required')
  assert.notEqual(m[1], 'latest')
  assert.doesNotMatch(m[1], /latest/)
  assert.match(m[1], /^(v\d+\.\d+\.\d+|\$\{MAILPIT_VERSION:\?)/, 'a literal semver tag or a required MAILPIT_VERSION')
  assert.match(env, /^MAILPIT_VERSION=/m)
})

test('the pinned Mailpit version in .env.example is never latest', () => {
  const v = env.match(/^MAILPIT_VERSION=(.*)$/m)[1]
  assert.doesNotMatch(v, /latest/i)
})

test('inbound auth is accepted and SMTP env is documented for the API', () => {
  assert.match(compose, /MP_SMTP_AUTH_ACCEPT_ANY: "true"/)
  assert.match(compose, /MP_SMTP_AUTH_ALLOW_INSECURE: "true"/)
  assert.match(env, /SMTP_HOST=mailpit/)
  assert.match(env, /SMTP_PORT=1025/)
  assert.match(env, /SMTP_SECURE=false/)
})

test('relaying is optional: stack.yml alone has no relay config or secret', () => {
  const b = live(base)
  assert.doesNotMatch(b, /mailpit_relay|MP_SMTP_RELAY|MAILPIT_RELAY_SECRET/)
  assert.match(live(overlay), /MP_SMTP_RELAY_CONFIG: \/run\/secrets\//)
})
