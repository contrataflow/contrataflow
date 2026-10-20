/*
 * Correlação (RN-FND-74 · observability.md §3): a API aplica a mesma regra do BFF a quem a chama
 * — `X-Correlation-Id` aceito só se casar `^[A-Za-z0-9._:-]{8,64}$`; ausente ou inválido, o valor
 * é descartado (nunca logado) e um UUIDv7 é gerado.
 */
export { CORRELATION_HEADER, resolveCorrelationId } from '@contrataflow/observability';
