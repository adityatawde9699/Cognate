export function Logo({ className }: { className?: string }) {
  return (
    <svg 
      className={className}
      viewBox="0 0 400 120" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
    >
      <g id="Logo-Mark">
        <path d="M65 30C52.5 30 42 38.5 38 50H48C51.5 44 57.5 40 65 40C73.8 40 81 47.2 81 56C81 64.8 73.8 72 65 72C57.5 72 51.5 68 48 62H38C42 73.5 52.5 82 65 82C79.4 82 91 70.4 91 56C91 41.6 79.4 30 65 30Z" fill="var(--text, #1B2B44)"/>
        <path d="M40 50C28.9 50 20 58.9 20 70C20 81.1 28.9 90 40 90C47.5 90 54 86 57.5 80L49 75C47 78.5 43.8 80 40 80C34.5 80 30 75.5 30 70C30 64.5 34.5 60 40 60C43.8 60 47 61.5 49 65L57.5 60C54 54 47.5 50 40 50Z" fill="var(--accent, #D35400)"/>
        <path d="M40 75L45 80L65 60L60 55L45 70L40 65V75Z" fill="var(--accent, #D35400)"/>
      </g>
      <g id="Text">
        <text x="105" y="75" fontFamily="Inter, sans-serif" fontWeight="700" fontSize="52" fill="var(--text, #1B2B44)">Cognate</text>
      </g>
    </svg>
  );
}
