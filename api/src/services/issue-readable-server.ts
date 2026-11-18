import { db } from '../db/index.js'
import { type ReadableIssue, type ReadableOpts, readableIssue } from './issue-readable.js'
import { instanceTimezone } from './liquid-dates.js'

/**
 * `readableIssue` for text read OUTSIDE the app (the stored title of a new issue, a GitLab
 * title): times in the instance zone with its short name ("12:50 AM EST"), collection and field
 * names from metadata (display name / label, else the id in words). Never throws: null = show
 * the title as it is.
 */
export async function readableIssueForServer(input: {
  title: string | null | undefined
  details?: string | null
}): Promise<ReadableIssue | null> {
  try {
    const first = readableIssue(input)
    if (!first) return null
    const opts: ReadableOpts = { timeZone: await instanceTimezone(), zoneName: true }
    const { collections, fields } = first.names
    if (collections.length || fields.length) opts.labels = await metadataLabels(collections, fields)
    return readableIssue(input, opts)
  } catch {
    return null
  }
}

async function metadataLabels(
  collections: string[],
  fields: Array<{ collection: string; field: string }>
): Promise<NonNullable<ReadableOpts['labels']>> {
  const names = [...new Set([...collections, ...fields.map((f) => f.collection)])]
  const col = new Map<string, string>()
  const fld = new Map<string, string>()
  try {
    const rows = (await db('nivaro_collections')
      .whereIn('collection', names)
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    for (const r of rows) if (r.display_name?.trim()) col.set(r.collection, r.display_name.trim())
  } catch {
    // labels fall back to the ids in words
  }
  if (fields.length) {
    try {
      const rows = (await db('nivaro_fields')
        .whereIn('collection', names)
        .whereIn(
          'field',
          fields.map((f) => f.field)
        )
        .select('collection', 'field', 'label')) as Array<{
        collection: string
        field: string
        label: string | null
      }>
      for (const r of rows)
        if (r.label?.trim()) fld.set(`${r.collection}.${r.field}`, r.label.trim())
    } catch {
      // as above
    }
  }
  return {
    collection: (c) => col.get(c) ?? null,
    field: (c, f) => fld.get(`${c}.${f}`) ?? null
  }
}
