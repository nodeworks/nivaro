// api/src/services/display-value.ts
// Pure, dependency-free display-value resolution shared by pdf-layout.ts and the Queues feature.
// Kept separate from pdf-layout.ts because that module imports puppeteer at module scope —
// consumers that only need display-template rendering must not transitively pull that in.

export const LABEL_FALLBACK = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']

export function resolveDisplayValue(record: Record<string, unknown>, template?: string | null): string {
  if (template) {
    return template
      .replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
        const parts = key.split('.')
        let val: unknown = record
        for (const p of parts) {
          if (val == null || typeof val !== 'object') {
            val = null
            break
          }
          val = (val as Record<string, unknown>)[p]
        }
        return String(val ?? '')
      })
      .trim()
  }
  if (record.first_name != null || record.last_name != null) {
    return [record.first_name, record.last_name].filter(Boolean).join(' ').trim() || String(record.id ?? '')
  }
  for (const f of LABEL_FALLBACK) {
    if (record[f] != null && record[f] !== '') return String(record[f])
  }
  return String(record.id ?? '')
}

export function extractTemplateFields(template: string | null | undefined): string[] {
  if (!template) return ['id']
  const matches = [...template.matchAll(/\{\{([\w.]+)\}\}/g)]
  const fields = new Set<string>(['id'])
  for (const m of matches) fields.add(m[1].split('.')[0])
  return [...fields]
}
