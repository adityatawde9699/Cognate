/**
 * Brand mark: the day-arc C. A 24-hour dial where the 255° arc is the default
 * work hours (06:00 → 23:00) and the dot in the mouth is the "now" marker.
 * Keep in sync with public/favicon.svg.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="cg-accent" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="var(--accent-strong, #10b981)" />
        </linearGradient>
      </defs>

      {/* ── Icon mark: day-arc C + now dot ─────────── */}
      <g id="Logo-Mark">
        <circle
          cx="50"
          cy="58"
          r="34"
          stroke="url(#cg-accent)"
          strokeWidth="20"
          pathLength="360"
          strokeDasharray="255 105"
          strokeDashoffset="-52.5"
        />
        <circle cx="84" cy="58" r="6.5" fill="#6ee7b7" />
      </g>

      {/* ── Wordmark ──────────────────────────────── */}
      <g id="Text">
        <text
          x="108"
          y="75"
          fontFamily="'Space Grotesk Variable', system-ui, sans-serif"
          fontWeight="700"
          fontSize="48"
          letterSpacing="-1.5"
          fill="var(--text, #fafafa)"
        >
          Cognate
        </text>
      </g>
    </svg>
  );
}

/** Standalone icon (no text) — for use as a small brand mark */
export function LogoIcon({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="ci-accent" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="var(--accent-strong, #10b981)" />
        </linearGradient>
      </defs>
      {/* Rounded dark square background */}
      <rect x="4" y="4" width="92" height="92" rx="20" fill="var(--bg-2, #1c1c21)" />
      {/* Day-arc C */}
      <circle
        cx="50"
        cy="50"
        r="29"
        stroke="url(#ci-accent)"
        strokeWidth="17"
        pathLength="360"
        strokeDasharray="255 105"
        strokeDashoffset="-52.5"
      />
      {/* Now dot */}
      <circle cx="79" cy="50" r="5.5" fill="#6ee7b7" />
    </svg>
  );
}
