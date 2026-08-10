// Icone inline, dal set Lucide (https://lucide.dev, licenza ISC).
//
// Niente CDN: la CSP dell'estensione blocca le richieste esterne e l'estensione
// deve funzionare offline. Niente font di icone: un SVG resta nitido a ogni
// dimensione e, ereditando `currentColor`, segue il tema chiaro/scuro senza
// una riga di CSS in piu'.

const PATHS = {
  x: ['M18 6 6 18', 'm6 6 12 12'],
  trash: [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6'
  ],
  settings: ['M20 7h-9', 'M14 17H5'],
  chevronLeft: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 16v-4', 'M12 8h.01'],
  check: ['m9 12 2 2 4-4'],
  xCircle: ['m15 9-6 6', 'm9 9 6 6'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  send: ['M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z', 'm21.854 2.147-10.94 10.939']
};

// Cerchi e rettangoli che alcune icone hanno oltre ai tracciati.
const SHAPES = {
  settings: [
    { tag: 'circle', attrs: { cx: '17', cy: '17', r: '3' } },
    { tag: 'circle', attrs: { cx: '7', cy: '7', r: '3' } }
  ],
  calendar: [{ tag: 'rect', attrs: { x: '3', y: '4', width: '18', height: '18', rx: '2' } }],
  info: [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } }],
  check: [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } }],
  xCircle: [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } }]
};

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {keyof PATHS} name
 * @param {{size?: number, title?: string}} [options]
 * @returns {SVGElement}
 */
export function icon(name, { size = 16, title } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', title ? 'false' : 'true');
  svg.classList.add('icon');

  if (title) {
    svg.setAttribute('role', 'img');
    const label = document.createElementNS(NS, 'title');
    label.textContent = title;
    svg.appendChild(label);
  }

  for (const shape of SHAPES[name] || []) {
    const node = document.createElementNS(NS, shape.tag);
    for (const [key, value] of Object.entries(shape.attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  for (const d of PATHS[name] || []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Sostituisce il contenuto di un pulsante con un'icona, tenendo il title. */
export function setIcon(element, name, size = 16) {
  element.replaceChildren(icon(name, { size }));
  return element;
}
