import { db } from '../db/index.js'

/**
 * Words for an access request as the ADMINISTRATORS read it (army 11): the record by its
 * kind and business id ("workflow TP26-81395"), never the table key or an internal row id,
 * and the system's reason retold about the requester ("their Zone filter limits them to …"),
 * not addressed to "you" — the admin is not the one who was refused.
 */

/** "workflow" — the collection's singular name, lower case; the key read as words otherwise. */
export async function collectionNoun(collection: string): Promise<string> {
  try {
    const meta = (await db('nivaro_collections')
      .where({ collection })
      .first('singular', 'display_name')) as
      | { singular: string | null; display_name: string | null }
      | undefined
    const name = meta?.singular || meta?.display_name
    if (name) return name.toLowerCase()
  } catch {
    /* fall back to the key */
  }
  return collection.replace(/_/g, ' ')
}

/** "workflow TP26-81395"; a record with no business id is "a workflow" (never its row id). */
export function accessTarget(
  noun: string,
  item: string | null | undefined,
  friendly: string | null | undefined
): string {
  if (!item) return `${noun} records`
  const f = friendly == null ? '' : String(friendly).trim()
  return f && f !== String(item) ? `${noun} ${f}` : `a ${noun}`
}

export function accessRequestSubject(requester: string, target: string): string {
  return `${requester} is asking for access to ${target}`
}

/** The refusal reason, retold about the requester ("you" → "they"). */
export function reasonAboutRequester(message: string): string {
  return message
    .replace(/\byou are\b/gi, (m) => (m[0] === 'Y' ? 'They are' : 'they are'))
    .replace(/\byou have\b/gi, (m) => (m[0] === 'Y' ? 'They have' : 'they have'))
    .replace(/\byou can\b/gi, (m) => (m[0] === 'Y' ? 'They can' : 'they can'))
    .replace(/\byou do\b/gi, (m) => (m[0] === 'Y' ? 'They do' : 'they do'))
    .replace(/\byour\b/gi, (m) => (m[0] === 'Y' ? 'Their' : 'their'))
    .replace(/\byours\b/gi, 'theirs')
    .replace(/\byou\b/gi, (m) => (m[0] === 'Y' ? 'They' : 'them'))
}
