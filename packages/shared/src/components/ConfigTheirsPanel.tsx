import type { ConfigFieldDiff } from '../lib/config-watch'

/**
 * "Beth's version" beside yours (rt4 #14): opened from the change strip's Show while the editor
 * holds unsaved edits. Read-only — it lists only the fields where their saved copy and your form
 * differ. Nothing in your form changes unless you press "Take theirs"; "Keep mine" closes it and
 * lets your next save go over theirs (you have seen it). Light and dark.
 */
export function ConfigTheirsPanel({
  who,
  rows,
  onTakeTheirs,
  onKeepMine,
  className
}: {
  who: string
  rows: ConfigFieldDiff[]
  onTakeTheirs: () => void
  onKeepMine: () => void
  className?: string
}) {
  const btn =
    'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
  return (
    <section
      data-config-theirs
      aria-label={`${who}'s version`}
      className={`border-b border-slate-200 bg-white text-[12px] motion-safe:animate-[nvr-fade-in_240ms_ease-out_backwards] dark:border-border dark:bg-card ${className ?? ''}`}
    >
      <header className='flex flex-wrap items-center gap-2 px-4 py-2'>
        <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan' aria-hidden />
        <span className='font-medium text-slate-800 dark:text-foreground'>
          {who}'s saved version
        </span>
        <span className='text-slate-500 dark:text-muted-foreground'>
          {rows.length
            ? `${rows.length} ${rows.length === 1 ? 'field differs' : 'fields differ'} from your form. Nothing in your form has changed yet.`
            : 'Same as your form.'}
        </span>
        <span className='ml-auto flex items-center gap-2'>
          <button
            type='button'
            onClick={onKeepMine}
            className={`${btn} border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-border dark:text-foreground dark:hover:bg-muted`}
          >
            Keep mine
          </button>
          <button
            type='button'
            onClick={onTakeTheirs}
            className={`${btn} bg-nvr-cyan text-white hover:opacity-90`}
          >
            Take theirs
          </button>
        </span>
      </header>
      {rows.length > 0 && (
        <div className='max-h-[320px] overflow-auto border-t border-slate-100 dark:border-border'>
          <table className='w-full table-fixed text-left'>
            <thead className='sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-muted dark:text-muted-foreground'>
              <tr>
                <th className='w-[22%] px-4 py-1.5 font-medium'>Field</th>
                <th className='px-4 py-1.5 font-medium'>Theirs (saved)</th>
                <th className='px-4 py-1.5 font-medium'>Yours (unsaved)</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {rows.map((r) => (
                <tr key={r.key} className='align-top'>
                  <td className='px-4 py-1.5 font-medium text-slate-700 dark:text-foreground'>
                    {r.label}
                  </td>
                  <td
                    className={`break-words px-4 py-1.5 text-slate-700 dark:text-slate-200 ${r.code ? 'font-mono text-[11.5px]' : ''}`}
                  >
                    {r.theirs}
                  </td>
                  <td
                    className={`break-words px-4 py-1.5 text-slate-500 dark:text-slate-400 ${r.code ? 'font-mono text-[11.5px]' : ''}`}
                  >
                    {r.mine}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
