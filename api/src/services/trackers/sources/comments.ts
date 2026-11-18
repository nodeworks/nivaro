import { randomUUID } from 'node:crypto'
import { db } from '../../../db/index.js'
import { announceRecordAspect, emitRecordEvent } from '../../record-events.js'
import { trackerUserId } from '../identity.js'
import type { MirroredCommentMeta } from './types.js'

/** A mirrored GitLab comment longer than this is cut. */
export const NOTE_MAX = 100_000

/** The start of a mirrored comment's meta (key order fixed so it can be found by prefix). */
export const trackerMetaPrefix = (linkId: number, noteId: number) =>
  `{"tracker":{"link":${linkId},"note_id":${noteId},`

/** The full meta of a mirrored comment: `{"tracker":{"link":…,"note_id":…,"author":"…"}}`. */
export const trackerMeta = (linkId: number, noteId: number, author: string) =>
  `${trackerMetaPrefix(linkId, noteId)}"author":${JSON.stringify(author)}}}`

/**
 * One comment on a thread (`collection` + `item`) written by the GitLab machine user, then the
 * same live refresh POST /comments gives (comment counts, open threads).
 */
export async function insertMirroredComment(
  collection: string,
  item: string | number,
  text: string,
  meta: string,
  createdAt?: Date
): Promise<void> {
  const userId = await trackerUserId()
  await db('nivaro_comments').insert({
    id: randomUUID(),
    collection,
    item: String(item),
    user: userId,
    text: String(text ?? '').slice(0, NOTE_MAX),
    meta,
    created_at: createdAt ?? new Date(),
    updated_at: new Date()
  })
  announceRecordAspect(collection, item, '$comments')
  emitRecordEvent(collection, item, 'record:comment', { user: userId })
}

/** addComment for every source: the note on the source's own thread with the tracker meta. */
export async function addTrackerComment(
  collection: string,
  item: string | number,
  text: string,
  meta: MirroredCommentMeta
): Promise<void> {
  await insertMirroredComment(
    collection,
    item,
    text,
    trackerMeta(meta.link, meta.note_id, meta.author),
    meta.created_at
  )
}
