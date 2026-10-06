import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'
import { describe, expect, it } from 'vitest'
import { hostRunRefusal } from '../../../services/runbook-admission.js'
import type { RunbookSummary } from '../../../services/runbook-runs.js'

const decl = {
  key: 'staging-rebuild',
  label: 'Rebuild',
  runs_on: 'host',
  command: ['bash', 'x.sh', 'staging'],
  dry_args: ['--dry'],
  go_args: [],
  resume_flag: '--from',
  target_env: 'TARGET',
  refuse_targets: ['EFP', 'EFP_Development'],
  phases: [
    { key: 'refresh', label: 'Clone' },
    { key: 'convert', label: 'Convert' }
  ]
} as unknown as ExtensionRunbookDecl

const now = Date.parse('2026-10-06T22:00:00Z')
const run = (over: Record<string, unknown> = {}) => ({
  extension: 'efp-ops',
  runbook: 'staging-rebuild',
  mode: 'dry',
  target: 'EFP_Staging',
  from_step: null,
  ...over
})
const dryDone = {
  extension: 'efp-ops',
  runbook: 'staging-rebuild',
  mode: 'dry',
  target: 'EFP_Staging',
  state: 'done',
  started_at: '2026-10-06T20:00:00Z',
  finished_at: '2026-10-06T21:00:00Z'
} as unknown as RunbookSummary

describe('hostRunRefusal', () => {
  it('admits a dry run on an allowed target', () => {
    expect(hostRunRefusal(decl, run(), [], now)).toBeNull()
  })
  it('refuses a refused target in any case', () => {
    expect(hostRunRefusal(decl, run({ target: 'efp' }), [], now)).toMatch(/refused/)
    expect(hostRunRefusal(decl, run({ target: 'EFP_Development' }), [], now)).toMatch(/refused/)
  })
  it('refuses a missing or malformed target', () => {
    expect(hostRunRefusal(decl, run({ target: null }), [], now)).not.toBeNull()
    expect(hostRunRefusal(decl, run({ target: 'X; rm -rf /' }), [], now)).not.toBeNull()
  })
  it('accepts only declared start steps', () => {
    expect(hostRunRefusal(decl, run({ from_step: 'convert' }), [], now)).toBeNull()
    expect(hostRunRefusal(decl, run({ from_step: '2' }), [], now)).toBeNull()
    expect(hostRunRefusal(decl, run({ from_step: '3' }), [], now)).toMatch(/unknown start step/)
    expect(hostRunRefusal(decl, run({ from_step: '--execute' }), [], now)).toMatch(/unknown/)
  })
  it('requires a fresh finished dry run for a real run', () => {
    expect(hostRunRefusal(decl, run({ mode: 'go' }), [], now)).toMatch(/dry run/)
    expect(hostRunRefusal(decl, run({ mode: 'go' }), [dryDone], now)).toBeNull()
    const stale = now + 25 * 3600_000
    expect(hostRunRefusal(decl, run({ mode: 'go' }), [dryDone], stale)).toMatch(/dry run/)
  })
  it('skips the dry-run gate only when the declaration says so', () => {
    expect(hostRunRefusal(decl, run({ mode: 'go' }), [], now)).toMatch(/dry run/)
    const skip = { ...decl, skip_dry_gate: true } as ExtensionRunbookDecl
    expect(hostRunRefusal(skip, run({ mode: 'go' }), [], now)).toBeNull()
    // the other gates still hold
    expect(hostRunRefusal(skip, run({ mode: 'go', target: 'EFP' }), [], now)).toMatch(/refused/)
  })
  it('refuses an unknown mode', () => {
    expect(hostRunRefusal(decl, run({ mode: 'exec' }), [], now)).toMatch(/mode/)
  })
})
