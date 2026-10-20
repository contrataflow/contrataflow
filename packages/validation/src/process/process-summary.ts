import { z } from 'zod';

import { PROCESS_ACTIONS, PROCESS_STAGE_STATUSES, PROCESS_STATUSES } from './process-actions.js';
import { processDeadlineSchema } from './process-list.js';
import { ESTIMATED_VALUE_SOURCES, PRIORITIES } from './process.js';
import { isoDateSchema, isoDateTimeSchema } from '../common/dates.js';
import {
  CONFIDENTIALITIES,
  DAY_COUNT_TYPES,
  DOCUMENT_STATUSES,
} from '../document/document-type.js';
import { RULE_SEVERITIES, RULE_TYPES, STAGE_TYPES } from '../workflow/workflow.js';

/*
 * Painel situacional do processo (US-004 · SCR-006 · api/02-processes.md): PRC-07 (`summary` — as
 * 7 perguntas de DEC-180, cabeçalho e contadores das abas), PRC-10 (`stages` — stepper e passagens)
 * e o `meta.allowedActions` de PRC-04. O mesmo contrato na API e no web.
 */

/** Mensagem padrão de regra que não pôde ser avaliada (fail-closed — RN-PROC-51 · FA-10). */
export const RULE_EVALUATION_FAILED_MESSAGE =
  'Não foi possível verificar esta regra. Tente novamente ou fale com o administrador.';

/** Abas do SCR-006 (RN-PROC-57), na ordem da tela; o valor é o de `?aba=`. */
export const PROCESS_PANEL_TABS = [
  'resumo',
  'documentos',
  'itens',
  'tramitacao',
  'timeline',
  'comentarios',
  'participantes',
] as const;
export type ProcessPanelTab = (typeof PROCESS_PANEL_TABS)[number];

/** V-06: aba desconhecida (ou ausente) abre o Resumo. */
export function processPanelTabOf(value: string | null | undefined): ProcessPanelTab {
  return PROCESS_PANEL_TABS.find((tab) => tab === value) ?? 'resumo';
}

const refSchema = z.object({ id: z.uuid(), name: z.string() });

const summaryHeaderSchema = z.object({
  /** `null` = "Rascunho (sem número)". */
  code: z.string().nullable(),
  title: z.string(),
  status: z.enum(PROCESS_STATUSES),
  priority: z.enum(PRIORITIES),
  tags: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      color: z.string().nullable(),
      isActive: z.boolean(),
    }),
  ),
  isBudgetConfidential: z.boolean(),
  /** `null` quando não informado ou mascarado (POL-09 · RN-PROC-55). */
  estimatedValue: z.string().nullable(),
  estimatedValueMasked: z.boolean(),
  estimatedValueSource: z.enum(ESTIMATED_VALUE_SOURCES).nullable(),
  organization: z.object({ id: z.uuid(), shortName: z.string() }),
  /** Órgão diferente do principal do tenant: o cabeçalho o exibe (RN-PROC-54). */
  showOrganization: z.boolean(),
});

const summaryWhereSchema = z.object({
  stage: z
    .object({
      key: z.string(),
      name: z.string(),
      type: z.enum(STAGE_TYPES),
      groupLabel: z.string().nullable(),
    })
    .nullable(),
  department: refSchema,
  status: z.enum(PROCESS_STATUSES),
  statusBeforeSuspension: z.enum(PROCESS_STATUSES).nullable(),
  suspensionReason: z.string().nullable(),
  suspendedAt: isoDateTimeSchema.nullable(),
  /** Data de conclusão (FA-07 — "Planejamento da contratação concluído em …"). */
  completedAt: isoDateTimeSchema.nullable(),
  canceledAt: isoDateTimeSchema.nullable(),
  cancellationReason: z.string().nullable(),
});

const summaryApproverSchema = z.object({
  approvalId: z.uuid(),
  /** Usuário, perfil no escopo ou titular da unidade (com substituto se `allowDeputy`). */
  label: z.string(),
  isMine: z.boolean(),
});

const summaryResponsibleSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), jobTitle: z.string().nullable() }).nullable(),
  /** Processo na fila da unidade (sem responsável). */
  queueDepartment: refSchema.nullable(),
  /** Início da atribuição ativa. */
  since: isoDateTimeSchema.nullable(),
  /** Em `AWAITING_APPROVAL`: o aprovador designado da aprovação pendente. */
  approver: summaryApproverSchema.nullable(),
});

/** Atalho da pendência: o documento existente ou a criação do tipo (RN-PROC-51). */
export const pendingLinkSchema = z.union([
  z.object({ documentId: z.uuid(), restricted: z.boolean() }),
  z.object({ createDocumentTypeCode: z.string() }),
]);
export type PendingLink = z.infer<typeof pendingLinkSchema>;

export const pendingItemSchema = z.object({
  ruleId: z.uuid(),
  name: z.string(),
  type: z.enum(RULE_TYPES),
  severity: z.enum(RULE_SEVERITIES),
  message: z.string(),
  /** Regra que não pôde ser avaliada (contada como pendência — FA-10). */
  evaluationFailed: z.boolean(),
  link: pendingLinkSchema.nullable(),
});
export type PendingItem = z.infer<typeof pendingItemSchema>;

const summaryActionSchema = z.object({
  action: z.enum(PROCESS_ACTIONS),
  transitionKey: z.string().optional(),
  approvalId: z.uuid().optional(),
  label: z.string(),
  enabled: z.boolean(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type SummaryAction = z.infer<typeof summaryActionSchema>;

export const summaryDocumentSchema = z.object({
  id: z.uuid(),
  typeCode: z.string(),
  typeName: z.string(),
  code: z.string().nullable(),
  title: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  /** Número da versão atual (`null` sem versão gerada). */
  versionNumber: z.int().nullable(),
  confidentiality: z.enum(CONFIDENTIALITIES),
  /** `RESTRICTED` para quem não atende POL-09: sem link de conteúdo/PDF (RN-PROC-55). */
  restricted: z.boolean(),
  /** Selo "Em aprovação" (`pendingApprovalId` preenchido — DEC-018). */
  inApproval: z.boolean(),
});
export type SummaryDocument = z.infer<typeof summaryDocumentSchema>;

export const summaryApprovalSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  approverLabel: z.string(),
  requestedAt: isoDateTimeSchema,
  dueAt: isoDateTimeSchema.nullable(),
  isOverdue: z.boolean(),
  /** O usuário é o aprovador designado (POL-03) — "Aguardando sua decisão". */
  isMine: z.boolean(),
});
export type SummaryApproval = z.infer<typeof summaryApprovalSchema>;

/** PRC-07 — `GET /processes/{id}/summary` (RN-PROC-48..57). */
export const processSummarySchema = z
  .object({
    header: summaryHeaderSchema,
    where: summaryWhereSchema,
    responsible: summaryResponsibleSchema,
    pending: z.object({
      blockingCount: z.int(),
      warningCount: z.int(),
      items: z.array(pendingItemSchema),
    }),
    nextStep: z.object({
      /** Ação primária do usuário (RN-PROC-49); `null` = a área mostra com quem o processo está. */
      action: summaryActionSchema.nullable(),
      /** `WorkflowStage.instructions` (Markdown — o web renderiza sanitizado). */
      instructions: z.string().nullable(),
    }),
    /** DTO `deadline` da etapa (US-002); `null` em status final (sem badges — RN-PROC-53). */
    deadline: processDeadlineSchema.nullable(),
    target: z
      .object({
        targetDate: isoDateSchema,
        isOverdue: z.boolean(),
        /** Dias corridos após o prazo alvo (DEC-031). */
        overdueDays: z.int().nullable(),
      })
      .nullable(),
    documents: z.array(summaryDocumentSchema),
    approvals: z.array(summaryApprovalSchema),
    counts: z.object({
      documents: z.int(),
      items: z.int(),
      comments: z.int(),
      participants: z.int(),
    }),
    version: z.int(),
  })
  .meta({ id: 'ProcessSummary' });
export type ProcessSummaryDto = z.infer<typeof processSummarySchema>;

export const stagePassSchema = z.object({
  processStageId: z.uuid(),
  sequence: z.int(),
  status: z.enum(PROCESS_STAGE_STATUSES),
  department: refSchema,
  assignee: refSchema.nullable(),
  enteredAt: isoDateTimeSchema,
  exitedAt: isoDateTimeSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  dueDateOverridden: z.boolean(),
  overdueSince: isoDateTimeSchema.nullable(),
});
export type StagePassDto = z.infer<typeof stagePassSchema>;

/** PRC-10 — etapa da versão fixada com as passagens (RN-PROC-52). */
export const processStageEntrySchema = z
  .object({
    workflowStageId: z.uuid(),
    key: z.string(),
    name: z.string(),
    type: z.enum(STAGE_TYPES),
    groupLabel: z.string().nullable(),
    displayOrder: z.int(),
    slaDays: z.int().nullable(),
    slaType: z.enum(DAY_COUNT_TYPES).nullable(),
    /** Status da última passagem; `null` = ainda não percorrida. */
    lastPassStatus: z.enum(PROCESS_STAGE_STATUSES).nullable(),
    /** Etapa da passagem ativa (destaque no stepper — `aria-current="step"`). */
    isCurrent: z.boolean(),
    passes: z.array(stagePassSchema),
  })
  .meta({ id: 'ProcessStageEntry' });
export type ProcessStageEntryDto = z.infer<typeof processStageEntrySchema>;

/** `meta` de PRC-04: ações habilitadas para o usuário (api.md §1.5). */
export const processDetailMetaSchema = z.object({ allowedActions: z.array(z.string()) });
export type ProcessDetailMeta = z.infer<typeof processDetailMetaSchema>;
