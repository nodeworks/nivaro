import { useState } from 'react'

/**
 * Visual schedule builder (#376): preset-driven cron editor — nobody should
 * have to remember cron syntax for "every day at 3am". Advanced mode keeps
 * the raw string for anything the presets can't say.
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parsePreset(cron: string): {
  kind: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'
  n?: number
  hour?: number
  minute?: number
  dow?: number
  dom?: number
} {
  const m = cron.trim().split(/\s+/)
  if (m.length !== 5) return { kind: 'custom' }
  const [min, hour, dom, , dow] = m
  const every = min.match(/^\*\/(\d+)$/)
  if (every && hour === '*' && dom === '*' && dow === '*')
    return { kind: 'minutes', n: Number(every[1]) }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && dow === '*')
    return { kind: 'hourly', minute: Number(min) }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && dow === '*')
    return { kind: 'daily', hour: Number(hour), minute: Number(min) }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && /^\d+$/.test(dow))
    return { kind: 'weekly', hour: Number(hour), minute: Number(min), dow: Number(dow) }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && dow === '*')
    return { kind: 'monthly', hour: Number(hour), minute: Number(min), dom: Number(dom) }
  return { kind: 'custom' }
}

export function describeCron(cron: string): string {
  const p = parsePreset(cron)
  const t = (h?: number, m?: number) =>
    `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`
  switch (p.kind) {
    case 'minutes':
      return `every ${p.n} minute${p.n === 1 ? '' : 's'}`
    case 'hourly':
      return `hourly at :${String(p.minute ?? 0).padStart(2, '0')}`
    case 'daily':
      return `daily at ${t(p.hour, p.minute)}`
    case 'weekly':
      return `${DOW[p.dow ?? 0]} at ${t(p.hour, p.minute)}`
    case 'monthly':
      return `day ${p.dom} of the month at ${t(p.hour, p.minute)}`
    default:
      return cron
  }
}

export function CronBuilder({
  value,
  onChange,
  disabled
}: {
  value: string
  onChange: (cron: string) => void
  disabled?: boolean
}) {
  const parsed = parsePreset(value || '0 3 * * *')
  const [mode, setMode] = useState<'visual' | 'raw'>(parsed.kind === 'custom' ? 'raw' : 'visual')
  const p = parsed.kind === 'custom' ? { kind: 'daily' as const, hour: 3, minute: 0 } : parsed

  const emit = (next: { kind: string; n?: number; hour?: number; minute?: number; dow?: number; dom?: number }) => {
    const mm = next.minute ?? 0
    const hh = next.hour ?? 3
    switch (next.kind) {
      case 'minutes':
        onChange(`*/${next.n ?? 15} * * * *`)
        break
      case 'hourly':
        onChange(`${mm} * * * *`)
        break
      case 'daily':
        onChange(`${mm} ${hh} * * *`)
        break
      case 'weekly':
        onChange(`${mm} ${hh} * * ${next.dow ?? 1}`)
        break
      case 'monthly':
        onChange(`${mm} ${hh} ${next.dom ?? 1} * *`)
        break
    }
  }

  const numInput = (
    val: number,
    min: number,
    max: number,
    set: (n: number) => void,
    w = 'w-14'
  ) => (
    <input
      value={String(val)}
      disabled={disabled}
      inputMode='numeric'
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n)))
      }}
      className={`${w} h-7 rounded-md border border-slate-200 bg-background px-1.5 text-center tabular-nums text-[12.5px] dark:border-border`}
    />
  )

  return (
    <div className='space-y-1.5' data-cron-builder>
      <div className='flex items-center gap-1.5'>
        {(
          [
            ['minutes', 'Every N min'],
            ['hourly', 'Hourly'],
            ['daily', 'Daily'],
            ['weekly', 'Weekly'],
            ['monthly', 'Monthly']
          ] as Array<[string, string]>
        ).map(([kind, label]) => (
          <button
            key={kind}
            type='button'
            disabled={disabled}
            onClick={() => {
              setMode('visual')
              emit({ ...p, kind })
            }}
            className={
              mode === 'visual' && p.kind === kind
                ? 'rounded-md bg-nvr-cyan/10 px-2 py-1 text-[11.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
                : 'rounded-md px-2 py-1 text-[11.5px] text-slate-500 hover:bg-muted'
            }
          >
            {label}
          </button>
        ))}
        <button
          type='button'
          disabled={disabled}
          onClick={() => setMode(mode === 'raw' ? 'visual' : 'raw')}
          className={
            mode === 'raw'
              ? 'ml-auto rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] font-medium dark:bg-muted'
              : 'ml-auto rounded-md px-2 py-1 font-mono text-[11px] text-slate-400 hover:bg-muted'
          }
        >
          cron
        </button>
      </div>
      {mode === 'raw' ? (
        <input
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder='0 3 * * *'
          className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12.5px] dark:border-border'
        />
      ) : (
        <div className='flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-600 dark:text-slate-300'>
          {p.kind === 'minutes' && (
            <>
              every {numInput(p.n ?? 15, 1, 59, (n) => emit({ ...p, kind: 'minutes', n }))} minutes
            </>
          )}
          {p.kind === 'hourly' && (
            <>
              hourly at minute{' '}
              {numInput(p.minute ?? 0, 0, 59, (minute) => emit({ ...p, kind: 'hourly', minute }))}
            </>
          )}
          {(p.kind === 'daily' || p.kind === 'weekly' || p.kind === 'monthly') && (
            <>
              {p.kind === 'weekly' && (
                <span className='flex gap-0.5'>
                  {DOW.map((d, i) => (
                    <button
                      key={d}
                      type='button'
                      disabled={disabled}
                      onClick={() => emit({ ...p, kind: 'weekly', dow: i })}
                      className={
                        (p as { dow?: number }).dow === i
                          ? 'rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[11px] font-semibold text-nvr-navy dark:text-nvr-cyan'
                          : 'rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-muted'
                      }
                    >
                      {d}
                    </button>
                  ))}
                </span>
              )}
              {p.kind === 'monthly' && (
                <>
                  day{' '}
                  {numInput((p as { dom?: number }).dom ?? 1, 1, 28, (dom) =>
                    emit({ ...p, kind: 'monthly', dom })
                  )}
                </>
              )}
              at {numInput(p.hour ?? 3, 0, 23, (hour) => emit({ ...p, kind: p.kind, hour }))}:
              {numInput(p.minute ?? 0, 0, 59, (minute) => emit({ ...p, kind: p.kind, minute }))}
            </>
          )}
          <span className='ml-1 font-mono text-[10.5px] text-slate-400'>{value}</span>
        </div>
      )}
      <p className='text-[11px] text-slate-400'>Runs {describeCron(value || '0 3 * * *')}.</p>
    </div>
  )
}
