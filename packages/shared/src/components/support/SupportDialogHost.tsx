import { useEffect, useState } from 'react'
import { registerSupportDialog, type SupportDraft } from '../../lib/error-actions'
import { SupportRequestDialog } from './SupportRequestDialog'

/**
 * Mount ONCE at the app root, inside NivaroProvider + QueryClientProvider: every error's
 * "Get help" / "Ask for access" (ErrorNotice, error toasts, runErrorAction 'contact') then opens
 * the Get help dialog over the current page, filled in with what happened, instead of the
 * Support page in a new tab.
 */
export function SupportDialogHost() {
  const [draft, setDraft] = useState<(SupportDraft & { key: number }) | null>(null)
  useEffect(() => registerSupportDialog((next) => setDraft({ ...next, key: Date.now() })), [])
  if (!draft) return null
  return (
    <SupportRequestDialog
      // A fresh dialog per request: the dialog keeps typed text while open and only fills an
      // empty title/description, so a second Get help must not inherit the first one's text.
      key={draft.key}
      open
      onOpenChange={(open) => {
        if (!open) setDraft(null)
      }}
      initialTitle={draft.title}
      initialDescription={draft.description}
      source='error'
    />
  )
}
