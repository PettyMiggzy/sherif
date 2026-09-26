'use client';
import { useMemo } from 'react';
import type { Candle } from '@/lib/data';

const UP = '#4ADE80';
const DOWN = '#FF6B5E';
const fmtP = (p: number) => (p >= 1 ? p.toFixed(2) : p.toFixed(6));

export function CandleChart({ candles, height = 340 }: { candles: Candle[]; height?: number }) {
  const W = 900, H = height, padL = 10, padR = 78, padT = 12, padB = 26, volH = 56;

  const m = useMemo(() => {
    if (!candles.length) return null;
    const hi = Math.max(...candles.map((c) => c.h)), lo = Math.min(...candles.map((c) => c.l));
    const vmax = Math.max(...candles.map((c) => c.v)) || 1;
    const plotH = H - padT - padB - volH - 10;
    const x = (i: number) => padL + ((i + 0.5) / candles.length) * (W - padL - padR);
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo || 1)) * plotH;
    const cw = Math.max(2, ((W - padL - padR) / candles.length) * 0.62);
    return { hi, lo, vmax, x, y, cw, volTop: padT + plotH + 10 };
  }, [candles, H]);

  if (!m) return <div className="grid place-items-center text-dim" style={{ height: H }}>No candles to draw yet.</div>;

  const ticks = 5;
  const labelEvery = Math.max(1, Math.floor(candles.length / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Price chart">
      {Array.from({ length: ticks }, (_, i) => {
        const p = m.lo + ((m.hi - m.lo) * i) / (ticks - 1);
        return (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={m.y(p)} y2={m.y(p)} stroke="#1E2B12" strokeDasharray="2 5" />
            <text x={W - padR + 8} y={m.y(p) + 4} fill="#A3B28C" fontSize="11">{fmtP(p)}</text>
          </g>
        );
      })}
      {candles.map((c, i) => {
        const up = c.c >= c.o, color = up ? UP : DOWN;
        const top = m.y(Math.max(c.o, c.c)), bot = m.y(Math.min(c.o, c.c)), vh = (c.v / m.vmax) * volH;
        return (
          <g key={c.t}>
            <line x1={m.x(i)} x2={m.x(i)} y1={m.y(c.h)} y2={m.y(c.l)} stroke={color} strokeWidth="1.2" />
            <rect x={m.x(i) - m.cw / 2} y={top} width={m.cw} height={Math.max(1.5, bot - top)} fill={color} rx="1" />
            <rect x={m.x(i) - m.cw / 2} y={m.volTop + volH - vh} width={m.cw} height={vh} fill={color} opacity="0.55" />
            {i % labelEvery === 0 && (
              <text x={m.x(i)} y={H - 7} fill="#A3B28C" fontSize="11" textAnchor="middle">
                {new Date(c.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
