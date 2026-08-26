/**
 * Theme studio (#662) — applies instance appearance settings (corner radius
 * preset + font pairing) at runtime, the same way AppLayout applies
 * project_color. Idempotent; call it whenever settings change:
 *
 *   applyThemeSettings(settings)   // inside AppLayout's settings effect
 *
 * Radius lands on the shadcn `--radius` token (all rounded-sm/md/lg derive
 * from it); the font lands via an injected stylesheet so `font-mono` code
 * surfaces are untouched. Only zero-download stacks are offered — DM Sans is
 * the bundled default, the rest are system fonts.
 */

export const THEME_RADIUS_PRESETS: Record<string, string> = {
  sharp: '4px',
  soft: '8px',
  round: '12px'
}

export const THEME_FONT_STACKS: Record<string, string> = {
  'dm-sans': `'DM Sans', 'DM Sans Fallback', system-ui, sans-serif`,
  'system-ui': `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`,
  serif: `Georgia, 'Times New Roman', serif`
}

const FONT_STYLE_ID = 'nvr-theme-font'

export function applyThemeSettings(
  settings: { theme_radius?: string | null; theme_font?: string | null } | null | undefined
): void {
  const root = document.documentElement

  const radius = settings?.theme_radius ? THEME_RADIUS_PRESETS[settings.theme_radius] : undefined
  if (radius) root.style.setProperty('--radius', radius)
  else root.style.removeProperty('--radius') // fall back to the stylesheet default

  const fontKey = settings?.theme_font ?? ''
  const stack = fontKey && fontKey !== 'dm-sans' ? THEME_FONT_STACKS[fontKey] : undefined
  let styleEl = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null
  if (stack) {
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = FONT_STYLE_ID
      document.head.appendChild(styleEl)
    }
    // Injected after the compiled CSS, so the equal-specificity .font-sans
    // rule wins; font-mono is deliberately left alone.
    styleEl.textContent = `html, body { font-family: ${stack}; }\n.font-sans { font-family: ${stack}; }`
  } else if (styleEl) {
    styleEl.remove()
  }
}
