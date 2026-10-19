import { describe, expect, it } from 'vitest';

import {
  APPROVAL_DECISION_MESSAGES,
  decideApprovalSchema,
  decisionCommentIssues,
  decisionRequiresComment,
} from './approval-decision.js';

/* US-052 — corpo do APV-03 e RN-TRAM-55 (as mesmas regras no SCR-015 e na API). */

const COMMENT = 'Ajustar a estimativa de quantidades do item 2.';
const TRANSITION = '0192d052-0000-7000-8000-0000000000aa';

describe('decisionCommentIssues (RN-TRAM-55)', () => {
  it('comentário obrigatório só para RETURN e REJECT', () => {
    expect(decisionRequiresComment('APPROVE')).toBe(false);
    expect(decisionRequiresComment('RETURN')).toBe(true);
    expect(decisionRequiresComment('REJECT')).toBe(true);
    expect(decisionCommentIssues('APPROVE', undefined)).toEqual([]);
    expect(decisionCommentIssues('APPROVE', '   ')).toEqual([]);
    expect(decisionCommentIssues('RETURN', null)).toEqual([
      { field: 'comment', code: 'REQUIRED', message: APPROVAL_DECISION_MESSAGES.commentRequired },
    ]);
  });

  it('informado, entre 10 e 5.000 caracteres sem os espaços das pontas (em qualquer decisão)', () => {
    expect(decisionCommentIssues('REJECT', '   curto   ')[0]?.code).toBe('TOO_SHORT');
    expect(decisionCommentIssues('APPROVE', 'ok')[0]?.code).toBe('TOO_SHORT');
    expect(decisionCommentIssues('RETURN', 'x'.repeat(5001))[0]?.code).toBe('TOO_LONG');
    expect(decisionCommentIssues('RETURN', `  ${'x'.repeat(10)}  `)).toEqual([]);
    expect(decisionCommentIssues('RETURN', COMMENT)).toEqual([]);
  });
});

describe('decideApprovalSchema (APV-03)', () => {
  it('aceita a decisão com comentário, avisos reconhecidos e a transição escolhida', () => {
    const body = decideApprovalSchema.parse({
      decision: 'RETURN',
      comment: COMMENT,
      acknowledgedWarnings: [TRANSITION],
      transitionId: TRANSITION,
    });
    expect(body).toEqual({
      decision: 'RETURN',
      comment: COMMENT,
      acknowledgedWarnings: [TRANSITION],
      transitionId: TRANSITION,
    });
    expect(decideApprovalSchema.parse({ decision: 'APPROVE' })).toEqual({ decision: 'APPROVE' });
  });

  it('recusa decisão fora do enum, comentário ausente na devolução e campo desconhecido', () => {
    const invalid = decideApprovalSchema.safeParse({ decision: 'TALVEZ' });
    expect(invalid.error?.issues[0]).toMatchObject({
      path: ['decision'],
      message: APPROVAL_DECISION_MESSAGES.decisionRequired,
    });
    const missing = decideApprovalSchema.safeParse({ decision: 'REJECT' });
    expect(missing.error?.issues[0]).toMatchObject({
      path: ['comment'],
      params: { code: 'REQUIRED' },
    });
    expect(decideApprovalSchema.safeParse({ decision: 'APPROVE', extra: 1 }).success).toBe(false);
    expect(decideApprovalSchema.safeParse({ decision: 'APPROVE', transitionId: 'x' }).success).toBe(
      false,
    );
  });
});
