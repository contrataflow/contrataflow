import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import RootLayout, { metadata } from './layout';
import HomePage from './page';

vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));

describe('página inicial (estado hello)', () => {
  it('declara o título ContrataFlow', () => {
    expect(metadata.title).toBe('ContrataFlow');
  });

  it('renderiza o documento em pt-BR com o nome do produto (sempre dinâmico, por causa do nonce)', async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: <HomePage /> }));
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<h1 class="text-3xl font-semibold">ContrataFlow</h1>');
  });
});
