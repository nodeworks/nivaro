import { describe, expect, it } from 'vitest'
import { templateRelationPaths } from './CollectionBrowserView'

// 2026-11-13: Category Tasks → Category read "-" for every row. The categories template is
// "{{core_category.name}} - {{sub_category.name}}" and the list read the row with fields=*,
// so both links came back as ids. The dotted tokens are now read with the row.
describe('templateRelationPaths', () => {
  it('names the template tokens that go through a link, once each', () => {
    expect(templateRelationPaths('{{core_category.name}} - {{sub_category.name}}')).toEqual([
      'core_category.name',
      'sub_category.name'
    ])
    expect(templateRelationPaths('{{a.b}} {{name}} {{a.b}}')).toEqual(['a.b'])
  })

  it('nothing for a plain template or none', () => {
    expect(templateRelationPaths('{{name}} ({{code}})')).toEqual([])
    expect(templateRelationPaths(null)).toEqual([])
  })
})
