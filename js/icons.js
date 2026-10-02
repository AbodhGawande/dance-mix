// Line icons (24×24), drawn in the current text colour.
const F = 'fill="currentColor" stroke="none"';
const P = {
  play: `<path d="M7.5 4.5v15l12-7.5z" ${F}/>`,
  pause: `<rect x="6" y="5" width="4.2" height="14" rx="1.2" ${F}/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" ${F}/>`,
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  settings: '<path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M8 11H6v10h12V11h-2"/>',
  grip: `<circle cx="9" cy="6" r="1.4" ${F}/><circle cx="15" cy="6" r="1.4" ${F}/><circle cx="9" cy="12" r="1.4" ${F}/><circle cx="15" cy="12" r="1.4" ${F}/><circle cx="9" cy="18" r="1.4" ${F}/><circle cx="15" cy="18" r="1.4" ${F}/>`,
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.6 8.6L19 19M8.6 15.4L19 5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  back5: `<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 3v4h4"/><text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" font-family="-apple-system,system-ui,sans-serif" ${F}>5</text>`,
  fwd5: `<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 3v4h-4"/><text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" font-family="-apple-system,system-ui,sans-serif" ${F}>5</text>`,
  repeat: '<path d="M4 12V9a3 3 0 0 1 3-3h13l-3-3M20 12v3a3 3 0 0 1-3 3H4l3 3"/>',
  toStart: `<path d="M6 5v14"/><path d="M19 5l-9 7 9 7z" ${F}/>`,
  chevron: '<path d="M6 9l6 6 6-6"/>',
  fade: '<path d="M3 18L21 6M3 6l18 12"/>',
  silence: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4M8 11h6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
};

export const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
