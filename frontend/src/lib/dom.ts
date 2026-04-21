/** Lightweight DOM helper. `h('button.primary', { onClick }, ['Go'])` */

type Attrs = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child[] | Child,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function svg(tag: string, attrs?: Record<string, string>, children?: Child[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (children) for (const c of children) if (c != null && c !== false) el.appendChild(c as Node);
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style' && typeof value === 'object')
      Object.assign(el.style, value);
    else if (key === 'style') el.setAttribute('style', String(value));
    else if (key === 'dataset' && typeof value === 'object')
      Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in el) (el as any)[key] = value;
    else el.setAttribute(key, String(value));
  }
}

function appendChildren(el: HTMLElement, children: Child[] | Child | undefined): void {
  if (children == null || children === false) return;
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr) {
    if (child == null || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`Element not found: ${sel}`);
  return found;
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
