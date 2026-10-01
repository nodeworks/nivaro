import { formatRelative } from '../lib/utils'

/** What changed on a record since the viewer last opened it (#643). */
export interface UnseenChange {
  changed_at: string
  by: string | null
  kinds: string[]
}

const KIND_WORDS: Record<string, string> = {
  edit: 'edited',
  transition: 'moved',
  comment: 'commented on'
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? 'changed'
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** "Beth edited and moved this · 2h ago" — one sentence for every host. */
export function unseenSentence(u: UnseenChange): string {
  const what = joinWords(u.kinds.map((k) => KIND_WORDS[k] ?? k))
  const when = Number.isNaN(new Date(u.changed_at).getTime())
    ? ''
    : ` · ${formatRelative(u.changed_at)}`
  return `${u.by ?? 'Someone'} ${what} this since you last opened it${when}`
}

/**
 * The "changed since you last looked" mark. Always occupies its slot — pass
 * `change={null}` to reserve the space on rows that have nothing new, so the
 * column beside it never shifts between rows.
 *
 * The visible dot is 7px; the hover target around it is 16px so the
 * explanation is actually reachable.
 */
export function UnseenDot({
  change,
  dataAttr = 'data-unseen',
  hang = false
}: {
  change: UnseenChange | null | undefined
  /** Probe hook kept per host (`data-cbv-unseen`, `data-queue-unseen`). */
  dataAttr?: string
  /**
   * Hang the mark in the cell's left padding (inside a `gap-1.5` flex row) so
   * the text after it stays aligned with its column header. The host widens
   * that column's left padding to make room.
   */
  hang?: boolean
}) {
  if (!change) return hang ? null : <span aria-hidden className='inline-block h-4 w-4 shrink-0' />
  const sentence = unseenSentence(change)
  return (
    <span
      {...{ [dataAttr]: '' }}
      data-tip={sentence}
      role='img'
      aria-label={sentence}
      className={`inline-flex h-4 w-4 shrink-0 cursor-default items-center justify-center ${hang ? '-ml-[22px]' : ''}`}
    >
      <span className='h-[7px] w-[7px] rounded-full bg-nvr-cyan ring-[3px] ring-nvr-cyan/15' />
    </span>
  )
}
