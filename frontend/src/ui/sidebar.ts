import { h } from '../lib/dom';

export type ViewId = 'observe' | 'control' | 'configure';

interface NavEntry {
  id: ViewId;
  label: string;
  icon: string; // SVG path data (24x24 viewBox)
}

const NAV: NavEntry[] = [
  {
    id: 'observe',
    label: 'Observe',
    icon: 'M3 12h3l3-8 4 16 3-10h5',
  },
  {
    id: 'control',
    label: 'Control',
    icon: 'M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07-2.83 2.83M9.76 14.24l-2.83 2.83m0-12.14 2.83 2.83m4.48 4.48 2.83 2.83',
  },
  {
    id: 'configure',
    label: 'Configure',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.5-2.4.8a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.3a7.4 7.4 0 0 0-2 1.2l-2.4-.8-2 3.5 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.5 2.4-.8a7.4 7.4 0 0 0 2 1.2l.4 2.3h5l.4-2.3a7.4 7.4 0 0 0 2-1.2l2.4.8 2-3.5-2-1.6c.06-.4.1-.8.1-1.2Z',
  },
];

export class Sidebar {
  readonly element: HTMLElement;
  private activeId: ViewId = 'observe';
  private readonly buttons = new Map<ViewId, HTMLButtonElement>();

  constructor(private readonly onSelect: (id: ViewId) => void) {
    const nav = h('nav', { class: 'sidebar-nav', 'aria-label': 'Primary navigation' });
    for (const entry of NAV) {
      const btn = h(
        'button',
        {
          class: 'sidebar-btn',
          title: entry.label,
          'aria-label': entry.label,
          dataset: { view: entry.id },
          onclick: () => this.select(entry.id),
        },
        [iconSvg(entry.icon), h('span', { class: 'sidebar-label' }, entry.label)],
      );
      this.buttons.set(entry.id, btn);
      nav.appendChild(btn);
    }

    this.element = h('aside', { class: 'sidebar' }, [nav]);
    this.select('observe');
  }

  select(id: ViewId): void {
    this.activeId = id;
    for (const [key, btn] of this.buttons) {
      btn.classList.toggle('active', key === id);
    }
    this.onSelect(id);
  }

  get active(): ViewId { return this.activeId; }
}

function iconSvg(path: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'sidebar-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}
