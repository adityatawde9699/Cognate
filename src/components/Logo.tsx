export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* ── Icon mark: geometric C + checkmark ─────── */}
      <defs>
        <linearGradient id="cg-accent" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--accent, #34d399)" />
          <stop offset="100%" stopColor="var(--accent-strong, #10b981)" />
        </linearGradient>
        <linearGradient id="cg-glow" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>

      <g id="Logo-Mark">
        {/* Outer C shape */}
        <path
          d="M60 18 L82 30 L82 42 L72 36 L48 36 C36 36 28 46 28 58 C28 70 36 80 48 80 L72 80 L72 74 L82 86 L60 98 L36 86 C24 78 16 68 16 58 C16 48 24 38 36 30 Z"
          fill="url(#cg-accent)"
          opacity="0.9"
        />
        {/* Checkmark integrated into C opening */}
        <path
          d="M52 68 L62 78 L88 48 L80 42 L62 64 L56 58 Z"
          fill="url(#cg-glow)"
        />
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
          <stop offset="0%" stopColor="var(--accent, #34d399)" />
          <stop offset="100%" stopColor="var(--accent-strong, #10b981)" />
        </linearGradient>
        <linearGradient id="ci-glow" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>
      {/* Rounded dark square background */}
      <rect x="4" y="4" width="92" height="92" rx="20" fill="var(--bg-2, #1c1c21)" />
      {/* C shape */}
      <path
        d="M50 20 L68 28 L68 38 L60 34 L42 34 C33 34 26 42 26 50 C26 58 33 66 42 66 L60 66 L60 62 L68 72 L50 80 L34 72 C25 66 20 58 20 50 C20 42 25 34 34 28 Z"
        fill="url(#ci-accent)"
        opacity="0.92"
      />
      {/* Checkmark */}
      <path
        d="M44 56 L52 64 L74 40 L68 35 L52 54 L48 48 Z"
        fill="url(#ci-glow)"
      />
    </svg>
  );
}
