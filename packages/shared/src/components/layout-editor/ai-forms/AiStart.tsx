import { FileImage, FileText, Wand2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { useLayoutEditorHost } from '../host'
import { createLayout } from '../overview/OverviewActions'
import { apiFailure } from '../overview/overview-api'
import { AiComposer } from './AiComposer'
import { type ComposeMode, emptyBundle } from './ai-forms-api'
import { stashBuild } from './pending'

/**
 * The overview's New form → "Start with AI" (#2668 #2669 #2670): the
 * proposal is reviewed here against an empty form; "Create form" makes the
 * layout and opens it with the build waiting as one unsaved draft step.
 */

const OPTIONS: Array<{ mode: ComposeMode; label: string; icon: typeof Wand2 }> = [
  { mode: 'describe', label: 'Describe it', icon: Wand2 },
  { mode: 'picture', label: 'From a picture or PDF', icon: FileImage },
  { mode: 'sop', label: 'From a process document', icon: FileText }
]

/** Three rows under the kind list; only for forms, only for admins. */
export function AiStartOptions({ onPick }: { onPick: (mode: ComposeMode) => void }) {
  const host = useLayoutEditorHost()
  if (!host.isAdmin) return null
  return (
    <div className='mt-3 border-t border-slate-200 pt-2 dark:border-border' data-ai-start=''>
      <p className='mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'>
        Start with AI
      </p>
      <div className='flex flex-col gap-0.5'>
        {OPTIONS.map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            type='button'
            onClick={() => onPick(mode)}
            data-ai-start-option={mode}
            className='flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] font-medium text-slate-800 transition-colors hover:bg-muted dark:text-foreground'
          >
            <Icon className='h-3.5 w-3.5 text-[#0089ad] dark:text-nvr-cyan' />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function AiStartComposer({
  collection,
  mode,
  name,
  onBack,
  onCreated
}: {
  collection: string
  mode: ComposeMode
  /** The name typed in New form; the AI's name when it was left as the default. */
  name: string | null
  onBack: () => void
  onCreated: (id: number) => void
}) {
  const client = useNivaroClient()
  const bundle = useMemo(() => emptyBundle(collection), [collection])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className='space-y-2'>
      <AiComposer
        collection={collection}
        mode={mode}
        bundle={bundle}
        busy={busy}
        onBack={onBack}
        applyLabel={() => (busy ? 'Creating…' : 'Create form')}
        onApply={async (build, result) => {
          setBusy(true)
          setError(null)
          try {
            const id = await createLayout(client, {
              collection,
              name: (name?.trim() || result.form.name || 'New form').slice(0, 80),
              layout_type: 'grouped'
            })
            if (id == null) throw new Error('No id came back')
            stashBuild(id, {
              label: 'Build with AI',
              plan: build,
              done: 'Form drafted from your input. Check it, then Save.'
            })
            onCreated(id)
          } catch (err) {
            setError(apiFailure(err, 'Could not create the form').message)
          } finally {
            setBusy(false)
          }
        }}
      />
      {error && (
        <p role='alert' className='text-[12.5px] leading-snug text-red-700 dark:text-red-300'>
          {error}
        </p>
      )}
    </div>
  )
}
