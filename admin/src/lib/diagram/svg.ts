// Renders a laid-out Diagram to SVG markup (used for both the on-screen view
// and the SVG / PNG export, so what you see is what you download).

import type { Diagram, DiagramEdge, DiagramNode } from './layout'

export type DiagramTheme = 'light' | 'dark'

interface Palette {
  bg: string
  node: string
  text: string
  sub: string
  border: string
  edge: string
  label: string
  fail: string
  split: string
  start: string
  end: string
  trigger: string
}

const PALETTES: Record<DiagramTheme, Palette> = {
  light: {
    bg: '#ffffff',
    node: '#ffffff',
    text: '#0f172a',
    sub: '#475569',
    border: '#cbd5e1',
    edge: '#64748b',
    label: '#ffffff',
    fail: '#dc2626',
    split: '#7c3aed',
    start: '#047857',
    end: '#b45309',
    trigger: '#ecfeff'
  },
  dark: {
    bg: '#0b1220',
    node: '#111827',
    text: '#e5e7eb',
    sub: '#9ca3af',
    border: '#334155',
    edge: '#94a3b8',
    label: '#0b1220',
    fail: '#f87171',
    split: '#a78bfa',
    start: '#34d399',
    end: '#fbbf24',
    trigger: '#083344'
  }
}

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

function safeColor(c: string | null | undefined, fallback: string): string {
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback
}

function nodeSvg(n: DiagramNode, p: Palette): string {
  const accent = safeColor(n.color, p.edge)
  const role = n.role ?? 'normal'
  const fill = role === 'trigger' ? p.trigger : role === 'virtual' ? 'none' : p.node
  const dash = role === 'virtual' || role === 'fork' ? ' stroke-dasharray="5 4"' : ''
  const stroke = role === 'fork' ? p.split : role === 'initial' ? p.start : p.border
  const sw = role === 'terminal' ? 2.5 : role === 'initial' ? 2 : 1.2
  const rx = role === 'trigger' ? 22 : 10
  const parts: string[] = []
  parts.push(
    `<g data-node="${esc(n.id)}" data-role="${role}">`,
    `<title>${esc(n.title)}</title>`,
    `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`
  )
  if (role === 'terminal') {
    parts.push(
      `<rect x="${n.x + 4}" y="${n.y + 4}" width="${n.w - 8}" height="${n.h - 8}" rx="${Math.max(2, rx - 4)}" fill="none" stroke="${stroke}" stroke-width="1"/>`
    )
  }
  if (role === 'normal' || role === 'initial' || role === 'terminal') {
    parts.push(
      `<rect x="${n.x}" y="${n.y + 8}" width="5" height="${n.h - 16}" rx="2.5" fill="${accent}"/>`
    )
  }
  const tx = n.x + 16
  n.titleLines.forEach((l, i) => {
    parts.push(
      `<text x="${tx}" y="${n.y + 22 + i * 16}" font-family="${FONT}" font-size="13" font-weight="600" fill="${p.text}">${esc(l)}</text>`
    )
  })
  let cy = n.y + 8 + n.titleLines.length * 16 + 4
  if (n.tags?.length) {
    let cx = tx
    for (const t of n.tags) {
      const w = Math.round(t.length * 5.8 + 12)
      const color =
        t === 'Start'
          ? p.start
          : t === 'End'
            ? p.end
            : t.includes('arallel') || t.includes('Runs')
              ? p.split
              : p.sub
      parts.push(
        `<rect x="${cx}" y="${cy}" width="${w}" height="15" rx="7.5" fill="none" stroke="${color}" stroke-width="1"/>`,
        `<text x="${cx + w / 2}" y="${cy + 11}" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="600" fill="${color}">${esc(t)}</text>`
      )
      cx += w + 5
    }
    cy += 20
  }
  n.noteLines.forEach((l, i) => {
    parts.push(
      `<text x="${tx}" y="${cy + 12 + i * 13}" font-family="${FONT}" font-size="11" fill="${p.sub}">${esc(l)}</text>`
    )
  })
  parts.push('</g>')
  return parts.join('')
}

function edgeColor(e: DiagramEdge, p: Palette): string {
  if (e.tone === 'fail') return p.fail
  if (e.tone === 'split') return p.split
  return p.edge
}

function edgeSvg(e: DiagramEdge, p: Palette): string {
  const c = edgeColor(e, p)
  const dash = e.dashed ? ' stroke-dasharray="6 4"' : ''
  const parts = [
    `<g data-edge="${esc(e.id)}"${e.back ? ' data-back="1"' : ''}>`,
    `<path d="${e.d}" fill="none" stroke="${c}" stroke-width="1.6"${dash} marker-end="url(#nv-arrow-${e.tone ?? 'normal'})"/>`
  ]
  const ls = e.lines ?? []
  if (ls.length) {
    parts.push(
      `<rect x="${e.labelX - e.labelW / 2}" y="${e.labelY - e.labelH / 2}" width="${e.labelW}" height="${e.labelH}" rx="5" fill="${p.label}" stroke="${p.border}" stroke-width="0.8" opacity="0.96"/>`
    )
    ls.forEach((l, i) => {
      const y = e.labelY - e.labelH / 2 + 4 + 10 + i * 13
      parts.push(
        `<text x="${e.labelX}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="${i === 0 ? 600 : 400}" fill="${i === 0 ? p.text : p.sub}">${esc(l)}</text>`
      )
    })
  }
  parts.push('</g>')
  return parts.join('')
}

function defs(p: Palette): string {
  const mk = (id: string, c: string) =>
    `<marker id="nv-arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="${c}"/></marker>`
  return `<defs>${mk('normal', p.edge)}${mk('any', p.edge)}${mk('fail', p.fail)}${mk('split', p.split)}</defs>`
}

/** Inner SVG markup (no <svg> wrapper) — edges first, nodes on top. */
export function diagramInner(d: Diagram, theme: DiagramTheme): string {
  const p = PALETTES[theme]
  return (
    defs(p) +
    d.edges.map((e) => edgeSvg(e, p)).join('') +
    d.nodes.map((n) => nodeSvg(n, p)).join('')
  )
}

export function diagramToSvg(d: Diagram, theme: DiagramTheme, title = 'Diagram'): string {
  const p = PALETTES[theme]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><rect width="100%" height="100%" fill="${p.bg}"/>${diagramInner(d, theme)}</svg>`
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportSvg(d: Diagram, theme: DiagramTheme, filename: string, title?: string) {
  downloadBlob(
    new Blob([diagramToSvg(d, theme, title)], { type: 'image/svg+xml;charset=utf-8' }),
    `${filename}.svg`
  )
}

export async function exportPng(
  d: Diagram,
  theme: DiagramTheme,
  filename: string,
  title?: string
): Promise<void> {
  const svg = diagramToSvg(d, theme, title)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('Could not render the diagram'))
      img.src = url
    })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(8000, Math.round(d.width * scale))
    canvas.height = Math.min(8000, Math.round(d.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No canvas support')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!blob) throw new Error('PNG export failed')
    downloadBlob(blob, `${filename}.png`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
