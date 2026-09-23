/**
 * Twin Pane mark: two panes, one per agent, overlapping where OpenGlass watches.
 * Geometry and stroke weights follow docs/brand/clear-channel.html: the stroke gets
 * heavier as the mark shrinks. Strokes use currentColor so the mark follows the theme;
 * the overlap is always Signal Green glass.
 */
export function TwinPane({ size = 28, title }: { size?: number; title?: string }) {
  const small = size < 40;
  const stroke = small ? 5 : size < 96 ? 3.5 : 2.5;
  const [a, side] = small ? [12, 54] : [14, 52];
  const labelled = Boolean(title);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={title}
    >
      <rect x={a} y={a} width={side} height={side} rx="2" stroke="currentColor" strokeWidth={stroke} />
      <rect x="30" y="30" width={side} height={side} rx="2" stroke="currentColor" strokeWidth={stroke} />
      <path d="M30 30 H66 V66 H30 Z" fill="#3FD9A4" fillOpacity={small ? 0.7 : 0.6} />
    </svg>
  );
}
