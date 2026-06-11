import type { CMSRelation } from './api'

const LABEL_FALLBACK_FIELDS = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']

export function renderDisplayTemplate(
  template: string | null | undefined,
  item: Record<string, unknown>
): string {
  if (!template) {
    for (const f of LABEL_FALLBACK_FIELDS) {
      if (item[f] != null && item[f] !== '') return String(item[f])
    }
    return String(item.id ?? '')
  }
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const parts = key.split('.')
    let val: unknown = item
    for (const part of parts) {
      if (val == null || typeof val !== 'object') { val = null; break }
      val = (val as Record<string, unknown>)[part]
    }
    return String(val ?? '')
  })
}

export function extractTemplateFields(template: string | null | undefined): string[] {
  if (!template) return ['id', ...LABEL_FALLBACK_FIELDS]
  const fields = [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])
  return ['id', ...fields]
}

export function findM2ORelation(
  relations: CMSRelation[],
  manyCollection: string,
  field: string
): CMSRelation | undefined {
  return relations.find(
    (r) =>
      r.many_collection === manyCollection &&
      r.many_field === field &&
      r.junction_field === null &&
      r.one_collection !== null
  )
}

export function findO2MRelation(
  relations: CMSRelation[],
  oneCollection: string,
  field: string
): CMSRelation | undefined {
  return relations.find(
    (r) => r.one_collection === oneCollection && r.one_field === field && r.junction_field === null
  )
}
