/**
 * Gancho de inicialização do Next (RN-FND-75): sobe o OpenTelemetry Node SDK antes de qualquer
 * requisição, só no runtime Node — o proxy (Edge) não carrega o SDK.
 */
export async function register(): Promise<void> {
  // O Next substitui `process.env.NEXT_RUNTIME` no build: a comparação literal tira o SDK (e o
  // pino) do bundle Edge, o que uma função de `src/config` não permitiria.
  // eslint-disable-next-line contrataflow/no-process-env -- ver comentário acima
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startWebTelemetry } = await import('@/bff/telemetry');
  startWebTelemetry();
}
