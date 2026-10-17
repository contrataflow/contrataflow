import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_REGISTRY,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_TYPES,
  isRelativeNotificationLink,
} from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { NOTIFICATION_RULE_EVENTS, planNotification } from './notification-rules.js';
import type { NotificationPlan, PlanOutcome } from './notification-rules.js';
import { notificationContent } from './notification-templates.js';
import { PROCESS, TENANT, envelope, testId } from './testing.js';
import { resolveRoutes } from '../events/routes.js';

const USER = testId();
const OTHER_USER = testId();
const DEPARTMENT = testId();
const APPROVAL = testId();
const MEMBERSHIP = testId();

function notify(outcome: PlanOutcome): NotificationPlan {
  if (outcome.kind !== 'notify') throw new Error(`esperava notificar, veio ${outcome.kind}`);
  return outcome;
}

/** Routing key de cada evento de origem (events.md §4) — usada para conferir o fan-out. */
const ROUTING_KEYS: Readonly<Record<string, string>> = {
  ProcessStageChanged: 'process.stage_changed.return',
  ProcessAssigned: 'process.assigned',
  ProcessStatusChanged: 'process.status_changed.suspended',
  ApprovalRequested: 'approval.requested',
  ApprovalCompleted: 'approval.completed',
  ApprovalReturned: 'approval.returned',
  ApprovalRejected: 'approval.rejected',
  ApprovalReassigned: 'approval.reassigned',
  UserMentioned: 'comment.user_mentioned',
  CommentCreated: 'comment.created',
  ProcessStageDueSoon: 'process.stage_due_soon',
  ProcessStageOverdue: 'process.stage_overdue',
  ProcessParticipantAdded: 'process.participant_added',
  AttachmentRejected: 'attachment.rejected',
  DocumentRenditionFailed: 'document.rendition_failed',
  RoleAssigned: 'role.assigned',
  RoleRevoked: 'role.revoked',
  AiGenerationCompleted: 'ai.generation_completed',
  AiGenerationFailed: 'ai.generation_failed',
  AiUsageThresholdReached: 'ai.usage_threshold_reached',
};

describe('cobertura do registro NotificationType (events.md §6 · DoD da US-111)', () => {
  const sourceEvents = [
    ...new Set(NOTIFICATION_TYPES.flatMap((type) => NOTIFICATION_REGISTRY[type].sourceEvents)),
  ];

  it('todo evento de origem do registro tem regra (e nenhuma regra fica órfã)', () => {
    expect([...NOTIFICATION_RULE_EVENTS].sort()).toEqual(sourceEvents.sort());
  });

  it.each(sourceEvents)(
    '%s chega à fila notifications pelo fan-out do domain-events',
    (eventType) => {
      const routingKey = ROUTING_KEYS[eventType];
      expect(routingKey).toBeDefined();
      expect(resolveRoutes(routingKey ?? '').queues).toContain('notifications');
    },
  );

  it('evento fora do registro é descartado (RN-NTF-01 · V-03)', () => {
    expect(planNotification(envelope('ProcessCreated', {}))).toEqual({ kind: 'unmapped' });
    expect(planNotification(envelope('toString', {}))).toEqual({ kind: 'unmapped' });
  });
});

describe('regras por tipo (coluna "Destinatários" de events.md §6)', () => {
  it('PROCESS_RETURNED: responsável de destino; senão membros da unidade', () => {
    for (const cause of ['RETURN', 'APPROVAL_RETURNED', 'APPROVAL_REJECTED']) {
      const plan = notify(
        planNotification(
          envelope('ProcessStageChanged', {
            cause,
            toUserId: USER,
            toDepartmentId: DEPARTMENT,
            toStage: { type: 'TASK' },
          }),
        ),
      );
      expect(plan).toMatchObject({
        type: 'PROCESS_RETURNED',
        priority: 'NORMAL',
        processId: PROCESS,
        entityType: 'Process',
        link: `/processos/${PROCESS}`,
      });
      expect(plan.recipients).toEqual([
        {
          kind: 'FIRST_OF',
          specs: [
            { kind: 'USER', userId: USER },
            { kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT },
          ],
        },
      ]);
    }
  });

  it('PROCESS_RECEIVED: só em etapa START/TASK, com fallback para quem pode assumir', () => {
    const plan = notify(
      planNotification(
        envelope('ProcessStageChanged', {
          cause: 'FORWARD',
          toUserId: null,
          toDepartmentId: DEPARTMENT,
          toStage: { type: 'TASK' },
        }),
      ),
    );
    expect(plan.type).toBe('PROCESS_RECEIVED');
    expect(plan.recipients).toEqual([
      {
        kind: 'FIRST_OF',
        specs: [
          { kind: 'USER', userId: null },
          { kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT, permission: 'PROCESS_CLAIM' },
        ],
      },
    ]);
    // Encaminhamento para etapa de aprovação: quem avisa é o `APPROVAL_REQUESTED`.
    expect(
      planNotification(
        envelope('ProcessStageChanged', { cause: 'FORWARD', toStage: { type: 'APPROVAL' } }),
      ),
    ).toEqual({ kind: 'ignored', reason: 'stage_APPROVAL' });
    expect(planNotification(envelope('ProcessStageChanged', { cause: 'COMPLETE' }))).toEqual({
      kind: 'ignored',
      reason: 'stage_unknown',
    });
  });

  it('PROCESS_ASSIGNED: só atribuição MANUAL/RETURN', () => {
    for (const assignmentType of ['MANUAL', 'RETURN']) {
      const plan = notify(
        planNotification(envelope('ProcessAssigned', { assignmentType, toUserId: USER })),
      );
      expect(plan).toMatchObject({ type: 'PROCESS_ASSIGNED' });
      expect(plan.recipients).toEqual([{ kind: 'USER', userId: USER }]);
    }
    expect(
      planNotification(envelope('ProcessAssigned', { assignmentType: 'CLAIM', toUserId: USER })),
    ).toEqual({ kind: 'ignored', reason: 'assignment_CLAIM' });
  });

  it('PROCESS_STATUS_CHANGED: suspenso, retomado, cancelado e concluído', () => {
    for (const status of ['suspended', 'resumed', 'canceled', 'completed']) {
      const plan = notify(
        planNotification(
          envelope('ProcessStatusChanged', {}, { routingKey: `process.status_changed.${status}` }),
        ),
      );
      expect(plan.type).toBe('PROCESS_STATUS_CHANGED');
      expect(plan.recipients).toEqual([{ kind: 'LOOKUP', lookup: 'PROCESS_STAKEHOLDERS' }]);
    }
    expect(
      planNotification(
        envelope('ProcessStatusChanged', {}, { routingKey: 'process.status_changed.active' }),
      ),
    ).toEqual({ kind: 'ignored', reason: 'status_active' });
  });

  it('APPROVAL_REQUESTED (obrigatória → HIGH): usuário, titular(+substituto) ou perfil', () => {
    const byUser = notify(
      planNotification(
        envelope('ApprovalRequested', {
          approvalId: APPROVAL,
          approverType: 'USER',
          approverUserId: USER,
        }),
      ),
    );
    expect(byUser).toMatchObject({
      type: 'APPROVAL_REQUESTED',
      priority: 'HIGH',
      entityType: 'Approval',
      entityId: APPROVAL,
      link: `/aprovacoes/${APPROVAL}`,
    });
    expect(byUser.recipients).toEqual([{ kind: 'USER', userId: USER }]);

    const byHead = notify(
      planNotification(
        envelope('ApprovalRequested', {
          approvalId: APPROVAL,
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentId: DEPARTMENT,
          allowDeputy: true,
        }),
      ),
    );
    expect(byHead.recipients).toEqual([
      { kind: 'DEPARTMENT_HEADS', departmentId: DEPARTMENT, includeDeputy: true },
    ]);

    const byRole = notify(
      planNotification(envelope('ApprovalRequested', { approverType: 'ROLE' })),
    );
    expect(byRole.recipients).toEqual([{ kind: 'LOOKUP', lookup: 'ROLE_HOLDERS' }]);
    // Sem `approvalId`, o link cai no processo.
    expect(byRole.link).toBe(`/processos/${PROCESS}`);
  });

  it.each([
    ['ApprovalCompleted', 'Aprovação concluída'],
    ['ApprovalReturned', 'Aprovação devolvida'],
    ['ApprovalRejected', 'Aprovação rejeitada'],
  ])('APPROVAL_DECIDED a partir de %s', (eventType, title) => {
    const plan = notify(planNotification(envelope(eventType, { approvalId: APPROVAL })));
    expect(plan.type).toBe('APPROVAL_DECIDED');
    expect(plan.recipients).toEqual([{ kind: 'LOOKUP', lookup: 'APPROVAL_STAKEHOLDERS' }]);
    expect(plan.content(1).title).toBe(title);
  });

  it('APPROVAL_REASSIGNED: novo e anterior aprovador; perfil novo via fonte', () => {
    const plan = notify(
      planNotification(
        envelope('ApprovalReassigned', {
          approvalId: APPROVAL,
          toApproverUserId: USER,
          fromApproverUserId: OTHER_USER,
          toApproverRoleId: testId(),
        }),
      ),
    );
    expect(plan.type).toBe('APPROVAL_REASSIGNED');
    expect(plan.recipients).toEqual([
      { kind: 'USER', userId: USER },
      { kind: 'USER', userId: OTHER_USER },
      { kind: 'LOOKUP', lookup: 'ROLE_HOLDERS' },
    ]);
  });

  it('MENTIONED: usuário mencionado ou membros da unidade mencionada', () => {
    const plan = notify(
      planNotification(
        envelope('UserMentioned', { commentId: testId(), mentionedDepartmentId: DEPARTMENT }),
      ),
    );
    expect(plan.type).toBe('MENTIONED');
    expect(plan.recipients).toEqual([
      {
        kind: 'FIRST_OF',
        specs: [
          { kind: 'USER', userId: null },
          { kind: 'DEPARTMENT_MEMBERS', departmentId: DEPARTMENT },
        ],
      },
    ]);
  });

  it('COMMENT_REPLY: só resposta (com `parentId`), para o autor do pai', () => {
    const plan = notify(
      planNotification(
        envelope('CommentCreated', {
          commentId: testId(),
          parentId: testId(),
          parentAuthorId: USER,
        }),
      ),
    );
    expect(plan).toMatchObject({ type: 'COMMENT_REPLY', entityType: 'Comment' });
    expect(plan.recipients).toEqual([{ kind: 'USER', userId: USER }]);
    expect(planNotification(envelope('CommentCreated', { commentId: testId() }))).toEqual({
      kind: 'ignored',
      reason: 'not_a_reply',
    });
  });

  it('STAGE_DUE_SOON/STAGE_OVERDUE ficam com a US-114', () => {
    expect(planNotification(envelope('ProcessStageDueSoon', {}))).toEqual({
      kind: 'deferred',
      type: 'STAGE_DUE_SOON',
    });
    expect(planNotification(envelope('ProcessStageOverdue', {}))).toEqual({
      kind: 'deferred',
      type: 'STAGE_OVERDUE',
    });
  });

  it('PARTICIPANT_ADDED: participante usuário ou unidade', () => {
    const plan = notify(planNotification(envelope('ProcessParticipantAdded', { userId: USER })));
    expect(plan.type).toBe('PARTICIPANT_ADDED');
    expect(plan.recipients).toEqual([
      {
        kind: 'FIRST_OF',
        specs: [
          { kind: 'USER', userId: USER },
          { kind: 'DEPARTMENT_MEMBERS', departmentId: null },
        ],
      },
    ]);
  });

  it('PARTICIPANT_ADDED: notify = false não avisa (US-012 · RN-PROC-130)', () => {
    expect(
      planNotification(envelope('ProcessParticipantAdded', { userId: USER, notify: false })),
    ).toMatchObject({ kind: 'ignored' });
    expect(
      notify(planNotification(envelope('ProcessParticipantAdded', { userId: USER, notify: true })))
        .type,
    ).toBe('PARTICIPANT_ADDED');
  });

  it('ATTACHMENT_REJECTED (obrigatória): quem enviou; texto conforme o motivo', () => {
    const infected = notify(
      planNotification(
        envelope('AttachmentRejected', { attachmentId: testId(), status: 'INFECTED' }),
      ),
    );
    expect(infected).toMatchObject({ type: 'ATTACHMENT_REJECTED', priority: 'HIGH' });
    expect(infected.recipients).toEqual([{ kind: 'LOOKUP', lookup: 'ATTACHMENT_UPLOADER' }]);
    // US-068: a varredura roda com o ator de quem confirmou — o próprio uploader é avisado.
    expect(infected.includeActor).toBe(true);
    expect(infected.content(1).body).toContain('verificação de segurança');
    const rejected = notify(
      planNotification(envelope('AttachmentRejected', { status: 'REJECTED' }, { processId: null })),
    );
    expect(rejected.content(1).body).not.toContain('verificação de segurança');
    expect(rejected.link).toBeNull();
  });

  it.each([
    ['AiGenerationCompleted', 'AI_GENERATION_READY', 'pronto para revisão'],
    ['AiGenerationFailed', 'AI_GENERATION_FAILED', 'Não foi possível'],
  ])(
    'US-115: %s → %s ao solicitante (o próprio ator), com link ?ia= para o editor',
    (eventType, type, title) => {
      const generationId = testId();
      const documentId = testId();
      const plan = notify(
        planNotification(envelope(eventType, { generationId, documentId, requestedById: USER })),
      );
      expect(plan).toMatchObject({
        type,
        priority: 'NORMAL',
        includeActor: true,
        entityType: 'AiGeneration',
        entityId: generationId,
        link: `/processos/${PROCESS}/documentos/${documentId}?ia=${generationId}`,
      });
      expect(plan.recipients).toEqual([{ kind: 'USER', userId: USER }]);
      expect(plan.content(1).title).toContain(title);
      // Sem documento (mapa de riscos ainda não emitido): o processo, ainda com a geração.
      const withoutDocument = notify(
        planNotification(
          envelope(eventType, { generationId, documentId: null, requestedById: USER }),
        ),
      );
      expect(withoutDocument.link).toBe(`/processos/${PROCESS}?ia=${generationId}`);
      const withoutProcess = notify(
        planNotification(envelope(eventType, { generationId }, { processId: null })),
      );
      expect(withoutProcess.link).toBeNull();
    },
  );

  it.each([
    [80, 'chegou a 80%'],
    [100, 'atingido'],
  ])(
    'US-116: AiUsageThresholdReached (%i%%) → AI_USAGE_LIMIT_WARNING a quem tem SETTINGS_MANAGE no tenant',
    (threshold, title) => {
      const plan = notify(
        planNotification(
          envelope(
            'AiUsageThresholdReached',
            { month: '2026-10', threshold, usedTokens: 41_000, limitTokens: 50_000 },
            { processId: null, aggregateType: 'Tenant', aggregateId: TENANT },
          ),
        ),
      );
      expect(plan).toMatchObject({
        type: 'AI_USAGE_LIMIT_WARNING',
        priority: 'NORMAL',
        includeActor: true,
        processId: null,
        entityType: 'Tenant',
        entityId: TENANT,
        link: '/admin/configuracoes',
      });
      expect(plan.recipients).toEqual([
        { kind: 'TENANT_PERMISSION_HOLDERS', permission: 'SETTINGS_MANAGE' },
      ]);
      const content = plan.content(1);
      expect(content.title).toContain(title);
      expect(content.body).toContain('2026-10');
    },
  );

  it('DOCUMENT_RENDER_FAILED: quem solicitou a renderização', () => {
    const plan = notify(
      planNotification(envelope('DocumentRenditionFailed', { documentId: testId() })),
    );
    expect(plan).toMatchObject({ type: 'DOCUMENT_RENDER_FAILED', entityType: 'Document' });
    expect(plan.recipients).toEqual([{ kind: 'LOOKUP', lookup: 'RENDITION_REQUESTER' }]);
  });

  it.each([
    ['RoleAssigned', 'Você recebeu um novo perfil de acesso'],
    ['RoleRevoked', 'Um perfil de acesso seu foi removido'],
  ])('ROLE_CHANGED (obrigatória, aviso de segurança) a partir de %s', (eventType, title) => {
    const plan = notify(
      planNotification(
        envelope(
          eventType,
          { membershipId: MEMBERSHIP, roleAssignmentId: testId() },
          {
            processId: null,
          },
        ),
      ),
    );
    expect(plan).toMatchObject({
      type: 'ROLE_CHANGED',
      priority: 'HIGH',
      processId: null,
      link: '/perfil',
    });
    expect(plan.recipients).toEqual([{ kind: 'MEMBERSHIP_USER', membershipId: MEMBERSHIP }]);
    expect(plan.content(1).title).toBe(title);
  });

  it('ids fora do formato UUID no payload são ignorados', () => {
    const plan = notify(
      planNotification(envelope('ProcessAssigned', { assignmentType: 'MANUAL', toUserId: 'x' })),
    );
    expect(plan.recipients).toEqual([{ kind: 'USER', userId: null }]);
  });
});

describe('templates (RN-NTF-07/08)', () => {
  const variants = [undefined, 'suspended', 'approved', 'infected', 'revoked', 'desconhecida'];

  it.each(NOTIFICATION_TYPES)('%s: pt-BR, dentro dos limites e sem valores', (type) => {
    for (const variant of variants) {
      for (const groupCount of [1, 2, 51]) {
        const content = notificationContent(type, { groupCount, variant });
        expect(content.title.length).toBeGreaterThan(0);
        expect(content.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
        expect(content.body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX);
        expect(`${content.title} ${content.body}`).not.toMatch(/R\$\s?\d/);
      }
    }
  });

  it('o agrupamento reescreve o corpo com a contagem', () => {
    expect(notificationContent('COMMENT_REPLY', { groupCount: 3 }).body).toBe(
      'Há 3 novas respostas a comentários seus neste processo.',
    );
    expect(notificationContent('PROCESS_RETURNED', { groupCount: 2 }).body).toMatch(
      /\(2 avisos neste processo\)$/,
    );
    expect(notificationContent('MENTIONED', { groupCount: 4 }).body).toContain('4 vezes');
  });

  it('todo link gerado é rota relativa', () => {
    const plans = [
      planNotification(envelope('ProcessAssigned', { assignmentType: 'MANUAL', toUserId: USER })),
      planNotification(
        envelope('ApprovalRequested', { approvalId: APPROVAL, approverType: 'USER' }),
      ),
      planNotification(envelope('RoleAssigned', { membershipId: MEMBERSHIP }, { processId: null })),
    ];
    for (const plan of plans) {
      const { link } = notify(plan);
      expect(link !== null && isRelativeNotificationLink(link)).toBe(true);
    }
  });
});
