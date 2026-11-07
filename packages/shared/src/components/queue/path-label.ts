/**
 * The header a queue column (and the Peek sheet's field label) falls back to
 * when the queue gives the path no alias. Plain words, never the raw path
 * (army 7 N7: Peek read "PROJECT TYPE → NAME", "WORKFLOW LINES → ID"):
 *  - a relation's own display column names the relation: `project_type.name`
 *    → "Project Type", `workflow_lines.id` → "Workflow Lines"
 *  - a column that repeats its relation's name drops the repeat:
 *    `project.project_id` → "Project ID"
 *  - anything else keeps the hop: `workflow_lines.requisition_id` →
 *    "Workflow Lines → Requisition ID"
 */
const DISPLAY_LEAVES = new Set(['id', 'name', 'title', 'label', 'type', 'code', 'display_name'])

function words(seg: string): string {
  return seg
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/g, 'ID')
}

export function pathHeader(path: string): string {
  const segs = path.split('.').filter(Boolean)
  if (segs.length === 0) return path
  if (segs.length === 1) return words(segs[0])
  const leaf = segs[segs.length - 1]
  const parent = segs[segs.length - 2]
  const head = segs.slice(0, -1)
  if (DISPLAY_LEAVES.has(leaf.toLowerCase())) return head.map(words).join(' → ')
  if (leaf.toLowerCase().startsWith(`${parent.toLowerCase()}_`))
    return [...segs.slice(0, -2), leaf].map(words).join(' → ')
  return segs.map(words).join(' → ')
}
