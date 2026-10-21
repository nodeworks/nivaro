import { ChevronRight, FileImage, FileText, Sparkles, UserRound, Wand2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent } from '../../ui/popover'
import { useLayoutEditorHost } from '../host'
import { ToolButton } from '../toolbar-kit'
import type { LayoutDraft } from '../useLayoutDraft'
import { AiComposer } from './AiComposer'
import type { ComposeMode } from './ai-forms-api'
import { MeaningSuggestions } from './MeaningSuggestions'
import { usePendingBuild } from './pending'
import { SlimPanel } from './SlimPanel'

/**
 * AI → "Rebuild or lighter version" (admins): rebuild the draft from a description, a
 * picture / PDF of an old form or a process document (#2668-#2670), make a
 * lighter version for a role (#2671), or place unplaced fields by meaning
 * (#2672). Every proposal is reviewed in plain words first and lands through
 * the draft as one undo step that still needs Save. Also applies a build
 * waiting for this layout (a form just created from the overview's "Start
 * with AI" or a lighter version).
 */

type View = 'menu' | ComposeMode | 'slim' | 'meaning'

export function AiFormsButton({
  collection,
  layoutId,
  draft,
  onOpenLayout
}: {
  collection: string
  layoutId: number
  draft: Pick<LayoutDraft, 'bundle' | 'apply'>
  onOpenLayout: (id: number) => void
}) {
  const host = useLayoutEditorHost()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('menu')
  usePendingBuild(layoutId, draft)
  const bundle = draft.bundle
  if (!host.isAdmin || !bundle) return null
  const layout = bundle.layout as Record<string, unknown>
  const slimOk = (layout.layout_type ?? 'grouped') === 'grouped' && !layout.parent_layout_id

  const close = () => {
    setOpen(false)
    setView('menu')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setView('menu')
      }}
    >
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Rebuild or lighter version'
        icon={<Wand2 className='h-3.5 w-3.5 text-nvr-cyan' />}
        tip='Rebuild this form with AI, or make a lighter version for a role'
        hint='From a description, a picture or a process; lighter for a role'
        data={{ 'data-ai-forms-trigger': '' }}
      />
      <PopoverContent
        align='end'
        className='max-h-[min(72vh,560px)] w-[460px] overflow-y-auto overscroll-contain p-3'
        data-ai-forms=''
      >
        {view === 'menu' && (
          <div className='flex flex-col gap-0.5'>
            <p className='px-2 pb-1 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
              Rebuild with AI
            </p>
            <MenuRow
              icon={<Wand2 className='h-3.5 w-3.5' />}
              title='From a description'
              sub='“a returns form with a manager approval step”'
              onClick={() => setView('describe')}
            />
            <MenuRow
              icon={<FileImage className='h-3.5 w-3.5' />}
              title='From a picture or PDF'
              sub='An old paper, PDF or Excel form, matched to fields'
              onClick={() => setView('picture')}
            />
            <MenuRow
              icon={<FileText className='h-3.5 w-3.5' />}
              title='From a process document'
              sub='Steps per stage, with read-only and required fields'
              onClick={() => setView('sop')}
            />
            <p className='px-2 pb-1 pt-2 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
              More
            </p>
            <MenuRow
              icon={<UserRound className='h-3.5 w-3.5' />}
              title='Lighter version for a role'
              sub={
                slimOk
                  ? 'Only the fields that role really fills'
                  : 'Made from a form that does not inherit from another'
              }
              disabled={!slimOk}
              onClick={() => setView('slim')}
            />
            <MenuRow
              icon={<Sparkles className='h-3.5 w-3.5' />}
              title='Place new fields by meaning'
              sub='A section for each field not on the form'
              onClick={() => setView('meaning')}
            />
          </div>
        )}
        {(view === 'describe' || view === 'picture' || view === 'sop') && (
          <AiComposer
            collection={collection}
            mode={view}
            bundle={bundle}
            onBack={() => setView('menu')}
            applyLabel={(plan) =>
              plan.steps.length > 1 ? `Apply ${plan.steps.length} changes` : 'Apply'
            }
            onApply={(build) => {
              const current = draft.bundle
              if (!current) return
              const plan = build(current)
              if (plan.ops.length === 0) {
                toast.error('Nothing left to change on the form as it is now')
                return
              }
              draft.apply(plan.ops, { label: 'Rebuild with AI' })
              toast.success('Rebuilt. Check the form, then Save — or undo it in one step.')
              close()
            }}
          />
        )}
        {view === 'slim' && (
          <SlimPanel
            collection={collection}
            layoutId={layoutId}
            parentGroups={bundle.groups}
            onBack={() => setView('menu')}
            onOpenLayout={(id) => {
              close()
              onOpenLayout(id)
            }}
          />
        )}
        {view === 'meaning' && (
          <div className='space-y-2'>
            <MeaningSuggestions bundle={bundle} collection={collection} apply={draft.apply} />
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Nothing shows when every field is already on the form or the form has no section yet.
              The same suggestions sit at the top of the Add panel.
            </p>
            <div className='flex justify-end'>
              <button
                type='button'
                className='inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted dark:text-muted-foreground'
                onClick={() => setView('menu')}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function MenuRow({
  icon,
  title,
  sub,
  onClick,
  disabled
}: {
  icon: ReactNode
  title: string
  sub: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      data-ai-forms-option={title}
      className='group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50'
    >
      <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-nvr-cyan/10 text-[#0089ad] dark:text-nvr-cyan'>
        {icon}
      </span>
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {title}
        </span>
        <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {sub}
        </span>
      </span>
      <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
    </button>
  )
}
