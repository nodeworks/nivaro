import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import Underline from '@tiptap/extension-underline'
import {
  Bold,
  Italic,
  UnderlineIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Minus,
  Link as LinkIcon,
  Link2Off,
} from 'lucide-react'
import { cn } from '@/lib/utils'

import './rich-text-editor.css'

interface ToolbarButtonProps {
  active?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}

function ToolbarButton({ active, disabled, title, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type='button'
      title={title}
      disabled={disabled}
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200',
        active && 'bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100'
      )}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className='mx-0.5 h-4 w-px bg-slate-200 dark:bg-slate-700' />
}

interface Props {
  value: string
  onChange: (html: string) => void
  disabled?: boolean
  placeholder?: string
}

export function RichTextEditor({ value, onChange, disabled, placeholder }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
      }),
      Underline,
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: value || '',
    editable: !disabled,
    onUpdate({ editor }) {
      onChange(editor.getHTML())
    },
  })

  if (!editor) return null

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('URL', prev ?? 'https://')
    if (url === null) return
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <div className={cn(
      'overflow-hidden rounded-md border border-input bg-background',
      disabled && 'opacity-60'
    )}>
      {/* Toolbar */}
      {!disabled && (
        <div className='flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900'>
          <ToolbarButton
            title='Bold'
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Italic'
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Underline'
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Strikethrough'
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough className='h-3.5 w-3.5' />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            title='Heading 1'
            active={editor.isActive('heading', { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Heading 2'
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Heading 3'
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 className='h-3.5 w-3.5' />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            title='Bullet list'
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Ordered list'
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className='h-3.5 w-3.5' />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            title='Blockquote'
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Code block'
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            <Code className='h-3.5 w-3.5' />
          </ToolbarButton>
          <ToolbarButton
            title='Horizontal rule'
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          >
            <Minus className='h-3.5 w-3.5' />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            title='Link'
            active={editor.isActive('link')}
            onClick={setLink}
          >
            <LinkIcon className='h-3.5 w-3.5' />
          </ToolbarButton>
          {editor.isActive('link') && (
            <ToolbarButton
              title='Remove link'
              onClick={() => editor.chain().focus().unsetLink().run()}
            >
              <Link2Off className='h-3.5 w-3.5' />
            </ToolbarButton>
          )}
        </div>
      )}

      {/* Editor area */}
      <EditorContent
        editor={editor}
        className='nivaro-rich-text min-h-[160px] px-3 py-2 text-[13px]'
      />
    </div>
  )
}
