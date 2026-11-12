import { z } from 'zod';

import { STAGE_TYPES } from '../workflow/workflow.js';

/*
 * US-124 — ramos paralelos em execução (DEC-194 · ADR-005 · api.md MVP 2 PRC-04/08/19/20/21/22/39):
 * o alvo das ações por etapa (`processStageId`), as etapas ativas (`activeStages[]`, aditivo ao
 * processo — DEC-108) e a visão dos ramos do split (PRC-39). As mensagens das validações V-01..V-09
 * da story são as do usuário (pt-BR).
 */

/** `ProcessBranchStatus` (entities.md MVP 2 §2). */
export const PROCESS_BRANCH_STATUSES = ['OPEN', 'ARRIVED', 'CANCELED'] as const;
export type ProcessBranchStatus = (typeof PROCESS_BRANCH_STATUSES)[number];

export const PROCESS_BRANCH_MESSAGES = Object.freeze({
  stageRequired: 'Escolha em qual ramo você quer agir.',
  stageInvalid: 'Essa etapa não está ativa neste processo. Atualize a página.',
  stageChanged:
    'Este ramo já foi movimentado por outra pessoa. Atualize a página para ver a situação atual.',
  notCustodian:
    'Este ramo está com outra pessoa ou outra unidade. Assuma a etapa ou peça a atribuição.',
  transitionNotAvailable: 'Esta ação não está disponível para este ramo.',
  cancellationNotConfirmed:
    'Devolver nesta etapa cancela os outros ramos e as aprovações pendentes. Confirme para continuar.',
  /** `cancellationReason` dos ramos e motivo das aprovações canceladas pela devolução (RN-WF2-23). */
  returnedBeforeSplit: 'Processo devolvido para etapa anterior à ramificação',
  /** `cancellationReason` dos ramos no cancelamento do processo (RN-WF2-25). */
  processCanceled: 'Processo cancelado',
});

/** Etapa ativa do processo (`activeStages[]` de PRC-04/PRC-08/PRC-39 — RN-WF2-15). */
export const activeStageSchema = z
  .object({
    processStageId: z.uuid(),
    stageKey: z.string(),
    stageName: z.string(),
    stageType: z.enum(STAGE_TYPES),
    /** Ramo da etapa; `null` fora do paralelismo (tronco). */
    branchKey: z.string().nullable(),
    department: z.object({ id: z.uuid(), name: z.string() }),
    responsible: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    enteredAt: z.iso.datetime({ offset: true }),
    dueAt: z.iso.datetime({ offset: true }).nullable(),
    isOverdue: z.boolean(),
    /** Aberta por devolução (`enteredViaMovement.action = RETURN`) — status `RETURNED` (RN-WF2-16). */
    openedByReturn: z.boolean(),
  })
  .meta({ id: 'ActiveStage' });
export type ActiveStageDto = z.infer<typeof activeStageSchema>;

/** Resumo das etapas em que o usuário pode agir (`stages[]` irmão de `data` em PRC-08). */
export const actionStageSchema = z
  .object({
    processStageId: z.uuid(),
    branchKey: z.string().nullable(),
    stageKey: z.string(),
    stageName: z.string(),
    /** O usuário tem a custódia da etapa (responsável ou, na fila, lotado na unidade). */
    isMine: z.boolean(),
  })
  .meta({ id: 'ActionStage' });
export type ActionStageDto = z.infer<typeof actionStageSchema>;

/** Uma passagem de um ramo (PRC-39 · `branches[].passes[]`). */
const branchPassSchema = z.object({
  processStageId: z.uuid(),
  stageKey: z.string(),
  stageName: z.string(),
  status: z.string(),
  enteredAt: z.iso.datetime({ offset: true }),
  exitedAt: z.iso.datetime({ offset: true }).nullable(),
});

/** PRC-39 — `data` da resposta: a rodada atual (ou `round`) do bloco paralelo; `null` fora dele. */
export const processBranchesSchema = z
  .object({
    splitProcessStageId: z.uuid(),
    splitStageKey: z.string(),
    joinStageKey: z.string().nullable(),
    /** Status da `ProcessStage` do split (`ACTIVE` em curso; `COMPLETED`/`RETURNED` encerrado). */
    status: z.string(),
    openBranchesLeft: z.number().int().min(0),
    branches: z.array(
      z.object({
        branchKey: z.string(),
        status: z.enum(PROCESS_BRANCH_STATUSES),
        arrivedAt: z.iso.datetime({ offset: true }).nullable(),
        canceledAt: z.iso.datetime({ offset: true }).nullable(),
        cancellationReason: z.string().nullable(),
        activeStage: activeStageSchema.nullable(),
        passes: z.array(branchPassSchema),
      }),
    ),
    /** Rodadas anteriores (FA-08: o processo voltou para antes do split e entrou de novo). */
    previousRounds: z.array(z.object({ splitProcessStageId: z.uuid(), status: z.string() })),
  })
  .meta({ id: 'ProcessBranches' });
export type ProcessBranchesDto = z.infer<typeof processBranchesSchema>;

/** PRC-39 — `round` (o `splitProcessStageId` de uma rodada; padrão = a atual/mais recente). */
export const processBranchesQuerySchema = z.strictObject({ round: z.uuid().optional() });

/** PRC-21 — corpo opcional do "assumir" (US-124 · RN-WF2-18: a etapa do ramo). */
export const claimProcessSchema = z
  .strictObject({
    processStageId: z.uuid({ error: PROCESS_BRANCH_MESSAGES.stageInvalid }).optional(),
  })
  .meta({ id: 'ClaimProcessRequest' });
export type ClaimProcess = z.output<typeof claimProcessSchema>;

/** Campo `processStageId` dos corpos de PRC-19/20/22 (RN-WF2-18). */
export const processStageIdField = z
  .uuid({ error: PROCESS_BRANCH_MESSAGES.stageInvalid })
  .optional();
