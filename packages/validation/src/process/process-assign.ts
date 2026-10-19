import { z } from 'zod';

/*
 * Atribuir/reatribuir responsável (US-050 · PRC-22 · api/02-processes.md): o corpo de
 * `POST /processes/{id}/assign` com `If-Match`; a resposta é o `Process` atualizado
 * (`processSchema`). As MESMAS regras validam o diálogo SCR-115 e a API; a obrigatoriedade do motivo
 * depende do responsável atual (RN-TRAM-39) e fica com o comando e com o modelo do diálogo.
 */

/** Limites de RN-TRAM-39. */
export const PROCESS_ASSIGN_LIMITS = Object.freeze({
  reasonMin: 10,
  reasonMax: 2000,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-050. */
export const PROCESS_ASSIGN_MESSAGES = Object.freeze({
  /** V-01. */
  assigneeRequired: 'Selecione um responsável ou deixe na fila da unidade.',
  /** V-02. */
  reasonRequired: 'Informe o motivo da troca de responsável.',
  /** V-03. */
  reasonTooShort: 'O motivo deve ter ao menos 10 caracteres.',
  reasonTooLong: 'O motivo pode ter até 2.000 caracteres.',
  /** V-04. */
  assigneeNotEligible: 'Esta pessoa não pode ser responsável por este processo.',
  /** Referência de outro tenant (REFERENCE_NOT_FOUND). */
  assigneeNotFound: 'Selecione um responsável válido.',
  /** V-05. */
  permissionDenied: 'Você não pode atribuir responsáveis neste processo.',
  /** V-06. */
  invalidStatus: 'Este processo não pode ser atribuído no momento.',
  /** V-07. */
  versionConflict: 'Os dados do processo mudaram. Atualize a página.',
  /** Sucesso (toast do front). */
  assigned: (name: string) => `Processo atribuído a ${name}.`,
  queued: 'Processo devolvido para a fila da unidade.',
  /** 503. */
  unavailable: 'Não foi possível atribuir o processo agora. Tente novamente em instantes.',
});

/**
 * Corpo de PRC-22. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). `assigneeId` sempre presente
 * (`null` = deixar na fila da unidade — RN-TRAM-40); `reason` opcional aqui, exigido pelo comando
 * quando já há responsável (RN-TRAM-39).
 */
export const assignProcessSchema = z
  .strictObject({
    assigneeId: z.uuid({ error: PROCESS_ASSIGN_MESSAGES.assigneeRequired }).nullable(),
    reason: z
      .string({ error: PROCESS_ASSIGN_MESSAGES.reasonRequired })
      .trim()
      .min(PROCESS_ASSIGN_LIMITS.reasonMin, { error: PROCESS_ASSIGN_MESSAGES.reasonTooShort })
      .max(PROCESS_ASSIGN_LIMITS.reasonMax, { error: PROCESS_ASSIGN_MESSAGES.reasonTooLong })
      .optional(),
  })
  .meta({ id: 'AssignProcessRequest' });
export type AssignProcess = z.output<typeof assignProcessSchema>;
export type AssignProcessInput = z.input<typeof assignProcessSchema>;

/** RN-TRAM-39: o motivo é exigido quando já existe um responsável individual (troca ou remoção). */
export function assignReasonRequired(currentResponsibleId: string | null): boolean {
  return currentResponsibleId !== null;
}
