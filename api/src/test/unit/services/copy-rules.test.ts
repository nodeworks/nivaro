import { describe, expect, it } from 'vitest'
import {
  type CopyRuleContext,
  childRowSkip,
  copyableValues,
  copySkipMap,
  copySkipReason,
  linkPlans,
  linkSkipReason,
  parseNeverCopy
} from '../../../services/copy-rules.js'

const ctx = (over: Partial<CopyRuleContext> = {}): CopyRuleContext => ({
  stateFields: new Set(['workflow_state']),
  autoIds: new Set(['workflow_id']),
  rollups: new Set(['line_total']),
  neverCopy: new Set(['po_number']),
  ...over
})

describe('copySkipReason — the one "never copied" rule', () => {
  it('copies a plain field people type', () => {
    expect(copySkipReason({ field: 'description' }, ctx())).toBeNull()
  })

  it('never copies the pipeline state field, even when it is editable and visible', () => {
    expect(copySkipReason({ field: 'workflow_state' }, ctx())).toBe('pipeline-state')
  })

  it('never copies audit stamps by name or by special', () => {
    expect(copySkipReason({ field: 'id' }, ctx())).toBe('audit')
    expect(copySkipReason({ field: 'last_state_change' }, ctx())).toBe('audit')
    expect(copySkipReason({ field: 'made_by', special: ['user-created'] }, ctx())).toBe('audit')
    expect(copySkipReason({ field: 'stamp', special: 'date-updated' }, ctx())).toBe('audit')
  })

  it('never copies generated, calculated and rollup fields', () => {
    expect(copySkipReason({ field: 'workflow_id' }, ctx())).toBe('generated')
    expect(copySkipReason({ field: 'ref', options: '{"auto_id":{"pattern":"X"}}' }, ctx())).toBe(
      'generated'
    )
    expect(copySkipReason({ field: 'f', computed_type: 'write' }, ctx())).toBe('calculated')
    expect(copySkipReason({ field: 'amount', computed_type: 'rollup' }, ctx())).toBe('rollup')
    expect(copySkipReason({ field: 'line_total' }, ctx())).toBe('rollup')
  })

  it('never copies read-only, hidden or "do not duplicate" fields (partner state)', () => {
    expect(copySkipReason({ field: 'partner_status', readonly: true }, ctx())).toBe('read-only')
    expect(copySkipReason({ field: 'trigger_push', hidden: true }, ctx())).toBe('hidden')
    expect(copySkipReason({ field: 'order_number', options: { no_duplicate: true } }, ctx())).toBe(
      'do-not-duplicate'
    )
  })

  it("a rollup filter's yes/no switch stays behind; a type it filters on copies", () => {
    const c = ctx({ rollupFilters: new Set(['follows_cars', 'workflow_type']) })
    expect(copySkipReason({ field: 'follows_cars', type: 'boolean' }, c)).toBe('rollup-switch')
    expect(copySkipReason({ field: 'workflow_type', type: 'integer' }, c)).toBeNull()
  })

  it("honours the collection's own never-copy list", () => {
    expect(copySkipReason({ field: 'po_number' }, ctx())).toBe('never-copy')
  })

  it('never copies link lists', () => {
    expect(copySkipReason({ field: 'lines', special: ['o2m'] }, ctx())).toBe('list')
    expect(copySkipReason({ field: 'zones', type: 'alias' }, ctx())).toBe('list')
  })
})

describe('copySkipMap / copyableValues', () => {
  it('keeps only what copies, including state fields with no metadata row', () => {
    const skip = copySkipMap(
      [{ field: 'name' }, { field: 'order_number', options: { no_duplicate: true } }],
      ctx()
    )
    const row = {
      id: 9,
      name: 'A',
      order_number: 'SO-1',
      workflow_state: 4,
      workflow_id: 'W-1',
      po_number: 'PO-1',
      'project.name': 'x',
      $state: 'review'
    }
    expect(copyableValues(row, skip)).toEqual({ name: 'A' })
  })

  it('child rows keep hidden columns but drop the rest of the rule', () => {
    const skip = copySkipMap(
      [
        { field: 'sort', hidden: true },
        { field: 'shipped_qty', readonly: true }
      ],
      ctx({ stateFields: new Set(), neverCopy: new Set() })
    )
    const child = childRowSkip(skip)
    expect(child).toContain('shipped_qty')
    expect(child).not.toContain('sort')
  })
})

describe('parseNeverCopy', () => {
  it('reads browser_config.never_copy from text or object, dropping junk', () => {
    expect(parseNeverCopy('{"never_copy":["po_number","bad name",""]}')).toEqual(['po_number'])
    expect(parseNeverCopy({ never_copy: ['a', 'a', 'b'] })).toEqual(['a', 'b'])
    expect(parseNeverCopy(null)).toEqual([])
    expect(parseNeverCopy('not json')).toEqual([])
  })
})

describe('linkPlans — many-to-many lists that follow a copy', () => {
  const rels = [
    {
      many_collection: 'workflows_regions',
      many_field: 'workflows_id',
      one_collection: 'workflows',
      one_field: 'regions',
      junction_field: 'regions_id'
    },
    {
      many_collection: 'workflows_files',
      many_field: 'workflows_id',
      one_collection: 'workflows',
      one_field: 'attachments',
      junction_field: 'directus_files_id'
    },
    {
      many_collection: 'workflows_files',
      many_field: 'directus_files_id',
      one_collection: 'directus_files',
      one_field: null,
      junction_field: 'workflows_id'
    },
    {
      many_collection: 'workflows_contacts',
      many_field: 'workflows_id',
      one_collection: 'workflows',
      one_field: 'contacts',
      junction_field: 'users_id'
    },
    {
      many_collection: 'workflow_lines',
      many_field: 'workflow',
      one_collection: 'workflows',
      one_field: 'lines',
      junction_field: null
    }
  ]
  const lctx = { neverCopy: new Set<string>(), mayRead: () => true }
  const names = (plans: Array<{ field: string }>) => plans.map((p) => p.field)

  it('copies plain link lists, never files or child rows', () => {
    expect(names(linkPlans('workflows', rels, [], lctx))).toEqual(['regions', 'contacts'])
  })

  it('honours do-not-duplicate, the never-copy list and read access', () => {
    const fields = [{ field: 'contacts', options: { no_duplicate: true } }]
    expect(names(linkPlans('workflows', rels, fields, lctx))).toEqual(['regions'])
    const never = { ...lctx, neverCopy: new Set(['regions']) }
    expect(names(linkPlans('workflows', rels, [], never))).toEqual(['contacts'])
    const unread = { ...lctx, mayRead: (f: string) => f !== 'contacts' }
    expect(names(linkPlans('workflows', rels, [], unread))).toEqual(['regions'])
  })

  it('says why a list stays behind', () => {
    expect(linkSkipReason({ field: 'z', hidden: true }, 'z', lctx, 'zones', 'j')).toBe('hidden')
    expect(linkSkipReason(undefined, 'z', lctx, 'nivaro_files', 'j')).toBe('files')
    expect(linkSkipReason(undefined, 'z', lctx, 'zones', 'j')).toBeNull()
  })
})
