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
    fields: Array<{ label: string; value: string }>
  }>
}

export function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Classic ──────────────────────────────────────────────────────────────────
// Deep navy cover · white content pages · cyan accents · Georgia serif headings

export function classicTheme(data: PdfLayoutData): string {
  const totalFields = data.sections.reduce((n, s) => n + s.fields.length, 0)

  const coverPage = data.coverEnabled ? `
<div class="cover">
  <div class="cover-top">
    ${data.logoUrl
      ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
      : `<div class="cover-wordmark"><span class="wordmark-badge">${escHtml(data.collectionLabel.charAt(0).toUpperCase())}</span><span class="wordmark-text">${escHtml(data.collectionLabel)}</span></div>`
    }
  </div>

  <div class="cover-body">
    <div class="cover-pill">${escHtml(data.collectionLabel.toUpperCase())}</div>
    <h1 class="cover-title">
      ${data.coverSubtitle
        ? `${escHtml(data.coverTitle)}<br><span class="cover-title-accent">${escHtml(data.coverSubtitle)}</span>`
        : escHtml(data.coverTitle)
      }
    </h1>

    <div class="cover-stats">
      <div class="stat-cell">
        <div class="stat-value">${data.sections.length}</div>
        <div class="stat-label">SECTIONS</div>
      </div>
      <div class="stat-divider"></div>
      <div class="stat-cell">
        <div class="stat-value">${totalFields}</div>
        <div class="stat-label">FIELDS</div>
      </div>
      <div class="stat-divider"></div>
      <div class="stat-cell">
        <div class="stat-value">${escHtml(data.generatedAt)}</div>
        <div class="stat-label">GENERATED</div>
      </div>
    </div>

    ${data.sections.length > 0 ? `
    <div class="toc">
      ${data.sections.map((s, i) => `
        <div class="toc-item">
          <span class="toc-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="toc-label">${escHtml(s.label)}</span>
        </div>`).join('')}
    </div>` : ''}
  </div>

  <div class="cover-footer">
    <span>Prepared by ${escHtml(data.generatedBy)}</span>
    <span>${escHtml(data.generatedAt)}</span>
  </div>
</div>` : ''

  const contentSections = data.sections.map((s, i) => `
<div class="section">
  <div class="section-eyebrow">SECTION ${String(i + 1).padStart(2, '0')}</div>
  <h2 class="section-title">${escHtml(s.label)}</h2>
  <div class="fields">
    ${s.fields.map(f => `
    <div class="field-row">
      <div class="field-label">${escHtml(f.label)}</div>
      <div class="field-value">${escHtml(f.value)}</div>
    </div>`).join('')}
  </div>
</div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #1a2a40; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

/* ── Cover ── */
.cover { background: #0f1f3d; color: white; min-height: 100vh; display: flex; flex-direction: column; padding: 48px 56px; page-break-after: always; }
.cover-top { display: flex; align-items: center; margin-bottom: auto; }
.cover-logo { max-height: 36px; object-fit: contain; }
.cover-wordmark { display: flex; align-items: center; gap: 10px; }
.wordmark-badge { width: 34px; height: 34px; border-radius: 8px; background: #00ceff; color: #0f1f3d; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 15px; flex-shrink: 0; }
.wordmark-text { font-weight: 600; font-size: 15px; color: white; }

.cover-body { padding: 60px 0 40px; }
.cover-pill { display: inline-block; border: 1px solid rgba(0,206,255,0.5); color: #00ceff; font-size: 8pt; font-weight: 600; letter-spacing: 0.18em; padding: 5px 14px; border-radius: 100px; margin-bottom: 28px; }
.cover-title { font-family: Georgia, 'Times New Roman', serif; font-size: 42pt; font-weight: bold; line-height: 1.08; color: white; margin-bottom: 36px; }
.cover-title-accent { color: #00ceff; }

.cover-stats { display: flex; align-items: center; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 18px 28px; gap: 0; margin-bottom: 44px; }
.stat-cell { flex: 1; }
.stat-value { font-size: 18pt; font-weight: 700; color: white; line-height: 1.1; }
.stat-label { font-size: 7pt; font-weight: 600; color: rgba(255,255,255,0.4); letter-spacing: 0.14em; margin-top: 4px; }
.stat-divider { width: 1px; height: 36px; background: rgba(255,255,255,0.12); margin: 0 24px; }

.toc { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 32px; }
.toc-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.07); }
.toc-num { width: 24px; height: 24px; border-radius: 50%; background: rgba(0,206,255,0.15); border: 1px solid rgba(0,206,255,0.3); color: #00ceff; font-size: 8pt; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.toc-label { font-size: 9pt; color: rgba(255,255,255,0.75); }

.cover-footer { margin-top: auto; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; font-size: 8pt; color: rgba(255,255,255,0.3); }

/* ── Page header (content pages) ── */
.page-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; margin-bottom: 44px; }
.page-header-left { display: flex; align-items: center; gap: 10px; }
.page-header-logo { max-height: 26px; object-fit: contain; }
.page-header-badge { width: 26px; height: 26px; border-radius: 6px; background: #0f1f3d; color: #00ceff; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.page-header-name { font-weight: 600; font-size: 10pt; color: #1a2a40; }
.page-header-right { font-size: 7.5pt; font-weight: 600; letter-spacing: 0.12em; color: #94a3b8; }

/* ── Content ── */
.content { padding: 44px 56px 80px; }
.section { margin-bottom: 48px; }
.section-eyebrow { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.18em; color: #00ceff; margin-bottom: 6px; }
.section-title { font-family: Georgia, 'Times New Roman', serif; font-size: 20pt; font-weight: bold; color: #0f1f3d; margin-bottom: 22px; line-height: 1.2; }

.fields { border: 1px solid #e8edf2; border-radius: 8px; overflow: hidden; }
.field-row { display: flex; border-bottom: 1px solid #f1f5f9; }
.field-row:last-child { border-bottom: none; }
.field-label { width: 220px; flex-shrink: 0; padding: 12px 16px; font-size: 9pt; font-weight: 600; color: #64748b; background: #f8fafc; border-right: 1px solid #f1f5f9; }
.field-value { flex: 1; padding: 12px 16px; font-size: 10pt; color: #1a2a40; }

/* ── Footer ── */
.page-footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 56px; border-top: 1px solid #e2e8f0; background: white; display: flex; justify-content: space-between; font-size: 8pt; color: #94a3b8; }
</style>
</head>
<body>
${coverPage}
<div class="content">
  <div class="page-header">
    <div class="page-header-left">
      ${data.logoUrl
        ? `<img class="page-header-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="page-header-badge">${escHtml(data.collectionLabel.charAt(0).toUpperCase())}</div>`
      }
      <span class="page-header-name">${escHtml(data.collectionLabel)}</span>
    </div>
    <span class="page-header-right">${escHtml(data.coverTitle.toUpperCase())}</span>
  </div>
  ${contentSections}
</div>
<div class="page-footer">
  <span>${escHtml(data.collectionLabel)} — ${escHtml(data.coverTitle)}</span>
  <span>${escHtml(data.generatedAt)}</span>
</div>
</body>
</html>`
}

// ─── Minimal ──────────────────────────────────────────────────────────────────
// All-white · razor-thin type · generous space · zero color blocks

export function minimalTheme(data: PdfLayoutData): string {
  const totalFields = data.sections.reduce((n, s) => n + s.fields.length, 0)

  const coverPage = data.coverEnabled ? `
<div class="cover">
  <div class="cover-top">
    ${data.logoUrl
      ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
      : `<span class="cover-wordmark">${escHtml(data.collectionLabel)}</span>`
    }
  </div>

  <div class="cover-body">
    <p class="cover-collection">${escHtml(data.collectionLabel.toUpperCase())}</p>
    <h1 class="cover-title">${escHtml(data.coverTitle)}</h1>
    ${data.coverSubtitle ? `<p class="cover-subtitle">${escHtml(data.coverSubtitle)}</p>` : ''}
    <div class="cover-rule"></div>

    <div class="cover-meta-row">
      <div class="cover-meta-item"><span class="meta-key">Prepared by</span><span class="meta-val">${escHtml(data.generatedBy)}</span></div>
      <div class="cover-meta-item"><span class="meta-key">Date</span><span class="meta-val">${escHtml(data.generatedAt)}</span></div>
      <div class="cover-meta-item"><span class="meta-key">Sections</span><span class="meta-val">${data.sections.length}</span></div>
      <div class="cover-meta-item"><span class="meta-key">Fields</span><span class="meta-val">${totalFields}</span></div>
    </div>
  </div>

  ${data.sections.length > 0 ? `
  <div class="toc">
    ${data.sections.map((s, i) => `
    <div class="toc-item">
      <span class="toc-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="toc-label">${escHtml(s.label)}</span>
    </div>`).join('')}
  </div>` : ''}
</div>` : ''

  const contentSections = data.sections.map((s, i) => `
<div class="section">
  <div class="section-num">/ ${String(i + 1).padStart(2, '0')}</div>
  <h2 class="section-title">${escHtml(s.label)}</h2>
  <div class="fields">
    ${s.fields.map(f => `
    <div class="field-row">
      <div class="field-label">${escHtml(f.label)}</div>
      <div class="field-value">${escHtml(f.value)}</div>
    </div>`).join('')}
  </div>
</div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

/* ── Cover ── */
.cover { background: white; min-height: 100vh; display: flex; flex-direction: column; padding: 64px 72px; page-break-after: always; border-left: 3px solid #111; }
.cover-top { margin-bottom: auto; }
.cover-logo { max-height: 32px; object-fit: contain; }
.cover-wordmark { font-size: 11pt; font-weight: 600; letter-spacing: 0.06em; color: #111; }

.cover-body { padding: 80px 0 0; }
.cover-collection { font-size: 8pt; font-weight: 600; letter-spacing: 0.2em; color: #999; margin-bottom: 20px; }
.cover-title { font-size: 52pt; font-weight: 200; line-height: 1.0; color: #111; letter-spacing: -0.03em; margin-bottom: 20px; }
.cover-subtitle { font-size: 13pt; font-weight: 300; color: #555; margin-bottom: 40px; line-height: 1.5; }
.cover-rule { height: 1px; background: #e5e5e5; margin: 32px 0; }

.cover-meta-row { display: flex; gap: 0; }
.cover-meta-item { flex: 1; padding-right: 24px; }
.meta-key { display: block; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.12em; color: #aaa; margin-bottom: 4px; }
.meta-val { font-size: 10pt; font-weight: 500; color: #111; }

.toc { margin-top: auto; padding-top: 48px; }
.toc-item { display: flex; align-items: baseline; gap: 12px; padding: 9px 0; border-top: 1px solid #f0f0f0; }
.toc-num { font-size: 8pt; font-weight: 600; color: #bbb; letter-spacing: 0.08em; width: 24px; flex-shrink: 0; }
.toc-label { font-size: 10pt; color: #333; }

/* ── Page header ── */
.page-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid #e5e5e5; margin-bottom: 52px; }
.page-header-logo { max-height: 22px; object-fit: contain; }
.page-header-name { font-size: 9.5pt; font-weight: 600; color: #111; }
.page-header-right { font-size: 7.5pt; letter-spacing: 0.1em; color: #bbb; }

/* ── Content ── */
.content { padding: 52px 72px 80px; }
.section { margin-bottom: 56px; }
.section-num { font-size: 8pt; font-weight: 700; letter-spacing: 0.16em; color: #bbb; margin-bottom: 8px; }
.section-title { font-size: 22pt; font-weight: 600; color: #111; margin-bottom: 24px; letter-spacing: -0.02em; }

.fields { }
.field-row { display: flex; align-items: baseline; padding: 11px 0; border-bottom: 1px solid #f0f0f0; gap: 24px; }
.field-row:first-child { border-top: 1px solid #f0f0f0; }
.field-label { width: 180px; flex-shrink: 0; font-size: 8.5pt; font-weight: 600; color: #999; letter-spacing: 0.04em; }
.field-value { flex: 1; font-size: 10.5pt; color: #111; }

/* ── Footer ── */
.page-footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 72px; background: white; display: flex; justify-content: space-between; font-size: 8pt; color: #ccc; border-top: 1px solid #f0f0f0; }
</style>
</head>
<body>
${coverPage}
<div class="content">
  <div class="page-header">
    ${data.logoUrl
      ? `<img class="page-header-logo" src="${escHtml(data.logoUrl)}" alt="">`
      : `<span class="page-header-name">${escHtml(data.collectionLabel)}</span>`
    }
    <span class="page-header-right">${escHtml(data.coverTitle.toUpperCase())}</span>
  </div>
  ${contentSections}
</div>
<div class="page-footer">
  <span>${escHtml(data.collectionLabel)} · ${escHtml(data.coverTitle)}</span>
  <span>${escHtml(data.generatedAt)}</span>
</div>
</body>
</html>`
}

// ─── Executive ────────────────────────────────────────────────────────────────
// Near-black cover with cyan gradient accent · crisp white content pages · bold type

export function executiveTheme(data: PdfLayoutData): string {
  const totalFields = data.sections.reduce((n, s) => n + s.fields.length, 0)

  const coverPage = data.coverEnabled ? `
<div class="cover">
  <div class="cover-bar"></div>
  <div class="cover-inner">
    <div class="cover-top">
      ${data.logoUrl
        ? `<img class="cover-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="cover-wordmark"><div class="wordmark-badge">${escHtml(data.collectionLabel.charAt(0).toUpperCase())}</div><span class="wordmark-text">${escHtml(data.collectionLabel)}</span></div>`
      }
    </div>

    <div class="cover-body">
      <div class="cover-pill">${escHtml(data.collectionLabel.toUpperCase())}</div>
      <h1 class="cover-title">
        ${escHtml(data.coverTitle)}${data.coverSubtitle ? `<br><span class="cover-title-accent">${escHtml(data.coverSubtitle)}</span>` : ''}
      </h1>

      <div class="cover-stats">
        <div class="stat-cell">
          <div class="stat-value">${data.sections.length}</div>
          <div class="stat-label">SECTIONS</div>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-cell">
          <div class="stat-value">${totalFields}</div>
          <div class="stat-label">FIELDS</div>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-cell">
          <div class="stat-value">${escHtml(data.generatedAt)}</div>
          <div class="stat-label">GENERATED</div>
        </div>
      </div>

      ${data.sections.length > 0 ? `
      <div class="toc">
        <div class="toc-grid">
          ${data.sections.map((s, i) => `
          <div class="toc-item">
            <span class="toc-num">${i + 1}</span>
            <span class="toc-label">${escHtml(s.label)}</span>
          </div>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <div class="cover-footer">
      <div class="cover-footer-left">
        <span class="footer-key">Prepared by</span>
        <span class="footer-val">${escHtml(data.generatedBy)}</span>
      </div>
      <div class="cover-footer-right">
        <span class="footer-key">Date</span>
        <span class="footer-val">${escHtml(data.generatedAt)}</span>
      </div>
    </div>
  </div>
</div>` : ''

  const contentSections = data.sections.map((s, i) => `
<div class="section">
  <div class="section-eyebrow">SECTION ${String(i + 1).padStart(2, '0')}</div>
  <h2 class="section-title">${escHtml(s.label)}</h2>
  <div class="fields">
    <div class="fields-header">
      <div class="fh-label">Field</div>
      <div class="fh-value">Value</div>
    </div>
    ${s.fields.map((f, fi) => `
    <div class="field-row ${fi % 2 === 1 ? 'field-row-alt' : ''}">
      <div class="field-label">${escHtml(f.label)}</div>
      <div class="field-value">${escHtml(f.value)}</div>
    </div>`).join('')}
  </div>
</div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #0d1b2e; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

/* ── Cover ── */
.cover { background: #0a1628; min-height: 100vh; display: flex; flex-direction: column; page-break-after: always; }
.cover-bar { height: 4px; background: linear-gradient(90deg, #00ceff 0%, #0077cc 60%, #004499 100%); }
.cover-inner { flex: 1; display: flex; flex-direction: column; padding: 48px 60px 40px; }

.cover-top { margin-bottom: auto; }
.cover-logo { max-height: 34px; object-fit: contain; }
.cover-wordmark { display: flex; align-items: center; gap: 10px; }
.wordmark-badge { width: 32px; height: 32px; border-radius: 7px; background: #00ceff; color: #0a1628; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0; }
.wordmark-text { font-size: 14pt; font-weight: 600; color: white; letter-spacing: 0.01em; }

.cover-body { padding: 56px 0 36px; }
.cover-pill { display: inline-block; border: 1px solid rgba(0,206,255,0.45); color: #00ceff; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.2em; padding: 5px 14px; border-radius: 100px; margin-bottom: 24px; }
.cover-title { font-size: 44pt; font-weight: 800; line-height: 1.05; color: white; margin-bottom: 40px; letter-spacing: -0.02em; }
.cover-title-accent { color: #00ceff; font-weight: 800; }

.cover-stats { display: flex; align-items: stretch; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; overflow: hidden; margin-bottom: 40px; }
.stat-cell { flex: 1; padding: 18px 24px; }
.stat-value { font-size: 16pt; font-weight: 700; color: white; line-height: 1.1; }
.stat-label { font-size: 7pt; font-weight: 700; color: rgba(255,255,255,0.35); letter-spacing: 0.16em; margin-top: 5px; }
.stat-divider { width: 1px; background: rgba(255,255,255,0.08); }

.toc { }
.toc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; }
.toc-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.toc-num { width: 22px; height: 22px; border-radius: 50%; background: rgba(0,206,255,0.12); border: 1px solid rgba(0,206,255,0.25); color: #00ceff; font-size: 8pt; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.toc-label { font-size: 9pt; color: rgba(255,255,255,0.65); line-height: 1.2; }

.cover-footer { margin-top: auto; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.08); display: flex; gap: 40px; }
.cover-footer-left, .cover-footer-right { }
.footer-key { display: block; font-size: 7pt; font-weight: 700; letter-spacing: 0.14em; color: rgba(255,255,255,0.3); margin-bottom: 3px; }
.footer-val { font-size: 9pt; color: rgba(255,255,255,0.6); }

/* ── Page header ── */
.page-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 14px; border-bottom: 1px solid #e2e8f0; margin-bottom: 44px; }
.page-header-left { display: flex; align-items: center; gap: 10px; }
.page-header-logo { max-height: 24px; object-fit: contain; }
.page-header-badge { width: 26px; height: 26px; border-radius: 6px; background: #0a1628; color: #00ceff; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.page-header-name { font-size: 10pt; font-weight: 700; color: #0d1b2e; letter-spacing: 0.01em; }
.page-header-right { font-size: 7pt; font-weight: 700; letter-spacing: 0.14em; color: #94a3b8; }

/* ── Content ── */
.content { padding: 44px 60px 80px; }
.section { margin-bottom: 52px; }
.section-eyebrow { font-size: 7.5pt; font-weight: 800; letter-spacing: 0.2em; color: #00b3e0; margin-bottom: 6px; }
.section-title { font-size: 21pt; font-weight: 800; color: #0a1628; margin-bottom: 20px; letter-spacing: -0.02em; }

.fields { border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; }
.fields-header { display: flex; background: #0a1628; padding: 10px 16px; }
.fh-label { width: 200px; flex-shrink: 0; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.12em; color: rgba(255,255,255,0.5); }
.fh-value { flex: 1; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.12em; color: rgba(255,255,255,0.5); }
.field-row { display: flex; border-bottom: 1px solid #f1f5f9; }
.field-row:last-child { border-bottom: none; }
.field-row-alt { background: #f8fafc; }
.field-label { width: 200px; flex-shrink: 0; padding: 12px 16px; font-size: 9pt; font-weight: 600; color: #475569; }
.field-value { flex: 1; padding: 12px 16px; font-size: 10pt; color: #0d1b2e; }

/* ── Footer ── */
.page-footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 60px; background: white; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 8pt; color: #94a3b8; }
</style>
</head>
<body>
${coverPage}
<div class="content">
  <div class="page-header">
    <div class="page-header-left">
      ${data.logoUrl
        ? `<img class="page-header-logo" src="${escHtml(data.logoUrl)}" alt="">`
        : `<div class="page-header-badge">${escHtml(data.collectionLabel.charAt(0).toUpperCase())}</div>`
      }
      <span class="page-header-name">${escHtml(data.collectionLabel)}</span>
    </div>
    <span class="page-header-right">${escHtml(data.coverTitle.toUpperCase())}</span>
  </div>
  ${contentSections}
</div>
<div class="page-footer">
  <span>${escHtml(data.collectionLabel)} — ${escHtml(data.coverTitle)}</span>
  <span>${escHtml(data.generatedAt)}</span>
</div>
</body>
</html>`
}
