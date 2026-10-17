import { describe, expect, it } from 'vitest';

import {
  TO_CONFIRM_MESSAGE,
  countToConfirmNodes,
  richTextDocSchema,
  richTextPlainText,
  richTextProblem,
} from './rich-text.js';

/*
 * Nó `toConfirm` no schema do editor e no validador do backend (US-122 · RN-AI-53 · V-05 · DEC-056):
 * aceito só com `label` 1..120, `category` e `origin` do contrato, sem filhos nem atributos extras.
 */

const marker = (attrs: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'toConfirm',
  attrs,
  ...extra,
});
const doc = (...inline: unknown[]) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Prazo: ' }, ...inline] }],
});

describe('nó toConfirm (RN-AI-53)', () => {
  it('aceita a marcação dentro do contrato, da IA ou do usuário', () => {
    const value = doc(
      marker({ label: 'prazo', category: 'DEADLINE', origin: 'AI' }),
      marker({ label: 'x'.repeat(120), category: 'OTHER', origin: 'USER' }),
    );
    expect(richTextProblem(value)).toBeNull();
    expect(richTextDocSchema.safeParse(value).success).toBe(true);
    expect(countToConfirmNodes(value)).toBe(2);
  });

  it.each([
    ['label vazio', { label: '  ', category: 'VALUE', origin: 'AI' }],
    ['label longo', { label: 'x'.repeat(121), category: 'VALUE', origin: 'AI' }],
    ['label ausente', { category: 'VALUE', origin: 'AI' }],
    ['categoria inválida', { label: 'valor', category: 'XYZ', origin: 'AI' }],
    ['origem inválida', { label: 'valor', category: 'VALUE', origin: 'BOT' }],
    ['atributo extra', { label: 'valor', category: 'VALUE', origin: 'AI', color: 'red' }],
    ['sem atributos', undefined],
  ])('rejeita %s (V-05)', (_case, attrs) => {
    const value = doc(marker(attrs));
    expect(richTextProblem(value)).toBe(TO_CONFIRM_MESSAGE);
    expect(richTextDocSchema.safeParse(value).success).toBe(false);
  });

  it('rejeita marcação com filhos', () => {
    const value = doc(
      marker(
        { label: 'valor', category: 'VALUE', origin: 'AI' },
        { content: [{ type: 'text', text: 'R$ 10' }] },
      ),
    );
    expect(richTextProblem(value)).toBe(TO_CONFIRM_MESSAGE);
  });

  it('texto puro mostra "[a confirmar: …]" e a contagem ignora documentos vazios', () => {
    expect(richTextPlainText(doc(marker({ label: 'prazo', category: 'DEADLINE' })))).toBe(
      'Prazo: [a confirmar: prazo]',
    );
    expect(countToConfirmNodes(null)).toBe(0);
    expect(countToConfirmNodes({ type: 'doc' })).toBe(0);
  });
});
