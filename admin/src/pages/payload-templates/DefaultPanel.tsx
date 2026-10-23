import { RotateCcw } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type DraftBody, errorMessage, publishedOf, sameBody, type TemplateDetail } from './api'
import { usePayloadEditor } from './editor-context'
import { defaultOf, useResetDefault } from './panel-api'
import { BodyCompare, OUTLINE_BTN, PanelFrame, STRONG_BTN } from './panel-parts'

/** What taking the default does to a draft, in words (a mode switch said out loud). */
export function defaultCopy(owner: string, def: DraftBody, draft: DraftBody): string {
  const base = `The draft becomes the default ${owner} ships. Nothing goes live until you publish.`
  if (def.mode === draft.mode) return base
  return def.mode === 'map'
    ? `${base} The default is a field map, so this payload switches back from Liquid to the field map.`
    : `${base} The default is Liquid, so the field map goes away.`
}

/** POST reset-default → the editor adopts the new draft. Shared by the panel and the banner. */
export function useTakeDefault(template: TemplateDetail) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const reset = useResetDefault(template.key)
  const owner = template.owner ?? 'The extension'
  const take = useCallback(async (): Promise<string | null> => {
    try {
      await ctxRef.current.discardPending()
      await reset.mutateAsync()
      await ctxRef.current.adoptServerDraft()
      toast.success(`The draft now holds the ${owner} default`, {
        description: 'Nothing goes live until you publish.'
      })
      return null
    } catch (e) {
      return errorMessage(e, 'The default was not copied into the draft')
    }
  }, [reset, owner])
  return { take, pending: reset.isPending }
}

/**
 * The file default the registrar ships: its diff against the draft, and
 * **Use as draft** (newer default) / **Reset to file default**.
 */
export function DefaultPanel({
  template,
  draft,
  recordId,
  onRecordChange,
  onClose
}: {
  template: TemplateDetail
  draft: DraftBody
  recordId: string | null
  onRecordChange: (id: string) => void
  onClose: () => void
}) {
  const def = defaultOf(template)
  const owner = template.owner ?? 'The extension'
  const newer = template.newer_default
  const { take, pending } = useTakeDefault(template)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = publishedOf(template)
  const unpublished = !live || !sameBody(draft, live)
  const matches = def ? sameBody(def, draft) : false
  const action = newer ? 'Use as draft' : 'Reset to file default'
  // Ask first when something would be lost or the mode would switch.
  const needsConfirm = unpublished || def?.mode !== draft.mode

  const go = async () => {
    setError(null)
    const err = await take()
    if (err) setError(err)
    else onClose()
  }

  if (!def)
    return (
      <PanelFrame title='File default' panel='default' onClose={onClose}>
        <p className='px-4 py-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          {template.owner
            ? `${template.owner} isn't loaded on this server, so its file default can't be read. History still has every published version.`
            : 'This payload was created here, so there is no file default. History has every published version.'}
        </p>
      </PanelFrame>
    )

  return (
    <PanelFrame
      title={newer ? `${owner} ships a newer default` : 'File default'}
      panel='default'
      onClose={onClose}
      footer={
        <div className='space-y-2'>
          {confirming && (
            <p
              className='text-[12.5px] text-slate-600 dark:text-slate-300'
              data-payload-default-confirm
            >
              {defaultCopy(owner, def, draft)}
              {unpublished ? ' Your unpublished changes are not kept as a version.' : ''}
            </p>
          )}
          {error && (
            <p className='text-[12px] text-red-700 dark:text-red-300' role='alert'>
              {error}
            </p>
          )}
          <div className='flex flex-wrap gap-2'>
            <span data-tip={matches ? 'The draft already matches the default' : undefined}>
              <button
                type='button'
                disabled={matches || pending}
                onClick={() => (needsConfirm && !confirming ? setConfirming(true) : void go())}
                className={STRONG_BTN}
                data-payload-default-go
              >
                <RotateCcw className='h-3.5 w-3.5' />
                {pending ? 'Copying…' : confirming ? `${action} — replace my draft` : action}
              </button>
            </span>
            {confirming && (
              <button
                type='button'
                onClick={() => setConfirming(false)}
                disabled={pending}
                className={OUTLINE_BTN}
              >
                Keep my draft
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className='space-y-3 px-4 py-3'>
        <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          {matches
            ? newer
              ? 'The draft holds this default. Publish it to make it live.'
              : 'The draft is the same as the file default.'
            : newer
              ? `${owner} changed the default it ships for this payload. File changes never go live by themselves: use it as the draft, check it, then publish.`
              : `The default ${owner} ships for this payload, compared with your draft.`}
        </p>
        <BodyCompare
          templateKey={template.key}
          collection={template.collection}
          recordId={recordId}
          onRecordChange={onRecordChange}
          before={{ label: 'your draft', body: draft }}
          after={{ label: `${owner} default`, body: def }}
          sameText={{
            payload: 'The default sends the same body as your draft for this record.',
            template: 'The default is the same template as your draft.'
          }}
        />
      </div>
    </PanelFrame>
  )
}
