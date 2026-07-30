/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // "Gallery, Alive" — warm riso palette (see handoff/DESIGN-SYSTEM.md §1)
        cream: '#F6EFE1', // page background
        paper: '#FFFCF4', // cards, inputs, surfaces
        ink: '#201A14', // text, borders, solid buttons
        blue: { DEFAULT: '#2E49C9', hover: '#4661E0' },
        red: { DEFAULT: '#E2512B', hover: '#C43F1D' },
        yellow: '#F2B63C',
        green: { DEFAULT: '#3C9E68', light: '#9FE8BE' },
        muted: '#6E6557', // secondary text
        faint: '#8A8172', // tertiary text, captions
        hairline: '#E3D9C4', // internal row dividers
        dash: '#B8AD98', // dashed dividers, pending borders
      },
      fontFamily: {
        serif: ['Instrument Serif', 'serif'],
        sans: ['Instrument Sans', 'sans-serif'],
      },
      boxShadow: {
        // Flat offset shadows — never blurred
        press: '5px 5px 0 #201A14',
        'press-sm': '3px 3px 0 #201A14',
        card: '5px 5px 0 rgba(32,26,20,.12)',
        modal: '8px 8px 0 rgba(32,26,20,.35)',
        hero: '7px 7px 0 #201A14',
      },
      keyframes: {
        // processing artwork "developing" from blur+grayscale to sharp
        develop: {
          '0%': { filter: 'blur(16px) grayscale(90%)' },
          '100%': { filter: 'blur(0) grayscale(0%)' },
        },
        // active stage chip / waking pill gentle float
        floatSoft: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        // status dots / checklists soft pulse
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.35' },
        },
      },
      animation: {
        develop: 'develop 9s ease-in-out infinite alternate',
        'float-soft': 'floatSoft 2.4s ease-in-out infinite',
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
