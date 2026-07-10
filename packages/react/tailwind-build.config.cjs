/**
 * Build-time config for the precompiled stylesheet (dist/full.css).
 * Generates every utility the shared + react component source uses, on top of
 * the same preset consumers would otherwise wire up themselves.
 * Preflight is off — full.src.css carries a scoped mini-reset instead, so the
 * file can drop into apps that have their own reset (or none).
 */
module.exports = {
  presets: [require('./tailwind-preset.cjs')],
  corePlugins: { preflight: false },
  content: ['../shared/src/**/*.{ts,tsx}', './src/**/*.{ts,tsx}']
}
