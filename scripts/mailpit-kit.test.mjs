import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dir = new URL('../deploy/staging/mailpit/', import.meta.url)
const read = (f) => readFileSync(new URL(f, dir), 'utf8')
const compose = read('compose.yml')
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

test('ui-auth-file is configured from a read-only mount', () => {
  assert.match(live(compose), /MP_UI_AUTH_FILE:|--ui-auth-file/)
  assert.match(compose, /mailpit-ui-auth:ro/)
  assert.match(compose, /MP_SMTP_RELAY_CONFIG:/)
  assert.match(compose, /mailpit-relay\.yml:ro/)
})

test('UI port 8025 is published on a variable host address, never 0.0.0.0', () => {
  const ports = [...live(compose).matchAll(/^\s*-\s*"?([^"\n]*:8025(?::8025)?)"?\s*$/gm)].map((m) => m[1])
  assert.ok(ports.length > 0, 'port 8025 must be published')
  for (const p of ports) {
    assert.match(p, /^\$\{MAILPIT_UI_BIND[^}]*\}:8025:8025$/, p)
    assert.doesNotMatch(p, /0\.0\.0\.0/)
  }
  assert.doesNotMatch(live(compose), /0\.0\.0\.0/)
  const published = live(compose).match(/^\s*ports:\n(\s+-.*\n?)+/m)?.[0] ?? ''
  assert.doesNotMatch(published, /1025/, 'SMTP must not be published')
})

test('allowed/blocked recipients exist, as settings not hard-coded in compose', () => {
  assert.match(live(relay), /^allowed-recipients:/m)
  assert.match(live(relay), /^blocked-recipients:/m)
  assert.match(relay, /^# matching:/m)
  assert.match(relay, /allowed-recipients does NOT apply to auto-relay/)
  assert.match(compose, /MP_SMTP_RELAY_ALLOWED_RECIPIENTS: \$\{MAILPIT_ALLOWED_RECIPIENTS/)
  assert.match(compose, /MP_SMTP_RELAY_BLOCKED_RECIPIENTS: \$\{MAILPIT_BLOCKED_RECIPIENTS/)
  assert.match(env, /^MAILPIT_ALLOWED_RECIPIENTS=/m)
  assert.match(env, /^MAILPIT_BLOCKED_RECIPIENTS=/m)
})

test('image is axllent/mailpit with a pinned tag, never latest', () => {
  const m = compose.match(/^\s*image:\s*axllent\/mailpit:(\S+)/m)
  assert.ok(m, 'axllent/mailpit image required')
  assert.notEqual(m[1], 'latest')
  assert.doesNotMatch(m[1], /latest/)
  assert.match(env, /^MAILPIT_VERSION=/m)
})

test('inbound auth is accepted and SMTP env is documented for the API', () => {
  assert.match(compose, /MP_SMTP_AUTH_ACCEPT_ANY: "true"/)
  assert.match(compose, /MP_SMTP_AUTH_ALLOW_INSECURE: "true"/)
  assert.match(env, /SMTP_HOST=mailpit/)
  assert.match(env, /SMTP_PORT=1025/)
  assert.match(env, /SMTP_SECURE=false/)
})
