/** @type {import('tailwindcss').Config} */

// Backstory brand scales (from the design system's colors_and_type.css).
const horizon = {
  50: '#EBF3F6', 100: '#DBEBF2', 200: '#99C1D1', 300: '#7DACC0', 400: '#6397AD',
  500: '#447C93', 600: '#2B6178', 700: '#18485C', 800: '#0A2F3F', 900: '#021821', 950: '#01141C',
}
const graphite = {
  50: '#FAFAFA', 100: '#F1F2F5', 200: '#E3E3E4', 300: '#C7C7C8', 400: '#ABABAD',
  500: '#8E8E92', 600: '#717178', 700: '#55555E', 800: '#3C3C46', 900: '#171721', 950: '#0F0F17',
}

module.exports = {
  // INERT BY DESIGN. Nothing in src/ ever adds the `dark` class, so every
  // `dark:` variant in the app is currently unreachable. This line is kept
  // (rather than deleted) on purpose: removing it falls back to Tailwind's
  // default `media` strategy, which would switch ~260 never-reviewed `dark:`
  // utilities on for any visitor whose OS is in dark mode. Keeping the class
  // strategy holds the dark palette dormant until a real theme preference
  // exists; wiring one means adding/removing `dark` on <html> and nothing else.
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand scales, available by name.
        horizon,
        graphite,
        // Bring existing utility classes onto brand with zero per-file churn:
        // Graphite *is* the brand's neutral ("replaces gray"); Horizon is the
        // single accent ("color reserved for signal"). Semantic red/green/amber
        // keep Tailwind's defaults so signal colors stay distinct.
        gray: graphite,
        slate: graphite,
        zinc: graphite,
        neutral: graphite,
        blue: horizon,
        indigo: horizon,
        sky: horizon,
        // Accessible muted TEXT tone (see --fg-muted in backstory-design.css).
        // Use `text-fg-muted` for secondary copy; graphite-400 stays for
        // borders, dividers and decorative marks where AA does not apply.
        'fg-muted': 'var(--fg-muted)',
        // shadcn token aliases
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',   // 6px
        md: 'var(--radius-md)',   // 8px
        lg: 'var(--radius-lg)',   // 12px — product cards
        xl: 'var(--radius-xl)',   // 16px
        '2xl': 'var(--radius-2xl)', // 20px
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        3: 'var(--shadow-3)',
        4: 'var(--shadow-4)',
        popover: 'var(--shadow-popover)',
      },
      backgroundImage: {
        'gradient-horizon': 'var(--gradient-horizon)',
        'gradient-horizon-soft': 'var(--gradient-horizon-soft)',
        'gradient-graphite': 'var(--gradient-graphite)',
        'gradient-card-blue': 'var(--gradient-card-blue)',
      },
      fontFamily: {
        sans: ['var(--font-display)', 'Arimo', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Arimo', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'Anonymous Pro', 'ui-monospace', 'monospace'],
      },
      transitionDuration: {
        fast: '120ms',   // hover feedback
        base: '200ms',   // most transitions
        slow: '320ms',   // page-level entrances
      },
      transitionTimingFunction: {
        'out-quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
        spring: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
        'fade-in-up': 'fade-in-up 320ms cubic-bezier(0.25, 1, 0.5, 1) both',
        'scale-in': 'scale-in 200ms cubic-bezier(0.25, 1, 0.5, 1) both',
        'slide-in-right': 'slide-in-right 320ms cubic-bezier(0.25, 1, 0.5, 1) both',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS config file
  plugins: [require('tailwindcss-animate')],
}
