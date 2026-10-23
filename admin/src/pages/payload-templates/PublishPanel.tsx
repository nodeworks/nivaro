import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { type DraftBody, errorMessage, publishedOf, staleCurrent, type TemplateDetail } from './api'
import {
  CheckProgress,
  CheckResultsList,
  CheckSummary,
  plural,
  summarize
} from './CheckRecentPanel'
import { usePayloadEditor } from './editor-context'
import {
  draftLookupsOf,
  liveLookupsOf,
  sameLookups,
  useChunkedCheck,
  usePublish
} from './panel-api'
import {
  BodyCompare,
  EditWarningNote,
  InlineError,
  OUTLINE_BTN,
  PanelFrame,
  PRIMARY_BTN,
  SECTION_LABEL
} from './panel-parts'

const NOTE_MAX = 1000

/**
 * Publish: the preview column becomes this panel. It saves the waiting edit,
 * renders the recent records through the draft (failures listed first), shows
 * the payload diff live → draft for the preview record, and publishes the
 * saved draft with a required note.
 */
export function PublishPanel({
  template,
  draft,
  nothingToPublish,
  warning,
  recordId,
  onRecordChange,
  onPreview,
  onClose
}: {
  template: TemplateDetail
  draft: DraftBody
  nothingToPublish: boolean
  warning: string | null
  recordId: string | null
  onRecordChange: (id: string) => void
  onPreview: (id: string) => void
  onClose: () => void
}) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const noteId = useId()
  const blockedId = useId()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const publish = usePublish(template.key)
  const next = (template.published_version ?? 0) + 1
  const live = publishedOf(template)
  const lookupsChange = !sameLookups(draftLookupsOf(template), liveLookupsOf(template))

  // Send any waiting edit now, so the check below covers what will be published.
  const [mountSave, setMountSave] = useState<'pending' | 'ok' | 'failed'>('pending')
  useEffect(() => {
    void ctxRef.current.saveNow().then((ok) => setMountSave(ok ? 'ok' : 'failed'))
  }, [])
  // The saved draft the check covers: follows each save, never an edit still in flight.
  const [checkRev, setCheckRev] = useState<number | null>(null)
  useEffect(() => {
    if (!ctx.saving && ctx.rev != null) setCheckRev(ctx.rev)
  }, [ctx.saving, ctx.rev])
  const [retryN, setRetryN] = useState(0)
  const check = useChunkedCheck(
    template.key,
    'draft',
    checkRev != null && !nothingToPublish ? `${checkRev}:${retryN}` : null
  )
  const checking =
    ctx.saving || check.status === 'running' || (checkRev == null && !nothingToPublish)
  const results = check.results
  const s = summarize(results)
  // Failing records ask for a second, explicit step; a new check asks again.
  const [anyway, setAnyway] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per checked draft
  useEffect(() => setAnyway(false), [checkRev])
  const failing = check.status === 'done' ? s.failed : 0

  const transitions = template.used_by.filter((u) => u.kind === 'transition').length
  const codePushes = template.used_by.filter((u) => u.kind === 'code').length
  const uses = [
    transitions ? plural(transitions, 'pipeline transition') : null,
    codePushes ? plural(codePushes, 'code push', 'code pushes') : null
  ].filter(Boolean)

  const blockedTip = nothingToPublish
    ? 'Nothing to publish'
    : !note.trim()
      ? 'Add a note first — it shows in History'
      : checking
        ? 'Waiting for the record check'
        : undefined

  const doPublish = async (confirmed = false) => {
    if (blockedTip || busy) return
    if (failing > 0 && !confirmed) {
      setAnyway(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await ctxRef.current.saveNow()
      if (!saved) {
        const why = ctxRef.current.saveError?.message
        setError(
          ctxRef.current.conflicted
            ? 'Saving is paused by the conflict above. Reload, or keep your draft, before publishing.'
            : `Your latest edit didn't save${why ? ` (${why})` : ''}. Fix it, or undo it, before publishing.`
        )
        return
      }
      const rev = ctxRef.current.getRev()
      const r = await publish.mutateAsync({ base_rev: rev ?? 0, note: note.trim() })
      ctxRef.current.markPublished(template.key, r.version)
      toast.success(`Published v${r.version} of ${template.label}`, {
        description: 'Every push that uses this payload sends it from now on.'
      })
      onClose()
    } catch (e) {
      const current = staleCurrent(e)
      if (current) {
        ctxRef.current.raiseConflict(current)
        setError('This draft changed on the server. Review the banner above before publishing.')
      } else setError(errorMessage(e, 'The draft was not published'))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <div className='space-y-2'>
      {warning && <EditWarningNote text={warning} />}
      <div>
        <label htmlFor={noteId} className={SECTION_LABEL}>
          Note for History{' '}
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>(required)</span>
        </label>
        <Textarea
          id={noteId}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void doPublish(anyway)
            }
          }}
          placeholder='What changed and why — e.g. "Send the PO number to Fusion as sourceTrxReference"'
          className='mt-1 min-h-[64px] text-[12.5px]'
          disabled={nothingToPublish || busy}
          data-payload-publish-note
        />
      </div>
      {error && (
        <p className='text-[12px] text-red-700 dark:text-red-300' role='alert'>
          {error}
        </p>
      )}
      {anyway && failing > 0 ? (
        <div
          className='space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-500/30 dark:bg-red-500/10'
          data-payload-publish-anyway
        >
          <p className='text-[12.5px] text-red-900 dark:text-red-100'>
            <span className='font-medium'>
              {failing} of {s.total} recent records would fail with v{next}.
            </span>{' '}
            A push for a record like these is refused before anything is sent and recorded as a
            failed submission.
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <button
              type='button'
              disabled={!!blockedTip || busy}
              onClick={() => void doPublish(true)}
              className={PRIMARY_BTN}
              aria-describedby={blockedTip ? blockedId : undefined}
              data-payload-publish-anyway-go
            >
              {busy ? 'Publishing…' : `Publish anyway — ${plural(failing, 'record')} would fail`}
            </button>
            <button
              type='button'
              onClick={() => setAnyway(false)}
              disabled={busy}
              className={OUTLINE_BTN}
            >
              Keep editing
            </button>
            {blockedTip && !busy && (
              <span
                id={blockedId}
                className='text-[12px] text-slate-600 dark:text-muted-foreground'
              >
                {blockedTip}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className='space-y-1.5'>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
            <button
              type='button'
              disabled={!!blockedTip || busy}
              onClick={() => void doPublish()}
              className={cn(PRIMARY_BTN, 'shrink-0')}
              aria-describedby={blockedTip ? blockedId : undefined}
              data-payload-publish-confirm
            >
              {busy ? 'Publishing…' : `Publish v${next}`}
            </button>
            {blockedTip && !busy && (
              <span
                id={blockedId}
                className='text-[12px] text-slate-600 dark:text-muted-foreground'
                data-payload-publish-blocked
              >
                {blockedTip}
              </span>
            )}
          </div>
          {!nothingToPublish && failing > 0 && (
            <p className='text-[12px] text-red-700 dark:text-red-300' data-payload-publish-failing>
              {failing} of {s.total} recent records would fail with this version
            </p>
          )}
        </div>
      )}
    </div>
  )

  return (
    <PanelFrame title={`Publish v${next}`} panel='publish' onClose={onClose} footer={footer}>
      <div className='space-y-4 px-4 py-3'>
        {nothingToPublish ? (
          <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
            Nothing to publish — the draft is the same as live v{template.published_version}. Edit
            the field map or the code, then come back here.
          </p>
        ) : (
          <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
            {live
              ? `v${next} replaces live v${template.published_version}`
              : `v${next} is the first live version`}
            {uses.length
              ? ` for ${uses.join(' and ')} the moment you publish.`
              : '. Nothing sends this payload yet.'}{' '}
            You can restore an older version from History afterwards.
            {lookupsChange &&
              ' It also changes the lookups — the Template + lookups view below lists them.'}
          </p>
        )}

        {!nothingToPublish && mountSave === 'failed' && (
          <p
            className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
            role='status'
            data-payload-publish-unsaved
          >
            {ctx.conflicted
              ? 'Saving is paused by the conflict above, so the check below covers the last saved draft. Reload, or keep your draft, before publishing.'
              : `Your latest edit didn't save${ctx.saveError ? ` (${ctx.saveError.message})` : ''}, so the check below covers the last saved draft. Fix it before publishing.`}
          </p>
        )}

        {!nothingToPublish && (
          <section aria-label='Recent records' className='space-y-2'>
            <h3 className={SECTION_LABEL}>Recent records with this draft</h3>
            {checking && (
              <CheckProgress
                what='your draft'
                done={check.done}
                total={checkRev == null || ctx.saving ? null : check.total}
              />
            )}
            {check.status === 'error' ? (
              <InlineError
                title="The recent records couldn't be checked. You can still publish."
                error={check.error}
                onRetry={() => setRetryN((n) => n + 1)}
              />
            ) : (
              <>
                {check.status === 'done' && (
                  <CheckSummary results={results} collection={template.collection} />
                )}
                <CheckResultsList
                  results={results}
                  collection={template.collection}
                  onPreview={onPreview}
                  failuresOnly
                  spec={draft.mode === 'map' ? draft.body : null}
                  partner={template.external_api}
                />
              </>
            )}
          </section>
        )}

        <section aria-label='Payload diff' className='space-y-2'>
          <h3 className={SECTION_LABEL}>
            {live ? `Payload: live v${template.published_version} → draft` : 'Payload this sends'}
          </h3>
          {!live && (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Nothing is live yet, so every line below is new.
            </p>
          )}
          <BodyCompare
            templateKey={template.key}
            collection={template.collection}
            recordId={recordId}
            onRecordChange={onRecordChange}
            before={{
              label: live ? `live v${template.published_version}` : 'nothing live yet',
              body: live,
              lookups: liveLookupsOf(template),
              source: 'published'
            }}
            after={{
              label: 'draft',
              body: draft,
              lookups: draftLookupsOf(template),
              source: 'draft'
            }}
            sameText={{
              payload: `The draft sends the same body as live v${template.published_version} for this record.`,
              template: 'The draft template is the same as live.'
            }}
          />
        </section>
      </div>
    </PanelFrame>
  )
}
