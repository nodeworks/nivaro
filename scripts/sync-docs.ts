#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process'
/**
 * Regenerates sdk/README.md and updates marked sections in www/docs.html
 * from the shared DocSection data in admin/src/docs/.
 * Also regenerates www/openapi.json via generate-api-docs.mjs (DB mode).
 *
 * Run: pnpm sync-docs   (also runs automatically on release scripts)
 *
 * How www/docs.html sync works:
 *   - Add <!-- SYNC:id --> and <!-- /SYNC:id --> markers inside any doc-section div
 *   - This script auto-discovers ALL markers — no hardcoded list needed
 *   - When id matches an admin DocSection id exactly, content is replaced
 *   - When ids diverge (e.g. www "pipeline-owners" vs admin "pipeline-owner-matrix"),
 *     add an entry to ID_REMAP below
 *   - Adding a new admin section: add SYNC markers to www/docs.html, done
 *   - Removing an admin section: markers stay in HTML but produce empty content + warning
 * The data-toc attribute on each doc-section div is also regenerated from
 * the section's h1/h2/h3 nodes so the "On this page" sidebar stays accurate.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { allSections, navSections } from '../admin/src/docs/index.js'
import type { ContentNode } from '../admin/src/docs/types.js'

const ROOT = resolve(import.meta.dirname, '..')

// ─── Inline helpers ───────────────────────────────────────────────────────────

function inlineMd(text: string): string {
  return text // backtick syntax is already valid markdown
}

function inlineHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code class="doc-code">$1</code>')
}

// ─── Node → Markdown ─────────────────────────────────────────────────────────

function nodeToMd(node: ContentNode): string {
  switch (node.type) {
    case 'h1':
      return `## ${node.text}\n`
    case 'h2':
      return `### ${node.text}\n`
    case 'h3':
      return `#### ${node.text}\n`
    case 'p':
      return `${inlineMd(node.text)}\n`
    case 'pre':
      return `\`\`\`typescript\n${node.code}\n\`\`\`\n`
    case 'table': {
      const sep = node.head.map(() => '---').join(' | ')
      const rows = node.rows.map((r) => r.map((c) => inlineMd(c)).join(' | '))
      return (
        [`| ${node.head.join(' | ')} |`, `| ${sep} |`, ...rows.map((r) => `| ${r} |`)].join('\n') +
        '\n'
      )
    }
    case 'note':
      return `> **Note:** ${inlineMd(node.text)}\n`
    case 'warn':
      return `> **Warning:** ${inlineMd(node.text)}\n`
    case 'ul':
      return node.items.map((i) => `- ${inlineMd(i)}`).join('\n') + '\n'
    case 'divider':
      return '---\n'
  }
}

// ─── Node → HTML (www/docs.html class conventions) ───────────────────────────

function nodeToHtml(node: ContentNode, pad = '          '): string {
  switch (node.type) {
    case 'h1':
      return `${pad}<h1 class="doc-h1" id="${node.id}">${inlineHtml(node.text)}</h1>`
    case 'h2':
      return `${pad}<h2 class="doc-h2" id="${node.id}">${inlineHtml(node.text)}</h2>`
    case 'h3':
      return node.id
        ? `${pad}<h3 class="doc-h3" id="${node.id}">${inlineHtml(node.text)}</h3>`
        : `${pad}<h3 class="doc-h3">${inlineHtml(node.text)}</h3>`
    case 'p':
      return `${pad}<p class="doc-p">${inlineHtml(node.text)}</p>`
    case 'pre': {
      const escaped = node.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `${pad}<pre class="doc-pre"><code>${escaped}</code></pre>`
    }
    case 'table': {
      const ths = node.head.map((h) => `<th>${inlineHtml(h)}</th>`).join('')
      const rows = node.rows
        .map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`)
        .join(`\n${pad}    `)
      return [
        `${pad}<div class="doc-table-wrap"><table class="doc-table">`,
        `${pad}  <thead><tr>${ths}</tr></thead>`,
        `${pad}  <tbody><tr>${rows}</tr></tbody>`,
        `${pad}</table></div>`
      ].join('\n')
    }
    case 'note':
      return `${pad}<div class="doc-note">${inlineHtml(node.text)}</div>`
    case 'warn':
      return `${pad}<div class="doc-note doc-warn">${inlineHtml(node.text)}</div>`
    case 'ul':
      return [
        `${pad}<ul class="doc-ul">`,
        ...node.items.map((i) => `${pad}  <li>${inlineHtml(i)}</li>`),
        `${pad}</ul>`
      ].join('\n')
    case 'divider':
      return `${pad}<hr class="doc-divider">`
  }
}

function sectionToHtml(section: { content: ContentNode[] }): string {
  return section.content.map((n) => nodeToHtml(n)).join('\n')
}

// ─── data-toc builder ─────────────────────────────────────────────────────────

function buildToc(section: { content: ContentNode[] }): string {
  const items = section.content
    .filter(
      (n): n is Extract<ContentNode, { type: 'h1' | 'h2' | 'h3'; id: string }> =>
        (n.type === 'h1' || n.type === 'h2' || n.type === 'h3') && !!('id' in n && n.id)
    )
    .map((n) => ({ id: n.id, label: inlineHtml(n.text) }))
  // Single-quote delimited attribute — escape any literal single quotes
  return JSON.stringify(items).replace(/'/g, '&apos;')
}

// ─── ID remap — only divergent ids (1:1 matches are auto-discovered) ─────────

const ID_REMAP: Record<string, string> = {
  overview: 'what-is-nivaro',
  'ug-collections': 'collections',
  'pipeline-owners': 'pipeline-owner-matrix',
  'workflow-overview': 'workflows-guide',
  'microsoft-oidc': 'microsoft-guide',
  'sla-tracking': 'sla-tracking-guide',
  alerts: 'alert-engine-guide',
  imports: 'data-import-guide',
  'submission-forms': 'submission-forms-guide',
  'field-watches': 'field-watches-guide'
}

// ─── www/docs.html sync ───────────────────────────────────────────────────────

function syncWwwDocs(htmlPath: string): {
  updated: number
  noSection: string[]
  noMarker: string[]
} {
  let html = readFileSync(htmlPath, 'utf8')
  let updated = 0
  const noSection: string[] = []

  // Auto-discover every unique SYNC marker id present in the file
  const markerIds = [
    ...new Set([...html.matchAll(/<!-- SYNC:([^/][^ >]*?) -->/g)].map((m) => m[1]))
  ]

  for (const wwwId of markerIds) {
    const docId = ID_REMAP[wwwId] ?? wwwId
    const section = allSections[docId]
    if (!section) {
      noSection.push(`${wwwId}${docId !== wwwId ? ` (→ ${docId})` : ''}`)
      continue
    }

    const start = `<!-- SYNC:${wwwId} -->`
    const end = `<!-- /SYNC:${wwwId} -->`
    const si = html.indexOf(start)
    const ei = html.indexOf(end)
    if (si === -1 || ei === -1) continue

    html =
      html.slice(0, si + start.length) + `\n${sectionToHtml(section)}\n          ` + html.slice(ei)

    // Regenerate data-toc from content nodes so "On this page" sidebar stays accurate
    const toc = buildToc(section)
    html = html.replace(
      new RegExp(`(id="s-${wwwId}"[^>]*?)data-toc='[^']*'`),
      `$1data-toc='${toc}'`
    )

    updated++
  }

  writeFileSync(htmlPath, html, 'utf8')

  // Sections in admin with no www marker (informational)
  const covered = new Set(markerIds.map((id) => ID_REMAP[id] ?? id))
  const noMarker = Object.keys(allSections).filter((id) => !covered.has(id))

  return { updated, noSection, noMarker }
}

// ─── sdk/README.md ────────────────────────────────────────────────────────────

function generateSdkReadme(): void {
  const sdkGroup = navSections.find((g) => g.id === 'sdk')
  if (!sdkGroup) throw new Error('SDK nav group not found')

  const body = sdkGroup.items.map((s) => s.content.map(nodeToMd).join('\n')).join('\n---\n\n')

  const readme = `# @nivaro/sdk

TypeScript SDK for [Nivaro CMS](https://nivaro.dev) — typed REST client, GraphQL, realtime subscriptions, and presence.

## Installation

\`\`\`bash
npm install @nivaro/sdk
# or
pnpm add @nivaro/sdk
\`\`\`

All API calls use \`nivaro.request(command)\` where \`command\` is a typed descriptor built by one of the helper functions below.

---

${body}

---

## TypeScript

All commands are fully typed. Pass your collection interface as a generic to get typed responses:

\`\`\`typescript
interface Project {
  id: string
  name: string
  status: 'active' | 'done' | 'archived'
  owner: string
  created_at: string
}

const list = await nivaro.request(readItems<Project>('projects', {
  filter: { status: _eq('active') },
  sort: [desc('created_at')],
}))
// list.data is Project[]

const { data: project } = await nivaro.request(readItem<Project>('projects', id))
// project is Project
\`\`\`

---

## License

MIT — see [LICENSE](https://github.com/nodeworks/nivaro/blob/main/LICENSE).
`

  writeFileSync(resolve(ROOT, 'sdk/README.md'), readme, 'utf8')
  console.log('✓ sdk/README.md regenerated')
}

// ─── Entry ────────────────────────────────────────────────────────────────────

generateSdkReadme()

const wwwPath = resolve(ROOT, 'www/docs.html')
const { updated, noSection, noMarker } = syncWwwDocs(wwwPath)
console.log(`✓ www/docs.html — ${updated} sections updated, data-toc regenerated`)
if (noSection.length) {
  console.warn(`  ⚠ ${noSection.length} www markers have no admin DocSection:`)
  for (const s of noSection) console.warn(`    • ${s}`)
}
if (noMarker.length) {
  console.log(
    `  ℹ ${noMarker.length} admin sections have no www marker (www-only or not yet added):`
  )
  for (const s of noMarker) console.log(`    • ${s}`)
}

// ─── www/openapi.json (feeds api-reference.html) ─────────────────────────────

console.log('→ Regenerating www/openapi.json …')
const apiDocsResult = spawnSync('node', [resolve(ROOT, 'scripts/generate-api-docs.mjs')], {
  stdio: 'inherit',
  cwd: ROOT
})
if (apiDocsResult.status !== 0) {
  console.warn(
    '  ⚠ www/openapi.json generation failed (DB unavailable?). api-reference.html will show stale data.'
  )
} else {
  console.log('✓ www/openapi.json regenerated — api-reference.html is up to date')
}
