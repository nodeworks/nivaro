import type { CMSRelation } from '../../pipeline/types'
import { FieldPicker } from '../pickers/field-picker'
import { useCollectionMeta } from './field-context'
import { COLORS, DISPLAY_AS, WEIGHTS } from './HeaderItemInspector'
import { Choice, Setting, TextInput, Toggle, useInspectorEnv } from './kit'
import {
  findPlacement,
  SUBTITLE_FIELD,
  type SubtitleConfig,
  type SubtitleItem,
  subtitleBindings,
  subtitleOf
} from './model'

/** The line under the record title (`__subtitle__` row). */
export function SubtitleInspector() {
  const env = useInspectorEnv()
  const { data: meta } = useCollectionMeta(env.collection)
  const cfg = subtitleOf(env.bundle)
  const row = findPlacement(env.bundle, SUBTITLE_FIELD, null)
  const write = (next: SubtitleConfig, label: string, text?: boolean) =>
    env.apply(
      [
        {
          op: 'update_placement',
          at: { field: SUBTITLE_FIELD, group_key: null },
          patch: { input_bindings: subtitleBindings(next) }
        }
      ],
      { label, text }
    )
  const setItem = (i: number, patch: Partial<SubtitleItem>) =>
    cfg &&
    write(
      { ...cfg, fields: cfg.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) },
      'Change the subtitle'
    )

  return (
    <div className='space-y-4'>
      <Toggle
        k='subtitle.enabled'
        label='Subtitle under the title'
        effect='Fields shown on one line below the record title.'
        checked={!!row}
        onChange={(v) =>
          env.apply(
            v
              ? [
                  {
                    op: 'place',
                    field: SUBTITLE_FIELD,
                    group_key: null,
                    index: 0,
                    patch: { input_bindings: subtitleBindings({ fields: [], separator: ' | ' }) }
                  }
                ]
              : [{ op: 'remove', at: { field: SUBTITLE_FIELD, group_key: null } }],
            { label: v ? 'Add a subtitle' : 'Remove the subtitle' }
          )
        }
      />
      {cfg && (
        <>
          <Setting
            k='subtitle.separator'
            label='Between fields'
            effect='The text placed between the subtitle fields.'
          >
            <TextInput
              ariaLabel='Between fields'
              value={cfg.separator}
              placeholder=' | '
              onChange={(v) =>
                write({ ...cfg, separator: v }, 'Change the subtitle separator', true)
              }
            />
          </Setting>
          <Setting
            k='subtitle.fields'
            label='Fields'
            effect='Fields of related records are allowed.'
          >
            <div className='space-y-2'>
              {cfg.fields.map((f, i) => (
                <div
                  key={f.field}
                  className='space-y-1.5 rounded-md border border-slate-200 p-2 dark:border-border'
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className='truncate text-[12px] text-foreground'>
                      {f.label ?? f.field}
                    </span>
                    <button
                      type='button'
                      aria-label={`Remove ${f.label ?? f.field}`}
                      onClick={() =>
                        write(
                          { ...cfg, fields: cfg.fields.filter((_, j) => j !== i) },
                          'Remove a subtitle field'
                        )
                      }
                      className='shrink-0 text-[12px] text-slate-400 hover:text-red-500'
                    >
                      ✕
                    </button>
                  </div>
                  <div className='grid grid-cols-3 gap-1' data-setting='subtitle.field_style'>
                    <Choice
                      ariaLabel='Colour'
                      value={f.color ?? ''}
                      options={COLORS}
                      onChange={(v) => setItem(i, { color: v || undefined })}
                    />
                    <Choice
                      ariaLabel='Weight'
                      value={f.weight ?? ''}
                      options={WEIGHTS}
                      onChange={(v) => setItem(i, { weight: v || undefined })}
                    />
                    <Choice
                      ariaLabel='Shown as'
                      value={f.display_as ?? ''}
                      options={DISPLAY_AS}
                      onChange={(v) => setItem(i, { display_as: v || undefined })}
                    />
                  </div>
                </div>
              ))}
              <FieldPicker
                collection={env.collection}
                fields={(meta?.fields ?? [])
                  .filter(
                    (x) => !x.field.startsWith('__') && !cfg.fields.some((s) => s.field === x.field)
                  )
                  .map((x) => ({
                    field: x.field,
                    type: x.type ?? 'string',
                    interface: x.interface ?? null,
                    hidden: !!x.hidden
                  }))}
                relations={(meta?.relations ?? []) as unknown as CMSRelation[]}
                value=''
                placeholder='+ Add field…'
                onChange={(picked) =>
                  write(
                    {
                      ...cfg,
                      fields: [
                        ...cfg.fields,
                        { field: picked.path.join('.'), label: picked.pathLabels.join(' › ') }
                      ]
                    },
                    'Add a subtitle field'
                  )
                }
              />
            </div>
          </Setting>
        </>
      )}
    </div>
  )
}
