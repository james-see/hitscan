/**
 * Minimal DOM helpers.
 *
 * The HUD is hand-built rather than templated: every node is created once at
 * init and afterwards only its class list and custom properties change, which
 * is what keeps per-frame updates off the layout path.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  parent?: Element
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

export function text(
  tag: keyof HTMLElementTagNameMap,
  className: string,
  content: string,
  parent?: Element
): HTMLElement {
  const node = el(tag, className, parent);
  node.textContent = content;
  return node;
}

/** Builds an inline icon. Paths inherit `fill: currentColor` from the CSS. */
export function icon(className: string, viewBox: string, ...paths: string[]): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('class', className);
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    root.appendChild(path);
  }
  return root;
}

/**
 * Replays a CSS animation class from its first frame.
 *
 * The forced reflow is deliberate and is the cheapest reliable way to restart
 * a declarative animation; it happens at most once per hit or per shot.
 */
export function retrigger(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

/** Writes a custom property only when it actually changed. */
export function setVar(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

export const ICONS = {
  /** Elimination marker: a tapered round in flight. */
  kill: [
    'M0.5 5.1h9.4v1.8H0.5z',
    'M11 2.4 16.5 6l-5.5 3.6z',
  ],
  /** Headshot marker. */
  skull: [
    'M8 0.8C4.5 0.8 1.9 3.3 1.9 6.5c0 1.8.8 3.1 1.8 3.9.3.3.5.6.5 1v1.3c0 .6.5 1.1 1.1 1.1h1V12.4h1.1v1.4h1.2v-1.4h1.1v1.4h1c.6 0 1.1-.5 1.1-1.1v-1.3c0-.4.2-.7.5-1 1-.8 1.8-2.1 1.8-3.9C14.1 3.3 11.5.8 8 .8Zm-2.6 6.6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5.2 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
  ],
  /** Directional damage arc, drawn bowing away from screen centre. */
  arc: ['M3 15.5Q32 1.5 61 15.5'],
} as const;
