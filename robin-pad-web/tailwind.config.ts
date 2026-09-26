import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Robin Labs: near-black forest green, the logo's neon lime, and the
        // fox's orange as the warm second accent (robinlab.io, the brand art).
        bg: '#050803', panel: '#0B1107', panel2: '#111A0B', line: '#1E2B12', line2: '#2C3F19',
        text: '#EEF5E3', muted: '#A3B28C', dim: '#6E7D5A', cream: '#FFF8EA', ink: '#0A1004',
        brand: { DEFAULT: '#A3E635', hi: '#D4F21A', lo: '#65A30D' },
        gold: { DEFAULT: '#F08A24', hi: '#FFB347' },
        violet: '#8B6BFF',
        up: '#4ADE80', down: '#FF5C5C',
      },
      backgroundImage: {
        'robin-grad': 'linear-gradient(180deg,#DFF55A 0%,#A3E635 100%)',
        'robin-grad-v': 'linear-gradient(180deg,#D4F21A 0%,#A3E635 55%,#111A0B 100%)',
        'robin-gold': 'linear-gradient(180deg,#FFC870 0%,#F08A24 100%)',
        'robin-text': 'linear-gradient(90deg,#D4F21A 0%,#A3E635 55%,#F08A24 100%)',
      },
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl2: '14px', xl3: '18px' },
      boxShadow: {
        card: '0 0 0 1px rgba(163,230,53,0.05), 0 18px 40px -18px rgba(0,0,0,0.8)',
        glow: '0 0 0 2px rgba(163,230,53,.45)',
        btn: '0 8px 24px -8px rgba(163,230,53,.65)',
        icon: '0 0 24px rgba(163,230,53,.35)',
      },
    },
  },
  plugins: [],
} satisfies Config;
