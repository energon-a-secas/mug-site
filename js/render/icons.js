// ── Inline icons ──────────────────────────────────────────────
// 24px grid, stroke 1.8, currentColor, so they take the text colour they sit in.

const svg = (body, label) =>
  `<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>${body}</svg>`;

export const ICONS = {
  mug: (l) => svg('<path d="M5 7h11v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 9h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5c0 1 1 1 1 2M11.5 3.5c0 1 1 1 1 2"/>', l),
  own: (l) => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', l),
  want: (l) => svg('<path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z"/>', l),
  had: (l) => svg('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>', l),
  search: (l) => svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>', l),
  external: (l) => svg('<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>', l),
  camera: (l) => svg('<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', l),
  close: (l) => svg('<path d="M6 6l12 12M18 6L6 18"/>', l),
  share: (l) => svg('<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8"/>', l),
};
