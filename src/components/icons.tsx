const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const SidebarIcon = () => (
  <Svg><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 2.5v11" /></Svg>
);
export const QuoteIcon = () => (
  <Svg><path d="M3 3.5v9" strokeWidth="2" /><path d="M7 5.5h6M7 8h6M7 10.5h4" /></Svg>
);
export const BulletsIcon = () => (
  <Svg>
    <circle cx="3" cy="4.5" r=".8" fill="currentColor" /><circle cx="3" cy="8" r=".8" fill="currentColor" />
    <circle cx="3" cy="11.5" r=".8" fill="currentColor" /><path d="M6 4.5h8M6 8h8M6 11.5h8" />
  </Svg>
);
export const NumbersIcon = () => (
  <Svg>
    <path d="M2.2 3.2 3.3 2.7v3.6M6 4.5h8M6 8h8M6 11.5h8" />
    <path d="M2.2 9.6c.2-.6.7-.9 1.2-.9.6 0 1 .4 1 .9 0 .9-2.2 1.6-2.2 2.6h2.3" strokeWidth="1.1" />
  </Svg>
);
export const LinkIcon = () => (
  <Svg>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
  </Svg>
);
export const CodeIcon = () => <Svg><path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" /></Svg>;
export const NewDocIcon = () => (
  <Svg><path d="M9 1.5H4.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5z" /><path d="M8 7v4M6 9h4" /></Svg>
);
export const NewFolderIcon = () => (
  <Svg><path d="M1.5 4.5v7a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 13 4.5H8L6.5 2.5H3A1.5 1.5 0 0 0 1.5 4z" /><path d="M8 7v4M6 9h4" /></Svg>
);
export const Chevron = ({ open }: { open: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
    style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
    <path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Today's progress toward the daily goal; a plain chart glyph when there's no goal. */
export const ProgressRing = ({ value }: { value: number | null }) => {
  if (value === null) {
    return <Svg><path d="M2.5 13.5h11M4.5 13.5v-4M8 13.5v-9M11.5 13.5v-6" /></Svg>;
  }
  const r = 6;
  const c = 2 * Math.PI * r;
  const done = value >= 1;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" />
      {value > 0 && <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${Math.min(1, value) * c} ${c}`} transform="rotate(-90 8 8)" />}
      {done && <path d="M5.4 8.2 7.2 10l3.4-3.6" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
};

export const PublishIcon = () => (
  <Svg><path d="M8 10.5V2.5M5 5.5l3-3 3 3" /><path d="M2.5 9.5v2.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V9.5" /></Svg>
);

export const BookIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 2.5h8.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z" />
    <path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H13M6 5.5h4" />
  </svg>
);

export const NewProjectIcon = () => (
  <Svg>
    <path d="M3 12V3.5a1 1 0 0 1 1-1h6.5" />
    <path d="M3 12a1.5 1.5 0 0 0 1.5 1.5H8M3 12a1.5 1.5 0 0 1 1.5-1.5H8" />
    <path d="M12 8v6M9 11h6" />
  </Svg>
);

export const CloudIcon = () => (
  <Svg>
    <path d="M4.5 12.5h7.2a2.8 2.8 0 0 0 .5-5.55A4.2 4.2 0 0 0 4.1 6.3 3.1 3.1 0 0 0 4.5 12.5z" />
  </Svg>
);
