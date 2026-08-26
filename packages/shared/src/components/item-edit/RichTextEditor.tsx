import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useQuery } from '@tanstack/react-query'
import {
  Bold,
  Check,
  Code,
  FileSymlink,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2Off,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Quote,
  Strikethrough,
  UnderlineIcon,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useApiFetchConfig, useItemNavigation } from '../../context'
import { cn } from '../../lib/utils'
import { SimpleSelect } from '../ui/SimpleSelect'

// ─── EditorJS JSON → HTML ──────────────────────────────────────────────────────

type EditorJsBlock = { type: string; data: Record<string, unknown> }

function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function editorJsToHtml(raw: string): string {
  try {
    const doc = JSON.parse(raw || '{}') as { blocks?: EditorJsBlock[] }
    return (doc.blocks ?? [])
      .map((b) => {
        const text = esc(String(b.data.text ?? ''))
        const level = Math.max(1, Math.min(6, Number(b.data.level ?? 2)))
        switch (b.type) {
          case 'paragraph':
            return `<p>${text}</p>`
          case 'header':
            return `<h${level}>${text}</h${level}>`
          case 'list': {
            const items = ((b.data.items ?? []) as string[])
              .map((i) => `<li>${esc(i)}</li>`)
              .join('')
            return b.data.style === 'ordered' ? `<ol>${items}</ol>` : `<ul>${items}</ul>`
          }
          case 'quote':
            return `<blockquote><p>${text}</p></blockquote>`
          default:
            return text ? `<p>${text}</p>` : ''
        }
      })
      .join('')
  } catch {
    return `<p>${esc(raw)}</p>`
  }
}

// ─── Tiptap toolbar primitives ─────────────────────────────────────────────────

export function TiptapToolbarButton({
  active,
  title,
  onClick,
  children
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700',
        active && 'bg-slate-200 text-slate-900'
      )}
    >
      {children}
    </button>
  )
}

export function TiptapDivider() {
  return <div className='mx-0.5 h-4 w-px bg-slate-200' />
}

// ─── RichTextEditor ────────────────────────────────────────────────────────────

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  disabled,
  pastePlain
}: {
  value: string
  onChange: (v: unknown) => void
  placeholder?: string
  disabled?: boolean
  /** Paste control (#189): strip formatting from pasted content. */
  pastePlain?: boolean
}) {
  const [linkInputOpen, setLinkInputOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [recordLinkOpen, setRecordLinkOpen] = useState(false)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const apiCfg = useApiFetchConfig()
  const itemNav = useItemNavigation()

  const initialHtml = useMemo(() => {
    if (!value) return ''
    const isEditorJs = value.trimStart().startsWith('{"time":') && value.includes('"blocks":')
    return isEditorJs ? editorJsToHtml(value) : value
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps — initialHtml is init-only

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ bulletList: { keepMarks: true }, orderedList: { keepMarks: true } }),
      Underline,
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
      // 'record' protocol (#666): record://<collection>/<id> links survive the
      // Link extension's allowed-URI validation and render as record chips.
      Link.configure({ openOnClick: false, autolink: true, protocols: ['record'] })
    ],
    content: initialHtml,
    editable: !disabled,
    editorProps: pastePlain
      ? {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData('text/plain')
            if (text == null) return false
            event.preventDefault()
            view.dispatch(view.state.tr.insertText(text))
            return true
          }
        }
      : undefined,
    onUpdate({ editor }) {
      onChange(editor.getHTML())
    }
  })

  const prevValue = useRef(value)
  useEffect(() => {
    if (!editor || prevValue.current === value) return
    prevValue.current = value
    const isEditorJs = value.trimStart().startsWith('{"time":') && value.includes('"blocks":')
    const html = isEditorJs ? editorJsToHtml(value) : value || ''
    if (editor.getHTML() !== html) {
      editor.commands.setContent(html, { emitUpdate: false })
    }
  }, [editor, value])

  if (!editor) return null

  const openLinkInput = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    setLinkUrl(prev ?? 'https://')
    setLinkInputOpen(true)
    setTimeout(() => linkInputRef.current?.select(), 0)
  }
  const commitLink = () => {
    if (linkUrl === '') editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run()
    setLinkInputOpen(false)
    setLinkUrl('')
  }
  const cancelLink = () => {
    setLinkInputOpen(false)
    setLinkUrl('')
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-slate-200 bg-background focus-within:ring-1 focus-within:ring-[#00ceff] focus-within:border-[#00ceff]',
        disabled && 'opacity-60'
      )}
    >
      {!disabled && (
        <>
          <div className='flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5'>
            <TiptapToolbarButton
              title='Bold'
              active={editor.isActive('bold')}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Italic'
              active={editor.isActive('italic')}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Underline'
              active={editor.isActive('underline')}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            >
              <UnderlineIcon className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Strikethrough'
              active={editor.isActive('strike')}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapDivider />
            <TiptapToolbarButton
              title='Heading 1'
              active={editor.isActive('heading', { level: 1 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            >
              <Heading1 className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Heading 2'
              active={editor.isActive('heading', { level: 2 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              <Heading2 className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Heading 3'
              active={editor.isActive('heading', { level: 3 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            >
              <Heading3 className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapDivider />
            <TiptapToolbarButton
              title='Bullet list'
              active={editor.isActive('bulletList')}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              <List className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Ordered list'
              active={editor.isActive('orderedList')}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapDivider />
            <TiptapToolbarButton
              title='Blockquote'
              active={editor.isActive('blockquote')}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            >
              <Quote className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Code block'
              active={editor.isActive('codeBlock')}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              <Code className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapToolbarButton
              title='Horizontal rule'
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
            >
              <Minus className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            <TiptapDivider />
            <TiptapToolbarButton
              title='Link'
              active={editor.isActive('link')}
              onClick={openLinkInput}
            >
              <LinkIcon className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
            {editor.isActive('link') && (
              <TiptapToolbarButton
                title='Remove link'
                onClick={() => editor.chain().focus().unsetLink().run()}
              >
                <Link2Off className='h-3.5 w-3.5' />
              </TiptapToolbarButton>
            )}
            <TiptapToolbarButton
              title='Link record'
              active={recordLinkOpen}
              onClick={() => {
                setRecordLinkOpen((v) => !v)
                setLinkInputOpen(false)
              }}
            >
              <FileSymlink className='h-3.5 w-3.5' />
            </TiptapToolbarButton>
          </div>
          {linkInputOpen && (
            <div className='flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5'>
              <input
                ref={linkInputRef}
                type='url'
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitLink()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelLink()
                  }
                }}
                placeholder='https://example.com'
                aria-label='Link URL'
                className='flex-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[12px] text-slate-700 outline-none focus:border-[#00ceff]'
              />
              <button
                type='button'
                title='Apply link'
                onMouseDown={(e) => {
                  e.preventDefault()
                  commitLink()
                }}
                className='flex h-5 w-5 items-center justify-center rounded text-emerald-600 hover:bg-emerald-50'
              >
                <Check className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                title='Cancel'
                onMouseDown={(e) => {
                  e.preventDefault()
                  cancelLink()
                }}
                className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          )}
          {recordLinkOpen && (
            <RecordLinkPanel
              apiBase={apiCfg.apiBase}
              authHeaders={apiCfg.authHeaders}
              credentials={apiCfg.credentials}
              onInsert={(label, href) => {
                editor
                  .chain()
                  .focus()
                  .insertContent([
                    { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] },
                    { type: 'text', text: ' ' }
                  ])
                  .run()
                setRecordLinkOpen(false)
              }}
              onClose={() => setRecordLinkOpen(false)}
            />
          )}
        </>
      )}
      {/* Record link chips (#666) — record://<collection>/<id> hrefs. Styled via
          a scoped stylesheet since attribute selectors don't fit Tailwind
          arbitrary variants cleanly; clicks route through NavigationContext. */}
      <style>{`
        .nivaro-rich-text a { color: #00a5cc; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
        .nivaro-rich-text a[href^="record://"] {
          display: inline-block; text-decoration: none; cursor: pointer;
          background: rgba(0, 206, 255, 0.12); color: inherit;
          border-radius: 9999px; padding: 0 8px; font-weight: 500; font-size: 0.92em;
        }
        .nivaro-rich-text a[href^="record://"]::before { content: '↗ '; opacity: 0.55; }
      `}</style>
      <EditorContent
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest?.('a')
          const href = a?.getAttribute('href') ?? ''
          if (href.startsWith('record://')) {
            e.preventDefault()
            const [collection, itemId] = href.slice('record://'.length).split('/')
            if (collection && itemId) itemNav.open({ collection, itemId })
          }
        }}
        editor={editor}
        className='nivaro-rich-text min-h-[120px] px-3 py-2 text-[13px] [&_.tiptap]:outline-none [&_.tiptap]:min-h-[100px] [&_.tiptap_p]:my-1 [&_.tiptap_h1]:text-xl [&_.tiptap_h2]:text-lg [&_.tiptap_h3]:text-base [&_.tiptap_h1,&_.tiptap_h2,&_.tiptap_h3]:font-semibold [&_.tiptap_ul]:list-disc [&_.tiptap_ol]:list-decimal [&_.tiptap_ul,&_.tiptap_ol]:pl-5 [&_.tiptap_blockquote]:border-l-2 [&_.tiptap_blockquote]:border-slate-300 [&_.tiptap_blockquote]:pl-3 [&_.tiptap_blockquote]:text-slate-500 [&_.tiptap_code]:bg-slate-100 [&_.tiptap_code]:rounded [&_.tiptap_code]:px-1 [&_.tiptap_pre]:bg-slate-100 [&_.tiptap_pre]:rounded [&_.tiptap_pre]:p-2 [&_.tiptap_pre]:font-mono [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:text-slate-400 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0'
      />
    </div>
  )
}

// ─── Record link panel (#666) ──────────────────────────────────────────────────
// Pick a collection, search its records, insert a record://<collection>/<id>
// link with the record's display label as text. Read access is enforced by the
// /collections and /items endpoints themselves — a collection the viewer can't
// read never lists, a record they can't read never matches.

type RecordLinkCollection = {
  collection: string
  display_name?: string | null
  hidden?: boolean
  display_template?: string | null
}

function renderPlainTemplate(template: string | null | undefined, row: Record<string, unknown>): string {
  if (!template) return ''
  return template
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, token: string) => {
      if (token.includes('.')) return ''
      const v = row[token]
      return v == null ? '' : String(v)
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function recordLabel(row: Record<string, unknown>, template?: string | null): string {
  const fromTemplate = renderPlainTemplate(template, row)
  if (fromTemplate) return fromTemplate
  for (const k of ['name', 'title', 'label', 'subject']) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return `#${String(row.id ?? '')}`
}

function RecordLinkPanel({
  apiBase,
  authHeaders,
  credentials,
  onInsert,
  onClose
}: {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
  onInsert: (label: string, href: string) => void
  onClose: () => void
}) {
  const [collection, setCollection] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const jsonFetch = (path: string) =>
    fetch(`${apiBase}${path}`, {
      headers: authHeaders,
      credentials
    }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r.json()
    })

  const { data: collections } = useQuery<RecordLinkCollection[]>({
    queryKey: ['rte-record-link-collections'],
    queryFn: () =>
      jsonFetch('/collections').then((d: { data?: RecordLinkCollection[] }) =>
        (Array.isArray(d?.data) ? d.data : []).filter(
          (c) => !c.hidden && !c.collection.startsWith('nivaro_')
        )
      ),
    staleTime: 5 * 60_000
  })
  const selected = collections?.find((c) => c.collection === collection)

  const { data: results, isFetching } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['rte-record-link-search', collection, debounced],
    enabled: !!collection && debounced.trim().length > 0,
    queryFn: () =>
      jsonFetch(
        `/items/${collection}?limit=10&search=${encodeURIComponent(debounced.trim())}`
      ).then((d: { data?: Array<Record<string, unknown>> }) => (Array.isArray(d?.data) ? d.data : []))
  })

  return (
    <div className='space-y-1.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5'>
      <div className='flex items-center gap-1.5'>
        <SimpleSelect
          value={collection}
          onChange={setCollection}
          ariaLabel='Collection'
          className='h-6 w-44 rounded border-slate-200 bg-white text-[12px]'
          options={[
            { value: '', label: 'Collection…' },
            ...(collections ?? []).map((c) => ({
              value: c.collection,
              label: c.display_name || c.collection
            }))
          ]}
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder={collection ? 'Search records…' : 'Pick a collection first'}
          disabled={!collection}
          aria-label='Search records'
          className='flex-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[12px] text-slate-700 outline-none focus:border-[#00ceff] disabled:opacity-50'
        />
        {isFetching && <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />}
        <button
          type='button'
          title='Close'
          onMouseDown={(e) => {
            e.preventDefault()
            onClose()
          }}
          className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {collection && debounced.trim() && (results?.length ?? 0) === 0 && !isFetching && (
        <p className='px-1 text-[11px] text-slate-400'>No matching records.</p>
      )}
      {(results?.length ?? 0) > 0 && (
        <div className='max-h-40 overflow-y-auto rounded border border-slate-200 bg-white'>
          {(results ?? []).map((row) => {
            const label = recordLabel(row, selected?.display_template)
            const id = String(row.id ?? '')
            return (
              <button
                key={id}
                type='button'
                onMouseDown={(e) => {
                  e.preventDefault()
                  if (id) onInsert(label, `record://${collection}/${id}`)
                }}
                className='flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-muted'
              >
                <FileSymlink className='h-3 w-3 shrink-0 text-[#00a5cc]' />
                <span className='min-w-0 flex-1 truncate'>{label}</span>
                <span className='shrink-0 font-mono text-[10.5px] text-slate-400'>#{id}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
