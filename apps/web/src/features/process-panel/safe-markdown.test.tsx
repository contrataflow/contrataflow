// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafeMarkdown, markdownBlocks } from './safe-markdown';

describe('SafeMarkdown (instruções da etapa — Markdown sanitizado)', () => {
  it('parágrafos e listas (com e sem número) como blocos', () => {
    expect(
      markdownBlocks(
        'Elabore o ETP\ncom cuidado.\n\n- item 1\n* item 2\n1. primeiro\n2) segundo\nfim',
      ),
    ).toEqual([
      { kind: 'paragraph', text: 'Elabore o ETP com cuidado.' },
      { kind: 'list', ordered: false, items: ['item 1', 'item 2'] },
      { kind: 'list', ordered: true, items: ['primeiro', 'segundo'] },
      { kind: 'paragraph', text: 'fim' },
    ]);
    expect(markdownBlocks('')).toEqual([]);
  });

  it('ênfases viram elementos; HTML, links e scripts ficam como texto', () => {
    const { container } = render(
      <SafeMarkdown
        text={
          'Use **negrito**, *itálico*, _ênfase_ e `código`.\n\n<script>alert(1)</script> [link](javascript:alert(1)) <img src=x onerror=alert(1)>'
        }
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('negrito');
    expect([...container.querySelectorAll('em')].map((node) => node.textContent)).toEqual([
      'itálico',
      'ênfase',
    ]);
    expect(container.querySelector('code')?.textContent).toBe('código');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
