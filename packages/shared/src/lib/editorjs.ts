// Editor.js documents ({"time":…,"blocks":[…]}) — how the legacy store kept WYSIWYG fields.
// Light on purpose (no editor imports): history, tables and summaries read these values too, and
// must show the words, never the JSON.

type EditorJsBlock = { type?: string; data?: Record<string, unknown> }
type EditorJsDoc = { blocks?: EditorJsBlock[] }

function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The document, whether stored as JSON text or already parsed; null when it is not one. */
export function editorJsDoc(v: unknown): EditorJsDoc | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Array.isArray((v as EditorJsDoc).blocks) ? (v as EditorJsDoc) : null
  }
  if (typeof v !== 'string') return null
  const t = v.trimStart()
  if (!t.startsWith('{') || !t.includes('"blocks"')) return null
  try {
    const doc = JSON.parse(t) as EditorJsDoc
    return Array.isArray(doc?.blocks) ? doc : null
  } catch {
    return null
  }
}

export const isEditorJsValue = (v: unknown): boolean => editorJsDoc(v) !== null

export function editorJsToHtml(raw: unknown): string {
  const doc = editorJsDoc(raw)
  if (!doc) return typeof raw === 'string' && raw ? `<p>${esc(raw)}</p>` : ''
  return (doc.blocks ?? [])
    .map((b) => {
      const data = b.data ?? {}
      const text = esc(String(data.text ?? ''))
      const level = Math.max(1, Math.min(6, Number(data.level ?? 2)))
      switch (b.type) {
        case 'paragraph':
          return `<p>${text}</p>`
        case 'header':
          return `<h${level}>${text}</h${level}>`
        case 'list': {
          const items = ((data.items ?? []) as unknown[])
            .map((i) => `<li>${esc(itemText(i))}</li>`)
            .join('')
          return data.style === 'ordered' ? `<ol>${items}</ol>` : `<ul>${items}</ul>`
        }
        case 'quote':
          return `<blockquote><p>${text}</p></blockquote>`
        default:
          return text ? `<p>${text}</p>` : ''
      }
    })
    .join('')
}

/** A list item: a plain string, or Editor.js nested-list's {content, items}. */
function itemText(i: unknown): string {
  if (typeof i === 'string') return i
  if (i && typeof i === 'object' && 'content' in i)
    return String((i as { content: unknown }).content)
  return ''
}

const plain = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()

/** The document as readable text: one line per block, list items bulleted or numbered. */
export function editorJsToText(raw: unknown): string {
  const doc = editorJsDoc(raw)
  if (!doc) return ''
  const lines: string[] = []
  for (const b of doc.blocks ?? []) {
    const data = b.data ?? {}
    if (b.type === 'list') {
      const ordered = data.style === 'ordered'
      ;((data.items ?? []) as unknown[]).forEach((i, n) => {
        const t = plain(itemText(i))
        if (t) lines.push(`${ordered ? `${n + 1}.` : '•'} ${t}`)
      })
      continue
    }
    const t = plain(String(data.text ?? ''))
    if (t) lines.push(t)
  }
  return lines.join('\n')
}
