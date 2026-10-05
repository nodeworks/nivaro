import { describe, expect, it, vi } from 'vitest'
import { registrationMembers } from '../../../extensions/loader.js'
import {
  listTuningObservers,
  unregisterTuningObservers
} from '../../../services/db-tuning/observers/registry.js'

/** Every register… on the context stamps the ledger (#40) and the capability
 *  note — the builder is shared by the self-hosted and cloud context builds,
 *  so this holds for a tenant as well (#812). */
describe('registrationMembers', () => {
  it('stamps the ledger for every registration kind', () => {
    const owned: string[] = []
    const noted: string[] = []
    const cron = { schedule: vi.fn(), unschedule: vi.fn(), annotate: vi.fn() }
    const ctx = {
      app: { cron } as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      database: {} as never
    }
    const m = registrationMembers('t', ctx, {
      note: (c) => noted.push(c),
      own: (kind, label) => owned.push(`${kind}: ${label}`),
      cronPrefix: 'cloud-ext:t:'
    })
    m.bulkActions.register({ id: 'b', label: 'Bulk', execute: async () => ({ message: '' }) })
    m.itemActions.register({ id: 'i', label: 'Item', execute: async () => ({ message: '' }) })
    m.readiness.registerCheck({ id: 'r', label: 'Ready', run: async () => ({ status: 'pass' }) })
    m.integrity.registerCheck({
      id: 'x',
      collection: 'c',
      label: 'X',
      field: 'f',
      run: async () => []
    })
    m.flows.registerTrigger({ type: 'trig', label: 'Trigger' })
    m.digest.registerSection(async function mySection() {
      return null
    })
    m.cron.schedule('nightly', '0 3 * * *', async () => {})
    m.schema.step('watermarks', { description: 'two tables', up: async () => {} })
    m.tuning.registerObserver({ id: 't:hot', kind: 'index_create', observe: async () => [] })
    expect(listTuningObservers()).toContainEqual({ id: 't:hot', owner: 't', kind: 'index_create' })
    unregisterTuningObservers()
    expect(owned).toEqual([
      'bulk_actions: b · Bulk',
      'item_actions: i · Item',
      'readiness_checks: r · Ready',
      'integrity_checks: x · X',
      'flow_triggers: trig · Trigger',
      'digest_sections: mySection',
      'schema_steps: watermarks · two tables',
      'tuning_observers: t:hot · index_create'
    ])
    expect(noted).toEqual([
      'bulk-actions',
      'item-actions',
      'readiness',
      'integrity',
      'flows',
      'digest',
      'cron',
      'schema',
      'tuning'
    ])
    expect(cron.schedule).toHaveBeenCalledWith(
      'cloud-ext:t:nightly',
      '0 3 * * *',
      expect.any(Function),
      {
        extensionId: 't'
      }
    )
  })
})
