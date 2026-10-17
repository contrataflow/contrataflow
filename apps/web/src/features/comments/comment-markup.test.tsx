// @vitest-environment jsdom
import { validateCommentContent } from '@contrataflow/validation';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CommentBodyView } from './comment-body';
import { commentBodyToText, inlineNodes, textToCommentBody } from './comment-markup';
import { applyFormat, prepareCommentBody, relativeTimeOf } from './comments-model';

/* US-071 — marcação do compositor ⇄ JSON restrito (RN-CMT-03) e render em modo leitura (RN-CMT-06). */

describe('textToCommentBody', () => {
  it('parágrafos, negrito, itálico, links, URL solta e listas no JSON TipTap restrito', () => {
    const body = textToCommentBody(
      [
        'Precisamos rever **as quantidades** do *item 2*.',
        'Fonte: [painel](https://paineldeprecos.planejamento.gov.br) e https://www.gov.br/x_y',
        '',
        '- primeiro',
        '- segundo',
        '1. passo',
      ].join('\n'),
    );
    expect(validateCommentContent(body)).toMatchObject({ ok: true });
    expect(body).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Precisamos rever ' },
            { type: 'text', text: 'as quantidades', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' do ' },
            { type: 'text', text: 'item 2', marks: [{ type: 'italic' }] },
            { type: 'text', text: '.' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Fonte: ' },
            {
              type: 'text',
              text: 'painel',
              marks: [
                { type: 'link', attrs: { href: 'https://paineldeprecos.planejamento.gov.br' } },
              ],
            },
            { type: 'text', text: ' e ' },
            {
              type: 'text',
              text: 'https://www.gov.br/x_y',
              marks: [{ type: 'link', attrs: { href: 'https://www.gov.br/x_y' } }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'primeiro' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'segundo' }] }],
            },
          ],
        },
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'passo' }] }],
            },
          ],
        },
      ],
    });
  });

  it('link inseguro fica como texto (nunca vira marca link)', () => {
    expect(inlineNodes('[x](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[x](javascript:alert(1))' },
    ]);
  });

  it('ida e volta: texto → JSON → texto', () => {
    const text = 'Rever **item 2** e *prazo*: [link](https://a.gov.br)\n\n- um\n- dois';
    expect(commentBodyToText(textToCommentBody(text))).toBe(text);
  });

  it('V-01 no front: vazio e acima de 10.000 caracteres', () => {
    expect(prepareCommentBody('   ')).toEqual({ ok: false, key: 'length' });
    expect(prepareCommentBody('a'.repeat(10_001))).toEqual({ ok: false, key: 'length' });
    expect(prepareCommentBody('Olá')).toMatchObject({ ok: true });
  });

  it('barra de formatação: envolve a seleção e insere o prefixo de lista', () => {
    expect(applyFormat('abc def', { start: 4, end: 7 }, 'bold')).toEqual({
      text: 'abc **def**',
      start: 6,
      end: 9,
    });
    expect(applyFormat('abc', { start: 0, end: 3 }, 'italic').text).toBe('*abc*');
    expect(applyFormat('um\ndois', { start: 4, end: 4 }, 'list').text).toBe('um\n- dois');
    expect(applyFormat('ver', { start: 0, end: 3 }, 'link').text).toBe('[ver](https://)');
  });

  it('data relativa', () => {
    const now = new Date('2026-10-17T15:00:00Z');
    expect(relativeTimeOf('2026-10-17T14:59:30Z', now)).toEqual({ unit: 'now' });
    expect(relativeTimeOf('2026-10-17T14:55:00Z', now)).toEqual({ unit: 'minutes', count: 5 });
    expect(relativeTimeOf('2026-10-17T12:00:00Z', now)).toEqual({ unit: 'hours', count: 3 });
    expect(relativeTimeOf('2026-10-15T15:00:00Z', now)).toEqual({ unit: 'days', count: 2 });
  });
});

describe('CommentBodyView (RN-CMT-04/06)', () => {
  it('renderiza marcas e listas como elementos; links com rel/target fixos', () => {
    const { container } = render(
      <CommentBodyView body={textToCommentBody('**a** *b* [c](https://c.gov.br)\n\n- d')} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('a');
    expect(container.querySelector('em')?.textContent).toBe('b');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://c.gov.br');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('ul li')?.textContent).toBe('d');
  });

  it('nunca interpreta HTML nem link inseguro vindo do JSON', () => {
    const { container } = render(
      <CommentBodyView
        body={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '<img src=x onerror=alert(1)>' },
                {
                  type: 'text',
                  text: 'clique',
                  marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                },
              ],
            },
            { type: 'image', attrs: { src: 'https://evil/x.png' } },
          ],
        }}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
