// api/src/services/pdf-layout.ts
import type { Browser } from 'puppeteer'
import puppeteer from 'puppeteer'
import { db } from '../db/index.js'
import { classicTheme, executiveTheme, minimalTheme } from './pdf-layout-themes.js'
import type { PdfLayoutData } from './pdf-layout-themes.js'

let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  })
  browser.on('disconnected', () => { browser = null })
  return browser
}

export function renderFieldValue(type: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean' || type === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.map(v => renderFieldValue('string', v)).join(', ')
  if (type === 'date' && typeof value === 'string') {
    try {
      return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    } catch { return String(value) }
  }
  if (type === 'datetime' && typeof value === 'string') {
    try {
      return new Date(value).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch { return String(value) }
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
    const first = Object.values(value as Record<string, unknown>).find(v => typeof v === 'string')
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

interface GroupRow { id: number; label: string; sort: number }
interface AssignmentRow {
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  is_visible: boolean | number | null
}
interface FieldMetaRow { field: string; label: string | null; type: string }

export async function generatePdfFromLayout(params: {
  layout: LayoutRow
  collectionLabel: string
  item: Record<string, unknown>
  groups: GroupRow[]
  assignments: AssignmentRow[]
  fieldMeta: FieldMetaRow[]
  logoUrl: string | null
  generatedBy: string
}): Promise<Buffer> {
  const { layout, collectionLabel, item, groups, assignments, fieldMeta, logoUrl, generatedBy } = params

  const fieldMetaMap = new Map(fieldMeta.map(f => [f.field, f]))

  const sections = groups
    .sort((a, b) => a.sort - b.sort)
    .map(group => {
      const groupFields = assignments
        .filter(a =>
          a.group_key === String(group.id) &&
          a.is_visible !== 0 &&
          a.is_visible !== false &&
          !a.field.startsWith('__')
        )
        .sort((a, b) => a.sort - b.sort)
        .map(a => {
          const meta = fieldMetaMap.get(a.field)
          return {
            label: a.label_override ?? meta?.label ?? a.field,
            value: renderFieldValue(meta?.type ?? 'string', item[a.field]),
          }
        })
      return { label: group.label, fields: groupFields }
    })
    .filter(s => s.fields.length > 0)

  const coverTitleField = layout.pdf_cover_title_field
  const coverTitle = coverTitleField && item[coverTitleField] != null
    ? renderFieldValue('string', item[coverTitleField])
    : String(item['id'] ?? 'Record')

  const generatedAt = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  })

  const data: PdfLayoutData = {
    coverTitle,
    coverSubtitle: layout.pdf_cover_subtitle ?? '',
    logoUrl: Boolean(layout.pdf_show_logo ?? true) ? logoUrl : null,
    collectionLabel,
    generatedAt,
    generatedBy,
    coverEnabled: Boolean(layout.pdf_cover_enabled ?? true),
    sections,
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
        sections: data.sections,
      })
    } else {
      html = classicTheme(data)
    }
  } else {
    const theme = layout.pdf_theme === 'minimal' ? minimalTheme
      : layout.pdf_theme === 'executive' ? executiveTheme
      : classicTheme
    html = theme(data)
  }

  const b = await getBrowser()
  const page = await b.newPage()
  try {
    await page.setContent(html, { waitUntil: 'load' })
    const pdfBuf = await page.pdf({
      format: (layout.pdf_page_size as 'A4' | 'Letter') ?? 'A4',
      landscape: layout.pdf_orientation === 'landscape',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })
    return Buffer.from(pdfBuf)
  } finally {
    await page.close()
  }
}
