import type { PolicyId } from '@contrataflow/types';

/*
 * Bateria de autorização (permissions.md §10): os arquivos que o `test:authz` roda. Fonte única
 * para o `vitest.authz.config.ts` e para o `policy-coverage.spec.ts`, que confere o inventário.
 *
 * - Matriz gerada, visibilidade e inventário: `test/authz/*.spec.ts`.
 * - Meta-teste de decorators e matriz §3.2 × código: `authorization-coverage.spec.ts` e
 *   `default-roles.spec.ts`.
 * - Políticas POL-01..18: a suíte que já prova cada uma (sucesso e violação) fica onde a story a
 *   escreveu; o inventário aponta os arquivos e o termo que a violação precisa citar.
 * - Multi-tenant: suíte `test:tenant-leak` (com banco), fora daqui.
 */

export interface PolicyEvidence {
  /** Spec (caminho a partir de `apps/api`) que exercita a política com sucesso e violação. */
  readonly file: string;
  /** Termos que o arquivo precisa conter (código de erro da violação, ID da política). */
  readonly mentions: readonly string[];
}

export const POLICY_EVIDENCE: Readonly<Record<PolicyId, readonly PolicyEvidence[]>> = {
  'POL-01': [
    {
      file: 'src/modules/process/presentation/process-forward.routes.spec.ts',
      mentions: ['NOT_PROCESS_CUSTODIAN', 'INVALID_PROCESS_STATUS'],
    },
  ],
  'POL-02': [
    {
      file: 'src/modules/document/presentation/document.routes.spec.ts',
      mentions: ['DOCUMENT_NOT_EDITABLE'],
    },
  ],
  // Segregação de funções: SELF_APPROVAL_FORBIDDEN. US-134: POL-03 por linha (linha em espera,
  // linha já decidida, pessoa única).
  'POL-03': [
    {
      file: 'src/modules/process/presentation/approval-decision.routes.spec.ts',
      mentions: ['NOT_DESIGNATED_APPROVER', 'SELF_APPROVAL_FORBIDDEN', 'APPROVAL_NOT_PENDING'],
    },
    {
      file: 'src/modules/approval/domain/approval-vote.spec.ts',
      mentions: ['NOT_DESIGNATED_APPROVER', 'SELF_APPROVAL_FORBIDDEN', 'LINE_WAITING'],
    },
    {
      file: 'src/modules/process/presentation/multi-approver-decision.routes.spec.ts',
      mentions: [
        'LINE_WAITING',
        'APPROVAL_LINE_NOT_PENDING',
        'APPROVER_ALREADY_VOTED',
        'SELF_APPROVAL_FORBIDDEN',
      ],
    },
    {
      // Designação por perfil: escopo cobrindo a unidade solicitante (DEC-022).
      file: 'src/modules/access/domain/approval-competence.spec.ts',
      mentions: ['DEC-022', 'HISTORICAL'],
    },
  ],
  'POL-04': [
    {
      file: 'src/modules/process/presentation/process-claim.routes.spec.ts',
      mentions: ['PROCESS_ALREADY_ASSIGNED', 'PROCESS_CLAIM'],
    },
  ],
  'POL-05': [
    {
      file: 'src/modules/process/presentation/process-assign.routes.spec.ts',
      mentions: ['POL-05', 'PROCESS_ASSIGN'],
    },
  ],
  'POL-06': [
    {
      file: 'src/modules/process/presentation/process-cancellation.routes.spec.ts',
      mentions: ['PROCESS_CANCEL', 'pelo menos 20 caracteres'],
    },
  ],
  'POL-07': [
    {
      file: 'src/modules/process/presentation/process-suspension.routes.spec.ts',
      mentions: ['PROCESS_SUSPEND', 'INVALID_PROCESS_STATUS'],
    },
  ],
  'POL-08': [
    {
      file: 'src/modules/process/presentation/process-completion.routes.spec.ts',
      mentions: ['NOT_PROCESS_CUSTODIAN', 'TRANSITION_BLOCKED', 'PROCESS_COMPLETE'],
    },
  ],
  'POL-09': [
    {
      file: 'src/modules/process/presentation/process-list.routes.spec.ts',
      mentions: ['POL-09', 'confidentialStepUpAvailable'],
    },
    {
      file: 'src/modules/dfd/presentation/dfd.routes.spec.ts',
      mentions: ['POL-09'],
    },
  ],
  'POL-10': [
    {
      file: 'src/modules/process/domain/process-participants.spec.ts',
      mentions: ['POL-10'],
    },
    {
      file: 'src/modules/process/presentation/process-participants.routes.spec.ts',
      mentions: ['PROCESS_MANAGE_PARTICIPANTS', 'CONSULTANT'],
    },
  ],
  'POL-11': [
    {
      file: 'src/modules/document/presentation/document.routes.spec.ts',
      mentions: ['POL-11', 'DOCUMENT_REOPEN'],
    },
  ],
  // Anti-bloqueio.
  'POL-12': [
    {
      file: 'src/modules/access/presentation/role-assignment.routes.spec.ts',
      mentions: ['LAST_ADMIN_REQUIRED'],
    },
    {
      file: 'src/modules/identity/domain/membership-lifecycle.spec.ts',
      mentions: ['POL-12'],
    },
  ],
  // Anti-escalonamento.
  'POL-13': [
    {
      file: 'src/modules/access/presentation/role-assignment.routes.spec.ts',
      mentions: ['PRIVILEGE_ESCALATION_FORBIDDEN'],
    },
    { file: 'src/modules/access/domain/role-assignment.spec.ts', mentions: ['POL-13'] },
    { file: 'src/modules/access/domain/role-management.spec.ts', mentions: ['POL-13'] },
  ],
  'POL-14': [
    {
      file: 'src/modules/access/domain/authorization-decision.spec.ts',
      mentions: ['MFA_REQUIRED'],
    },
    {
      file: 'src/modules/access/application/authorization.service.spec.ts',
      mentions: ['MFA_REQUIRED'],
    },
  ],
  'POL-15': [
    {
      file: 'src/modules/access/presentation/role-assignment.routes.spec.ts',
      mentions: ['EXTERNAL_HIGH_RISK_ROLE'],
    },
    { file: 'src/modules/access/domain/role-assignment.spec.ts', mentions: ['POL-15'] },
  ],
  'POL-16': [
    { file: 'src/modules/identity/domain/membership-lifecycle.spec.ts', mentions: ['POL-16'] },
    {
      file: 'src/modules/access/presentation/role-assignment.routes.spec.ts',
      mentions: ['POL-16'],
    },
  ],
  'POL-17': [
    { file: 'src/modules/process/domain/process-withdrawal.spec.ts', mentions: ['POL-17'] },
  ],
  'POL-18': [
    {
      file: 'src/modules/ai/presentation/ai-generation.routes.spec.ts',
      mentions: ['AI_GENERATE', 'AI_DISABLED', 'AI_GENERATION_NOT_OWNED'],
    },
  ],
};

/** Decisão, retrato de permissões e meta-teste — o núcleo do `access`. */
const CORE = [
  'test/authz/**/*.spec.ts',
  'src/openapi/authorization-coverage.spec.ts',
  'src/modules/access/domain/default-roles.spec.ts',
  'src/modules/access/domain/effective-permissions.spec.ts',
  'src/modules/access/domain/authorization-decision.spec.ts',
  'src/modules/access/application/authorization.service.spec.ts',
  'src/shared/database/process-visibility.spec.ts',
];

export const AUTHZ_BATTERY: readonly string[] = [
  ...new Set([
    ...CORE,
    ...Object.values(POLICY_EVIDENCE).flatMap((evidence) => evidence.map((entry) => entry.file)),
  ]),
];
