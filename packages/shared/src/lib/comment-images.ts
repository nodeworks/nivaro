/**
 * Images pasted or dropped into a comment. The comment text carries one
 * markdown-style line per image, `![name](/api/files/<id>)`: plain text, so
 * every reader, mail and preview that only knows text still shows something
 * sensible, and the server already attributes a file named in a comment's text
 * to the record (services/file-attribution.ts), so exactly the people who can
 * read the record can open the picture. api services/comment-images.ts is the
 * server twin of the token shape.
 */

export const MAX_COMMENT_IMAGES = 6

const TOKEN_RE = /!\[([^\]\n]*)\]\(\/api\/files\/([0-9a-fA-F-]{36})\)/g

export function commentImageToken(id: string, name: string): string {
  const clean =
    name
      .replace(/[[\]()\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'image'
  return `![${clean}](/api/files/${id})`
}

/** The text to post: what was typed, then one line per attached image. */
export function withCommentImages(
  text: string,
  images: Array<{ id: string; name: string }>
): string {
  const lines = images.map((i) => commentImageToken(i.id, i.name))
  return [text.trim(), ...lines].filter(Boolean).join('\n')
}

export type CommentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; id: string; name: string }

/** Comment text split into runs of text and images, in order. */
export function splitCommentImages(text: string): CommentPart[] {
  const parts: CommentPart[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) })
    parts.push({ kind: 'image', id: m[2], name: m[1] || 'image' })
    last = at + m[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

/** A one-line preview: each image reads "[image]". */
export function stripCommentImages(text: string): string {
  return text.replace(TOKEN_RE, '[image]')
}

/** The image files in a paste or drop (a screenshot arrives as an unnamed png). */
export function imageFilesFrom(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  const out: File[] = []
  for (const f of Array.from(data.files ?? [])) {
    if (!f.type.startsWith('image/')) continue
    if (f.name && f.name !== 'image.png') {
      out.push(f)
      continue
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    out.push(
      new File([f], `screenshot-${stamp}.${f.type.split('/')[1] || 'png'}`, { type: f.type })
    )
  }
  return out
}
