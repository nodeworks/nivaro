import { cn } from '@/lib/utils'

export type EditorView = 'editor' | 'diagram'

/** Small Editor / Diagram switch shown above an editor page. */
export function DiagramTabs({
  value,
  onChange
}: {
  value: EditorView
  onChange: (v: EditorView) => void
}) {
  return (
    <div
      role='tablist'
      aria-label='Editor or diagram'
      className='flex shrink-0 gap-1 border-b border-slate-200 bg-white px-6 pt-2 dark:border-border dark:bg-card'
    >
      {(['editor', 'diagram'] as const).map((v) => (
        <button
          key={v}
          type='button'
          role='tab'
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cn(
            '-mb-px border-b-2 px-3 py-1.5 text-[12px] font-medium transition-colors',
            value === v
              ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-foreground'
          )}
        >
          {v === 'editor' ? 'Editor' : 'Diagram'}
        </button>
      ))}
    </div>
  )
}
