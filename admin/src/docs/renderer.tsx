import type React from 'react'
import type { ContentNode, DocSection } from './types.js'

// ─── Inline text parser ───────────────────────────────────────────────────────
// Parses `backtick` spans into <code> elements; everything else is plain text.

function parseInline(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800 dark:bg-slate-800 dark:text-slate-200'
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}

// ─── Node renderer ────────────────────────────────────────────────────────────

function renderNode(node: ContentNode, i: number): React.ReactElement {
  switch (node.type) {
    case 'h1':
      return (
        <h2
          key={i}
          id={node.id}
          className='mb-3 mt-0 text-[1.35rem] font-semibold text-slate-900 dark:text-foreground'
        >
          {node.text}
        </h2>
      )
    case 'h2':
      return (
        <h3
          key={i}
          id={node.id}
          className='mb-2 mt-6 text-[1.1rem] font-semibold text-slate-800 dark:text-foreground'
        >
          {node.text}
        </h3>
      )
    case 'h3':
      return (
        <h4
          key={i}
          id={node.id}
          className='mb-1.5 mt-5 text-[0.95rem] font-semibold text-slate-700 dark:text-foreground'
        >
          {node.text}
        </h4>
      )
    case 'p':
      return (
        <p
          key={i}
          className='mb-3 text-[0.875rem] leading-relaxed text-slate-600 dark:text-slate-300'
        >
          {parseInline(node.text)}
        </p>
      )
    case 'pre':
      return (
        <pre
          key={i}
          className='mb-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-[0.8rem] leading-relaxed text-slate-100'
        >
          <code>{node.code}</code>
        </pre>
      )
    case 'table':
      return (
        <div
          key={i}
          className='mb-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-border'
        >
          <table className='w-full text-[0.8rem]'>
            <thead>
              <tr className='border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted'>
                {node.head.map((h, hi) => (
                  <th
                    key={hi}
                    className='px-3 py-2 text-left font-medium text-slate-700 dark:text-foreground'
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, ri) => (
                <tr key={ri} className='border-b border-slate-100 last:border-0 dark:border-border'>
                  {row.map((cell, ci) => (
                    <td key={ci} className='px-3 py-2 text-slate-600 dark:text-slate-300 align-top'>
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'note':
      return (
        <div
          key={i}
          className='mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-[0.85rem] text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
        >
          {parseInline(node.text)}
        </div>
      )
    case 'warn':
      return (
        <div
          key={i}
          className='mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[0.85rem] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
        >
          {parseInline(node.text)}
        </div>
      )
    case 'ul':
      return (
        <ul
          key={i}
          className='mb-4 list-disc space-y-1 pl-5 text-[0.875rem] text-slate-600 dark:text-slate-300'
        >
          {node.items.map((item, ii) => (
            <li key={ii}>{parseInline(item)}</li>
          ))}
        </ul>
      )
    case 'divider':
      return <hr key={i} className='my-8 border-slate-200 dark:border-border' />
  }
}

// ─── Section renderer ─────────────────────────────────────────────────────────

export function DocRenderer({ section }: { section: DocSection }): React.ReactElement {
  return <section>{section.content.map((node, i) => renderNode(node, i))}</section>
}
