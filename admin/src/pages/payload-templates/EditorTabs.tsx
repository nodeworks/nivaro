import { cn } from '@/lib/utils'
import type { DraftBody, MapSpec, Problem, TemplateDetail } from './api'
import { CodeTab } from './CodeTab'
import { DataTab } from './DataTab'
import { FieldMap } from './field-map/FieldMap'

export type EditorTab = 'map' | 'code' | 'data'

export interface EditorTabsProps {
  tab: EditorTab
  onTabChange: (t: EditorTab) => void
  template: TemplateDetail
  draft: DraftBody
  onDraftChange: (next: DraftBody) => void
  /** From the draft preview of the chosen record (server-computed; the client never evaluates). */
  values: Record<string, unknown>
  problems: Problem[]
  secretNames: string[]
}

const TABS: { id: EditorTab; label: string }[] = [
  { id: 'map', label: 'Field map' },
  { id: 'code', label: 'Code' },
  { id: 'data', label: 'Data' }
]

/**
 * The editor column: tab bar (Field map · Code · Data) and the active tab's
 * body. The three bodies live in their own files (field-map/FieldMap,
 * CodeTab, DataTab) and only ever see these props.
 */
export function EditorTabs({
  tab,
  onTabChange,
  template,
  draft,
  onDraftChange,
  values,
  problems,
  secretNames
}: EditorTabsProps) {
  const isCode = draft.mode === 'code'
  const active: EditorTab = isCode && tab === 'map' ? 'code' : tab
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div
        className='flex shrink-0 items-end gap-1 border-b border-slate-200 px-4 dark:border-border'
        role='tablist'
        aria-label='Editor'
      >
        {TABS.map((t) => {
          const off = t.id === 'map' && isCode
          return (
            <span
              key={t.id}
              role='presentation'
              data-tip={
                off ? 'A code template is written in Liquid — it has no field map' : undefined
              }
            >
              <button
                type='button'
                role='tab'
                aria-selected={active === t.id}
                disabled={off}
                onClick={() => onTabChange(t.id)}
                className={cn(
                  '-mb-px border-b-2 px-2.5 pb-2 pt-2.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
                  active === t.id
                    ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                )}
                data-editor-tab={t.id}
              >
                {t.label}
              </button>
            </span>
          )
        })}
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto' role='tabpanel'>
        {active === 'map' && draft.mode === 'map' ? (
          <FieldMap
            spec={draft.body}
            onChange={(spec: MapSpec) => onDraftChange({ mode: 'map', body: spec })}
            values={values}
            problems={problems}
            lockedKeys={template.locked_keys}
            secretNames={secretNames}
            collection={template.collection}
          />
        ) : active === 'code' ? (
          <CodeTab template={template} draft={draft} onChange={onDraftChange} problems={problems} />
        ) : (
          <DataTab template={template} />
        )}
      </div>
    </div>
  )
}
