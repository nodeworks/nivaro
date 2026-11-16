import { ConfirmButton } from '@nivaro/shared'
import { Undo2 } from 'lucide-react'
import { useRef } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { errorMessage, staleCurrent, type TemplateDetail } from './api'
import { usePayloadEditor } from './editor-context'
import { useDiscardDraft } from './panel-api'
import { OUTLINE_BTN } from './panel-parts'

/**
 * Throw the working copy away and go back to the live version (POST /:key/discard-draft).
 * Two presses, never a native confirm. The editor's waiting autosave is dropped first (and a
 * save in flight waited out), so the request names the revision the server really holds; a
 * 409 raises the conflict banner like Publish does. The caller shows it only while the draft
 * differs from a live version — a never-published template has nothing to go back to.
 */
export function DiscardDraftButton({ template }: { template: TemplateDetail }) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const discard = useDiscardDraft(template.key)
  const live = template.published_version

  const run = async () => {
    try {
      await ctxRef.current.discardPending()
      await discard.mutateAsync({
        base_rev: ctxRef.current.getRev() ?? template.draft_rev,
        base_published_version: ctxRef.current.getLoadedVersion(template.key)
      })
      await ctxRef.current.adoptServerDraft()
      toast.success(`Discarded the draft of ${template.label}`, {
        description: `The editor shows live v${live} again.`
      })
    } catch (e) {
      const current = staleCurrent(e)
      if (current) {
        ctxRef.current.raiseConflict(current)
        toast.error('The draft changed on the server', {
          description: 'Review the banner above, then discard again if you still want to.'
        })
      } else toast.error(errorMessage(e, 'The draft was not discarded'))
    }
  }

  return (
    <ConfirmButton
      onConfirm={() => void run()}
      disabled={discard.isPending || ctx.conflicted}
      title={`Throw the draft away and go back to live v${live}`}
      confirmLabel={`Back to v${live}?`}
      confirmTitle={`Discard the draft and go back to live v${live}?`}
      className={OUTLINE_BTN}
      armedClassName={cn(
        'border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
        'dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25'
      )}
    >
      <Undo2 className='h-3.5 w-3.5 text-slate-400' />
      {discard.isPending ? 'Discarding…' : 'Discard draft'}
    </ConfirmButton>
  )
}
