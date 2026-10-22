import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dir = new URL('../deploy/staging/mailpit/', import.meta.url)
const read = (f) => readFileSync(new URL(f, dir), 'utf8')
const compose = read('stack.yml')
const relay = read('relay.example.yml')
const env = read('.env.example')
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

test('relay.example.yml and .env.example hold placeholders only', () => {
  assert.match(relay, /^password:\s*RELAY_PASSWORD\s*$/m)
  assert.match(relay, /^username:\s*RELAY_USERNAME\s*$/m)
  assert.match(relay, /^host:\s*\S+\.invalid\s*$/m)
  for (const line of live(env).split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && /SECRET|PASSWORD|USER/i.test(m[1])) assert.equal(m[2], '', m[1])
  }
})

test('ui-auth-file and relay config are external Swarm secrets under /run/secrets', () => {
  const c = live(compose)
  assert.match(c, /MP_UI_AUTH_FILE: \/run\/secrets\//)
  assert.match(c, /MP_SMTP_RELAY_CONFIG: \/run\/secrets\//)
  for (const name of ['mailpit_ui_auth', 'mailpit_relay']) {
    assert.match(c, new RegExp(`^  ${name}:\\n    external: true`, 'm'), name)
  }
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
  const c = live(compose)
  assert.doesNotMatch(c, /^\s*ports:/m, 'no active ports: key (host mode is a commented option)')
  assert.doesNotMatch(c, /0\.0\.0\.0/)
  // a host-mode publish, if someone enables it, must be 8025 only and mode: host
  const commented = compose.match(/^#\s+ports:[\s\S]*?mode: host/m)?.[0] ?? ''
  assert.doesNotMatch(commented, /1025/)
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
  const regex = (key) => new RegExp(relay.match(new RegExp(`^${key}: '(.*)'$`, 'm'))[1])
  const allowed = regex('allowed-recipients')
  const blocked = regex('blocked-recipients')
  assert.match('ana@nivaro.dev', allowed)
  assert.doesNotMatch('ana@evil.example', allowed)
  assert.match('ana@customer-one.example', blocked)
  assert.match('probed-admin-one@nivaro.dev', blocked)
  assert.doesNotMatch('ana@nivaro.dev', blocked)
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
