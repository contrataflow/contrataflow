import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  resolveTemplateVariables,
  richTextToHtml,
  richTextToPlainText,
  toConfirmLabelOf,
} from './html.js';

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks }),
});

describe('richTextToHtml (DEC-056 · RN-DOC-65)', () => {
  it('serializa os nós e marks do schema permitido', () => {
    const html = richTextToHtml({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [text('Objeto')] },
        {
          type: 'paragraph',
          content: [
            text('negrito', [{ type: 'bold' }]),
            { type: 'hardBreak' },
            text('link', [{ type: 'link', attrs: { href: 'https://gov.br' } }]),
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('a')] }] }],
        },
        { type: 'horizontalRule' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: { colspan: 2 }, content: [text('H')] },
                { type: 'tableCell', content: [text('C')] },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toBe(
      '<h3>Objeto</h3><p><strong>negrito</strong><br><a href="https://gov.br" rel="noopener noreferrer">link</a></p>' +
        '<ol start="3"><li><p>a</p></li></ol><hr>' +
        '<table><tbody><tr><th colspan="2">H</th><td>C</td></tr></tbody></table>',
    );
  });

  it('escapa texto e descarta HTML, nós desconhecidos e links inseguros', () => {
    const html = richTextToHtml({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            text('<script>alert(1)</script>'),
            text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
            text('y', [{ type: 'unknownMark' }]),
          ],
        },
        { type: 'iframe', content: [text('filho')] },
        { type: 'heading', attrs: { level: 99 }, content: [text('"aspas"')] },
      ],
    });
    expect(html).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;xy</p>filho<h2>&quot;aspas&quot;</h2>',
    );
    expect(html).not.toContain('javascript:');
  });

  it('vazio ou nulo → string vazia; transformText recebe o texto cru', () => {
    expect(richTextToHtml(null)).toBe('');
    expect(richTextToHtml({ type: 'doc' })).toBe('');
    expect(
      richTextToHtml(
        { type: 'doc', content: [{ type: 'paragraph', content: [text('{{a}} & b')] }] },
        { transformText: (raw) => raw.replace('{{a}}', '<1>') },
      ),
    ).toBe('<p>&lt;1&gt; &amp; b</p>');
  });

  it('texto puro por parágrafo', () => {
    expect(
      richTextToPlainText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [text('a'), { type: 'hardBreak' }, text('b')] },
          { type: 'paragraph', content: [text('c')] },
        ],
      }),
    ).toBe('a\nb\nc');
    expect(richTextToPlainText(null)).toBe('');
  });
});

describe('resolveTemplateVariables', () => {
  it('troca as conhecidas (com espaços internos) e mantém as desconhecidas', () => {
    expect(
      resolveTemplateVariables('{{ process.code }} — {{document.hash}} {{outra}}', {
        'process.code': '0012/2026',
        'document.hash': 'abc',
      }),
    ).toBe('0012/2026 — abc {{outra}}');
  });

  it('não confunde propriedades do protótipo com variáveis', () => {
    expect(resolveTemplateVariables('{{constructor}}', {})).toBe('{{constructor}}');
  });

  it('entrada adversarial ({{ seguido de muitos espaços, sem fechamento) roda em tempo linear', () => {
    const text = `{{{{${' '.repeat(100_000)}`;
    const startedAt = performance.now();
    expect(resolveTemplateVariables(text, { today: '20/10/2026' })).toBe(text);
    expect(resolveTemplateVariables('{{\ttoday\n}}', { today: '20/10/2026' })).toBe('20/10/2026');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe('escapeHtml', () => {
  it('escapa os cinco caracteres especiais', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('nó toConfirm (US-122 · RN-AI-53)', () => {
  const marker = (attrs: Record<string, unknown>) => ({ type: 'toConfirm', attrs });

  it('sai destacado como "[a confirmar: …]" com a categoria e o rótulo escapado', () => {
    const html = richTextToHtml({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            text('Prazo de '),
            marker({ label: 'prazo <b>', category: 'DEADLINE', origin: 'AI' }),
          ],
        },
      ],
    });
    expect(html).toBe(
      '<p>Prazo de <mark class="cf-to-confirm" data-category="DEADLINE">[a confirmar: prazo &lt;b&gt;]</mark></p>',
    );
  });

  it('categoria fora do contrato não vira atributo; rótulo vazio vira "informação"', () => {
    const html = richTextToHtml({
      type: 'doc',
      content: [marker({ label: ' ', category: '"><script>', origin: 'USER' })],
    });
    expect(html).toBe('<mark class="cf-to-confirm">[a confirmar: informação]</mark>');
    expect(toConfirmLabelOf(marker({ label: '  valor ' }))).toBe('valor');
  });

  it('texto puro leva a marcação literal', () => {
    expect(
      richTextToPlainText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [text('Total: '), marker({ label: 'valor', category: 'VALUE' })],
          },
        ],
      }),
    ).toBe('Total: [a confirmar: valor]');
  });
});
