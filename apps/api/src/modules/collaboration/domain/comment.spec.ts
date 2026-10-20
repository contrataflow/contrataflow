import { commentBodyFromText } from '@contrataflow/validation';
import type { ProcessStatus } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  abilitiesOf,
  authorRefusal,
  commentContentOf,
  createComment,
  deleteByAuthor,
  editComment,
  editableUntil,
  inheritedTarget,
  isDeleted,
  isModerated,
  moderateComment,
  parentRefusal,
  processAcceptsComments,
  withinEditWindow,
} from './comment.js';
import type { Comment } from './comment.js';

/* US-071 — `CommentContent`, `CommentPolicy` (RN-CMT-08..11) e herança de alvo (RN-CMT-02). */

const MARCOS = '0192d071-0000-7000-8000-00000000000a';
const PATRICIA = '0192d071-0000-7000-8000-00000000000b';
const PROCESS = '0192d071-0000-7000-8000-000000000001';
const ETP = '0192d071-0000-7000-8000-000000000002';
const CREATED = new Date('2026-10-17T15:00:00.000Z');
const at = (minutes: number, seconds = 0) =>
  new Date(CREATED.getTime() + (minutes * 60 + seconds) * 1000);

function comment(fields: Partial<Comment> = {}): Comment {
  return {
    ...createComment({
      id: '0192d071-0000-7000-8000-000000000003',
      tenantId: '0192d071-0000-7000-8000-000000000004',
      processId: PROCESS,
      target: { targetType: 'DOCUMENT', documentId: ETP, sectionKey: 'REQUIREMENTS' },
      parentId: null,
      authorId: MARCOS,
      body: commentBodyFromText('Precisamos rever as quantidades do item 2.'),
      bodyText: 'Precisamos rever as quantidades do item 2.',
      now: CREATED,
    }),
    ...fields,
  };
}

const edit = (target: Comment, now: Date, processStatus: ProcessStatus = 'IN_PROGRESS') =>
  authorRefusal(target, { userId: MARCOS, now, processStatus, action: 'edit' });

describe('CommentContent', () => {
  it('confere o schema restrito e deriva o texto puro', () => {
    expect(commentContentOf(commentBodyFromText('  Olá\nmundo  '))).toMatchObject({
      ok: true,
      bodyText: 'Olá\nmundo',
    });
  });

  it('RN-CMT-19 (US-072): menção aceita; nó `mention` sem `id` é RICH_TEXT_INVALID (V-01)', () => {
    const withMention = (attrs: Record<string, unknown>) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs }] }],
    });
    expect(
      commentContentOf(withMention({ kind: 'USER', id: MARCOS, label: 'Marcos' })),
    ).toMatchObject({ ok: true, bodyText: '@Marcos' });
    expect(commentContentOf(withMention({ kind: 'USER', label: 'Marcos' }))).toMatchObject({
      ok: false,
      issue: { code: 'RICH_TEXT_INVALID', element: 'mention' },
    });
  });
});

describe('CommentPolicy', () => {
  it('RN-CMT-08: escreve em DRAFT/IN_PROGRESS/AWAITING_APPROVAL/RETURNED/SUSPENDED; status final é somente leitura', () => {
    for (const status of ['DRAFT', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RETURNED', 'SUSPENDED']) {
      expect(processAcceptsComments(status as ProcessStatus)).toBe(true);
    }
    for (const status of ['CANCELED', 'COMPLETED', 'PUBLISHED']) {
      expect(processAcceptsComments(status as ProcessStatus)).toBe(false);
    }
  });

  it('RN-CMT-09: janela de 15 min nas bordas (14:59 e 15:00 sim, 15:01 não)', () => {
    expect(editableUntil(comment()).toISOString()).toBe('2026-10-17T15:15:00.000Z');
    expect(withinEditWindow(comment(), at(14, 59))).toBe(true);
    expect(withinEditWindow(comment(), at(15))).toBe(true);
    expect(withinEditWindow(comment(), at(15, 1))).toBe(false);
    expect(edit(comment(), at(14, 59))).toBeNull();
    expect(edit(comment(), at(15, 1))).toBe('EDIT_WINDOW_EXPIRED');
  });

  it('autor × terceiro, excluído e status final — nessa ordem', () => {
    expect(
      authorRefusal(comment(), {
        userId: PATRICIA,
        now: at(1),
        processStatus: 'IN_PROGRESS',
        action: 'edit',
      }),
    ).toBe('NOT_AUTHOR');
    expect(edit(deleteByAuthor(comment(), at(1)), at(2))).toBe('DELETED');
    expect(edit(comment(), at(1), 'COMPLETED')).toBe('INVALID_PROCESS_STATUS');
    // RN-CMT-10: excluir o próprio não tem limite de tempo.
    expect(
      authorRefusal(comment(), {
        userId: MARCOS,
        now: at(600),
        processStatus: 'IN_PROGRESS',
        action: 'delete',
      }),
    ).toBeNull();
  });

  it('ações exibidas: autor edita até HH:mm; moderador modera o de terceiros em qualquer status', () => {
    const mine = abilitiesOf(comment(), {
      userId: MARCOS,
      now: at(5),
      processStatus: 'IN_PROGRESS',
      canModerate: true,
    });
    expect(mine).toEqual({
      canEdit: true,
      editableUntil: at(15),
      canDelete: true,
      canModerate: false,
    });
    const moderator = abilitiesOf(comment(), {
      userId: PATRICIA,
      now: at(5),
      processStatus: 'COMPLETED',
      canModerate: true,
    });
    expect(moderator).toEqual({
      canEdit: false,
      editableUntil: null,
      canDelete: false,
      canModerate: true,
    });
    const closed = abilitiesOf(comment(), {
      userId: MARCOS,
      now: at(5),
      processStatus: 'CANCELED',
      canModerate: false,
    });
    expect(closed).toMatchObject({ canEdit: false, canDelete: false });
    const removed = moderateComment(comment(), {
      moderatorId: PATRICIA,
      reason: 'Contém dados pessoais de terceiro.',
      now: at(6),
    });
    expect(
      abilitiesOf(removed, {
        userId: PATRICIA,
        now: at(7),
        processStatus: 'IN_PROGRESS',
        canModerate: true,
      }).canModerate,
    ).toBe(false);
  });
});

describe('respostas (RN-CMT-02)', () => {
  it('pai inexistente, de outro processo, excluído ou já resposta → recusado', () => {
    expect(parentRefusal(null, PROCESS)).toBe('PARENT_NOT_FOUND');
    expect(parentRefusal(comment({ processId: ETP }), PROCESS)).toBe('PARENT_NOT_FOUND');
    expect(parentRefusal(deleteByAuthor(comment(), at(1)), PROCESS)).toBe('PARENT_NOT_FOUND');
    expect(parentRefusal(comment({ parentId: ETP }), PROCESS)).toBe('PARENT_NOT_FOUND');
    expect(parentRefusal(comment(), PROCESS)).toBeNull();
  });

  it('herda documento e seção; valores divergentes são recusados', () => {
    const parent = comment();
    expect(inheritedTarget(parent, { targetType: 'DOCUMENT' })).toEqual({
      targetType: 'DOCUMENT',
      documentId: ETP,
      sectionKey: 'REQUIREMENTS',
    });
    expect(
      inheritedTarget(parent, {
        targetType: 'DOCUMENT',
        documentId: ETP,
        sectionKey: 'REQUIREMENTS',
      }),
    ).not.toBeNull();
    expect(inheritedTarget(parent, { targetType: 'PROCESS' })).toBeNull();
    expect(inheritedTarget(parent, { targetType: 'DOCUMENT', documentId: PROCESS })).toBeNull();
    expect(inheritedTarget(parent, { targetType: 'DOCUMENT', sectionKey: 'OTHER' })).toBeNull();
  });
});

describe('fábricas', () => {
  it('editar grava editedAt e sobe a versão; excluir/moderar são lógicos', () => {
    const edited = editComment(
      comment(),
      { body: commentBodyFromText('Novo'), bodyText: 'Novo' },
      at(5),
    );
    expect(edited).toMatchObject({ bodyText: 'Novo', editedAt: at(5), version: 2 });
    const deleted = deleteByAuthor(comment(), at(6));
    expect(isDeleted(deleted)).toBe(true);
    expect(isModerated(deleted)).toBe(false);
    expect(deleted).toMatchObject({
      deletedById: MARCOS,
      version: 2,
      bodyText: comment().bodyText,
    });
    const moderated = moderateComment(comment(), {
      moderatorId: PATRICIA,
      reason: 'Contém dados pessoais de terceiro.',
      now: at(7),
    });
    expect(isModerated(moderated)).toBe(true);
    expect(moderated).toMatchObject({
      deletedById: PATRICIA,
      deletionReason: 'Contém dados pessoais de terceiro.',
    });
  });
});
