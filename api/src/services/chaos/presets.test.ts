import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetCatalogForTests, registerFault } from './catalog.js'
import {
  _setPresetStoreForTests,
  deletePreset,
  getPreset,
  listPresets,
  presetStoreMode,
  savePreset,
  updatePreset,
  validateSpec
} from './presets.js'
import { SHIPPED_PRESETS } from './presets-shipped.js'

const by = { id: '11111111-1111-1111-1111-111111111111' }

function demoFault() {
  registerFault({
    key: 'slow_requests',
    label: 'Slow requests',
    proves: 'x',
    claim_keys: ['http.slow_honest'],
    targets: ['all', 'route', 'share'],
    params: { delay_ms: { type: 'number', label: 'Delay', min: 100, max: 5000, default: 1500 } },
    max_seconds: 300,
    points: ['http.request']
  })
}

beforeEach(() => {
  _resetCatalogForTests()
  _setPresetStoreForTests('memory')
  demoFault()
})
afterEach(() => {
  _resetCatalogForTests()
  _setPresetStoreForTests(null)
})

describe('fault presets (#2855)', () => {
  it('lists every shipped preset with a claim and a fault, without the table', async () => {
    expect(await presetStoreMode()).toBe('memory')
    const list = await listPresets()
    expect(list.map((p) => p.key)).toEqual(SHIPPED_PRESETS.map((p) => p.key))
    for (const p of list) {
      expect(p.source).toBe('shipped')
      expect(p.claim_keys.length).toBeGreaterThan(0)
      expect(p.spec.fault_key).toMatch(/^[a-z]/)
      expect(p.proves).toBeTruthy()
    }
    expect(new Set(list.map((p) => p.key)).size).toBe(list.length)
  })

  it('degrades without the 497 table and without Redis: shipped list, saves in memory', async () => {
    _setPresetStoreForTests(null) // the test db has no schema: the table probe fails closed
    expect(await presetStoreMode()).toBe('memory')
    await savePreset({ key: 'tmp-one', label: 'Tmp', spec: { fault_key: 'slow_requests' } }, by)
    const keys = (await listPresets()).map((p) => p.key)
    expect(keys).toContain('tmp-one')
    expect(keys).toContain(SHIPPED_PRESETS[0].key)
  })

  it('saves a new preset with the catalog caps applied', async () => {
    const p = await savePreset(
      {
        key: 'my-slow',
        label: 'My slow',
        claim_keys: ['http.slow_honest', 'BAD KEY'],
        spec: {
          fault_key: 'slow_requests',
          target: { kind: 'route', pattern: '/api/items/*' },
          params: { delay_ms: 99_999 },
          seconds: 9999,
          hypothesis: [{ sampler: 'http.5xx_pct', op: '<', limit: 1 }]
        }
      },
      by,
      { mustBeNew: true }
    )
    expect(p.source).toBe('saved')
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.claim_keys).toEqual(['http.slow_honest'])
    expect(p.spec.params).toEqual({ delay_ms: 5000 })
    expect(p.spec.seconds).toBe(300)
    expect((await getPreset('my-slow'))?.label).toBe('My slow')
    expect((await getPreset(p.id as string))?.key).toBe('my-slow')
    await expect(
      savePreset({ key: 'my-slow', label: 'again', spec: p.spec }, by, { mustBeNew: true })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('refuses bad keys, a missing label, a bad target and a bad hypothesis line', async () => {
    const spec = { fault_key: 'slow_requests' }
    await expect(savePreset({ key: 'X', label: 'x', spec }, by)).rejects.toMatchObject({
      statusCode: 400
    })
    await expect(savePreset({ key: 'ok-key', spec }, by)).rejects.toThrow(/label/)
    await expect(
      savePreset(
        { key: 'ok-key', label: 'x', spec: { ...spec, target: { kind: 'user', user_id: 'x' } } },
        by
      )
    ).rejects.toThrow(/cannot target/)
    expect(() =>
      validateSpec({ ...spec, hypothesis: [{ sampler: 'bad sampler!', op: '<', limit: 1 }] })
    ).toThrow(/hypothesis/)
  })

  it('keeps a spec for a fault this instance does not have, as written', () => {
    const s = validateSpec({
      fault_key: 'db_latency',
      target: { kind: 'table', table: 'orders' },
      params: { delay_ms: 200, nested: { no: 1 } },
      seconds: 30
    })
    expect(s).toEqual({
      fault_key: 'db_latency',
      target: { kind: 'table', table: 'orders' },
      params: { delay_ms: 200 },
      seconds: 30
    })
  })

  it('editing a shipped preset makes a saved override; deleting it restores the shipped one', async () => {
    const key = SHIPPED_PRESETS[0].key
    const edited = await updatePreset(key, { label: 'Ours' }, by)
    expect(edited).toMatchObject({ key, label: 'Ours', source: 'saved', overrides_shipped: true })
    expect((await listPresets()).filter((p) => p.key === key)).toHaveLength(1)
    expect((await getPreset(key))?.label).toBe('Ours')
    expect(await deletePreset(key)).toEqual({ deleted: true, restored: true })
    expect((await getPreset(key))?.source).toBe('shipped')
    await expect(deletePreset(key)).rejects.toMatchObject({ statusCode: 400 })
    await expect(deletePreset('nope-nope')).rejects.toMatchObject({ statusCode: 404 })
  })
})
