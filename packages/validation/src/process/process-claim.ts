/*
 * Assumir processo (US-049 · PRC-21 · api/02-processes.md): comando SEM corpo — `POST
 * /processes/{id}/claim` com `If-Match`; a resposta é o `Process` atualizado (`processSchema`). As
 * mensagens são as das tabelas "Validações" e "Casos de erro" da story, as mesmas da API e do botão
 * "Assumir" (SCR-115).
 */

export const PROCESS_CLAIM_MESSAGES = Object.freeze({
  /** V-01 (a API completa com o nome de quem assumiu em `alreadyAssignedBy`). */
  alreadyAssigned: 'Este processo já foi assumido.',
  alreadyAssignedBy: (name: string) => `Este processo já foi assumido por ${name}.`,
  /** V-02. */
  notInDepartment: 'Você não pertence à unidade responsável por este processo.',
  /** V-03. */
  invalidStatus: 'Este processo não pode ser assumido no momento.',
  /** V-04. */
  versionConflict: 'Os dados do processo mudaram. Atualize a página.',
  /** Sucesso (toast do front). */
  claimed: 'Você assumiu este processo.',
  /** 503. */
  unavailable: 'Não foi possível assumir o processo agora. Tente novamente em instantes.',
});
