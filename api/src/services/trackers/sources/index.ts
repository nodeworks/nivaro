import { issueSource } from './issue.js'
import { recordSource } from './record.js'
import { ticketSource } from './ticket.js'
import type { SourceKind, TrackerSource } from './types.js'

export {
  isSourceKind,
  type LoadOptions,
  type MirroredCommentMeta,
  normalizeSourceId,
  parseRecordId,
  SOURCE_KINDS,
  type SourceActor,
  type SourceKind,
  type SourceView,
  sourceKey,
  type TrackerSource
} from './types.js'

const SOURCES: Record<SourceKind, TrackerSource> = {
  issue: issueSource,
  ticket: ticketSource,
  record: recordSource
}

/** The source behind a link member kind. */
export function sourceFor(kind: SourceKind): TrackerSource {
  const s = SOURCES[kind]
  if (!s) throw new Error(`Unknown source kind: ${String(kind)}`)
  return s
}
