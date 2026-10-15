import 'server-only';

/*
 * Correlação no BFF (RN-FND-74 · observability.md §3 · V-01): o `X-Correlation-Id` do browser só é
 * aceito se casar `^[A-Za-z0-9._:-]{8,64}$`; ausente ou inválido, o valor é descartado (evita log
 * injection) e um UUIDv7 é gerado. A mesma regra vale na API.
 */
export {
  CORRELATION_HEADER,
  isValidCorrelationId,
  resolveCorrelationId,
} from '@contrataflow/observability/correlation';
