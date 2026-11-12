import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';

/*
 * US-125 — ramos paralelos nas LEITURAS (DEC-194 · RN-WF2-29..38): a caixa de tarefas (TSK-01),
 * a lista de processos (PRC-01), o painel situacional (PRC-07) e as aprovações (APV-01/APV-02).
 * Tudo aditivo (DEC-108): sem ramificação as respostas do MVP 1 não mudam. Nenhum destes blocos
 * traz pessoas nem valores — `siblings[]` só nomeia etapa e situação (POL-09).
 */

/** Limite de `siblings[]` por linha; o excedente vai em `siblingsMore` (RN-WF2-30). */
export const BRANCH_SIBLINGS_LIMIT = 3;

/** Situação de um ramo irmão (`ProcessBranch.status` sem os cancelados). */
export const BRANCH_SIBLING_STATUSES = ['OPEN', 'ARRIVED'] as const;
export type BranchSiblingStatus = (typeof BRANCH_SIBLING_STATUSES)[number];

/** Outro ramo do mesmo split (RN-WF2-30): nome da etapa e situação, sem pessoas nem valores. */
export const branchSiblingSchema = z
  .object({
    branchKey: z.string(),
    /** Rótulo do ramo (nome da primeira etapa do ramo na versão — RN-WF2-07). */
    branchLabel: z.string(),
    /** Etapa ativa do ramo (`OPEN`) ou a última percorrida (`ARRIVED`). */
    stageName: z.string(),
    status: z.enum(BRANCH_SIBLING_STATUSES),
    isOverdue: z.boolean(),
  })
  .meta({ id: 'BranchSibling' });
export type BranchSiblingDto = z.infer<typeof branchSiblingSchema>;

/** Campos de ramo de uma linha (TSK-01, APV-01, APV-02 — RN-WF2-30/37). */
export const branchRowFields = {
  /** Ramo da etapa da linha; `null` fora do paralelismo. */
  branchKey: z.string().nullable().optional(),
  branchLabel: z.string().nullable().optional(),
  /** Os outros ramos do mesmo split (até 3). */
  siblings: z.array(branchSiblingSchema).max(BRANCH_SIBLINGS_LIMIT).optional(),
  /** Quantos irmãos ficaram fora de `siblings[]`. */
  siblingsMore: z.int().min(0).optional(),
};

/** A etapa que define o prazo do processo (menor `dueAt` entre as ativas — RN-WF2-34). */
export const criticalStageSchema = z
  .object({
    processStageId: z.uuid(),
    branchKey: z.string().nullable(),
    stageName: z.string(),
  })
  .meta({ id: 'CriticalStage' });
export type CriticalStageDto = z.infer<typeof criticalStageSchema>;

/** `activeStages[]` compacto da lista de processos (PRC-01 · RN-WF2-36). */
export const compactActiveStageSchema = z
  .object({
    processStageId: z.uuid(),
    stageKey: z.string(),
    stageName: z.string(),
    branchKey: z.string().nullable(),
    branchLabel: z.string().nullable(),
    departmentName: z.string(),
    dueAt: isoDateTimeSchema.nullable(),
    isOverdue: z.boolean(),
  })
  .meta({ id: 'CompactActiveStage' });
export type CompactActiveStageDto = z.infer<typeof compactActiveStageSchema>;

/**
 * `InboxRowKey` (RN-WF2-30): a chave única da linha — o processo fora de ramo; `processId:
 * processStageId` na linha de um ramo. A UI a usa como `key` (o processo pode ter várias linhas).
 */
export function inboxRowKeyOf(processId: string, processStageId: string | null): string {
  return processStageId === null ? processId : `${processId}:${processStageId}`;
}
