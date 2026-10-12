import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  changeSetHash,
  decodeDetail,
  dropReferenced,
  extractFileIds,
  type FieldRuleRow,
  type FileRefMeta,
  fileRefSources,
  findDuplicateViews,
  findRuleConflicts,
  groupLabelConcepts,
  guardApply,
  type LabelOccurrence,
  parseAiPhrasing,
  publicDetail,
  reviveRow,
  rewriteLabel,
  type SavedViewRow,
  undoableFix
} from '../../../services/config-review/pure.js'

const rule = (over: Partial<FieldRuleRow>): FieldRuleRow => ({
  id: 1,
  collection: 'workflows',
  trigger_field: 'type',
  trigger_op: 'eq',
  trigger_value: 'A',
  target_field: 'priority',
  target_type: 'set',
  target_value: 'high',
  sort: 0,
  is_active: true,
  ...over
})

describe('findRuleConflicts (#1913)', () => {
  it('the later rule on the same trigger + target wins; a different value is a contradiction', () => {
    const out = findRuleConflicts([
      rule({ id: 1, sort: 1 }),
      rule({ id: 2, sort: 2, target_value: 'low' })
    ])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('contradiction')
    expect(out[0].shadowed.id).toBe(1)
    expect(out[0].winner.id).toBe(2)
  })
  it('an identical twin is a duplicate', () => {
    const out = findRuleConflicts([rule({ id: 1 }), rule({ id: 2 })])
    expect(out.map((c) => c.kind)).toEqual(['duplicate'])
  })
  it('inactive rules, other triggers and only-when-empty winners are not conflicts', () => {
    expect(
      findRuleConflicts([rule({ id: 1 }), rule({ id: 2, is_active: 0, target_value: 'x' })])
    ).toEqual([])
    expect(
      findRuleConflicts([rule({ id: 1 }), rule({ id: 2, trigger_value: 'B', target_value: 'x' })])
    ).toEqual([])
    expect(
      findRuleConflicts([rule({ id: 1 }), rule({ id: 2, target_value: 'x', only_when_empty: 1 })])
    ).toEqual([])
  })
})

const view = (over: Partial<SavedViewRow>): SavedViewRow => ({
  id: 1,
  collection: 'workflows',
  name: 'Mine',
  filters: '[{"field":"a","op":"eq","value":1}]',
  sort: '"-id"',
  columns: '["a","b"]',
  user: 'U1',
  is_shared: false,
  role: null,
  is_default: false,
  default_for_role: null,
  ...over
})

describe('findDuplicateViews (#1913)', () => {
  it('same filters (key order ignored), sort and columns for the same owner are duplicates', () => {
    const out = findDuplicateViews([
      view({ id: 1 }),
      view({ id: 2, name: 'Copy', filters: '[{"value":1,"op":"eq","field":"a"}]' })
    ])
    expect(out).toHaveLength(1)
    expect(out[0].keep.id).toBe(1)
    expect(out[0].duplicates.map((d) => d.id)).toEqual([2])
  })
  it('a default view is the one kept', () => {
    const out = findDuplicateViews([view({ id: 1 }), view({ id: 2, is_default: true })])
    expect(out[0].keep.id).toBe(2)
  })
  it('different owners or columns are not duplicates', () => {
    expect(findDuplicateViews([view({ id: 1 }), view({ id: 2, user: 'U2' })])).toEqual([])
    expect(findDuplicateViews([view({ id: 1 }), view({ id: 2, columns: '["a"]' })])).toEqual([])
  })
  it('canonicalJson sorts keys and keeps non-JSON text', () => {
    expect(canonicalJson('{"b":1,"a":2}')).toBe('{"a":2,"b":1}')
    expect(canonicalJson('-id')).toBe('-id')
  })
})

const occ = (over: Partial<LabelOccurrence>): LabelOccurrence => ({
  source: 'field',
  ref: 1,
  path: 'label',
  field: 'req_amount',
  label: 'Req Amount',
  where: 'x',
  ...over
})

describe('groupLabelConcepts (#1999)', () => {
  it('one field labelled two ways is a concept; the most used label is suggested', () => {
    const out = groupLabelConcepts([
      occ({}),
      occ({ source: 'layout', ref: 2, label: 'Requisition $' }),
      occ({ source: 'queue', ref: 'q', label: 'Requisition $' })
    ])
    expect(out).toHaveLength(1)
    expect(out[0].suggested).toBe('Requisition $')
    expect(out[0].labels).toEqual([
      { label: 'Req Amount', count: 1 },
      { label: 'Requisition $', count: 2 }
    ])
  })
  it('a sentence-length label never wins the suggestion over a short one', () => {
    const long = 'Enter amount to increase / decrease by'
    const out = groupLabelConcepts([
      occ({ label: 'REQ Amount' }),
      occ({ source: 'layout', ref: 2, label: long }),
      occ({ source: 'layout', ref: 3, label: long })
    ])
    expect(out[0].suggested).toBe('REQ Amount')
  })
  it('case, spacing and trailing colons do not make a second label; generic leaves are skipped', () => {
    expect(groupLabelConcepts([occ({}), occ({ ref: 2, label: 'req  amount:' })])).toEqual([])
    expect(
      groupLabelConcepts([occ({ field: 'status' }), occ({ field: 'status', label: 'State' })])
    ).toEqual([])
  })
})

describe('parseAiPhrasing — model output is data, never instructions', () => {
  it('keeps reason + label for ids we sent and drops everything else', () => {
    const text = `Sure! {"f1": {"reason": "<b>Two</b> rules\\u0007 fight.", "label": "Requested Amount", "action": "DROP TABLE"}, "f9": {"reason": "x"}}`
    expect(parseAiPhrasing(text, new Set(['f1']))).toEqual({
      f1: { reason: 'Two rules fight.', label: 'Requested Amount' }
    })
  })
  it('rejects labels with markup or that are too long, and unparseable replies', () => {
    expect(parseAiPhrasing('{"f1":{"label":"<script>"}}', new Set(['f1']))).toEqual({})
    expect(parseAiPhrasing(`{"f1":{"label":"${'x'.repeat(90)}"}}`, new Set(['f1']))).toEqual({})
    expect(parseAiPhrasing('no json here', new Set(['f1']))).toEqual({})
  })
})

describe('rewriteLabel (#1999 apply + undo)', () => {
  it('plain label columns', () => {
    expect(
      rewriteLabel({ source: 'field', path: 'label' }, 'Req Amount', 'Req Amount', 'Requested')
    ).toBe('Requested')
    expect(
      rewriteLabel({ source: 'layout', path: 'label_override' }, 'Other', 'Req Amount', 'Requested')
    ).toBeNull()
  })
  it('layout overrides keep their other keys', () => {
    const raw = JSON.stringify({ label: 'Req $', width: 2 })
    const out = rewriteLabel(
      { source: 'layout', path: 'overrides.label' },
      raw,
      'Req $',
      'Requested'
    )
    expect(JSON.parse(out as string)).toEqual({ label: 'Requested', width: 2 })
  })
  it('queue aliases and view columns rewrite only the named key', () => {
    const aliases = JSON.stringify({ 'extra.req_amount': 'Req $', state: 'Stage' })
    expect(
      JSON.parse(
        rewriteLabel(
          { source: 'queue', path: 'extra.req_amount' },
          aliases,
          'Req $',
          'Requested'
        ) as string
      )
    ).toEqual({ 'extra.req_amount': 'Requested', state: 'Stage' })
    const cols = JSON.stringify([
      'a',
      { key: 'req_amount', label: 'Req $' },
      { key: 'b', label: 'B' }
    ])
    expect(
      JSON.parse(
        rewriteLabel({ source: 'view', path: 'req_amount' }, cols, 'Req $', 'Requested') as string
      )
    ).toEqual(['a', { key: 'req_amount', label: 'Requested' }, { key: 'b', label: 'B' }])
  })
  it('report widgets follow the JSON pointer', () => {
    const cfg = JSON.stringify({
      columns: [
        { field: 'x', label: 'X' },
        { field: 'req_amount', label: 'Req $' }
      ]
    })
    const out = rewriteLabel({ source: 'report', path: '/columns/1' }, cfg, 'Req $', 'Requested')
    expect(JSON.parse(out as string).columns[1]).toEqual({
      field: 'req_amount',
      label: 'Requested'
    })
    expect(
      rewriteLabel({ source: 'report', path: '/columns/0' }, cfg, 'Req $', 'Requested')
    ).toBeNull()
  })
  it('an undo is the same call swapped, and skips a label someone changed since', () => {
    const applied = rewriteLabel(
      { source: 'queue', path: 'k' },
      '{"k":"Old"}',
      'Old',
      'New'
    ) as string
    expect(rewriteLabel({ source: 'queue', path: 'k' }, applied, 'New', 'Old')).toBe('{"k":"Old"}')
    expect(rewriteLabel({ source: 'queue', path: 'k' }, '{"k":"Edited"}', 'New', 'Old')).toBeNull()
  })
})

describe('finding detail envelope', () => {
  it('old plain-text details become the reason', () => {
    expect(decodeDetail('just text')).toEqual({ reason: 'just text' })
    expect(decodeDetail(null)).toEqual({ reason: '' })
  })
  it('the page never sees undo copies, only whether one exists', () => {
    const d = {
      reason: 'r',
      applied: [
        { at: 'now', by: null, title: 't', total: 1, undo: { kind: 'views', data: { views: [1] } } }
      ]
    }
    expect(undoableFix(d)?.title).toBe('t')
    const pub = publicDetail(d)
    expect(pub.can_undo).toBe(true)
    expect(pub.applied?.[0].undo).toEqual({ kind: 'views', data: null })
  })
  it('reviveRow drops the identity and turns ISO strings back into dates', () => {
    const out = reviveRow({ id: 5, name: 'n', saved_at: '2026-01-02T03:04:05.000Z' })
    expect(out.id).toBeUndefined()
    expect(out.saved_at).toBeInstanceOf(Date)
    expect(out.name).toBe('n')
  })
})

describe('phraseFindings — what the model sees and what comes back', () => {
  it('sends names and reasons only, and maps replies back to findings', async () => {
    const { phraseFindings } = await import('../../../services/config-review/ai-phrasing.js')
    let sent = ''
    const deps = {
      model: async () => 'm',
      getClient: async () => ({
        messages: {
          create: async (p: Record<string, unknown>) => {
            sent = String((p.messages as Array<{ content: string }>)[0].content)
            return {
              content: [
                { type: 'text', text: '{"f1":{"reason":"Plain words.","label":"Requested"}}' }
              ]
            }
          }
        }
      })
    }
    const res = await phraseFindings(
      [
        {
          family: 'label',
          code: 'label-inconsistent',
          subject: 'label:req',
          title: 't',
          severity: 'info',
          detail: {
            reason: 'r',
            data: { labels: [{ label: 'Req', count: 1 }], occurrences: [{ secret: 'row-value' }] }
          }
        }
      ],
      deps
    )
    expect(sent).toContain('"labels":["Req"]')
    expect(sent).not.toContain('row-value')
    expect(res.byKey.get('label|label-inconsistent|label:req')).toEqual({
      reason: 'Plain words.',
      label: 'Requested'
    })
  })
  it('no client configured is a note, not an error', async () => {
    const { phraseFindings } = await import('../../../services/config-review/ai-phrasing.js')
    const res = await phraseFindings([], { model: async () => 'm', getClient: async () => null })
    expect(res.note).toBe('AI is not configured')
  })
})

describe('unreferenced files (#2020) — what counts as a reference', () => {
  const A = '11111111-2222-3333-4444-555555555555'
  const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const C = '99999999-8888-7777-6666-555555555555'
  const meta: FileRefMeta = {
    fkRefs: [{ table: 'workflows_files', column: 'directus_files_id' }],
    relations: [
      // Alias M2M: the junction's file leg is named by junction_field.
      {
        one_collection: 'inventory_request',
        one_field: 'files',
        many_collection: 'inventory_request_files',
        many_field: 'inventory_request_id',
        junction_field: 'directus_files_id'
      }
    ],
    fields: [
      // A legacy file field with NO relation row.
      { collection: 'projects', field: 'cover', interface: 'file-image', special: null },
      { collection: 'inventory_request', field: 'files', interface: 'files', special: 'files' },
      { collection: 'projects', field: 'scope', interface: 'rich_text', special: null }
    ],
    columns: [
      { table: 'projects', column: 'cover', data_type: 'nvarchar' },
      { table: 'projects', column: 'scope', data_type: 'nvarchar' },
      {
        table: 'inventory_request_files',
        column: 'directus_files_id',
        data_type: 'uniqueidentifier'
      },
      { table: 'workflows_files', column: 'directus_files_id', data_type: 'uniqueidentifier' },
      { table: 'nivaro_pages', column: 'layout', data_type: 'nvarchar' },
      { table: 'nivaro_pdf_templates', column: 'template', data_type: 'nvarchar' },
      { table: 'ext_reports', column: 'logo_file', data_type: 'uniqueidentifier' }
    ]
  }
  const sources = fileRefSources(meta)
  const has = (t: string, c: string) => sources.find((x) => x.table === t && x.column === c)

  it('covers file fields without a relation row, M2M junction legs, config text, rich text and *file* uuid columns', () => {
    expect(has('projects', 'cover')?.mode).toBe('id')
    expect(has('inventory_request_files', 'directus_files_id')?.mode).toBe('id')
    expect(has('nivaro_pages', 'layout')?.mode).toBe('scan')
    expect(has('nivaro_pdf_templates', 'template')?.mode).toBe('scan')
    expect(has('projects', 'scope')).toMatchObject({ mode: 'scan', urlOnly: true })
    expect(has('ext_reports', 'logo_file')?.mode).toBe('id')
  })
  it('skips columns a foreign key covers and columns that do not exist', () => {
    expect(has('workflows_files', 'directus_files_id')).toBeUndefined()
    expect(has('nivaro_users', 'avatar')).toBeUndefined()
  })
  it('a file named only in JSON config, or only by a file field with no relation row, is NOT an orphan', () => {
    const named = new Set<string>()
    // nivaro_pages.layout (scan) and projects.cover (id) as read back.
    extractFileIds(JSON.stringify({ widgets: [{ type: 'image', src: `/api/files/${A}` }] }), named)
    extractFileIds(B.toUpperCase(), named)
    const left = dropReferenced([{ id: A }, { id: B }, { id: C }], named)
    expect(left.map((f) => f.id)).toEqual([C])
  })
})

describe('apply binds to the previewed change set (I2)', () => {
  const ids = ['draft:1', 'draft:2', 'draft:3']
  const hash = changeSetHash('drafts-delete', ids)
  it('the hash ignores order and changes with the kind or any id', () => {
    expect(changeSetHash('drafts-delete', [...ids].reverse())).toBe(hash)
    expect(changeSetHash('tasks-cancel', ids)).not.toBe(hash)
    expect(changeSetHash('drafts-delete', ['draft:1', 'draft:2'])).not.toBe(hash)
  })
  it('same rows: applies the intersection of the fresh plan and the previewed ids', () => {
    const g = guardApply('drafts-delete', ids, { ids: ['draft:1', 'draft:3', 'draft:99'], hash })
    expect(g.ok && [...g.allowed].sort()).toEqual(['draft:1', 'draft:3'])
  })
  it('rows changed since the preview: 409, nothing applied', () => {
    const g = guardApply('drafts-delete', ['draft:1', 'draft:2', 'draft:4'], { ids, hash })
    expect(g).toMatchObject({ ok: false, status: 409 })
  })
  it('an apply without the preview ids + hash is refused', () => {
    expect(guardApply('drafts-delete', ids, {})).toMatchObject({ ok: false, status: 400 })
    expect(guardApply('drafts-delete', ids, { ids: [], hash })).toMatchObject({
      ok: false,
      status: 409
    })
  })
})
