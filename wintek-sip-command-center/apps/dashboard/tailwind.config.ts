import type { Config } from 'tailwindcss';

/** Semantic tokens only: components never use raw palette colours, so status meaning stays consistent. */
const v = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: v('background'),
        surface: v('surface'),
        card: v('card'),
        elevated: v('elevated'),
        border: v('border'),
        input: v('input'),
        ring: v('ring'),
        foreground: v('foreground'),
        muted: v('muted'),
        subtle: v('subtle'),
        primary: { DEFAULT: v('primary'), foreground: v('primary-foreground') },
        success: { DEFAULT: v('success'), foreground: v('success-foreground') },
        warning: { DEFAULT: v('warning'), foreground: v('warning-foreground') },
        danger: { DEFAULT: v('danger'), foreground: v('danger-foreground') },
        info: { DEFAULT: v('info'), foreground: v('info-foreground') },
        neutral: { DEFAULT: v('neutral') },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { lg: '10px', md: '8px', sm: '6px' },
      keyframes: {
        'pulse-ring': { '0%': { boxShadow: '0 0 0 0 hsl(var(--success) / 0.55)' }, '100%': { boxShadow: '0 0 0 10px hsl(var(--success) / 0)' } },
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { 'pulse-ring': 'pulse-ring 1.6s ease-out infinite', 'fade-in': 'fade-in 160ms ease-out' },
    },
  },
  plugins: [],
} satisfies Config;
