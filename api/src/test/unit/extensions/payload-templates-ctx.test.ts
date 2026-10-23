import { beforeEach, describe, expect, it, vi } from 'vitest'

// ctx.payloadTemplates on the extension register context: register validates
// (through the service) before the ledger is stamped, render hands back the
// published body without the per-field values, hasBodySecret never throws.

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    () => {
      throw new Error('no database in this test')
    },
    { raw: async () => [], schema: { hasTable: async () => false } }
  )
  return { db }
})

vi.mock('../../../services/body-secrets.js', () => ({
  hasBodySecret: vi.fn(async (api: string, name: string) => {
    if (api === 'Broken') throw new Error('config unreadable')
    return api === 'MWF' && name === 'token'
  })
}))

const svc = vi.hoisted(() => ({
  register: vi.fn(async (_owner: string, def: { key?: string }) => {
    if (!def.key || !/^[a-z0-9-]+$/.test(def.key)) throw new Error('key must be lowercase')
  }),
  render: vi.fn(async () => ({
    body: { a: 1 },
    problems: [],
    values: { f1: 1 },
    version: 4
  }))
}))
vi.mock('../../../services/payload-templates/index.js', () => ({
  registerPayloadTemplate: svc.register,
  renderPayloadTemplate: svc.render
}))

import { registrationMembers } from '../../../extensions/loader.js'

const def = {
  key: 'mwf-ir-order',
  label: 'MWF IR order',
  external_api: 'MWF',
  collection: 'inventory_request',
  default: { mode: 'map' as const, body: '{"v":1,"fields":[]}' }
}

function members() {
  const owned: string[] = []
  const noted: string[] = []
  const ctx = {
    app: { cron: { schedule() {}, unschedule() {}, annotate() {} } } as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    database: {} as never
  }
  const m = registrationMembers('efp-ops', ctx, {
    note: (c) => noted.push(c),
    own: (kind, label) => owned.push(`${kind}: ${label}`),
    cronPrefix: 'ext:efp-ops:'
  })
  return { m, owned, noted }
}

describe('ctx.payloadTemplates', () => {
  beforeEach(() => {
    svc.register.mockClear()
    svc.render.mockClear()
  })

  it('registers under the extension id and stamps the ledger after it validates', async () => {
    const { m, owned, noted } = members()
    await m.payloadTemplates.register(def)
    expect(svc.register).toHaveBeenCalledWith('efp-ops', def)
    expect(owned).toEqual(['payload_templates: mwf-ir-order · MWF IR order'])
    expect(noted).toEqual(['payload-templates'])
  })

  it('rejects an invalid definition and notes or stamps nothing', async () => {
    const { m, owned, noted } = members()
    await expect(m.payloadTemplates.register({ ...def, key: 'Bad Key' })).rejects.toThrow(
      /lowercase/
    )
    expect(owned).toEqual([])
    expect(noted).toEqual([])
  })

  it('renders the published version: body, problems and version only', async () => {
    const { m } = members()
    const r = await m.payloadTemplates.render('mwf-ir-order', { record: { id: 1 } })
    expect(svc.render).toHaveBeenCalledWith('mwf-ir-order', { record: { id: 1 } })
    expect(r).toEqual({ body: { a: 1 }, problems: [], version: 4 })
  })

  it('answers hasBodySecret from the API config, false (never throws) when it cannot tell', async () => {
    const { m } = members()
    await expect(m.payloadTemplates.hasBodySecret('MWF', 'token')).resolves.toBe(true)
    await expect(m.payloadTemplates.hasBodySecret('MWF', 'other')).resolves.toBe(false)
    await expect(m.payloadTemplates.hasBodySecret('Broken', 'token')).resolves.toBe(false)
  })
})
