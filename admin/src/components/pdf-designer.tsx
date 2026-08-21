import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { titleCase } from '@/lib/utils'

/**
 * PDF visual designer (#46): a block-based layout that GENERATES the Liquid
 * body — field placeholders, child-row tables, headings, dividers. The
 * template column stays the render source of truth; "Apply to template"
 * regenerates it from the blocks.
 */

export type PdfBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'fields'; items: Array<{ field: string; label: string }>; cols: number }
  | { type: 'table'; alias: string; columns: Array<{ field: string; label: string }> }
  | { type: 'divider' }
  | { type: 'spacer' }

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function generateLiquid(blocks: PdfBlock[], title: string): string {
  const parts: string[] = []
  parts.push(
    `<div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #1e293b; font-size: 12px; line-height: 1.5;">`
  )
  parts.push(
    `<div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid #0f1e2d; padding-bottom:8px; margin-bottom:16px;">` +
      `<div style="font-size:18px; font-weight:700;">${esc(title)}</div>` +
      `<div style="font-size:10px; color:#64748b;">{{ generated_at | date: '%B %d, %Y' }}</div></div>`
  )
  for (const b of blocks) {
    if (b.type === 'heading') {
      parts.push(
        `<h2 style="font-size:14px; font-weight:700; margin:18px 0 8px; border-bottom:1px solid #e2e8f0; padding-bottom:4px;">${esc(b.text)}</h2>`
      )
    } else if (b.type === 'text') {
      parts.push(`<p style="margin:6px 0; color:#475569;">${b.text}</p>`)
    } else if (b.type === 'fields') {
      const cols = Math.max(1, Math.min(4, b.cols || 2))
      parts.push(
        `<div style="display:grid; grid-template-columns:repeat(${cols}, 1fr); gap:8px 20px; margin:8px 0;">` +
          b.items
            .map(
              (f) =>
                `<div><div style="font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:#94a3b8;">${esc(f.label || titleCase(f.field))}</div>` +
                `<div style="font-size:12px;">{{ ${f.field} }}</div></div>`
            )
            .join('') +
          `</div>`
      )
    } else if (b.type === 'table') {
      parts.push(
        `<table style="width:100%; border-collapse:collapse; margin:8px 0; font-size:11px;">` +
          `<thead><tr>` +
          b.columns
            .map(
              (c) =>
                `<th style="text-align:left; border-bottom:1.5px solid #0f1e2d; padding:4px 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:#64748b;">${esc(c.label || titleCase(c.field))}</th>`
            )
            .join('') +
          `</tr></thead><tbody>` +
          `{% for row in children.${b.alias} %}<tr>` +
          b.columns
            .map((c) => `<td style="border-bottom:1px solid #e2e8f0; padding:4px 6px;">{{ row.${c.field} }}</td>`)
            .join('') +
          `</tr>{% endfor %}</tbody></table>`
      )
    } else if (b.type === 'divider') {
      parts.push(`<hr style="border:none; border-top:1px solid #cbd5e1; margin:14px 0;" />`)
    } else if (b.type === 'spacer') {
      parts.push(`<div style="height:18px;"></div>`)
    }
  }
  parts.push(`</div>`)
  return parts.join('\n')
}

function FieldSelect({
  fields,
  value,
  onChange
}: {
  fields: string[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className='h-7 w-[180px] text-[12px]'>
        <SelectValue placeholder='Field…' />
      </SelectTrigger>
      <SelectContent>
        {fields.map((f) => (
          <SelectItem key={f} value={f}>
            {f}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PdfDesigner({
  collection,
  blocks,
  onChange
}: {
  collection: string | null
  blocks: PdfBlock[]
  onChange: (blocks: PdfBlock[]) => void
}) {
  const [addType, setAddType] = useState<PdfBlock['type']>('fields')

  const { data: meta } = useQuery<{ fields?: Array<{ field: string; hidden?: boolean }> }>({
    queryKey: ['pdf-designer-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data ?? r.data),
    enabled: !!collection
  })
  const fieldNames = (meta?.fields ?? [])
    .filter((f) => !f.hidden && !f.field.startsWith('__'))
    .map((f) => f.field)
    .sort()

  const { data: relations = [] } = useQuery<
    Array<{ one_collection: string | null; one_field: string | null; many_collection: string | null; junction_field: string | null }>
  >({
    queryKey: ['pdf-designer-rels', collection],
    queryFn: () => api.get(`/data-model/relations/for/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })
  const o2mAliases = relations
    .filter((r) => r.one_collection === collection && !r.junction_field && r.many_collection)
    .map((r) => ({ alias: r.one_field ?? String(r.many_collection), child: String(r.many_collection) }))

  const { data: childFieldsMap = {} } = useQuery<Record<string, string[]>>({
    queryKey: ['pdf-designer-child-fields', o2mAliases.map((a) => a.child).join(',')],
    queryFn: async () => {
      const out: Record<string, string[]> = {}
      for (const a of [...new Set(o2mAliases.map((x) => x.child))]) {
        try {
          const r = await api.get(`/collections/${a}`)
          out[a] = ((r.data.data ?? r.data).fields ?? [])
            .filter((f: { hidden?: boolean; field: string }) => !f.hidden)
            .map((f: { field: string }) => f.field)
            .sort()
        } catch {
          out[a] = []
        }
      }
      return out
    },
    enabled: o2mAliases.length > 0
  })

  const set = (i: number, patch: Partial<PdfBlock>) =>
    onChange(blocks.map((b, idx) => (idx === i ? ({ ...b, ...patch } as PdfBlock) : b)))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= blocks.length) return
    const next = [...blocks]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const remove = (i: number) => onChange(blocks.filter((_, idx) => idx !== i))
  const add = () => {
    const nb: PdfBlock =
      addType === 'heading'
        ? { type: 'heading', text: 'Section' }
        : addType === 'text'
          ? { type: 'text', text: '' }
          : addType === 'fields'
            ? { type: 'fields', items: [], cols: 2 }
            : addType === 'table'
              ? { type: 'table', alias: o2mAliases[0]?.alias ?? '', columns: [] }
              : { type: addType }
    onChange([...blocks, nb])
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <Select value={addType} onValueChange={(v) => setAddType(v as PdfBlock['type'])}>
          <SelectTrigger className='h-7 w-[190px] text-[12px]'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='heading'>Heading</SelectItem>
            <SelectItem value='text'>Text</SelectItem>
            <SelectItem value='fields'>Field grid</SelectItem>
            <SelectItem value='table' disabled={o2mAliases.length === 0}>
              Child table
            </SelectItem>
            <SelectItem value='divider'>Divider</SelectItem>
            <SelectItem value='spacer'>Spacer</SelectItem>
          </SelectContent>
        </Select>
        <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={add}>
          + Add block
        </Button>
        {!collection && (
          <span className='text-[11.5px] text-amber-600'>
            Bind the template to a collection to pick fields.
          </span>
        )}
      </div>
      {blocks.length === 0 && (
        <p className='rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-[12px] text-slate-400 dark:border-border'>
          No blocks yet — add a field grid, a child table, headings…
        </p>
      )}
      {blocks.map((b, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional editor list
          key={i}
          className='rounded-lg border border-slate-200 bg-white p-2.5 dark:border-border dark:bg-card'
        >
          <div className='mb-1.5 flex items-center gap-1.5'>
            <span className='rounded bg-slate-100 px-1.5 py-px text-[10px] font-semibold uppercase text-slate-500 dark:bg-muted'>
              {b.type}
            </span>
            <span className='flex-1' />
            <button type='button' onClick={() => move(i, -1)} className='rounded p-1 text-slate-300 hover:text-slate-600' aria-label='Move up'>
              <ArrowUp className='h-3.5 w-3.5' />
            </button>
            <button type='button' onClick={() => move(i, 1)} className='rounded p-1 text-slate-300 hover:text-slate-600' aria-label='Move down'>
              <ArrowDown className='h-3.5 w-3.5' />
            </button>
            <button type='button' onClick={() => remove(i)} className='rounded p-1 text-slate-300 hover:text-red-500' aria-label='Remove block'>
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          </div>
          {b.type === 'heading' && (
            <Input value={b.text} onChange={(e) => set(i, { text: e.target.value })} placeholder='Heading text' className='h-7 text-[12.5px]' />
          )}
          {b.type === 'text' && (
            <Textarea
              value={b.text}
              onChange={(e) => set(i, { text: e.target.value })}
              rows={2}
              placeholder='Paragraph — Liquid like {{ field }} works here'
              className='text-[12px]'
            />
          )}
          {b.type === 'fields' && (
            <div className='space-y-1.5'>
              {b.items.map((f, fi) => (
                <div key={`${f.field}-${fi}`} className='flex items-center gap-1.5'>
                  <FieldSelect
                    fields={fieldNames}
                    value={f.field}
                    onChange={(v) =>
                      set(i, { items: b.items.map((x, xi) => (xi === fi ? { ...x, field: v } : x)) })
                    }
                  />
                  <Input
                    value={f.label}
                    onChange={(e) =>
                      set(i, {
                        items: b.items.map((x, xi) => (xi === fi ? { ...x, label: e.target.value } : x))
                      })
                    }
                    placeholder={titleCase(f.field || 'Label')}
                    className='h-7 w-[160px] text-[12px]'
                  />
                  <button
                    type='button'
                    onClick={() => set(i, { items: b.items.filter((_, xi) => xi !== fi) })}
                    className='rounded p-1 text-slate-300 hover:text-red-500'
                    aria-label='Remove field'
                  >
                    <Trash2 className='h-3 w-3' />
                  </button>
                </div>
              ))}
              <div className='flex items-center gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  className='h-6 text-[11px]'
                  onClick={() => set(i, { items: [...b.items, { field: '', label: '' }] })}
                >
                  + Field
                </Button>
                <span className='text-[11px] text-slate-400'>Columns</span>
                <Select value={String(b.cols)} onValueChange={(v) => set(i, { cols: Number(v) })}>
                  <SelectTrigger className='h-6 w-[64px] text-[11px]'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['1', '2', '3', '4'].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {b.type === 'table' && (
            <div className='space-y-1.5'>
              <div className='flex items-center gap-2'>
                <span className='text-[11px] text-slate-400'>Rows from</span>
                <Select value={b.alias || undefined} onValueChange={(v) => set(i, { alias: v, columns: [] })}>
                  <SelectTrigger className='h-7 w-[220px] text-[12px]'>
                    <SelectValue placeholder='Child relation…' />
                  </SelectTrigger>
                  <SelectContent>
                    {o2mAliases.map((a) => (
                      <SelectItem key={a.alias} value={a.alias}>
                        {a.alias} ({a.child})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {b.columns.map((c, ci) => {
                const child = o2mAliases.find((a) => a.alias === b.alias)?.child
                return (
                  <div key={`${c.field}-${ci}`} className='flex items-center gap-1.5'>
                    <FieldSelect
                      fields={child ? (childFieldsMap[child] ?? []) : []}
                      value={c.field}
                      onChange={(v) =>
                        set(i, { columns: b.columns.map((x, xi) => (xi === ci ? { ...x, field: v } : x)) })
                      }
                    />
                    <Input
                      value={c.label}
                      onChange={(e) =>
                        set(i, {
                          columns: b.columns.map((x, xi) => (xi === ci ? { ...x, label: e.target.value } : x))
                        })
                      }
                      placeholder={titleCase(c.field || 'Column label')}
                      className='h-7 w-[160px] text-[12px]'
                    />
                    <button
                      type='button'
                      onClick={() => set(i, { columns: b.columns.filter((_, xi) => xi !== ci) })}
                      className='rounded p-1 text-slate-300 hover:text-red-500'
                      aria-label='Remove column'
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  </div>
                )
              })}
              <Button
                size='sm'
                variant='outline'
                className='h-6 text-[11px]'
                disabled={!b.alias}
                onClick={() => set(i, { columns: [...b.columns, { field: '', label: '' }] })}
              >
                + Column
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
