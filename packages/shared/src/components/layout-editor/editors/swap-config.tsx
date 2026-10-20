import { ChevronDown, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { titleCase } from '../../../lib/utils'

/** The group columns the swap editor reads; admin's FieldGroup and the editor's GroupRow both fit. */
export type SwapGroup = { id: number; swap_config?: string | null }

export function SwapConfigEditor({
  group,
  allFields,
  onGroupSettings
}: {
  group: SwapGroup
  allFields: Array<{ field: string; type?: string }>
  onGroupSettings: (id: number, patch: { swap_config: string | null }) => void
}) {
  type AltField = { field: string; width: 1 | 2 }
  type SwapCfg = {
    enabled: boolean
    primary_field: string
    alternate_fields: AltField[]
    toggle_label?: string
    back_label?: string
  }

  const [pfOpen, setPfOpen] = useState(false)
  const [afOpen, setAfOpen] = useState(false)
  const [pfSearch, setPfSearch] = useState('')
  const [afSearch, setAfSearch] = useState('')

  const swapCfg = (() => {
    try {
      if (!group.swap_config) return null
      const raw = JSON.parse(group.swap_config)
      // Normalise legacy string[] to AltField[]
      const alts: AltField[] = (raw.alternate_fields ?? []).map((x: string | AltField) =>
        typeof x === 'string' ? { field: x, width: 2 } : x
      )
      return { ...raw, alternate_fields: alts } as SwapCfg
    } catch {
      return null
    }
  })()

  const save = (patch: Partial<SwapCfg>) => {
    const next: SwapCfg = {
      enabled: swapCfg?.enabled ?? false,
      primary_field: swapCfg?.primary_field ?? '',
      alternate_fields: swapCfg?.alternate_fields ?? [],
      toggle_label: swapCfg?.toggle_label,
      back_label: swapCfg?.back_label,
      ...patch
    }
    onGroupSettings(group.id, { swap_config: JSON.stringify(next) })
  }

  const fieldLabel = (f: string) => titleCase(f)
  const altFieldKeys = new Set((swapCfg?.alternate_fields ?? []).map((a) => a.field))
  const pfFiltered = allFields.filter(
    (f) => !f.field.startsWith('__') && f.field.toLowerCase().includes(pfSearch.toLowerCase())
  )
  const afFiltered = allFields.filter(
    (f) =>
      !f.field.startsWith('__') &&
      f.field.toLowerCase().includes(afSearch.toLowerCase()) &&
      !altFieldKeys.has(f.field)
  )
  const altFields = swapCfg?.alternate_fields ?? []

  const setWidth = (field: string, width: 1 | 2) => {
    save({ alternate_fields: altFields.map((a) => (a.field === field ? { ...a, width } : a)) })
  }
  const removeAlt = (field: string) => {
    save({ alternate_fields: altFields.filter((a) => a.field !== field) })
  }

  return (
    <div className='border-t border-slate-100 dark:border-border pt-3 space-y-2'>
      <p className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>Field Swap</p>
      <p className='text-[11px] text-slate-400'>
        Toggle between a M2O picker and manual entry fields.
      </p>
      <label
        className='flex items-center gap-2 text-[11px] text-slate-600 dark:text-muted-foreground'
        data-setting='group.swap_config.enabled'
      >
        <input
          type='checkbox'
          checked={!!swapCfg?.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
          className='h-3.5 w-3.5 rounded accent-nvr-cyan'
        />
        Enable field swap
      </label>
      {swapCfg?.enabled && (
        <div className='space-y-2 pl-1'>
          {/* Primary field */}
          <div data-setting='group.swap_config.primary_field'>
            <p className='text-[11px] text-slate-400 mb-1'>Primary field (M2O)</p>
            <button
              type='button'
              onClick={() => {
                setPfOpen((v) => !v)
                setPfSearch('')
              }}
              className='w-full h-7 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-left text-[11px] flex items-center justify-between gap-1 hover:border-nvr-cyan/50'
            >
              {swapCfg.primary_field ? (
                <span className='flex-1 truncate'>
                  <span className='font-medium'>{fieldLabel(swapCfg.primary_field)}</span>{' '}
                  <span className='font-mono text-[11px] text-slate-400'>
                    {swapCfg.primary_field}
                  </span>
                </span>
              ) : (
                <span className='text-slate-400'>Select field…</span>
              )}
              <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
            </button>
            {pfOpen && (
              <div className='mt-0.5 rounded border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden'>
                <div className='flex items-center border-b border-slate-100 dark:border-border px-2'>
                  <Search className='h-3 w-3 text-slate-400 shrink-0' />
                  <input
                    // biome-ignore lint/a11y/noAutofocus: the search box opens on an explicit click
                    autoFocus
                    value={pfSearch}
                    onChange={(e) => setPfSearch(e.target.value)}
                    placeholder='Search…'
                    className='flex-1 h-7 bg-transparent px-2 text-[11px] outline-none'
                  />
                </div>
                <div className='max-h-36 overflow-y-auto'>
                  {pfFiltered.length === 0 ? (
                    <p className='px-3 py-2 text-[11px] text-slate-400'>No fields</p>
                  ) : (
                    pfFiltered.map((f) => (
                      <button
                        key={f.field}
                        type='button'
                        onClick={() => {
                          save({ primary_field: f.field })
                          setPfOpen(false)
                        }}
                        className={[
                          'w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted dark:hover:bg-muted flex items-center justify-between gap-2',
                          swapCfg.primary_field === f.field ? 'bg-nvr-cyan/5 text-nvr-cyan' : ''
                        ].join(' ')}
                      >
                        <span className='font-medium truncate'>{fieldLabel(f.field)}</span>
                        <span className='font-mono text-[11px] text-slate-400 shrink-0'>
                          {f.type ?? ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Alternate fields */}
          <div data-setting='group.swap_config.alternate_fields'>
            <p className='text-[11px] text-slate-400 mb-1'>Alternate fields</p>
            {altFields.length > 0 && (
              <div className='mb-1 space-y-1'>
                {altFields.map((a) => (
                  <div
                    key={a.field}
                    className='flex items-center gap-1.5 rounded border border-slate-100 dark:border-border bg-white dark:bg-card px-2 py-1'
                  >
                    <span className='flex-1 truncate text-[11px] font-medium text-slate-700 dark:text-slate-200'>
                      {fieldLabel(a.field)}
                    </span>
                    <div className='flex rounded border border-slate-200 dark:border-border overflow-hidden shrink-0'>
                      <button
                        type='button'
                        onClick={() => setWidth(a.field, 1)}
                        className={[
                          'px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                          a.width === 1
                            ? 'bg-nvr-cyan text-white'
                            : 'text-slate-400 hover:text-slate-600'
                        ].join(' ')}
                        title='Half width'
                      >
                        ½
                      </button>
                      <button
                        type='button'
                        onClick={() => setWidth(a.field, 2)}
                        className={[
                          'px-1.5 py-0.5 text-[11px] font-medium transition-colors border-l border-slate-200 dark:border-border',
                          a.width === 2
                            ? 'bg-nvr-cyan text-white'
                            : 'text-slate-400 hover:text-slate-600'
                        ].join(' ')}
                        title='Full width'
                      >
                        1
                      </button>
                    </div>
                    <button
                      type='button'
                      onClick={() => removeAlt(a.field)}
                      className='text-slate-300 hover:text-red-500 text-[14px] leading-none shrink-0'
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type='button'
              onClick={() => {
                setAfOpen((v) => !v)
                setAfSearch('')
              }}
              className='w-full h-7 rounded border border-dashed border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-left text-[11px] flex items-center gap-1.5 text-slate-400 hover:border-nvr-cyan/50 hover:text-nvr-cyan'
            >
              <Plus className='h-3 w-3' /> Add field…
            </button>
            {afOpen && (
              <div className='mt-0.5 rounded border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden'>
                <div className='flex items-center border-b border-slate-100 dark:border-border px-2'>
                  <Search className='h-3 w-3 text-slate-400 shrink-0' />
                  <input
                    // biome-ignore lint/a11y/noAutofocus: the search box opens on an explicit click
                    autoFocus
                    value={afSearch}
                    onChange={(e) => setAfSearch(e.target.value)}
                    placeholder='Search…'
                    className='flex-1 h-7 bg-transparent px-2 text-[11px] outline-none'
                  />
                </div>
                <div className='max-h-36 overflow-y-auto'>
                  {afFiltered.length === 0 ? (
                    <p className='px-3 py-2 text-[11px] text-slate-400'>No more fields</p>
                  ) : (
                    afFiltered.map((f) => (
                      <button
                        key={f.field}
                        type='button'
                        onClick={() => {
                          save({ alternate_fields: [...altFields, { field: f.field, width: 2 }] })
                          setAfSearch('')
                          setAfOpen(false)
                        }}
                        className='w-full text-left px-3 py-1.5 text-[11px] hover:bg-muted dark:hover:bg-muted flex items-center justify-between gap-2'
                      >
                        <span className='font-medium truncate'>{fieldLabel(f.field)}</span>
                        <span className='font-mono text-[11px] text-slate-400 shrink-0'>
                          {f.type ?? ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Labels */}
          <div className='flex gap-2'>
            <div className='flex-1' data-setting='group.swap_config.toggle_label'>
              <p className='text-[11px] text-slate-400 mb-1'>Toggle label</p>
              <input
                type='text'
                placeholder='Enter custom'
                key={`tl-${group.id}`}
                defaultValue={swapCfg.toggle_label ?? ''}
                onBlur={(e) => save({ toggle_label: e.target.value || undefined })}
                className='w-full h-6 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-[11px]'
              />
            </div>
            <div className='flex-1' data-setting='group.swap_config.back_label'>
              <p className='text-[11px] text-slate-400 mb-1'>Back label</p>
              <input
                type='text'
                placeholder='Use saved'
                key={`bl-${group.id}`}
                defaultValue={swapCfg.back_label ?? ''}
                onBlur={(e) => save({ back_label: e.target.value || undefined })}
                className='w-full h-6 rounded border border-slate-200 dark:border-border bg-white dark:bg-background px-2 text-[11px]'
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
