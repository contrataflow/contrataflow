import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VisuallyHidden } from './visually-hidden.js';

describe('VisuallyHidden', () => {
  it('renderiza o texto com a classe sr-only e preserva atributos', () => {
    const html = renderToStaticMarkup(
      <VisuallyHidden id="aviso" className="extra">
        Carregando
      </VisuallyHidden>,
    );
    expect(html).toBe('<span id="aviso" class="sr-only extra">Carregando</span>');
  });
});
