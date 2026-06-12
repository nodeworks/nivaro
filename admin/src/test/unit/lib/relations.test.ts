import { describe, it, expect } from 'vitest'
import { renderDisplayTemplate, extractTemplateFields, findM2ORelation } from '@/lib/relations'
import { makeRelation } from '@/test/fixtures'

describe('renderDisplayTemplate', () => {
  const item = { id: 1, title: 'Hello', author: { name: 'Alice' }, status: null }

  it('replaces {{field}} with item value', () => {
    expect(renderDisplayTemplate('{{title}}', item)).toBe('Hello')
  })

  it('replaces multiple template tokens', () => {
    expect(renderDisplayTemplate('{{id}} - {{title}}', item)).toBe('1 - Hello')
  })

  it('handles nested dot-path keys', () => {
    expect(renderDisplayTemplate('{{author.name}}', item)).toBe('Alice')
  })

  it('returns empty string for missing field', () => {
    expect(renderDisplayTemplate('{{missing}}', item)).toBe('')
  })

  it('returns empty string for null field value', () => {
    expect(renderDisplayTemplate('{{status}}', item)).toBe('')
  })

  it('uses fallback fields when template is null', () => {
    expect(renderDisplayTemplate(null, { id: 5, title: 'Found' })).toBe('Found')
  })

  it('uses fallback fields when template is undefined', () => {
    expect(renderDisplayTemplate(undefined, { name: 'Alice', id: 2 })).toBe('Alice')
  })

  it('falls back to id when no fallback field is present', () => {
    expect(renderDisplayTemplate(null, { id: 42 })).toBe('42')
  })

  it('returns empty string for item with no useful fields and no template', () => {
    expect(renderDisplayTemplate(null, {})).toBe('')
  })
})

describe('extractTemplateFields', () => {
  it('extracts field names from template', () => {
    const fields = extractTemplateFields('{{title}} by {{author}}')
    expect(fields).toContain('id')
    expect(fields).toContain('title')
    expect(fields).toContain('author')
  })

  it('returns ["*"] for null template', () => {
    expect(extractTemplateFields(null)).toEqual(['*'])
  })

  it('returns ["*"] for undefined template', () => {
    expect(extractTemplateFields(undefined)).toEqual(['*'])
  })

  it('always includes "id" in the result', () => {
    const fields = extractTemplateFields('{{name}}')
    expect(fields[0]).toBe('id')
  })

  it('extracts dot-path fields as-is', () => {
    const fields = extractTemplateFields('{{author.name}}')
    expect(fields).toContain('author.name')
  })
})

describe('findM2ORelation', () => {
  const relations = [
    makeRelation({ id: 1, many_collection: 'comments', many_field: 'article_id', one_collection: 'articles', junction_field: null }),
    makeRelation({ id: 2, many_collection: 'comments', many_field: 'user_id', one_collection: 'nivaro_users', junction_field: null }),
    makeRelation({ id: 3, many_collection: 'tags', many_field: 'post_id', one_collection: 'posts', junction_field: null }),
    // M2M — should NOT be returned by findM2ORelation
    makeRelation({ id: 4, many_collection: 'article_tags', many_field: 'tag_id', one_collection: 'tags', junction_field: 'article_id' }),
  ]

  it('finds the correct M2O relation', () => {
    const rel = findM2ORelation(relations, 'comments', 'article_id')
    expect(rel).toBeDefined()
    expect(rel?.id).toBe(1)
  })

  it('finds another M2O relation in the same collection', () => {
    const rel = findM2ORelation(relations, 'comments', 'user_id')
    expect(rel?.id).toBe(2)
  })

  it('returns undefined when collection does not match', () => {
    expect(findM2ORelation(relations, 'posts', 'article_id')).toBeUndefined()
  })

  it('returns undefined when field does not match', () => {
    expect(findM2ORelation(relations, 'comments', 'nonexistent')).toBeUndefined()
  })

  it('does not return M2M relations (junction_field is set)', () => {
    const rel = findM2ORelation(relations, 'article_tags', 'tag_id')
    expect(rel).toBeUndefined()
  })

  it('returns undefined on empty relations array', () => {
    expect(findM2ORelation([], 'comments', 'article_id')).toBeUndefined()
  })
})
