import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Elysium Pad, from the brand art: deep ink-teal ground, marble text,
        // Elysian mint as the brand, and laurel gold as the warm second accent.
        bg: '#05110F', panel: '#0A1A17', panel2: '#0F2420', line: '#16302B', line2: '#224039',
        text: '#EEF3EE', muted: '#9DB5AE', dim: '#62817A', cream: '#F6F1E4', ink: '#03100D',
        brand: { DEFAULT: '#4FE3BC', hi: '#7CF5D0', lo: '#1FAF8B' },
        gold: { DEFAULT: '#E9C46A', hi: '#F5DC9A' },
        violet: '#9A8CFF',
        up: '#5BE49B', down: '#FF6B6B',
      },
      backgroundImage: {
        'ely-grad': 'linear-gradient(180deg,#A6FBE4 0%,#5EEAC6 100%)',
        'ely-grad-v': 'linear-gradient(180deg,#7CF5D0 0%,#4FE3BC 55%,#0F2420 100%)',
        'ely-gold': 'linear-gradient(180deg,#F8E2A8 0%,#C9A24A 100%)',
        'ely-text': 'linear-gradient(90deg,#A6FBE4 0%,#7CF5D0 45%,#E9C46A 100%)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
      borderRadius: { xl2: '14px', xl3: '18px' },
      boxShadow: {
        card: '0 0 0 1px rgba(124,245,208,0.05), 0 18px 40px -18px rgba(0,0,0,0.85)',
        glow: '0 0 0 2px rgba(124,245,208,.45)',
        btn: '0 8px 24px -8px rgba(94,234,198,.6)',
        icon: '0 0 24px rgba(124,245,208,.3)',
      },
    },
  },
  plugins: [],
} satisfies Config;
