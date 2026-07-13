// api/src/services/pdf-layout.ts
import type { Browser } from 'puppeteer'
import puppeteer from 'puppeteer'
import { db } from '../db/index.js'
import { resolveDisplayValue } from './display-value.js'
import type { PdfLayoutData } from './pdf-layout-themes.js'
import { classicTheme, escHtml, executiveTheme, minimalTheme } from './pdf-layout-themes.js'

// Allowlist-based HTML sanitizer for richtext fields rendered in PDF.
// Strips all tags not on the allowlist (keeps inner text), drops block-removed tags
// (script/style/iframe/etc.) along with their content, and removes all attributes.
const RICHTEXT_BLOCK_RE =
  /<(script|style|iframe|object|embed|link|meta|form|input|button|svg|math)[^>]*>[\s\S]*?<\/\1>/gi
const RICHTEXT_BLOCK_VOID_RE = /<(script|style|iframe|object|embed|link|meta|input)[^>]*\/?>/gi
const RICHTEXT_ALLOWED = new Set([
  'p',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'br',
  'blockquote',
  'pre',
  'code',
  'span',
  'div'
])
function sanitizeRichtext(html: string): string {
  // 1. Remove dangerous block elements and their content
  let s = html.replace(RICHTEXT_BLOCK_RE, '').replace(RICHTEXT_BLOCK_VOID_RE, '')
  // 2. Strip all attributes from remaining tags
  s = s.replace(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (_, tag: string) => {
    const t = tag.toLowerCase()
    return RICHTEXT_ALLOWED.has(t) ? `<${t}>` : ''
  })
  // 3. Strip closing tags not on allowlist (keep their text content)
  s = s.replace(/<\/([a-zA-Z][a-zA-Z0-9]*)>/g, (_, tag: string) => {
    return RICHTEXT_ALLOWED.has(tag.toLowerCase()) ? `</${tag.toLowerCase()}>` : ''
  })
  return s
}

interface RelationRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

// Mirrors FieldGroupsTab logic: alias = one_field unless it's 'id'/null, then fall back to many_collection
function getVirtualAlias(r: RelationRow): string {
  return r.one_field && r.one_field !== 'id' ? r.one_field : r.many_collection
}

async function enrichRelationValues(
  collection: string,
  item: Record<string, unknown>,
  relations: RelationRow[],
  fieldMeta: Array<{ field: string; type: string; options: string | null }>,
  visibleFields: string[],
  effectiveOptsMap?: Map<string, Record<string, unknown>>
): Promise<{ enrichedItem: Record<string, unknown>; o2mHtml: Record<string, string> }> {
  const enrichedItem = { ...item }
  const o2mHtml: Record<string, string> = {}

  // Fetch display_template for all related collections up-front
  const relatedCollections = new Set<string>()
  for (const f of visibleFields) {
    const m2o = relations.find(
      (r) => r.many_collection === collection && r.many_field === f && !r.junction_field
    )
    if (m2o?.one_collection) {
      relatedCollections.add(m2o.one_collection)
      continue
    }
    const m2m = relations.find(
      (r) => r.one_collection === collection && r.junction_field != null && getVirtualAlias(r) === f
    )
    if (m2m) {
      const other = relations.find(
        (r) => r.many_collection === m2m.many_collection && r.many_field === m2m.junction_field
      )
      if (other?.one_collection) relatedCollections.add(other.one_collection)
      continue
    }
    const o2m = relations.find(
      (r) => r.one_collection === collection && !r.junction_field && getVirtualAlias(r) === f
    )
    if (o2m) relatedCollections.add(o2m.many_collection)
  }

  const displayTemplateMap: Record<string, string | null> = {}
  if (relatedCollections.size > 0) {
    const colRows = await db('nivaro_collections')
      .whereIn('collection', [...relatedCollections])
      .select('collection', 'display_template')
    for (const row of colRows) {
      displayTemplateMap[row.collection as string] = (row.display_template as string | null) ?? null
    }
  }

  for (const f of visibleFields) {
    const meta = fieldMeta.find((m) => m.field === f)

    // ── M2O: FK column on this collection → resolve to display value ──────────
    const m2oRel = relations.find(
      (r) => r.many_collection === collection && r.many_field === f && !r.junction_field
    )
    if (m2oRel?.one_collection) {
      const fkVal = item[f]
      if (fkVal == null || fkVal === '') continue
      const isUsers = m2oRel.one_collection === 'nivaro_users'
      const related = isUsers
        ? await db('nivaro_users')
            .where({ id: fkVal })
            .select(['id', 'first_name', 'last_name', 'email'])
            .first()
        : await db(m2oRel.one_collection).where({ id: fkVal }).select('*').first()
      if (related)
        enrichedItem[f] = resolveDisplayValue(
          related as Record<string, unknown>,
          displayTemplateMap[m2oRel.one_collection]
        )
      continue
    }

    // ── M2M: virtual field on this collection via junction ────────────────────
    const m2mRel = relations.find(
      (r) => r.one_collection === collection && r.junction_field != null && getVirtualAlias(r) === f
    )
    if (m2mRel) {
      const otherRel = relations.find(
        (r) =>
          r.many_collection === m2mRel.many_collection && r.many_field === m2mRel.junction_field
      )
      if (otherRel?.one_collection) {
        const itemId = item.id
        if (itemId == null) continue
        const junctionRows = await db(m2mRel.many_collection)
          .where({ [m2mRel.many_field]: itemId })
          .select(m2mRel.junction_field as string)
          .limit(100)
        const otherIds = junctionRows
          .map((r: Record<string, unknown>) => r[m2mRel.junction_field!])
          .filter(Boolean) as string[]
        if (otherIds.length === 0) {
          enrichedItem[f] = []
          continue
        }
        const isUsers = otherRel.one_collection === 'nivaro_users'
        const otherRows = isUsers
          ? await db('nivaro_users')
              .whereIn('id', otherIds)
              .select(['id', 'first_name', 'last_name', 'email'])
          : await db(otherRel.one_collection).whereIn('id', otherIds).select('*')
        enrichedItem[f] = (otherRows as Record<string, unknown>[]).map((r) =>
          resolveDisplayValue(r, displayTemplateMap[otherRel.one_collection!])
        )
      }
      continue
    }

    // ── O2M: virtual field → child records ───────────────────────────────────
    const o2mRel = relations.find(
      (r) => r.one_collection === collection && !r.junction_field && getVirtualAlias(r) === f
    )
    if (!o2mRel) continue
    {
      const itemId = item.id
      if (itemId == null) continue

      let opts: Record<string, unknown> = effectiveOptsMap?.get(f) ?? {}
      if (!effectiveOptsMap && meta?.options) {
        try {
          opts = JSON.parse(meta.options!)
        } catch {
          /* noop */
        }
      }
      const layoutId = opts.layout_id as number | null | undefined

      const toLabel = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

      // Determine which columns to show
      let columns: Array<{ field: string; label: string; type: string; options: string | null }> =
        []
      if (layoutId) {
        const [layoutFields, childFieldMeta] = await Promise.all([
          db('nivaro_layout_field_assignments')
            .where({ layout_id: layoutId })
            .select('field', 'sort', 'overrides', 'label_override', 'group_key')
            .orderBy('sort', 'asc'),
          db('nivaro_fields')
            .where({ collection: o2mRel.many_collection })
            .select('field', 'label', 'type', 'options')
        ])
        const metaMap = new Map(
          (
            childFieldMeta as Array<{
              field: string
              label: string | null
              type: string
              options: string | null
            }>
          ).map((m) => [m.field, m])
        )
        columns = (
          layoutFields as Array<{
            field: string
            group_key?: string | null
            overrides?: string | null
            label_override?: string | null
          }>
        )
          .filter((lf) => !lf.field.startsWith('__') && !lf.group_key?.startsWith('__'))
          .map((lf) => {
            let colLabel: string | null = null
            if (lf.overrides) {
              try {
                colLabel =
                  ((JSON.parse(lf.overrides) as Record<string, unknown>).label as string | null) ??
                  null
              } catch {
                /* noop */
              }
            }
            const fm = metaMap.get(lf.field)
            return {
              field: lf.field,
              label: colLabel ?? lf.label_override ?? fm?.label ?? toLabel(lf.field),
              type: fm?.type ?? 'string',
              options: fm?.options ?? null
            }
          })
      }

      const childRows = await db(o2mRel.many_collection)
        .where({ [o2mRel.many_field]: itemId })
        .select('*')
        .limit(200)

      if (childRows.length === 0) {
        enrichedItem[f] = '—'
        continue
      }

      if (columns.length === 0) {
        const template = displayTemplateMap[o2mRel.many_collection]
        enrichedItem[f] = (childRows as Record<string, unknown>[])
          .map((r) => resolveDisplayValue(r, template))
          .join(', ')
        continue
      }

      // Resolve M2O FK columns in child rows — batch fetch per FK column
      const childM2oRels = await db('nivaro_relations')
        .where({ many_collection: o2mRel.many_collection })
        .whereNull('junction_field')
        .select('many_field', 'one_collection')
      const fkDisplayMap: Record<string, Record<string, string>> = {} // field → { rawId: displayValue }
      for (const col of columns) {
        const fkRel = (
          childM2oRels as Array<{ many_field: string; one_collection: string | null }>
        ).find((r) => r.many_field === col.field && r.one_collection)
        if (!fkRel?.one_collection) continue
        const fkVals = [
          ...new Set(
            (childRows as Record<string, unknown>[])
              .map((r) => r[col.field])
              .filter((v) => v != null && v !== '')
          )
        ] as (string | number)[]
        if (fkVals.length === 0) continue
        const isUsers = fkRel.one_collection === 'nivaro_users'
        const [refRows, refColMeta] = await Promise.all([
          isUsers
            ? db('nivaro_users')
                .whereIn('id', fkVals)
                .select(['id', 'first_name', 'last_name', 'email'])
            : db(fkRel.one_collection).whereIn('id', fkVals).select('*'),
          db('nivaro_collections')
            .where({ collection: fkRel.one_collection })
            .first('display_template')
        ])
        const tpl = (refColMeta?.display_template as string | null) ?? null
        fkDisplayMap[col.field] = {}
        for (const r of refRows as Record<string, unknown>[]) {
          fkDisplayMap[col.field][String(r.id)] = resolveDisplayValue(r, tpl)
        }
      }

      // Build HTML table — run renderFieldValue per cell so selects/numbers/dates display correctly
      const thRow = columns.map((c) => `<th>${escHtml(c.label)}</th>`).join('')
      const bodyRows = (childRows as Record<string, unknown>[])
        .map((row) => {
          const cells = columns
            .map((c) => {
              const fkVal = fkDisplayMap[c.field]?.[String(row[c.field])]
              if (fkVal !== undefined) return `<td>${escHtml(fkVal)}</td>`
              let cellOpts: Record<string, unknown> | undefined
              if (c.options) {
                try {
                  cellOpts = JSON.parse(c.options)
                } catch {
                  /* noop */
                }
              }
              return `<td>${escHtml(renderFieldValue(c.type, row[c.field], cellOpts))}</td>`
            })
            .join('')
          return `<tr>${cells}</tr>`
        })
        .join('')
      o2mHtml[f] =
        `<table class="rel-table"><thead><tr>${thRow}</tr></thead><tbody>${bodyRows}</tbody></table>`
      enrichedItem[f] = '' // placeholder; o2mHtml takes precedence
    }
  }

  return { enrichedItem, o2mHtml }
}

let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  })
  browser.on('disconnected', () => {
    browser = null
  })
  return browser
}

export function renderFieldValue(
  type: string,
  value: unknown,
  options?: Record<string, unknown>
): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean' || type === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.map((v) => renderFieldValue(type, v, options)).join(', ')

  // Select / dropdown — resolve stored value to display label
  // choices stored as [{ value, text }] (Choice type in TableEditor)
  if ((type === 'select' || type === 'dropdown') && options) {
    const choices = Array.isArray(options) ? options : (options.choices ?? options.options)
    if (Array.isArray(choices)) {
      const str = String(value)
      const match = (choices as Record<string, unknown>[]).find((c) => String(c.value) === str)
      if (match) return String(match.text ?? match.label ?? match.value ?? str)
    }
  }

  // Number with currency or custom format
  // options keys: format ('int'|'decimal'|'currency'), currency ('USD'), precision (int)
  if (
    (type === 'integer' || type === 'decimal' || type === 'float' || type === 'bigInteger') &&
    options
  ) {
    const num = typeof value === 'number' ? value : parseFloat(String(value))
    if (!Number.isNaN(num)) {
      if (options.format === 'currency') {
        const currency = typeof options.currency === 'string' ? options.currency : 'USD'
        try {
          return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(num)
        } catch {
          /* fall through */
        }
      }
      if (options.format === 'decimal') {
        const precision = typeof options.precision === 'number' ? options.precision : 2
        return num.toFixed(precision)
      }
      if (options.format === 'int') return Math.round(num).toString()
    }
  }

  if (type === 'date' && typeof value === 'string') {
    try {
      return new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    } catch {
      return String(value)
    }
  }
  if (type === 'datetime' && typeof value === 'string') {
    try {
      return new Date(value).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {
      return String(value)
    }
  }
  if ((type === 'richtext' || type === 'wysiwyg') && typeof value === 'string') {
    return value
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }
  if (typeof value === 'object') {
    const first = Object.values(value as Record<string, unknown>).find((v) => typeof v === 'string')
    return first ? String(first) : JSON.stringify(value)
  }
  return String(value)
}

interface LayoutRow {
  id: number
  collection: string
  pdf_theme: string | null
  pdf_template_id: number | null
  pdf_cover_enabled: boolean | number | null
  pdf_cover_title_field: string | null
  pdf_cover_subtitle: string | null
  pdf_show_logo: boolean | number | null
  pdf_page_size: string | null
  pdf_orientation: string | null
}

interface GroupRow {
  id: number
  key: string
  label: string
  sort: number
}
interface AssignmentRow {
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  is_visible: boolean | number | null
  col_span?: number | null
  overrides?: string | null
}
interface FieldMetaRow {
  field: string
  label: string | null
  type: string
  interface: string | null
  options: string | null
}

export async function generatePdfFromLayout(params: {
  layout: LayoutRow
  collectionLabel: string
  collection: string
  item: Record<string, unknown>
  groups: GroupRow[]
  assignments: AssignmentRow[]
  fieldMeta: FieldMetaRow[]
  relations: RelationRow[]
  logoUrl: string | null
  generatedBy: string
}): Promise<Buffer> {
  const {
    layout,
    collectionLabel,
    collection,
    item,
    groups,
    assignments,
    fieldMeta,
    relations,
    logoUrl,
    generatedBy
  } = params

  const safeLogoUrl = logoUrl && /^https?:\/\//i.test(logoUrl) ? logoUrl : null

  const fieldMetaMap = new Map(fieldMeta.map((f) => [f.field, f]))

  // Build effective options per field: global nivaro_fields.options merged with layout assignment overrides
  const effectiveOptsMap = new Map<string, Record<string, unknown>>()
  for (const a of assignments) {
    let opts: Record<string, unknown> = {}
    const globalOpts = fieldMetaMap.get(a.field)?.options
    if (globalOpts) {
      try {
        opts = JSON.parse(globalOpts)
      } catch {
        /* noop */
      }
    }
    const ov = a.overrides
      ? ((typeof a.overrides === 'string'
          ? (() => {
              try {
                return JSON.parse(a.overrides)
              } catch {
                return null
              }
            })()
          : a.overrides) as Record<string, unknown> | null)
      : null
    if (ov?.options && typeof ov.options === 'object')
      opts = { ...opts, ...(ov.options as Record<string, unknown>) }
    effectiveOptsMap.set(a.field, opts)
  }

  // Pre-resolve relation values (M2O display names, M2M lists, O2M tables)
  const visibleFields = assignments
    .filter((a) => !a.field.startsWith('__') && a.is_visible !== 0 && a.is_visible !== false)
    .map((a) => a.field)
  const { enrichedItem, o2mHtml } = await enrichRelationValues(
    collection,
    item,
    relations,
    fieldMeta,
    visibleFields,
    effectiveOptsMap
  )

  const sections = groups
    .sort((a, b) => a.sort - b.sort)
    .map((group) => {
      // Match by slug key (current format) or fall back to numeric id string (legacy data)
      const groupFields = assignments
        .filter(
          (a) =>
            (group.key ? a.group_key === group.key : a.group_key === String(group.id)) &&
            a.is_visible !== 0 &&
            a.is_visible !== false &&
            !a.field.startsWith('__')
        )
        .sort((a, b) => a.sort - b.sort)
        .map((a) => {
          const meta = fieldMetaMap.get(a.field)
          let fieldOpts: Record<string, unknown> | undefined
          if (meta?.options) {
            try {
              fieldOpts = typeof meta.options === 'string' ? JSON.parse(meta.options) : meta.options
            } catch {
              /* noop */
            }
          }
          let ovLabel: string | null | undefined
          if (a.overrides) {
            try {
              ovLabel =
                ((JSON.parse(a.overrides) as Record<string, unknown>).label as string | null) ??
                null
            } catch {
              /* noop */
            }
          }
          const hideLabel = ovLabel === ''
          const isRichText =
            meta?.interface === 'input-rich-text-html' ||
            meta?.interface === 'rich_text' ||
            meta?.type === 'rich_text' ||
            meta?.type === 'richtext' ||
            meta?.type === 'wysiwyg'
          const rawHtml = o2mHtml[a.field] != null || isRichText
          const rawValue =
            isRichText && typeof enrichedItem[a.field] === 'string'
              ? `<div class="richtext-value">${sanitizeRichtext(enrichedItem[a.field] as string)}</div>`
              : (o2mHtml[a.field] ??
                renderFieldValue(meta?.type ?? 'string', enrichedItem[a.field], fieldOpts))
          return {
            label: hideLabel ? '' : (ovLabel ?? a.label_override ?? meta?.label ?? a.field),
            value: rawHtml
              ? rawValue
              : renderFieldValue(meta?.type ?? 'string', enrichedItem[a.field], fieldOpts),
            colSpan: a.col_span ?? undefined,
            rawHtml,
            hideLabel
          }
        })
      return { label: group.label, fields: groupFields }
    })
    .filter((s) => s.fields.length > 0)

  const effectiveSections =
    sections.length > 0
      ? sections
      : [
          {
            label: 'Layout configuration needed',
            fields: [
              { label: 'Groups in this layout', value: String(groups.length) },
              {
                label: 'Assignments in this layout',
                value: String(assignments.filter((a) => !a.field.startsWith('__')).length)
              },
              {
                label: 'How to fix',
                value:
                  'In Data Model → Layouts, select this file layout, then drag fields into sections using the layout editor.'
              }
            ]
          }
        ]

  const coverTitleField = layout.pdf_cover_title_field
  const coverTitle =
    coverTitleField && item[coverTitleField] != null
      ? renderFieldValue('string', item[coverTitleField])
      : String(item.id ?? 'Record')

  const generatedAt = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })

  const data: PdfLayoutData = {
    coverTitle,
    coverSubtitle: layout.pdf_cover_subtitle ?? '',
    logoUrl: (layout.pdf_show_logo ?? true) ? safeLogoUrl : null,
    collectionLabel,
    generatedAt,
    generatedBy,
    coverEnabled: Boolean(layout.pdf_cover_enabled ?? true),
    sections: effectiveSections
  }

  let html: string

  if (layout.pdf_theme === 'custom' && layout.pdf_template_id) {
    const tmpl = await db('nivaro_pdf_templates').where({ id: layout.pdf_template_id }).first()
    if (tmpl?.template) {
      const { Liquid } = await import('liquidjs')
      const engine = new Liquid()
      html = await engine.parseAndRender(tmpl.template as string, {
        cover_title: data.coverTitle,
        cover_subtitle: data.coverSubtitle,
        logo_url: data.logoUrl,
        collection_label: data.collectionLabel,
        generated_at: data.generatedAt,
        generated_by: data.generatedBy,
        cover_enabled: data.coverEnabled,
        sections: data.sections
      })
    } else {
      html = classicTheme(data)
    }
  } else {
    const theme =
      layout.pdf_theme === 'minimal'
        ? minimalTheme
        : layout.pdf_theme === 'executive'
          ? executiveTheme
          : classicTheme
    html = theme(data)
  }

  return htmlToPdf(html, {
    format: (['A4', 'Letter'].includes(layout.pdf_page_size ?? '')
      ? layout.pdf_page_size
      : 'A4') as 'A4' | 'Letter',
    landscape: layout.pdf_orientation === 'landscape'
  })
}

/** Render an HTML string to a PDF buffer (JS disabled, backgrounds on). */
export async function htmlToPdf(
  html: string,
  opts: { format?: 'A4' | 'Letter'; landscape?: boolean } = {}
): Promise<Buffer> {
  const b = await getBrowser()
  const page = await b.newPage()
  try {
    await page.setJavaScriptEnabled(false)
    await page.setContent(html, { waitUntil: 'domcontentloaded' })
    const pdfBuf = await page.pdf({
      format: opts.format ?? 'A4',
      landscape: !!opts.landscape,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    })
    return Buffer.from(pdfBuf)
  } finally {
    await page.close()
  }
}
