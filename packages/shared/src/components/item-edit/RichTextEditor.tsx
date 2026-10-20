import { lazy, Suspense } from 'react'
import { Skeleton } from '../ui/skeleton'

// TipTap and ProseMirror are ~380 KB. Most screens never show a rich-text
// field, so the editor loads as its own chunk the first time one mounts
// instead of riding along in the entry.
const Impl = lazy(() => import('./RichTextEditorImpl').then((m) => ({ default: m.RichTextEditor })))

type Props = {
  value: string
  onChange: (v: unknown) => void
  placeholder?: string
  disabled?: boolean
  /** Paste control (#189): strip formatting from pasted content. */
  pastePlain?: boolean
}

export function RichTextEditor(props: Props) {
  // Toolbar (~36px) + the body's 120px minimum, so the field does not jump.
  return (
    <Suspense fallback={<Skeleton className='h-[158px] w-full rounded-lg' aria-busy='true' />}>
      <Impl {...props} />
    </Suspense>
  )
}
