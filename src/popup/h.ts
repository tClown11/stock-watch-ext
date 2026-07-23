// Tiny hyperscript helper — enough to build the popup without a framework.
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el: Element, props: Props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', String(v));
    else if (k === 'style') (el as HTMLElement).style.cssText = String(v);
    else if (k === 'html') (el as HTMLElement).innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value' && el instanceof HTMLInputElement) {
      el.value = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function append(el: Element, child: Child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) {
    child.forEach((c) => append(el, c));
    return;
  }
  el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
}

export function h(tag: string, props: Props = {}, children?: Child): HTMLElement {
  const el = document.createElement(tag);
  apply(el, props);
  if (children !== undefined) append(el, children);
  return el;
}

export function svg(tag: string, props: Props = {}, children?: Child): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, props);
  if (children !== undefined) append(el, children);
  return el;
}
