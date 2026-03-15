// Generates a star polygon path centered at 0,0
function starPath(points: number, outerR: number, innerR: number): string {
  const total = points * 2;
  const step = (2 * Math.PI) / total;
  const start = -Math.PI / 2;
  return Array.from({ length: total }, (_, i) => {
    const a = start + i * step;
    const r = i % 2 === 0 ? outerR : innerR;
    return `${i === 0 ? "M" : "L"}${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
  }).join(" ") + "Z";
}

// Generates a regular polygon path centered at 0,0
function polygonPath(sides: number, r: number, startAngle = -Math.PI / 2): string {
  const step = (2 * Math.PI) / sides;
  return Array.from({ length: sides }, (_, i) => {
    const a = startAngle + i * step;
    return `${i === 0 ? "M" : "L"}${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`;
  }).join(" ") + "Z";
}

export function OrientalPattern({ className = "" }: { className?: string }) {
  const s = { stroke: "#5C6B3A", fill: "none" };

  // The connecting web: each outer tip of the 6-star links to the two nearest
  // inner valleys of the 12-star, creating 6 bridging "kite" shapes.
  const webLines = Array.from({ length: 6 }, (_, i) => {
    const a6        = -Math.PI / 2 + i * (Math.PI / 3);       // 6-star outer tip
    const aLeft     = a6 - Math.PI / 12;                       // 12-star inner, left
    const aRight    = a6 + Math.PI / 12;                       // 12-star inner, right
    const [x0, y0]  = [75 * Math.cos(a6),       75 * Math.sin(a6)];
    const [x1, y1]  = [90 * Math.cos(aLeft),    90 * Math.sin(aLeft)];
    const [x2, y2]  = [90 * Math.cos(aRight),   90 * Math.sin(aRight)];
    return { i, x0, y0, x1, y1, x2, y2 };
  });

  // Small circles at each of the 12 outer star tips
  const outerDots = Array.from({ length: 12 }, (_, i) => {
    const a = -Math.PI / 2 + i * (Math.PI / 6);
    return { i, x: (160 * Math.cos(a)).toFixed(2), y: (160 * Math.sin(a)).toFixed(2) };
  });

  return (
    <svg viewBox="-200 -200 400 400" className={className}>
      {/* Outermost dashed ring */}
      <circle cx="0" cy="0" r="188" {...s} strokeWidth="0.5" strokeDasharray="4 7" />

      {/* 12-pointed star */}
      <path d={starPath(12, 160, 90)} {...s} strokeWidth="1.2" />

      {/* Dodecagon tracing the inner valleys of the 12-star */}
      <path
        d={polygonPath(12, 90, -Math.PI / 2 + Math.PI / 12)}
        {...s} strokeWidth="0.7"
      />

      {/* Mid dashed ring */}
      <circle cx="0" cy="0" r="93" {...s} strokeWidth="0.5" strokeDasharray="3 5" />

      {/* Connecting web between 12-star and 6-star */}
      {webLines.map(({ i, x0, y0, x1, y1, x2, y2 }) => (
        <g key={i}>
          <line
            x1={x0.toFixed(2)} y1={y0.toFixed(2)}
            x2={x1.toFixed(2)} y2={y1.toFixed(2)}
            {...s} strokeWidth="0.7"
          />
          <line
            x1={x0.toFixed(2)} y1={y0.toFixed(2)}
            x2={x2.toFixed(2)} y2={y2.toFixed(2)}
            {...s} strokeWidth="0.7"
          />
        </g>
      ))}

      {/* Inner 6-pointed star */}
      <path d={starPath(6, 75, 43)} {...s} strokeWidth="1.2" />

      {/* Hexagon tracing the inner valleys of the 6-star */}
      <path
        d={polygonPath(6, 43, -Math.PI / 2 + Math.PI / 6)}
        {...s} strokeWidth="0.7"
      />

      {/* Inner ring */}
      <circle cx="0" cy="0" r="25" {...s} strokeWidth="1" />
      <circle cx="0" cy="0" r="14" {...s} strokeWidth="0.5" />

      {/* Radial spokes from center ring to inner valley ring */}
      {Array.from({ length: 12 }, (_, i) => {
        const a  = -Math.PI / 2 + i * (Math.PI / 6);
        const x1 = (25  * Math.cos(a)).toFixed(2);
        const y1 = (25  * Math.sin(a)).toFixed(2);
        const x2 = (43  * Math.cos(a)).toFixed(2);
        const y2 = (43  * Math.sin(a)).toFixed(2);
        return (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} {...s} strokeWidth="0.5" />
        );
      })}

      {/* Small circles at each outer tip */}
      {outerDots.map(({ i, x, y }) => (
        <circle key={i} cx={x} cy={y} r="4.5" {...s} strokeWidth="0.8" />
      ))}
    </svg>
  );
}
