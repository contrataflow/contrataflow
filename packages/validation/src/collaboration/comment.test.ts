import { describe, expect, it } from 'vitest';

import {
  COMMENT_LIMITS,
  COMMENT_MESSAGES,
  commentBodyFromText,
  commentListQuerySchema,
  createCommentSchema,
  deleteCommentSchema,
  isSafeCommentLink,
  validateCommentContent,
} from './comment.js';
import { CommentCreated, CommentDeleted, CommentUpdated } from './events.js';

/*
 * US-071 · RN-CMT-03..05 — o validador estrito do rich text de comentário é ponto de segurança
 * (XSS — RS-03): nada fora do schema passa, sem limpeza silenciosa. Inclui fuzzing com payloads
 * conhecidos (OWASP) e JSON profundo/grande.
 */

const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const link = (href: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'link',
  attrs: { href, ...extra },
});

const rejectedAs = (body: unknown) => {
  const result = validateCommentContent(body);
  if (result.ok) throw new Error('esperava recusa');
  return result.issue;
};

describe('validateCommentContent (RN-CMT-03..05)', () => {
  it('aceita parágrafos, listas, quebra de linha, negrito, itálico e link; deriva o texto puro', () => {
    const body = doc(
      paragraph(text('Precisamos rever '), text('as quantidades', [{ type: 'bold' }])),
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(text('item 2', [{ type: 'italic' }]))] }],
      },
      {
        type: 'orderedList',
        attrs: { start: 1, type: null },
        content: [{ type: 'listItem', content: [paragraph(text('ver'), { type: 'hardBreak' })] }],
      },
      paragraph(
        text('fonte', [
          link('https://www.gov.br/compras', {
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            class: null,
          }),
        ]),
      ),
    );
    const result = validateCommentContent(body);
    expect(result).toEqual({
      ok: true,
      bodyText: 'Precisamos rever as quantidades\nitem 2\nver\n\nfonte',
      links: ['https://www.gov.br/compras'],
      mentions: [],
    });
  });

  it('aceita mailto: e http:', () => {
    expect(
      validateCommentContent(doc(paragraph(text('a', [link('mailto:a@b.gov.br')])))),
    ).toMatchObject({ ok: true });
    expect(
      validateCommentContent(doc(paragraph(text('a', [link('http://exemplo.gov.br')])))),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['nó image', doc({ type: 'image', attrs: { src: 'https://x/y.png' } }), 'NODE', 'image'],
    [
      'nó heading',
      doc({ type: 'heading', attrs: { level: 1 }, content: [text('a')] }),
      'NODE',
      'heading',
    ],
    ['nó table', doc({ type: 'table', content: [] }), 'NODE', 'table'],
    ['marca underline', doc(paragraph(text('a', [{ type: 'underline' }]))), 'MARK', 'underline'],
    ['marca code', doc(paragraph(text('a', [{ type: 'code' }]))), 'MARK', 'code'],
    [
      'atributo em parágrafo',
      doc({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('a')] }),
      'ATTRIBUTE',
      'paragraph',
    ],
    [
      'atributo extra em link',
      doc(paragraph(text('a', [link('https://a.b', { onclick: 'x()' })]))),
      'ATTRIBUTE',
      'link',
    ],
    [
      'classe em link',
      doc(paragraph(text('a', [link('https://a.b', { class: 'evil' })]))),
      'ATTRIBUTE',
      'link',
    ],
    [
      'atributo em negrito',
      doc(paragraph(text('a', [{ type: 'bold', attrs: { style: 'x' } }]))),
      'ATTRIBUTE',
      'bold',
    ],
    [
      'chave desconhecida no nó',
      doc({ type: 'paragraph', html: '<b>x</b>', content: [text('a')] }),
      'STRUCTURE',
      'paragraph',
    ],
    ['doc aninhado', doc(doc(paragraph(text('a')))), 'NODE', 'doc'],
    ['raiz que não é doc', paragraph(text('a')), 'STRUCTURE', 'paragraph'],
    ['texto fora de parágrafo', doc(text('a')), 'STRUCTURE', 'text'],
    [
      'lista com parágrafo direto',
      doc({ type: 'bulletList', content: [paragraph(text('a'))] }),
      'STRUCTURE',
      'paragraph',
    ],
    ['texto vazio', doc(paragraph({ type: 'text', text: '' })), 'STRUCTURE', 'text'],
    [
      'menção antes da US-072',
      doc(
        paragraph({
          type: 'mention',
          attrs: { kind: 'USER', id: '0192d071-0000-7000-8000-000000000001', label: 'Ana' },
        }),
      ),
      'NODE',
      'mention',
    ],
  ])('recusa %s com RICH_TEXT_INVALID', (_label, body, reason, element) => {
    expect(rejectedAs(body)).toMatchObject({
      code: 'RICH_TEXT_INVALID',
      reason,
      element,
      message: COMMENT_MESSAGES.formatting,
    });
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/x',
    '/relativo',
    'https://exemplo.gov.br/\u0000',
    `https://exemplo.gov.br/${'a'.repeat(COMMENT_LIMITS.linkMax)}`,
    '',
  ])('recusa o link %j (V-03)', (href) => {
    expect(rejectedAs(doc(paragraph(text('clique', [link(href)]))))).toMatchObject({
      code: 'RICH_TEXT_INVALID',
      reason: 'LINK',
      message: COMMENT_MESSAGES.linkProtocol,
    });
    expect(isSafeCommentLink(href)).toBe(false);
  });

  it('fuzzing: payloads XSS (OWASP) viram texto puro ou são recusados — nunca HTML aceito', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '"><iframe src="javascript:alert(1)">',
      "';alert(String.fromCharCode(88,83,83))//",
      '<a href="javascript:alert(1)">x</a>',
      '{{constructor.constructor("alert(1)")()}}',
    ];
    for (const payload of payloads) {
      // Como TEXTO, o conteúdo é aceito e só sai como texto (o render nunca usa HTML — RN-CMT-06).
      const asText = validateCommentContent(doc(paragraph(text(payload))));
      expect(asText).toMatchObject({ ok: true, bodyText: payload });
      // Como estrutura (nó, atributo ou chave), é recusado.
      expect(validateCommentContent(doc({ type: payload, content: [] }))).toMatchObject({
        ok: false,
      });
      expect(
        validateCommentContent(
          doc({ type: 'paragraph', attrs: { onclick: payload }, content: [text('a')] }),
        ),
      ).toMatchObject({ ok: false });
      expect(validateCommentContent(doc(paragraph(text('a', [link(payload)]))))).toMatchObject({
        ok: false,
      });
    }
  });

  it('fuzzing: estruturas malformadas nunca lançam — sempre recusa', () => {
    const cyclic: Record<string, unknown> = { type: 'doc' };
    cyclic.content = [cyclic];
    const samples: unknown[] = [
      null,
      undefined,
      42,
      'doc',
      [],
      { type: 'doc', content: 'x' },
      { type: 'doc', content: [null] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 1 }] }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [text('a', 'bold' as never)] }] },
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [text('a', [{ type: 'bold' }, { type: 'bold' }])] },
        ],
      },
      JSON.parse(
        '{"type":"doc","content":[{"type":"paragraph","__proto__":{"x":1},"content":[{"type":"text","text":"a"}]}]}',
      ),
      { type: 'doc', content: [{ type: 'hardBreak', content: [] }] },
      cyclic,
    ];
    for (const sample of samples) {
      expect(() => validateCommentContent(sample)).not.toThrow();
      expect(validateCommentContent(sample).ok).toBe(false);
    }
  });

  it('JSON profundo além do limite → DEPTH', () => {
    let list: Record<string, unknown> = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(text('fundo'))] }],
    };
    for (let level = 0; level < 20; level += 1) {
      list = {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(text('a')), list] }],
      };
    }
    expect(rejectedAs(doc(list))).toMatchObject({ code: 'RICH_TEXT_INVALID', reason: 'DEPTH' });
  });

  it('JSON acima de 100 KB → SIZE (mesmo com texto dentro do limite)', () => {
    const marks = [{ type: 'bold' }, { type: 'italic' }];
    const many = Array.from({ length: 3000 }, () => text('a', marks));
    expect(rejectedAs(doc(paragraph(...many)))).toMatchObject({
      code: 'RICH_TEXT_INVALID',
      reason: 'SIZE',
    });
  });

  it('V-01: vazio, só espaços ou parágrafos vazios → VALIDATION_ERROR (EMPTY)', () => {
    for (const body of [
      doc(),
      doc({ type: 'paragraph' }),
      doc(paragraph(text('   \n  ')), { type: 'paragraph' }),
    ]) {
      expect(rejectedAs(body)).toMatchObject({
        code: 'VALIDATION_ERROR',
        reason: 'EMPTY',
        message: COMMENT_MESSAGES.textLength,
      });
    }
  });

  it('V-01: 10.000 caracteres passa; 10.001 → TOO_LONG (conta pontos de código)', () => {
    expect(
      validateCommentContent(commentBodyFromText('a'.repeat(COMMENT_LIMITS.textMax))),
    ).toMatchObject({ ok: true });
    expect(rejectedAs(commentBodyFromText('a'.repeat(COMMENT_LIMITS.textMax + 1)))).toMatchObject({
      code: 'VALIDATION_ERROR',
      reason: 'TOO_LONG',
    });
    expect(
      validateCommentContent(commentBodyFromText('😀'.repeat(COMMENT_LIMITS.textMax))),
    ).toMatchObject({ ok: true });
  });

  it('menção com a US-072 ativa: "@Nome" no texto e o alvo extraído', () => {
    const id = '0192d071-0000-7000-8000-000000000001';
    const result = validateCommentContent(
      doc(
        paragraph(text('Veja '), {
          type: 'mention',
          attrs: { kind: 'USER', id, label: 'Ana Souza' },
        }),
      ),
      { allowMentions: true },
    );
    expect(result).toEqual({
      ok: true,
      bodyText: 'Veja @Ana Souza',
      links: [],
      mentions: [{ kind: 'USER', id }],
    });
    expect(
      validateCommentContent(
        doc(paragraph({ type: 'mention', attrs: { kind: 'ROLE', id, label: 'x' } })),
        { allowMentions: true },
      ).ok,
    ).toBe(false);
  });
});

describe('schemas de requisição (CMT-01..04)', () => {
  const body = commentBodyFromText('Olá');

  it('CMT-02: DOCUMENT exige documentId; PROCESS não aceita documento nem seção', () => {
    expect(createCommentSchema.safeParse({ body, targetType: 'PROCESS' }).success).toBe(true);
    const missing = createCommentSchema.safeParse({ body, targetType: 'DOCUMENT' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['documentId']);
    const extra = createCommentSchema.safeParse({
      body,
      targetType: 'PROCESS',
      documentId: '0192d071-0000-7000-8000-000000000001',
      sectionKey: 'REQUIREMENTS',
    });
    expect(extra.error?.issues.map((issue) => issue.path[0])).toEqual(['documentId', 'sectionKey']);
    expect(
      createCommentSchema.safeParse({ body, targetType: 'PROCESS', html: '<b>' }).success,
    ).toBe(false);
    expect(createCommentSchema.safeParse({ body: '<p>x</p>', targetType: 'PROCESS' }).success).toBe(
      false,
    );
    expect(
      createCommentSchema.safeParse({
        body,
        targetType: 'DOCUMENT',
        documentId: '0192d071-0000-7000-8000-000000000001',
        sectionKey: 'secao minúscula',
      }).success,
    ).toBe(false);
  });

  it('CMT-04: motivo opcional com 10–1.000 caracteres depois do trim', () => {
    expect(deleteCommentSchema.parse({})).toEqual({});
    expect(deleteCommentSchema.parse({ reason: '  Contém dados pessoais.  ' })).toEqual({
      reason: 'Contém dados pessoais.',
    });
    expect(deleteCommentSchema.safeParse({ reason: 'curto' }).success).toBe(false);
    expect(deleteCommentSchema.safeParse({ reason: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('CMT-01: limite padrão 20 (máx. 100) e cursor opaco', () => {
    expect(commentListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(commentListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(commentListQuerySchema.safeParse({ cursor: 'a b' }).success).toBe(false);
  });
});

describe('eventos Comment* (events.md §4.4)', () => {
  const ids = {
    commentId: '0192d071-0000-7000-8000-000000000001',
    parentId: '0192d071-0000-7000-8000-000000000002',
    parentAuthorId: '0192d071-0000-7000-8000-000000000003',
  };

  it('routing keys e payload só com ids (nunca o texto)', () => {
    expect(
      CommentCreated.resolve({
        ...ids,
        targetType: 'PROCESS',
        documentId: null,
        sectionKey: null,
      }).routingKey,
    ).toBe('comment.created');
    expect(CommentUpdated.resolve({ commentId: ids.commentId }).routingKey).toBe('comment.updated');
    expect(CommentDeleted.resolve({ commentId: ids.commentId, byModerator: true }).routingKey).toBe(
      'comment.deleted',
    );
    expect(() =>
      CommentCreated.resolve({
        ...ids,
        targetType: 'PROCESS',
        documentId: null,
        sectionKey: null,
        bodyText: 'x',
      }),
    ).toThrow();
  });
});
