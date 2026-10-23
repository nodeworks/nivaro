import { type DraftBody, draftOf, publishedOf, type TemplateDetail } from './api'
import { BodyCompare, OUTLINE_BTN, PanelFrame } from './panel-parts'

/** Did the 409's row publish a new version since the editor loaded (vs. only save a draft)? */
export function conflictPublished(current: TemplateDetail, loaded: TemplateDetail): boolean {
  return (
    current.published_version != null &&
    current.published_version !== (loaded.published_version ?? null)
  )
}

/** The banner sentence, exactly as the spec words it. */
export function conflictText(current: TemplateDetail, loaded: TemplateDetail): string {
  const published = conflictPublished(current, loaded)
  const who = (published ? current.published_by_name : current.draft_updated_by_name) || 'Someone'
  return `${published ? `${who} published v${current.published_version}` : `${who} saved this draft`} while you edited. Reload, or keep your draft and review the diff.`
}

/**
 * "Review the diff" for a 409: what the other person left (the version they
 * published, or the draft they saved) against the draft held here.
 */
export function ConflictPanel({
  loaded,
  current,
  draft,
  recordId,
  onRecordChange,
  onReload,
  onKeep,
  onClose
}: {
  loaded: TemplateDetail
  current: TemplateDetail
  draft: DraftBody
  recordId: string | null
  onRecordChange: (id: string) => void
  onReload: () => void
  onKeep: () => void
  onClose: () => void
}) {
  const published = conflictPublished(current, loaded)
  const theirs = published ? publishedOf(current) : draftOf(current)
  const who = (published ? current.published_by_name : current.draft_updated_by_name) || 'Someone'
  const theirLabel = published ? `v${current.published_version} (${who})` : `${who}'s draft`
  return (
    <PanelFrame
      title='Review the diff'
      panel='conflict'
      onClose={onClose}
      footer={
        <div className='space-y-2'>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Reload drops your edits and opens{' '}
            {published ? `v${current.published_version}` : 'their draft'}. Keep my draft saves yours
            over it
            {published ? ` — live stays v${current.published_version} until you publish` : ''}.
          </p>
          <div className='flex flex-wrap gap-2'>
            <button type='button' onClick={onReload} className={OUTLINE_BTN}>
              Reload
            </button>
            <button type='button' onClick={onKeep} className={OUTLINE_BTN}>
              Keep my draft
            </button>
          </div>
        </div>
      }
    >
      <div className='space-y-3 px-4 py-3'>
        <BodyCompare
          templateKey={loaded.key}
          collection={loaded.collection}
          recordId={recordId}
          onRecordChange={onRecordChange}
          before={{ label: theirLabel, body: theirs }}
          after={{ label: 'your draft', body: draft }}
          sameText={{
            payload: `Your draft sends the same body as ${theirLabel} for this record.`,
            template: `Your draft is the same template as ${theirLabel}.`
          }}
        />
      </div>
    </PanelFrame>
  )
}
