import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Participantes do processo (US-012 · entities.md §4.4 `ProcessParticipant` · DEC-036 ·
 * api/02-processes.md PRC-28..32). Acesso explícito por processo, concedido a um usuário ou a uma
 * unidade, sem custódia (participantes nunca tramitam nem aprovam — RN-PROC-131). Os MESMOS schemas
 * validam o diálogo "Adicionar participante" do SCR-112 e o corpo da API; elegibilidade (vínculo
 * `EXTERNAL`, autoinclusão — POL-10) e a validade futura ficam no domínio da API.
 */

/** entities.md §2 — `ParticipantRole`. */
export const PARTICIPANT_ROLES = ['OBSERVER', 'COLLABORATOR', 'CONSULTANT'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/** Rótulos pt-BR do papel (story · "Campos"). */
export const PARTICIPANT_ROLE_LABELS: Readonly<Record<ParticipantRole, string>> = Object.freeze({
  OBSERVER: 'Observador',
  COLLABORATOR: 'Colaborador',
  CONSULTANT: 'Consultor',
});

/** Como a participação foi concedida (auditoria `metadata.grantedVia` e evento). */
export const PARTICIPANT_GRANT_CHANNELS = ['MANAGE', 'FOLLOW'] as const;
export type ParticipantGrantChannel = (typeof PARTICIPANT_GRANT_CHANNELS)[number];

/** Motivo da revogação no evento `ProcessParticipantRemoved` (events.md §4.1). */
export const PARTICIPANT_REMOVAL_REASONS = ['REVOKED', 'EXPIRED'] as const;
export type ParticipantRemovalReason = (typeof PARTICIPANT_REMOVAL_REASONS)[number];

export const PARTICIPANT_LIMITS = Object.freeze({ reasonMax: 500 });

/** Mensagens da tabela de validações da US-012 (V-01..V-08). */
export const PARTICIPANT_MESSAGES = Object.freeze({
  role: 'Selecione o papel do participante.',
  target: 'Selecione um usuário ou uma unidade.',
  expiresAtRequired: 'Informe a validade da participação do consultor.',
  expiresAtFuture: 'A validade deve ser uma data futura.',
  expiresAtFormat: 'Informe uma data e hora válidas.',
  expiresAtOnlyConsultant: 'A validade só se aplica ao papel Consultor.',
  reasonLength: 'O motivo deve ter no máximo 500 caracteres.',
  notEligibleConsultant: 'Este usuário não pode receber o papel de Consultor.',
  notEligibleSelf: 'Você não pode se adicionar com este papel.',
  expiresAfterMembership: 'A validade não pode ultrapassar a do vínculo externo do usuário.',
  invalidReference: 'Selecione um usuário ou unidade válidos.',
  alreadyExists: 'Esta pessoa (ou unidade) já participa do processo.',
  notFound: 'Este participante não existe mais.',
  permissionDenied: 'Você não tem permissão para gerenciar participantes deste processo.',
  unfollowNotObserver:
    'Você participa deste processo com outro papel; peça a quem gerencia os participantes para removê-lo.',
});

/** Texto opcional: vazio depois do `trim` = não informado (`null`). */
const reasonSchema = z
  .string()
  .trim()
  .max(PARTICIPANT_LIMITS.reasonMax, { error: PARTICIPANT_MESSAGES.reasonLength })
  .transform((value) => (value === '' ? null : value))
  .nullish();

const participantRoleSchema = z.enum(PARTICIPANT_ROLES, { error: PARTICIPANT_MESSAGES.role });

/**
 * PRC-29 — corpo de `POST /processes/{id}/participants`. Exatamente um entre `userId` e
 * `departmentId` (V-02 · RN-PROC-126); `CONSULTANT` exige `expiresAt` (V-03 · RN-PROC-127).
 */
export const addProcessParticipantSchema = z
  .strictObject({
    userId: z.uuid({ error: PARTICIPANT_MESSAGES.target }).nullish(),
    departmentId: z.uuid({ error: PARTICIPANT_MESSAGES.target }).nullish(),
    role: participantRoleSchema,
    notify: z.boolean().default(true),
    expiresAt: z.iso
      .datetime({ offset: true, error: PARTICIPANT_MESSAGES.expiresAtFormat })
      .nullish(),
    reason: reasonSchema,
  })
  .superRefine((value, ctx) => {
    const hasUser = Boolean(value.userId);
    const hasDepartment = Boolean(value.departmentId);
    if (hasUser === hasDepartment) {
      ctx.addIssue({
        code: 'custom',
        path: [hasUser ? 'departmentId' : 'userId'],
        message: PARTICIPANT_MESSAGES.target,
        params: { code: hasUser ? 'NOT_ALLOWED' : 'REQUIRED' },
      });
    }
    if (value.role === 'CONSULTANT' && !value.expiresAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: PARTICIPANT_MESSAGES.expiresAtRequired,
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    }
    // Só o consultor tem validade (RN-PROC-127); os demais valem até a revogação.
    if (value.role !== 'CONSULTANT' && value.expiresAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: PARTICIPANT_MESSAGES.expiresAtOnlyConsultant,
        params: { code: 'NOT_ALLOWED' },
      });
    }
  })
  .meta({ id: 'AddProcessParticipantRequest' });
export type AddProcessParticipant = z.output<typeof addProcessParticipantSchema>;
export type AddProcessParticipantInput = z.input<typeof addProcessParticipantSchema>;

/** PRC-30 — corpo opcional de `DELETE /process-participants/{participantId}`. */
export const removeProcessParticipantSchema = z
  .strictObject({ revocationReason: reasonSchema })
  .meta({ id: 'RemoveProcessParticipantRequest' });
export type RemoveProcessParticipant = z.output<typeof removeProcessParticipantSchema>;

export const processParticipantIdParamsSchema = z.strictObject({ participantId: uuidV7Schema });

/** `Participant` — resposta de PRC-28/29/31 (api/02-processes.md). */
export const processParticipantSchema = z
  .object({
    id: z.uuid(),
    processId: z.uuid(),
    principalType: z.enum(['USER', 'DEPARTMENT']),
    userId: z.uuid().nullable(),
    departmentId: z.uuid().nullable(),
    /** Usuário ou unidade participante; `isExternal` = vínculo `EXTERNAL` (só usuário). */
    principal: z.object({ id: z.uuid(), name: z.string(), isExternal: z.boolean() }),
    role: z.enum(PARTICIPANT_ROLES),
    notify: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    grantedAt: z.iso.datetime({ offset: true }),
    grantedBy: z.object({ id: z.uuid(), name: z.string() }),
    reason: z.string().nullable(),
  })
  .meta({ id: 'ProcessParticipant' });
export type ProcessParticipantDto = z.infer<typeof processParticipantSchema>;

/** `meta` de PRC-28: o que a UI mostra (gestão e o botão "Seguir" — DEC-180). */
export const processParticipantsMetaSchema = z.object({
  /** `PROCESS_MANAGE_PARTICIPANTS` cobrindo o processo (botões "Adicionar"/"Remover"). */
  canManage: z.boolean(),
  /** Participação ativa do próprio usuário (FA-01 · RN-PROC-133). */
  me: z.object({ participantId: z.uuid(), role: z.enum(PARTICIPANT_ROLES) }).nullable(),
});
export type ProcessParticipantsMeta = z.infer<typeof processParticipantsMetaSchema>;
