import { h } from './lib/dom';

export type ToastKind = 'info' | 'success' | 'error';

export class Toaster {
  readonly element: HTMLElement;

  constructor() {
    this.element = h('div', { class: 'toast-container', role: 'status', 'aria-live': 'polite' });
  }

  show(message: string, kind: ToastKind = 'info', durationMs = 3500): void {
    const toast = h('div', { class: `toast toast-${kind}` }, [
      h('span', { class: 'toast-dot' }),
      h('span', { class: 'toast-msg' }, message),
    ]);
    this.element.appendChild(toast);
    // Trigger enter animation on next frame
    requestAnimationFrame(() => toast.classList.add('toast-enter'));
    setTimeout(() => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 200);
    }, durationMs);
  }
}
