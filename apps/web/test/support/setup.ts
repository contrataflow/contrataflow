// Ambiente dos testes de componente (arquivos com `@vitest-environment jsdom`).
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@/lib/i18n/zod-locale';

afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});

if (typeof window !== 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {
      // jsdom não calcula layout.
    }

    unobserve(): void {
      // Idem.
    }

    disconnect(): void {
      // Idem.
    }
  }
  if (!('ResizeObserver' in globalThis)) globalThis.ResizeObserver = ResizeObserverStub;
  const noop = (): void => undefined;
  Object.assign(Element.prototype, {
    scrollIntoView: noop,
    hasPointerCapture: () => false,
    releasePointerCapture: noop,
  });
}
