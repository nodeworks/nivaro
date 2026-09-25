import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve(import.meta.dirname, 'release-chain.mjs')
const run = (args) =>
  execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: resolve(import.meta.dirname, '..')
  })

test('plan mode without --events prints no @@ lines', () => {
  const out = run([])
  assert.equal(out.includes('@@plan'), false)
  assert.equal(out.includes('@@event'), false)
})

test('plan mode with --events prints exactly one @@plan line with the plan shape', () => {
  const out = run(['--events'])
  const lines = out.split('\n').filter((l) => l.startsWith('@@plan '))
  assert.equal(lines.length, 1)
  const plan = JSON.parse(lines[0].slice('@@plan '.length))
  assert.equal(typeof plan.commits, 'number')
  assert.equal(typeof plan.last_tag, 'string')
  assert.ok(Array.isArray(plan.lines))
  assert.ok(plan.lines.every((l) => typeof l.stage === 'string' && typeof l.text === 'string'))
  assert.equal(typeof plan.versions.app, 'string')
  assert.ok(plan.head_tag === null || plan.head_tag.startsWith('v'))
  assert.ok(Array.isArray(plan.frontends) && plan.frontends.every((n) => typeof n === 'string'))
  assert.ok(Array.isArray(plan.deployments) && plan.deployments.every((n) => typeof n === 'string'))
})
