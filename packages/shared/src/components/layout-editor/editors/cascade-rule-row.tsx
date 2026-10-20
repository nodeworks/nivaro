import { useState } from 'react'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'

export type CascadeRuleCfg = { parent_field: string; child_field: string; on_unavailable?: unknown }

export function CascadeRuleRow({
  rule,
  parentFields,
  childFields,
  onChange,
  onRemove
}: {
  rule: CascadeRuleCfg
  parentFields: Array<{ value: string; label: string }>
  childFields: Array<{ value: string; label: string }>
  onChange: (r: CascadeRuleCfg) => void
  onRemove: () => void
}) {
  const [pfOpen, setPfOpen] = useState(false)
  const [cfOpen, setCfOpen] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const [swapText, setSwapText] = useState('')
  const [swapErr, setSwapErr] = useState<string | null>(null)
  const hasSwap = !!rule.on_unavailable && typeof rule.on_unavailable === 'object'
  return (
    <div className='flex items-center gap-1.5'>
      <Popover open={pfOpen} onOpenChange={setPfOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-setting='field.parent_cascades.parent_field'
            className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0 dark:bg-card dark:border-border'
          >
            {rule.parent_field ? (
              (parentFields.find((f) => f.value === rule.parent_field)?.label ?? rule.parent_field)
            ) : (
              <span className='text-slate-400'>parent field…</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-52 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandGroup>
                {parentFields.map((f) => (
                  <CommandItem
                    key={f.value}
                    value={f.value}
                    onSelect={() => {
                      onChange({ ...rule, parent_field: f.value })
                      setPfOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    {f.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <span className='text-[11px] text-slate-400 shrink-0'>→</span>
      <Popover open={cfOpen} onOpenChange={setCfOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-setting='field.parent_cascades.child_field'
            className='flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-left truncate hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan min-w-0 dark:bg-card dark:border-border'
          >
            {rule.child_field ? (
              (childFields.find((f) => f.value === rule.child_field)?.label ?? rule.child_field)
            ) : (
              <span className='text-slate-400'>child field…</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-52 p-0' align='start'>
          <Command>
            <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandGroup>
                {childFields.map((f) => (
                  <CommandItem
                    key={f.value}
                    value={f.value}
                    onSelect={() => {
                      onChange({ ...rule, child_field: f.value })
                      setCfOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    {f.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Popover
        open={swapOpen}
        onOpenChange={(o) => {
          setSwapOpen(o)
          if (o) {
            setSwapText(hasSwap ? JSON.stringify(rule.on_unavailable, null, 2) : '')
            setSwapErr(null)
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type='button'
            data-setting='field.parent_cascades.on_unavailable'
            aria-label='When the value is no longer offered'
            data-tip='On unavailable: swap the row to a default when the parent change orphans its value'
            className={`h-7 w-7 shrink-0 rounded border text-[11px] transition-colors ${hasSwap ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan' : 'border-slate-200 text-slate-400 hover:border-slate-400 hover:text-slate-700'}`}
          >
            ⇄
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-[420px] p-3 space-y-2' align='end'>
          <p className='text-[11px] font-medium text-slate-700 dark:text-foreground'>
            On unavailable — swap to a default
          </p>
          <p className='text-[11px] text-slate-500'>
            When the parent field is changed and a row’s value is no longer offered, re-point the
            row to the option that keeps <code>keep</code> from the old value and takes{' '}
            <code>replace</code> from the parent’s defaults (pinned_options entry shape). Row rules
            then run as if the user picked it. Empty = flag only.
          </p>
          <textarea
            value={swapText}
            onChange={(e) => {
              setSwapText(e.target.value)
              const t = e.target.value.trim()
              if (!t) {
                setSwapErr(null)
                const { on_unavailable: _drop, ...rest } = rule
                onChange(rest)
                return
              }
              try {
                const parsed = JSON.parse(t) as { replace?: unknown }
                if (!parsed || typeof parsed !== 'object' || !parsed.replace)
                  throw new Error('needs a "replace" map')
                setSwapErr(null)
                onChange({ ...rule, on_unavailable: parsed })
              } catch (err) {
                setSwapErr(err instanceof Error ? err.message : 'Invalid JSON')
              }
            }}
            rows={9}
            spellCheck={false}
            placeholder={
              '{\n  "keep": ["sub_category"],\n  "replace": { "core_category": [ { "parent_field": "project", "parent_collection": "projects", "source_field": "default_core_category" } ] },\n  "label": "Category"\n}'
            }
            className={`w-full rounded border bg-white px-2 py-1.5 font-mono text-[11px] leading-snug dark:bg-card ${swapErr ? 'border-red-400' : 'border-slate-200 dark:border-border'}`}
          />
          {swapErr && <p className='text-[11px] text-red-500'>{swapErr}</p>}
        </PopoverContent>
      </Popover>
      <button
        type='button'
        onClick={onRemove}
        className='shrink-0 text-slate-300 hover:text-red-400 text-[11px] px-0.5'
      >
        ✕
      </button>
    </div>
  )
}
