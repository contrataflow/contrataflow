import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import RootLayout, { metadata } from './layout';
import HomePage from './page';

describe('página inicial (estado hello)', () => {
  it('declara o título ContrataFlow', () => {
    expect(metadata.title).toBe('ContrataFlow');
  });

  it('renderiza o documento em pt-BR com o nome do produto', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <HomePage />
      </RootLayout>,
    );
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<h1 class="text-3xl font-semibold">ContrataFlow</h1>');
  });
});
