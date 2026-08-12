// api/src/services/pdf-layout-themes.ts

export interface PdfLayoutData {
  coverTitle: string
  coverSubtitle: string
  logoUrl: string | null
  collectionLabel: string
  generatedAt: string
  generatedBy: string
  coverEnabled: boolean
  sections: Array<{
    label: string
    /** Start this section on a fresh page (set for child-table sections). */
    pageBreak?: boolean
    fields: Array<{ label: string; value: string; colSpan?: number; rawHtml?: boolean; hideLabel?: boolean }>
  }>
}

function renderFieldsGrid(fields: Array<{ label: string; value: string; colSpan?: number; rawHtml?: boolean; hideLabel?: boolean }>): string {
  return `<div class="fields-grid">${fields.map(f => {
    const full = !f.colSpan || f.colSpan > 6
    const valueHtml = f.rawHtml ? f.value : escHtml(f.value)
    // field-rel = O2M table cell; allow page breaks so tall tables don't leave white gaps
    const relClass = f.rawHtml ? ' field-rel' : ''
    const labelHtml = f.hideLabel ? '' : `<div class="fcell-label">${escHtml(f.label)}</div>`
    return `<div class="field-cell${full ? ' field-full' : ''}${relClass}">${labelHtml}<div class="fcell-value">${valueHtml}</div></div>`
  }).join('')}</div>`
}

export function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Meridian (Classic) ───────────────────────────────────────────────────────
// Deep navy cover · amber-gold accent · Georgia serif headings
// Board-room quality — authoritative and refined

export function classicTheme(data: PdfLayoutData): string {
  const totalFields = data.sections.reduce((n, s) => n + s.fields.length, 0)
  const initial = data.collectionLabel.charAt(0).toUpperCase()

  const coverHtml = data.coverEnabled ? `
<div class="cover">
  <div class="cover-bg-circle cover-bg-circle-1"></div>
  <div class="cover-bg-circle cover-bg-circle-2"></div>
  <div class="cover-bg-circle cover-bg-circle-3"></div>

  <div class="cover-header">
    ${data.logoUrl
      ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
      : `<div class="cover-badge"><span>${escHtml(initial)}</span></div>`
    }
    <span class="cover-collection-label">${escHtml(data.collectionLabel)}</span>
  </div>

  <div class="cover-body">
    <div class="cover-eyebrow">
      <span class="cover-eyebrow-line"></span>
      <span class="cover-eyebrow-text">Document Record</span>
    </div>
    <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
    ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
  </div>

  <div class="cover-footer">
    <div class="cover-footer-rule"></div>
    <div class="cover-meta">
      <div class="meta-item">
        <span class="meta-label">Generated</span>
        <span class="meta-value">${escHtml(data.generatedAt)}</span>
      </div>
      <div class="meta-sep"></div>
      <div class="meta-item">
        <span class="meta-label">Prepared by</span>
        <span class="meta-value">${escHtml(data.generatedBy)}</span>
      </div>
      <div class="meta-sep"></div>
      <div class="meta-item">
        <span class="meta-label">Total fields</span>
        <span class="meta-value">${totalFields}</span>
      </div>
    </div>
  </div>
</div>` : ''

  const sectionsHtml = data.sections.map(s => `
<div class="section${s.pageBreak ? ' section-break' : ''}">
  <div class="section-header">
    <h2 class="section-title">${escHtml(s.label)}</h2>
    <div class="section-rule"></div>
  </div>
  ${renderFieldsGrid(s.fields)}
</div>`).join('')

  const contentHeaderHtml = `
<div class="content-header">
  <div class="ch-left">
    <span class="ch-dot"></span>
    <span class="ch-collection">${escHtml(data.collectionLabel)}</span>
  </div>
  <span class="ch-meta">${escHtml(data.coverTitle)}&ensp;&middot;&ensp;${escHtml(data.generatedAt)}</span>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 10pt;
    color: #1a2133;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── Cover ── */
  .cover {
    width: 210mm;
    height: 297mm;
    background: #0c1829;
    display: flex;
    flex-direction: column;
    padding: 26mm 24mm 20mm;
    page-break-after: always;
    overflow: hidden;
    position: relative;
  }
  .cover-bg-circle {
    position: absolute;
    border-radius: 50%;
    border: 1px solid rgba(196,160,82,0.12);
    pointer-events: none;
  }
  .cover-bg-circle-1 { top: -180px; right: -180px; width: 580px; height: 580px; }
  .cover-bg-circle-2 { top: -80px; right: -80px; width: 360px; height: 360px; border-color: rgba(196,160,82,0.08); }
  .cover-bg-circle-3 { bottom: -120px; left: -120px; width: 400px; height: 400px; border-color: rgba(196,160,82,0.06); }

  .cover-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: auto;
    position: relative;
  }
  .cover-badge {
    width: 44px; height: 44px;
    border-radius: 9px;
    border: 1.5px solid rgba(196,160,82,0.5);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .cover-badge span {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 20px; font-weight: 400; color: #c4a052;
  }
  .cover-logo {
    height: 36px; width: auto; object-fit: contain;
    filter: brightness(0) invert(1); flex-shrink: 0;
  }
  .cover-collection-label {
    font-size: 8pt; font-weight: 600;
    letter-spacing: 0.22em; text-transform: uppercase; color: #c4a052;
  }

  .cover-body { margin-bottom: 22mm; position: relative; }
  .cover-eyebrow {
    display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
  }
  .cover-eyebrow-line {
    display: inline-block; width: 24px; height: 1px;
    background: rgba(196,160,82,0.5); flex-shrink: 0;
  }
  .cover-eyebrow-text {
    font-size: 7.5pt; font-weight: 500;
    letter-spacing: 0.2em; text-transform: uppercase;
    color: rgba(196,160,82,0.7);
  }
  .cover-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 44pt; font-weight: 400; line-height: 1.07;
    letter-spacing: -0.02em; color: #ffffff;
    margin-bottom: 20px; max-width: 480px;
  }
  .cover-subtitle {
    font-size: 11.5pt; font-weight: 300;
    color: rgba(255,255,255,0.45); line-height: 1.5; max-width: 380px;
  }

  .cover-footer { position: relative; }
  .cover-footer-rule {
    height: 1px;
    background: linear-gradient(90deg, rgba(196,160,82,0.4), rgba(196,160,82,0.1) 60%, transparent);
    margin-bottom: 18px;
  }
  .cover-meta { display: flex; align-items: flex-start; }
  .meta-item {
    flex: 1; display: flex; flex-direction: column; gap: 5px;
    padding: 0 20px;
  }
  .meta-item:first-child { padding-left: 0; }
  .meta-item:last-child { padding-right: 0; }
  .meta-sep { width: 1px; background: rgba(255,255,255,0.08); align-self: stretch; }
  .meta-label {
    font-size: 6.5pt; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: rgba(255,255,255,0.28);
  }
  .meta-value {
    font-size: 8.5pt; color: rgba(255,255,255,0.65);
    font-weight: 400; line-height: 1.35;
  }

  /* ── Content header ── */
  .content-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 9px; margin-bottom: 10mm;
    border-bottom: 1px solid #e8e8ee;
  }
  .ch-left { display: flex; align-items: center; gap: 8px; }
  .ch-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #c4a052; flex-shrink: 0;
  }
  .ch-collection {
    font-size: 7pt; font-weight: 700;
    letter-spacing: 0.16em; text-transform: uppercase; color: #c4a052;
  }
  .ch-meta { font-size: 7pt; color: #a0a8b4; font-weight: 400; }

  /* ── Content ── */
  .content { padding: 12mm 8mm 18mm; }

  /* ── Sections ── */
  .section { margin-bottom: 10mm; }
  .section-header {
    margin-bottom: 5mm;
    page-break-after: avoid;
    display: flex; align-items: baseline; gap: 12px;
  }
  .section-break { break-before: page; padding-top: 22px; }
  .section-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 15pt; font-weight: 400; color: #0c1829;
    letter-spacing: -0.015em; white-space: nowrap;
    flex-shrink: 0;
  }
  .section-rule {
    flex: 1; height: 1px; align-self: center;
    background: linear-gradient(90deg, #c4a052 0px, rgba(196,160,82,0.2) 60px, #e8e8ee 120px);
  }

  /* ── Fields ── */
  .fields-grid {
    display: grid; grid-template-columns: 1fr 1fr;
    border: 1px solid #ebebf0; border-radius: 5px; overflow: hidden;
    break-before: avoid;
  }
  .field-cell {
    padding: 8px 12px;
    border-bottom: 1px solid #ebebf0; border-right: 1px solid #ebebf0;
    page-break-inside: avoid; min-height: 36px;
  }
  .field-cell.field-full { grid-column: span 2; border-right: none; }
  .field-cell.field-rel { page-break-inside: auto; }
  .fcell-label {
    font-size: 6.5pt; font-weight: 700; color: #9198a8;
    text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 3px;
  }
  .fcell-value {
    font-size: 9.5pt; color: #1a2133; line-height: 1.5; overflow-wrap: anywhere;
  }
  .richtext-value { font-size: 9.5pt; color: #1a2133; line-height: 1.6; }
  .richtext-value p { margin: 0 0 4px; }
  .richtext-value strong, .richtext-value b { font-weight: 700; }
  .richtext-value em, .richtext-value i { font-style: italic; }
  .richtext-value ul, .richtext-value ol { margin: 0 0 4px 16px; padding: 0; }
  .richtext-value li { margin-bottom: 2px; }
  .richtext-value h1, .richtext-value h2, .richtext-value h3 { font-weight: 700; margin: 6px 0 2px; }

  /* ── Relation tables (O2M) ── */
  .rel-table {
    width: 100%; border-collapse: collapse;
    font-size: 6.5pt; line-height: 1.3; margin-top: 4px;
    table-layout: auto;
  }
  .rel-table th {
    text-align: left; font-size: 6pt; font-weight: 700;
    color: #9198a8; text-transform: uppercase; letter-spacing: 0.07em;
    padding: 3px 6px 3px 0; border-bottom: 1.5px solid #c4a052;
    white-space: nowrap;
  }
  .rel-table th:first-child { padding-left: 0; }
  .rel-table td {
    padding: 3px 6px 3px 0; border-bottom: 1px solid #ebebf0;
    color: #1a2133; vertical-align: top; overflow-wrap: anywhere;
  }
  .rel-table td:first-child { padding-left: 0; }
  .rel-total td {
    font-weight: 700; border-top: 2px solid currentColor; border-bottom: none;
    padding-top: 5px;
  }
  .rel-total-label { text-transform: uppercase; font-size: 8px; letter-spacing: 0.08em; }
  .rel-table tr:last-child td { border-bottom: none; }
  .rel-table tbody tr:nth-child(even) td { background: #f9f9fb; }
</style>
</head>
<body>

${coverHtml}

<div class="content">
  ${contentHeaderHtml}
  ${sectionsHtml}
</div>

</body>
</html>`
}

// ─── Signal (Minimal) ─────────────────────────────────────────────────────────
// White · massive weight contrast · single cyan stripe · Swiss precision
// Confident and architectural — the design IS the content

export function minimalTheme(data: PdfLayoutData): string {
  const initial = data.collectionLabel.charAt(0).toUpperCase()

  const coverHtml = data.coverEnabled ? `
<div class="cover">
  <div class="cover-stripe"></div>
  <div class="cover-inner">
    <div class="cover-top">
      ${data.logoUrl
        ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="cover-badge">${escHtml(initial)}</div>`
      }
      <div class="cover-top-meta">
        <span class="cover-collection">${escHtml(data.collectionLabel)}</span>
        <span class="cover-date">${escHtml(data.generatedAt)}</span>
      </div>
    </div>

    <div class="cover-body">
      <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
      <div class="cover-rule"></div>
      ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
    </div>

    <div class="cover-bottom">
      <div class="cover-bottom-item">
        <span class="cover-bottom-label">Prepared by</span>
        <span class="cover-bottom-value">${escHtml(data.generatedBy)}</span>
      </div>
      <div class="cover-bottom-divider"></div>
      <div class="cover-bottom-item">
        <span class="cover-bottom-label">Collection</span>
        <span class="cover-bottom-value">${escHtml(data.collectionLabel)}</span>
      </div>
    </div>
  </div>
</div>` : ''

  const sectionsHtml = data.sections.map(s => `
<div class="section${s.pageBreak ? ' section-break' : ''}">
  <div class="section-header">
    <div class="section-marker"></div>
    <h2 class="section-title">${escHtml(s.label)}</h2>
  </div>
  ${renderFieldsGrid(s.fields)}
</div>`).join('')

  const contentHeaderHtml = `
<div class="content-header">
  <div class="ch-left">
    <span class="ch-bar"></span>
    <span class="ch-label">${escHtml(data.collectionLabel)}</span>
    <span class="ch-sep">/</span>
    <span class="ch-title">${escHtml(data.coverTitle)}</span>
  </div>
  <span class="ch-date">${escHtml(data.generatedAt)}</span>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 10pt; color: #111111; background: #ffffff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Cover ── */
  .cover {
    width: 210mm; height: 297mm;
    background: #ffffff;
    display: flex;
    page-break-after: always;
    overflow: hidden;
  }
  .cover-stripe { width: 8px; background: #00ceff; flex-shrink: 0; }
  .cover-inner {
    flex: 1; display: flex; flex-direction: column;
    padding: 26mm 24mm 20mm 22mm;
  }

  .cover-top {
    display: flex; align-items: flex-start; gap: 14px;
    margin-bottom: auto;
  }
  .cover-badge {
    width: 40px; height: 40px; border-radius: 50%;
    background: #00ceff;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 900; color: #ffffff; flex-shrink: 0;
  }
  .cover-logo { height: 30px; width: auto; object-fit: contain; flex-shrink: 0; }
  .cover-top-meta {
    display: flex; flex-direction: column; gap: 3px; padding-top: 4px;
  }
  .cover-collection {
    font-size: 8.5pt; font-weight: 700;
    letter-spacing: 0.1em; text-transform: uppercase; color: #111111;
  }
  .cover-date { font-size: 7.5pt; color: #888888; }

  .cover-body { margin-bottom: auto; }
  .cover-title {
    font-size: 54pt; font-weight: 900; line-height: 0.93;
    letter-spacing: -0.04em; color: #111111;
    margin-bottom: 18px; word-break: break-word; hyphens: auto;
  }
  .cover-rule { width: 56px; height: 4px; background: #00ceff; margin-bottom: 20px; }
  .cover-subtitle {
    font-size: 11.5pt; font-weight: 300; color: #555555;
    line-height: 1.5; max-width: 400px;
  }

  .cover-bottom {
    display: flex; align-items: center;
    padding-top: 18px; border-top: 1.5px solid #111111;
  }
  .cover-bottom-item {
    display: flex; flex-direction: column; gap: 4px; flex: 1;
    padding-right: 24px;
  }
  .cover-bottom-item + .cover-bottom-item { padding-left: 24px; padding-right: 0; }
  .cover-bottom-divider { width: 1px; height: 36px; background: #e0e0e0; flex-shrink: 0; }
  .cover-bottom-label {
    font-size: 6.5pt; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase; color: #bbbbbb;
  }
  .cover-bottom-value { font-size: 9pt; font-weight: 500; color: #111111; }

  /* ── Content header ── */
  .content-header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 9px; margin-bottom: 10mm;
    border-bottom: 2px solid #111111;
  }
  .ch-left { display: flex; align-items: center; gap: 8px; }
  .ch-bar {
    display: inline-block; width: 3px; height: 13px;
    background: #00ceff; border-radius: 1.5px; flex-shrink: 0;
  }
  .ch-label {
    font-size: 7pt; font-weight: 800;
    letter-spacing: 0.12em; text-transform: uppercase; color: #111111;
  }
  .ch-sep { font-size: 7pt; color: #cccccc; }
  .ch-title { font-size: 7pt; color: #777777; font-weight: 400; }
  .ch-date { font-size: 7pt; color: #999999; }

  /* ── Content ── */
  .content { padding: 12mm 8mm 18mm; }

  /* ── Sections ── */
  .section { margin-bottom: 10mm; }
  .section-header {
    display: flex; align-items: center; gap: 9px;
    margin-bottom: 5mm; page-break-after: avoid;
  }
  .section-marker {
    width: 10px; height: 10px; background: #00ceff;
    border-radius: 2px; flex-shrink: 0;
  }
  .section-break { break-before: page; padding-top: 22px; }
  .section-title {
    font-size: 13pt; font-weight: 800; color: #111111;
    letter-spacing: -0.025em; line-height: 1;
  }

  /* ── Fields ── */
  .fields-grid {
    display: grid; grid-template-columns: 1fr 1fr;
    border: 1.5px solid #111111; overflow: hidden;
    break-before: avoid;
  }
  .field-cell {
    padding: 8px 12px;
    border-bottom: 1px solid #e8e8e8; border-right: 1px solid #e8e8e8;
    page-break-inside: avoid;
  }
  .field-cell.field-full { grid-column: span 2; border-right: none; }
  .field-cell.field-rel { page-break-inside: auto; }
  .fcell-label {
    font-size: 6pt; font-weight: 700; color: #aaaaaa;
    text-transform: uppercase; letter-spacing: 0.09em; margin-bottom: 3px;
  }
  .fcell-value {
    font-size: 9.5pt; color: #111111; line-height: 1.5; word-break: break-word;
    font-weight: 400;
  }
  .richtext-value { font-size: 9.5pt; color: #111111; line-height: 1.6; }
  .richtext-value p { margin: 0 0 4px; }
  .richtext-value strong, .richtext-value b { font-weight: 700; }
  .richtext-value em, .richtext-value i { font-style: italic; }
  .richtext-value ul, .richtext-value ol { margin: 0 0 4px 16px; padding: 0; }
  .richtext-value li { margin-bottom: 2px; }
  .richtext-value h1, .richtext-value h2, .richtext-value h3 { font-weight: 700; margin: 6px 0 2px; }

  /* ── Relation tables (O2M) ── */
  .rel-table {
    width: 100%; border-collapse: collapse;
    font-size: 6.5pt; line-height: 1.3; margin-top: 4px;
    table-layout: auto;
  }
  .rel-table th {
    text-align: left; font-size: 6pt; font-weight: 800;
    color: #111111; text-transform: uppercase; letter-spacing: 0.08em;
    padding: 3px 6px 3px 0; border-bottom: 1.5px solid #00ceff;
    white-space: nowrap;
  }
  .rel-table th:first-child { padding-left: 0; }
  .rel-table td {
    padding: 3px 6px 3px 0; border-bottom: 1px solid #eeeeee;
    color: #111111; vertical-align: top; word-break: break-word;
  }
  .rel-table td:first-child { padding-left: 0; }
  .rel-total td {
    font-weight: 700; border-top: 2px solid currentColor; border-bottom: none;
    padding-top: 5px;
  }
  .rel-total-label { text-transform: uppercase; font-size: 8px; letter-spacing: 0.08em; }
  .rel-table tr:last-child td { border-bottom: none; }
  .rel-table tbody tr:nth-child(even) td { background: #f8f8f8; }
</style>
</head>
<body>

${coverHtml}

<div class="content">
  ${contentHeaderHtml}
  ${sectionsHtml}
</div>

</body>
</html>`
}

// ─── Obsidian (Executive) ─────────────────────────────────────────────────────
// Full dark-mode PDF · near-black surface · cyan accent · Georgia headings
// Premium and unexpected — dark PDFs are rare and immediately striking

export function executiveTheme(data: PdfLayoutData): string {
  const initial = data.collectionLabel.charAt(0).toUpperCase()

  const coverHtml = data.coverEnabled ? `
<div class="cover">
  <div class="cover-accent-bar"></div>
  <div class="cover-content">
    <div class="cover-header">
      ${data.logoUrl
        ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="cover-badge"><span>${escHtml(initial)}</span></div>`
      }
      <span class="cover-collection">${escHtml(data.collectionLabel)}</span>
    </div>

    <div class="cover-body">
      <div class="cover-tag-row">
        <span class="cover-tag-line"></span>
        <span class="cover-tag">Confidential Record</span>
      </div>
      <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
      ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
    </div>

    <div class="cover-footer">
      <div class="cover-footer-rule"></div>
      <div class="cover-meta">
        <div class="meta-col">
          <span class="meta-label">Date issued</span>
          <span class="meta-val">${escHtml(data.generatedAt)}</span>
        </div>
        <div class="meta-col">
          <span class="meta-label">Prepared by</span>
          <span class="meta-val">${escHtml(data.generatedBy)}</span>
        </div>
        <div class="meta-col">
          <span class="meta-label">Data source</span>
          <span class="meta-val">${escHtml(data.collectionLabel)}</span>
        </div>
      </div>
    </div>
  </div>
</div>` : ''

  const sectionsHtml = data.sections.map(s => `
<div class="section${s.pageBreak ? ' section-break' : ''}">
  <div class="section-header">
    <h2 class="section-title">${escHtml(s.label)}</h2>
    <div class="section-rule"></div>
  </div>
  ${renderFieldsGrid(s.fields)}
</div>`).join('')

  const contentHeaderHtml = `
<div class="content-header">
  <div class="ch-left">
    <span class="ch-pip"></span>
    <span class="ch-label">${escHtml(data.collectionLabel)}</span>
  </div>
  <span class="ch-meta">${escHtml(data.coverTitle)}&ensp;&middot;&ensp;${escHtml(data.generatedAt)}</span>
</div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 0; background: #07090e; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 10pt; color: #d4dce8; background: #07090e;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Cover ── */
  .cover {
    width: 210mm; height: 297mm;
    background: #07090e;
    display: flex; flex-direction: column;
    page-break-after: always;
    overflow: hidden;
  }
  .cover-accent-bar { height: 5px; background: #00ceff; flex-shrink: 0; }
  .cover-content {
    flex: 1; display: flex; flex-direction: column;
    padding: 24mm 24mm 20mm;
  }

  .cover-header {
    display: flex; align-items: center; gap: 14px;
    margin-bottom: auto;
  }
  .cover-badge {
    width: 46px; height: 46px;
    background: #0f1623;
    border: 1px solid rgba(0,206,255,0.2);
    border-radius: 9px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .cover-badge span {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 21px; font-weight: 400; color: #00ceff;
  }
  .cover-logo {
    height: 34px; width: auto; object-fit: contain;
    filter: brightness(0) invert(1); opacity: 0.85; flex-shrink: 0;
  }
  .cover-collection {
    font-size: 8pt; font-weight: 600;
    letter-spacing: 0.22em; text-transform: uppercase; color: #00ceff;
  }

  .cover-body { margin-bottom: 22mm; }
  .cover-tag-row {
    display: flex; align-items: center; gap: 10px; margin-bottom: 22px;
  }
  .cover-tag-line {
    display: inline-block; width: 22px; height: 1px;
    background: rgba(0,206,255,0.35); flex-shrink: 0;
  }
  .cover-tag {
    font-size: 7.5pt; font-weight: 500;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: rgba(0,206,255,0.55);
  }
  .cover-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 46pt; font-weight: 400; line-height: 1.06;
    letter-spacing: -0.025em; color: #ffffff;
    margin-bottom: 22px; max-width: 490px;
  }
  .cover-subtitle {
    font-size: 11.5pt; font-weight: 300;
    color: rgba(255,255,255,0.38); line-height: 1.5; max-width: 380px;
  }

  .cover-footer {}
  .cover-footer-rule {
    height: 1px;
    background: linear-gradient(90deg, rgba(0,206,255,0.35), rgba(0,206,255,0.08) 50%, transparent);
    margin-bottom: 18px;
  }
  .cover-meta { display: flex; }
  .meta-col {
    flex: 1; display: flex; flex-direction: column; gap: 5px;
    padding: 0 22px;
  }
  .meta-col:first-child { padding-left: 0; }
  .meta-col:last-child { padding-right: 0; }
  .meta-col + .meta-col { border-left: 1px solid rgba(255,255,255,0.07); }
  .meta-label {
    font-size: 6.5pt; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: rgba(255,255,255,0.2);
  }
  .meta-val {
    font-size: 8.5pt; color: rgba(255,255,255,0.6);
    font-weight: 400; line-height: 1.35;
  }

  /* ── Content header ── */
  .content-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 0; margin-bottom: 10mm;
    border-top: 2px solid #00ceff;
    border-bottom: 1px solid #1a2336;
  }
  .ch-left { display: flex; align-items: center; gap: 9px; }
  .ch-pip {
    width: 6px; height: 6px; border-radius: 50%;
    background: #00ceff; flex-shrink: 0;
  }
  .ch-label {
    font-size: 7pt; font-weight: 700;
    letter-spacing: 0.16em; text-transform: uppercase; color: #00ceff;
  }
  .ch-meta { font-size: 7pt; color: rgba(255,255,255,0.22); }

  /* ── Content ── */
  .content { padding: 12mm 8mm 18mm; }

  /* ── Sections ── */
  .section { margin-bottom: 10mm; }
  .section-header {
    display: flex; align-items: baseline; gap: 12px;
    margin-bottom: 5mm;
    page-break-after: avoid;
  }
  .section-break { break-before: page; padding-top: 22px; }
  .section-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 14pt; font-weight: 400; color: #00ceff;
    letter-spacing: -0.01em; white-space: nowrap; flex-shrink: 0;
  }
  .section-rule {
    flex: 1; height: 1px; align-self: center;
    background: linear-gradient(90deg, rgba(0,206,255,0.3), rgba(0,206,255,0.05) 80px, rgba(26,35,54,0.5) 160px);
  }

  /* ── Fields ── */
  .fields-grid {
    display: grid; grid-template-columns: 1fr 1fr;
    border: 1px solid #1a2336; border-radius: 5px; overflow: hidden;
    break-before: avoid;
  }
  .field-cell {
    padding: 8px 12px;
    border-bottom: 1px solid #1a2336; border-right: 1px solid #1a2336;
    page-break-inside: avoid;
  }
  .field-cell.field-full { grid-column: span 2; border-right: none; }
  .field-cell.field-rel { page-break-inside: auto; }
  .fcell-label {
    font-size: 6.5pt; font-weight: 600; color: #3a5070;
    text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 3px;
  }
  .fcell-value {
    font-size: 9.5pt; color: #b8cce0; line-height: 1.5;
    word-break: break-word; font-weight: 300;
  }
  .richtext-value { font-size: 9.5pt; color: #b8cce0; line-height: 1.6; font-weight: 300; }
  .richtext-value p { margin: 0 0 4px; }
  .richtext-value strong, .richtext-value b { font-weight: 600; color: #d0e4f5; }
  .richtext-value em, .richtext-value i { font-style: italic; }
  .richtext-value ul, .richtext-value ol { margin: 0 0 4px 16px; padding: 0; }
  .richtext-value li { margin-bottom: 2px; }
  .richtext-value h1, .richtext-value h2, .richtext-value h3 { font-weight: 600; color: #d0e4f5; margin: 6px 0 2px; }

  /* ── Relation tables (O2M) ── */
  .rel-table {
    width: 100%; border-collapse: collapse;
    font-size: 6.5pt; line-height: 1.3; margin-top: 4px;
    table-layout: auto;
  }
  .rel-table th {
    text-align: left; font-size: 6pt; font-weight: 600;
    color: #00ceff; text-transform: uppercase; letter-spacing: 0.08em;
    padding: 3px 6px 3px 0; border-bottom: 1px solid rgba(0,206,255,0.3);
    white-space: nowrap;
  }
  .rel-table th:first-child { padding-left: 0; }
  .rel-table td {
    padding: 3px 6px 3px 0; border-bottom: 1px solid #1a2336;
    color: #b8cce0; vertical-align: top; word-break: break-word; font-weight: 300;
  }
  .rel-table td:first-child { padding-left: 0; }
  .rel-total td {
    font-weight: 700; border-top: 2px solid currentColor; border-bottom: none;
    padding-top: 5px;
  }
  .rel-total-label { text-transform: uppercase; font-size: 8px; letter-spacing: 0.08em; }
  .rel-table tr:last-child td { border-bottom: none; }
  .rel-table tbody tr:nth-child(even) td { background: rgba(0,206,255,0.03); }
</style>
</head>
<body>

${coverHtml}

<div class="content">
  ${contentHeaderHtml}
  ${sectionsHtml}
</div>

</body>
</html>`
}
