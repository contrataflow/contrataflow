import { describe, expect, it } from 'vitest';

import {
  createMention,
  mentionTargetsOf,
  mentionedIds,
  mentionsPresentIn,
  newMentionTargets,
  targetOf,
} from './mention.js';

/* US-072 — extração, deduplicação e diff de menções (RN-CMT-23/24) e a fábrica de `Mention`. */

const CLAUDIA = '0192d072-0000-7000-8000-0000000000c1';
const MARCOS = '0192d072-0000-7000-8000-0000000000c2';
const SETOR = '0192d072-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-10-18T12:00:00.000Z');

const mention = (kind: 'USER' | 'DEPARTMENT', id: string, label: string) => ({
  type: 'mention',
  attrs: { kind, id, label },
});
const doc = (...inline: unknown[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Veja ' }, ...inline] }],
});

describe('ExtractMentionsFromBody', () => {
  it('RN-CMT-23: alvos distintos na ordem da primeira aparição (repetidos geram um só)', () => {
    const body = doc(
      mention('USER', CLAUDIA, 'Cláudia'),
      mention('DEPARTMENT', SETOR, 'Setor de Manutenção'),
      mention('USER', CLAUDIA, 'Cláudia'),
    );
    expect(mentionTargetsOf(body)).toEqual([
      { kind: 'USER', id: CLAUDIA },
      { kind: 'DEPARTMENT', id: SETOR },
    ]);
  });

  it('o mesmo id como usuário e como unidade são alvos diferentes', () => {
    expect(
      mentionTargetsOf(doc(mention('USER', SETOR, 'A'), mention('DEPARTMENT', SETOR, 'B'))),
    ).toHaveLength(2);
  });

  it('sem menção, corpo nulo ou fora do schema: nenhum alvo', () => {
    expect(mentionTargetsOf(doc())).toEqual([]);
    expect(mentionTargetsOf(null)).toEqual([]);
    expect(mentionTargetsOf({ type: 'doc', content: [{ type: 'heading' }] })).toEqual([]);
  });
});

describe('RN-CMT-24 — alvos novos na edição', () => {
  it('só o que não estava no corpo anterior', () => {
    const before = doc(mention('USER', CLAUDIA, 'Cláudia'));
    const after = doc(mention('USER', CLAUDIA, 'Cláudia'), mention('USER', MARCOS, 'Marcos'));
    expect(newMentionTargets(before, after)).toEqual([{ kind: 'USER', id: MARCOS }]);
    expect(newMentionTargets(before, before)).toEqual([]);
    expect(newMentionTargets(null, before)).toEqual([{ kind: 'USER', id: CLAUDIA }]);
  });
});

describe('Mention', () => {
  const comment = { id: '0192d072-0000-7000-8000-0000000000e1', tenantId: 't', processId: 'p' };

  it('createFor: exatamente um alvo, sem notificação ainda', () => {
    const user = createMention({
      id: 'm1',
      comment,
      target: { kind: 'USER', id: CLAUDIA },
      now: NOW,
    });
    expect(user).toMatchObject({
      commentId: comment.id,
      processId: 'p',
      mentionedUserId: CLAUDIA,
      mentionedDepartmentId: null,
      notifiedAt: null,
      createdAt: NOW,
    });
    const unit = createMention({
      id: 'm2',
      comment,
      target: { kind: 'DEPARTMENT', id: SETOR },
      now: NOW,
    });
    expect(unit).toMatchObject({ mentionedUserId: null, mentionedDepartmentId: SETOR });
    expect(targetOf(user)).toEqual({ kind: 'USER', id: CLAUDIA });
    expect(targetOf(unit)).toEqual({ kind: 'DEPARTMENT', id: SETOR });
    expect(mentionedIds([user, unit])).toEqual({
      mentionedUserIds: [CLAUDIA],
      mentionedDepartmentIds: [SETOR],
    });
  });

  it('presentes no corpo: menção removida numa edição deixa de ser link', () => {
    const user = createMention({
      id: 'm1',
      comment,
      target: { kind: 'USER', id: CLAUDIA },
      now: NOW,
    });
    expect(mentionsPresentIn([user], doc(mention('USER', CLAUDIA, 'Cláudia')))).toEqual([user]);
    expect(mentionsPresentIn([user], doc())).toEqual([]);
  });
});
