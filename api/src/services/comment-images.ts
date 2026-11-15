/**
 * Server twin of packages/shared lib/comment-images.ts: a screenshot pasted into
 * a comment is one `![name](/api/files/<id>)` line in the comment text. Who may
 * open the picture needs no extra code here: file-attribution.ts already reads
 * every file id in a comment's text as "used on that record", and the comment
 * routes refuse a new link to a file the writer cannot open. This only turns the
 * lines into short words for the places that show a comment as plain text
 * (mention notifications, previews).
 */

const TOKEN_RE = /!\[([^\]\n]*)\]\(\/api\/files\/[0-9a-fA-F-]{36}\)/g

/** Comment text with every pasted image line read as "[image: name]". */
export function commentTextForPreview(text: string): string {
  return text.replace(TOKEN_RE, (_m, name: string) => (name ? `[image: ${name}]` : '[image]'))
}
