import { Search, X } from 'lucide-react'
import { type ComponentType, useCallback, useMemo, useState } from 'react'
import type { LayoutBundle, LayoutOp, LayoutPatch } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { PanelHeader } from '../panel-frame'
import { groupTitle } from '../panel-style'
import type { ApplyOptions } from '../useLayoutDraft'
import { AddendumSection } from './AddendumSection'
import { ButtonsSection } from './ButtonsSection'
import { inputCls, quietText, VisibleSettingsContext } from './controls'
import { DefaultsSection } from './DefaultsSection'
import { InheritanceSection } from './InheritanceSection'
import { LayoutSection } from './LayoutSection'
import { PdfSection } from './PdfSection'
import { ReadSection } from './ReadSection'
import type { SectionProps } from './section-props'
import type { RolePreview } from './settings-api'
import { layoutKindOf, type SectionId, visibleSections } from './settings-registry'
import { ToolsSection } from './ToolsSection'
import { WhoSection } from './WhoSection'

const SECTION_BODIES: Record<SectionId, ComponentType<SectionProps & Record<string, unknown>>> = {
  who: WhoSection,
  layout: LayoutSection,
  buttons: ButtonsSection,
  read: ReadSection,
  pdf: PdfSection,
  addendum: AddendumSection,
  defaults: DefaultsSection,
  inheritance: InheritanceSection,
  tools: ToolsSection as ComponentType<SectionProps & Record<string, unknown>>
}

export interface FormSettingsProps {
  bundle: LayoutBundle
  /** The draft's apply (useLayoutDraft). Every setting is one labelled `layout_update`. */
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  /** Send typed text now (inputs call it on blur). */
  flush?: () => void
  collection: string
  /** Preview as role: the canvas may mark the fields this role cannot see or edit. */
  onPreviewRole?: (preview: RolePreview | null) => void
  /**
   * The previewed role, when the host shares it with another picker (the
   * editor's top bar). With `onPreviewRoleChange` the setting follows this
   * value and reports picks instead of keeping its own.
   */
  previewRoleId?: string | null
  onPreviewRoleChange?: (roleId: string | null) => void
}

/**
 * Form settings — the whole-layout settings, in short named sections in the order
 * an admin thinks (spec §7.2), filtered to the layout's type and searchable by
 * label, effect sentence or key. Every change autosaves through the draft as one
 * undoable step.
 */
export function FormSettings({
  bundle,
  apply,
  flush,
  collection,
  onPreviewRole,
  previewRoleId,
  onPreviewRoleChange
}: FormSettingsProps) {
  const [query, setQuery] = useState('')
  const kind = layoutKindOf(bundle.layout)
  const sections = useMemo(() => visibleSections(kind, query), [kind, query])
  const visible = useMemo(
    () => new Set(sections.flatMap((s) => s.settings.map((d) => d.key))),
    [sections]
  )
  const doFlush = useCallback(() => flush?.(), [flush])
  const props: SectionProps = useMemo(
    () => ({
      bundle,
      layout: bundle.layout as Record<string, unknown>,
      kind,
      collection,
      set: (patch: LayoutPatch, label: string, opts?: { undoable?: boolean }) =>
        apply(
          [{ op: 'layout_update', patch }],
          opts?.undoable === false ? { label, undoable: false } : { label }
        ),
      setText: (patch: LayoutPatch, label: string) =>
        apply([{ op: 'layout_update', patch }], { label, text: true }),
      flush: doFlush
    }),
    [bundle, kind, collection, apply, doFlush]
  )

  const name = typeof bundle.layout.name === 'string' ? bundle.layout.name : ''

  return (
    <div className='flex h-full min-h-0 flex-col' data-form-settings={kind}>
      <PanelHeader
        eyebrow='Form settings'
        title={name || 'This form'}
        sub='Who gets this form and how it behaves'
      >
        <div className='relative'>
          <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Find a setting…'
            aria-label='Find a setting'
            data-settings-search
            className={cn(inputCls, 'pl-8 pr-8')}
          />
          {query && (
            <button
              type='button'
              aria-label='Clear search'
              onClick={() => setQuery('')}
              className='absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-foreground'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      </PanelHeader>
      <div data-panel-body='' className='min-h-0 flex-1 overflow-y-auto px-4 pb-8'>
        {sections.length === 0 ? (
          <p className={cn('py-8 text-center', quietText)}>No setting matches “{query.trim()}”.</p>
        ) : (
          <VisibleSettingsContext.Provider value={visible}>
            {sections.map(({ section }) => {
              const Body = SECTION_BODIES[section.id]
              return (
                <section
                  key={section.id}
                  data-section={section.id}
                  aria-labelledby={`form-settings-${section.id}`}
                  className='border-t border-slate-100 pb-6 first:border-t-0 dark:border-border/60'
                >
                  {/* Sticky: the section a row belongs to stays named while scrolling. */}
                  <h3
                    id={`form-settings-${section.id}`}
                    className={cn(
                      groupTitle,
                      'sticky top-0 z-10 -mx-4 bg-white px-4 pb-3 pt-4 dark:bg-card'
                    )}
                  >
                    {section.title}
                  </h3>
                  <div className='space-y-5'>
                    <Body
                      {...props}
                      onPreviewRole={onPreviewRole}
                      previewRoleId={previewRoleId}
                      onPreviewRoleChange={onPreviewRoleChange}
                    />
                  </div>
                </section>
              )
            })}
          </VisibleSettingsContext.Provider>
        )}
      </div>
    </div>
  )
}
