/**
 * Generated token art: a DiceBear "rings" avatar (free, keyless SVG API),
 * used wherever no uploaded picture is shown. Callers seed it with the token
 * address, so each token keeps the same icon on every visit. The style has a
 * transparent background, so it sits on whatever panel color the caller gives it.
 */
export function TokenIcon({ seed, className }: { seed: string; symbol?: string; className?: string }) {
  const src = `https://api.dicebear.com/9.x/rings/svg?seed=${encodeURIComponent(seed || '??')}`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} loading="lazy" />;
}
