const paths = {
  feed: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10m-10 3h6"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-4"/><circle cx="9.5" cy="7" r="4"/><path d="M16 3.3a4 4 0 0 1 0 7.4"/>',
  groups: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  music: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18.5" rx="3" ry="2.5"/><ellipse cx="17" cy="16.5" rx="3" ry="2.5"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  book: '<path d="M12 7c-3-3-7-3-9-2v14c3-1 6-1 9 2 3-3 6-3 9-2V5c-2-1-6-1-9 2zm0 0v14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M10 3h4l.6 2.2 2 .9 2-.9 2 3.5-1.6 1.6v2.4l1.6 1.6-2 3.5-2-.8-2 .9-.6 2.1h-4l-.6-2.1-2-.9-2 .8-2-3.5L5 12.7v-2.4L3.4 8.7l2-3.5 2 .9 2-.9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  caret: '<path d="m6 9 6 6 6-6"/>',
  heart: '<path d="M20.8 8.6c0 5.3-8.8 10.4-8.8 10.4S3.2 14 3.2 8.6C3.2 4 9 3 12 6.8c3-3.8 8.8-2.8 8.8 1.8z"/>',
  comment: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.8-5a8.5 8.5 0 1 1 16.2-4.5z"/>',
  link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-2 2m2 3a3.5 3.5 0 0 0-5 0l-4 4a3.5 3.5 0 0 0 5 5l2-2"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.5" ry="8.5"/><path d="M3.5 12h17"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/>',
  pen: '<path d="m4 15-1 6 6-1L20 9a2 2 0 0 0 0-3l-2-2a2 2 0 0 0-3 0zm8-8 5 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  paperclip: '<path d="m20 11-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  telegram: '<path d="m3 11.5 17-7-3.5 15-5.4-4.8-3.1 2.8.5-5.3L18 7.5 7 13z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 5v14m6-14v14" stroke-width="3"/>',
  volume: '<path d="M4 9v6h4l4 4V5L8 9H4m11 0a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
  muted: '<path d="M4 9v6h4l4 4V5L8 9H4m12 1 5 4m0-4-5 4"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  play: '<path d="m9 5 12 7-12 7z" fill="currentColor" stroke="none"/>'
};

export function icon(name, size = 20) {
  return '<svg aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || '') + '</svg>';
}
