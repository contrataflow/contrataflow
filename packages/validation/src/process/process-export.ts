import { z } from 'zod';

import type { ProcessStatus } from './process-actions.js';
import { processListQueryShape, refineProcessListRanges } from './process-list.js';
import type { Priority } from './process.js';
import { PROCESS_COLUMN_KEYS, SAVED_VIEW_MESSAGES } from './saved-views.js';
import type { ProcessColumnKey } from './saved-views.js';

/*
 * Exportação CSV da lista de processos (US-003 · PRC-34 · RN-PROC-40..46): os mesmos filtros e a
 * mesma ordenação de PRC-01 (sem paginação) + `columns`. Rótulos do arquivo em pt-BR pela
 * terminologia (DEC-184 — nunca valores técnicos); a serialização fica na API.
 */

/** RN-PROC-41: linhas por arquivo (lacuna 3 da US-003). */
export const PROCESS_EXPORT_MAX_ROWS = 10_000;

export const PROCESS_EXPORT_MESSAGES = Object.freeze({
  tooLarge: (total: number) =>
    `A consulta tem ${total.toLocaleString('pt-BR')} processos. Refine os filtros para exportar até ${PROCESS_EXPORT_MAX_ROWS.toLocaleString('pt-BR')}.`,
  invalidFilters: 'Alguns filtros eram inválidos. Revise a consulta.',
  forbidden: 'Você não tem permissão para exportar processos.',
  inProgress: 'Aguarde a exportação em andamento terminar.',
  interrupted: 'A exportação foi interrompida. Tente novamente.',
  unavailable: 'Não foi possível exportar agora. Tente novamente em instantes.',
});

const {
  page: _page,
  pageSize: _pageSize,
  includeStageOptions: _stages,
  ...filterShape
} = processListQueryShape;

/** `columns=code,title,status` (vírgula ou repetição); ausente = colunas padrão. */
const columnsParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value.join(',') : value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(
    z
      .array(z.enum(PROCESS_COLUMN_KEYS, { error: SAVED_VIEW_MESSAGES.invalidColumns }))
      .min(1, { error: SAVED_VIEW_MESSAGES.invalidColumns }),
  )
  .transform((columns) => [...new Set(columns)])
  .optional();

/** PRC-34 (query): filtros e `sort` de PRC-01 + `columns` e a visão de origem (auditoria). */
export const processExportQuerySchema = z
  .object({
    ...filterShape,
    columns: columnsParam,
    savedViewId: z.uuid().optional(),
  })
  .superRefine(refineProcessListRanges)
  .meta({ id: 'ProcessExportQuery' });
export type ProcessExportQuery = z.output<typeof processExportQuerySchema>;

// --- Rótulos do arquivo (RN-PROC-44) -------------------------------------------------------

export const PROCESS_STATUS_LABELS: Readonly<Record<ProcessStatus, string>> = {
  DRAFT: 'Rascunho',
  IN_PROGRESS: 'Em andamento',
  AWAITING_APPROVAL: 'Aguardando aprovação',
  RETURNED: 'Devolvido',
  SUSPENDED: 'Suspenso',
  CANCELED: 'Cancelado',
  COMPLETED: 'Concluído',
  PUBLISHED: 'Publicado',
};

export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  LOW: 'Baixa',
  MEDIUM: 'Média',
  HIGH: 'Alta',
  URGENT: 'Urgente',
};

/** Situação do prazo da etapa (coluna "Situação do prazo"). */
export const DEADLINE_SITUATION_LABELS = Object.freeze({
  overdue: 'Atrasado',
  dueSoon: 'Vence em breve',
  onTime: 'No prazo',
  paused: 'Pausado',
  none: 'Sem prazo',
});

export const CONFIDENTIAL_LABELS = Object.freeze({ masked: 'Sigiloso', yes: 'Sim', no: 'Não' });

/**
 * Cabeçalho de cada coluna (uma chave pode gerar duas colunas — `deadline`, `estimatedValue`).
 * `{secretariat}`/`{department}` vêm de `labels.secretariat`/`labels.department` do tenant.
 */
export function processExportHeaders(
  column: ProcessColumnKey,
  labels: { readonly secretariat: string; readonly department: string },
): readonly string[] {
  switch (column) {
    case 'code':
      return ['Código'];
    case 'title':
      return ['Título'];
    case 'status':
      return ['Situação'];
    case 'stage':
      return ['Etapa'];
    case 'currentDepartment':
      return ['Unidade atual'];
    case 'currentResponsible':
      return ['Responsável'];
    case 'deadline':
      return ['Prazo da etapa', 'Situação do prazo'];
    case 'priority':
      return ['Prioridade'];
    case 'requestingSecretariat':
      return [`${labels.secretariat} solicitante`];
    case 'requestingDepartment':
      return [`${labels.department} solicitante`];
    case 'organization':
      return ['Órgão'];
    case 'contractingType':
      return ['Tipo de contratação'];
    case 'modality':
      return ['Modalidade'];
    case 'origin':
      return ['Origem'];
    case 'estimatedValue':
      return ['Valor estimado', 'Orçamento sigiloso'];
    case 'targetDate':
      return ['Prazo alvo'];
    case 'tags':
      return ['Etiquetas'];
    case 'internalCode':
      return ['Código interno'];
    case 'createdAt':
      return ['Criado em'];
    case 'updatedAt':
      return ['Atualizado em'];
  }
}
