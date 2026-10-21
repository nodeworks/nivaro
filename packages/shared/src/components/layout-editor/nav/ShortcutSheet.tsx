import { Fragment } from 'react'
import { keyLabels, shortcutGroups } from '../shortcuts'

// The shortcut sheet (#2626): every row of the shortcuts registry, grouped
// by area. Opened with ? anywhere in the editor (not while typing).

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className='inline-flex items-center gap-0.5'>
      {keyLabels(keys).map((k) => (
        <kbd
          key={k}
          className='inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[11px] font-medium text-slate-700 dark:border-border dark:bg-muted dark:text-foreground'
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutSheet() {
  return (
    <div data-editor-shortcuts='' className='flex flex-col gap-3 p-3'>
      <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        Keyboard shortcuts
      </p>
      {shortcutGroups().map((g) => (
        <section key={g.area} aria-label={g.area}>
          <p className='mb-1 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'>
            {g.area}
          </p>
          <dl className='m-0 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5'>
            {g.items.map((s) => (
              <Fragment key={s.id}>
                <dt className='text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
                  {s.label}
                </dt>
                <dd data-shortcut={s.id} className='m-0 flex flex-wrap justify-end gap-1.5'>
                  {s.keys.map((k, i) => (
                    <Fragment key={k.join('+')}>
                      {i > 0 && (
                        <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                          or
                        </span>
                      )}
                      <Keys keys={k} />
                    </Fragment>
                  ))}
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
