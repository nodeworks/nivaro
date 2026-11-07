import { describe, expect, it } from 'vitest'
import { bellGroupLabel } from './NotificationBell'

describe('bellGroupLabel (army 6 M48: no row ids in bell headers)', () => {
  it('names a record by its collection word and friendly id', () => {
    expect(
      bellGroupLabel({
        collection: 'workflows',
        record_label: 'CR26-81410',
        record_collection_label: 'Workflow',
        kind: 'record'
      })
    ).toBe('Workflow CR26-81410')
    expect(
      bellGroupLabel({
        collection: 'inventory_request',
        record_label: 'CM26INV-37423',
        record_collection_label: 'Inventory request',
        kind: 'record'
      })
    ).toBe('Inventory request CM26INV-37423')
  })

  it('never prints the row id when nothing names the record', () => {
    expect(
      bellGroupLabel({
        collection: 'workflows',
        record_label: null,
        record_collection_label: 'Workflow',
        kind: 'record'
      })
    ).toBe('Workflow')
    // An older server without the labels: the collection word only.
    expect(bellGroupLabel({ collection: 'inventory_request', kind: 'record' })).toBe(
      'Inventory request'
    )
  })

  it('non-record targets show their label without the item id', () => {
    expect(bellGroupLabel({ collection: 'nivaro_tasks', kind: 'task', target_label: 'Task' })).toBe(
      'Task'
    )
  })

  it('chat and record-less rows', () => {
    expect(bellGroupLabel({ collection: '__chat__', kind: 'chat' })).toBe('Chat')
    expect(bellGroupLabel({ collection: null })).toBeNull()
    expect(bellGroupLabel(null)).toBeNull()
  })
})
