// APIs de layout ausentes no jsdom usadas pelos primitives Radix (posicionamento e foco).
class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // jsdom não calcula layout: nada a observar.
  }

  unobserve(): void {
    // Idem.
  }

  disconnect(): void {
    // Idem.
  }
}

const noop = (): void => undefined;

if (!('ResizeObserver' in globalThis)) globalThis.ResizeObserver = ResizeObserverStub;
Object.assign(Element.prototype, {
  scrollIntoView: noop,
  hasPointerCapture: () => false,
  releasePointerCapture: noop,
});
