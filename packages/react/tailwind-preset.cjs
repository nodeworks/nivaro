/**
 * Tailwind preset for @nivaro/react consumers.
 *
 * Usage (tailwind.config.js):
 *   module.exports = {
 *     presets: [require('@nivaro/react/tailwind-preset')],
 *     content: [
 *       './src/**\/*.{ts,tsx}',
 *       './node_modules/@nivaro/react/dist/**\/*.js'
 *     ]
 *   }
 *
 * Pair with:  import '@nivaro/react/styles.css'
 * (CSS variables the colors below resolve against, plus dark-mode overrides.)
 */
module.exports = {
  darkMode: ['class'],
  theme: {
    container: {
      center: true,
      padding: '2rem'
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        sidebar: {
          DEFAULT: '#172940',
          foreground: '#e2e8f0',
          accent: '#1e3a52',
          border: '#1e3a52',
          active: '#1e96d2'
        },
        nvr: {
          // rgb(var(...) / <alpha-value>) rather than a bare var(): an opaque
          // var() cannot carry an alpha channel, so `bg-nvr-cyan/10` silently
          // produced no CSS at all.
          cyan: 'rgb(var(--nvr-cyan-rgb) / <alpha-value>)',
          'cyan-dark': 'rgb(var(--nvr-cyan-dark-rgb) / <alpha-value>)',
          navy: '#172940'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      fontFamily: {
        sans: ['"DM Sans"', '"DM Sans Fallback"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'monospace']
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
        xs: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.005em' }],
        sm: ['0.75rem', { lineHeight: '1.125rem' }],
        base: ['0.8125rem', { lineHeight: '1.375rem' }],
        md: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['0.9375rem', { lineHeight: '1.5rem' }],
        xl: ['1rem', { lineHeight: '1.625rem' }],
        '2xl': ['1.125rem', { lineHeight: '1.75rem' }],
        '3xl': ['1.25rem', { lineHeight: '1.875rem' }]
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}
