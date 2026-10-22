// #2855 — every shipped preset against the real fault catalog: the fault and its claims exist,
// the params pass the fault's schema and the caps unchanged, the window is a safe first run,
// the hypothesis names registered samplers, and every claim a fault declares has a preset.
import { describe, expect, it } from 'vitest'
import { applyCaps } from './caps.js'
import { type FaultTarget, getFault, listFaults, validateParams } from './catalog.js'
import './faults/index.js'
import { validateSpec } from './presets.js'
import { SHIPPED_PRESETS } from './presets-shipped.js'
import { CHAOS_NODE } from './registry.js'
import { NO_CAPS } from './settings.js'
import { listSamplers, registerBuiltInSamplers } from './steady-state.js'

/** Faults that only run inside a game day or need a host runbook: no preset by design. */
const NO_PRESET = new Set(['kill_web_task'])

registerBuiltInSamplers()

describe('shipped presets (#2855)', () => {
  it('have stable, unique kebab-case keys', () => {
    const keys = SHIPPED_PRESETS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/)
  })

  for (const p of SHIPPED_PRESETS) {
    it(`${p.key}: names a catalog fault and its claims, and stays a safe first run`, () => {
      const def = getFault(p.spec.fault_key)
      expect(def, `fault ${p.spec.fault_key}`).toBeTruthy()
      if (!def) return
      expect(NO_PRESET.has(def.key)).toBe(false)
      expect(p.claim_keys.length).toBeGreaterThan(0)
      for (const c of p.claim_keys) expect(def.claim_keys, `claim ${c}`).toContain(c)

      // No target = the fault's first kind; a replica-only fault runs on one replica.
      const target: FaultTarget =
        p.spec.target ??
        (def.targets[0] === 'node' ? { kind: 'node', node: CHAOS_NODE } : { kind: 'all' })
      if (!p.spec.target) expect(def.targets[0]).toBe('node')
      expect(def.targets).toContain(target.kind)
      if (target.kind === 'share') expect(target.share_pct).toBeLessThanOrEqual(25)

      // Every param spelled out, each one already inside the fault's own range.
      expect(Object.keys(p.spec.params ?? {}).sort()).toEqual(Object.keys(def.params).sort())
      expect(validateParams(def, p.spec.params)).toEqual(p.spec.params)
      const capped = applyCaps(
        def,
        { target, params: p.spec.params, seconds: p.spec.seconds },
        NO_CAPS
      )
      expect(capped.applied).toEqual([])
      expect(capped.params).toEqual(p.spec.params)
      expect(capped.seconds).toBe(p.spec.seconds)
      expect(p.spec.seconds).toBeGreaterThanOrEqual(5)
      expect(p.spec.seconds).toBeLessThanOrEqual(Math.min(120, def.max_seconds))

      // The hypothesis names samplers the watcher has.
      const samplers = new Set(listSamplers().map((s) => s.key))
      expect(p.spec.hypothesis?.length).toBeGreaterThan(0)
      for (const r of p.spec.hypothesis ?? []) expect(samplers, r.sampler).toContain(r.sampler)

      // A saved copy (customising it) passes the preset validator unchanged.
      if (p.spec.target) expect(validateSpec(p.spec)).toEqual(p.spec)
    })
  }

  it('cover every claim a registered fault declares', () => {
    const covered = new Set(SHIPPED_PRESETS.flatMap((p) => p.claim_keys))
    const missing = listFaults()
      .filter((f) => !NO_PRESET.has(f.key))
      .flatMap((f) => f.claim_keys)
      .filter((c) => !covered.has(c))
    expect([...new Set(missing)]).toEqual([])
  })
})
