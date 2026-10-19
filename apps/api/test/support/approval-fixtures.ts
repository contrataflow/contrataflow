/*
 * Tokens do módulo `approval` para os testes de rota que atravessam módulos (US-052): a decisão
 * corre nas transações e no relógio do `approval`, substituídos pelo teste (fila, banco fora).
 */
export { APPROVAL_CLOCK, APPROVAL_TRANSACTIONS } from '#modules/approval/application/ports.js';
export type { ApprovalTransactions } from '#modules/approval/application/ports.js';
