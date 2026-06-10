import type { CMSRelation } from './api'

export function renderDisplayTemplate(
  template: string | null | undefined,
  item: Record<string, unknown>
): string {
  if (!template) return String(item.id ?? '')
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(item[key as string] ?? ''))
}

export function extractTemplateFields(template: string | null | undefined): string[] {
  if (!template) return ['id']
  const fields = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
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
