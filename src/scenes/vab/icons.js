// Inline SVG icons for the VAB UI (stroke icons use currentColor).
const svg = (body, vb = '0 0 24 24', extra = '') =>
  `<svg viewBox="${vb}" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;

export const ICONS = {
  // categories
  command: svg('<path d="M12 3c-3 3-5 7-5 12h10c0-5-2-9-5-12z"/><circle cx="12" cy="10.5" r="2"/><path d="M8 19h8"/>'),
  fuel: svg('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M7 8h10M7 16h10"/>'),
  engine: svg('<path d="M9 3h6v5H9z"/><path d="M9.5 8L6 20h12L14.5 8"/>'),
  coupling: svg('<path d="M5 9h14M5 15h14"/><path d="M12 3v4M10 5l2-2 2 2M12 21v-4M10 19l2 2 2-2"/>'),
  aero: svg('<path d="M12 2l-4 12h8z"/><path d="M8 14l-4 7h4M16 14l4 7h-4M10 14v7h4v-7"/>'),
  utility: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.8 2.8M16.2 16.2L19 19M19 5l-2.8 2.8M7.8 16.2L5 19"/>'),
  structural: svg('<path d="M7 3v18M17 3v18M7 6l10 6M17 6L7 12M7 12l10 6M17 12L7 18"/>'),
  all: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  // toolbar
  search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  symmetry: svg('<circle cx="12" cy="12" r="2.2"/><path d="M12 3v4M12 17v4M4.2 7.5l3.5 2M16.3 14.5l3.5 2M4.2 16.5l3.5-2M16.3 9.5l3.5-2"/>'),
  snap: svg('<path d="M6 4v8a6 6 0 0012 0V4"/><path d="M6 4h4v7M18 4h-4v7"/>'),
  com: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/><path d="M12 4a8 8 0 018 8h-8zM12 20a8 8 0 01-8-8h8z" fill="currentColor" stroke="none"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  newCraft: svg('<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>'),
  load: svg('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  save: svg('<path d="M5 3h11l4 4v12a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>'),
  exit: svg('<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>'),
  launch: svg('<path d="M12 2c3 2.5 5 6.5 5 11l-2.5 3h-5L7 13c0-4.5 2-8.5 5-11z" fill="currentColor" stroke="none"/><circle cx="12" cy="9.5" r="1.8" fill="#1d1204" stroke="none"/><path d="M9.5 17.5l-1 4 3.5-2.2 3.5 2.2-1-4" fill="currentColor" stroke="none" opacity="0.8"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  auto: svg('<path d="M4 20L15 9"/><path d="M13.5 7.5l3 3"/><path d="M17 2.5l.8 1.8 1.8.8-1.8.8L17 7.7l-.8-1.8-1.8-.8 1.8-.8zM20.5 10l.5 1.1 1.1.5-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.5zM9 3l.5 1.1 1.1.5-1.1.5L9 6.2l-.5-1.1-1.1-.5 1.1-.5z" fill="currentColor" stroke="none"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  frame: svg('<path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4"/><circle cx="12" cy="12" r="2.5"/>'),
  warn: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>'),
  ok: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'),
  error: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  mass: svg('<path d="M6 8h12l2 12H4z"/><circle cx="12" cy="5" r="2"/>'),
  parts: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M13 7.5h4v2M7.5 13v4h2"/>'),
  cost: svg('<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.6-1-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2.1 0 3 5.6 1.6 5.6 4.3 0 1.3-1.3 2.2-2.8 2.2-1.3 0-2.4-.5-3-1.6M12 6v1.8M12 16.4v1.6"/>'),
  height: svg('<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>'),
  dv: svg('<path d="M4 20L12 4l8 16z"/>'),
  twr: svg('<path d="M12 20V5M7 10l5-5 5 5"/><path d="M5 20h14"/>'),
  crew: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>'),
};

// Staging icons (filled, colored by the stage-group chip background).
export const STAGE_ICONS = {
  liquid: svg('<path d="M8 3h8v6H8z" fill="currentColor" stroke="none"/><path d="M9 9h6l3 10H6z" fill="currentColor" stroke="none" opacity="0.75"/><path d="M8 21l1-2M12 22v-3M16 21l-1-2" stroke-width="1.6"/>'),
  solid: svg('<path d="M9 3h6v14H9z" fill="currentColor" stroke="none"/><path d="M9 3l3-1.5L15 3" fill="currentColor"/><path d="M9.5 17h5l1.5 3H8z" fill="currentColor" stroke="none" opacity="0.75"/>'),
  decoupler: svg('<path d="M4 10.5h16M4 13.5h16" stroke-width="2.4"/><path d="M12 3v5M9.5 5.5L12 3l2.5 2.5M12 21v-5M9.5 18.5L12 21l2.5-2.5"/>'),
  radial: svg('<path d="M6 4v16" stroke-width="3"/><path d="M10 12h10M17 9l3 3-3 3"/>'),
  chute: svg('<path d="M3 11a9 7 0 0118 0z" fill="currentColor" stroke="none"/><path d="M3.5 11L12 20l8.5-9M8 11l4 9 4-9"/><rect x="10" y="19" width="4" height="3" rx="1" fill="currentColor" stroke="none"/>'),
};
