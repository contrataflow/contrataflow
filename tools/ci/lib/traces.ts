// Verificação de *traces* do estágio "Pós-deploy" (US-079 — RN-FND-28 · observability.md §3): uma
// requisição a staging com `traceparent` conhecido (amostrado) precisa aparecer no backend de
// traces (API HTTP do Tempo: `GET /api/traces/{traceId}`) dentro do tempo limite.
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  readonly traceId: string;
  readonly traceparent: string;
}

/** W3C Trace Context: `00-<trace-id>-<parent-id>-01` (flag "sampled"). */
export function newTraceContext(random: (size: number) => Buffer = randomBytes): TraceContext {
  const traceId = random(16).toString('hex');
  const parentId = random(8).toString('hex');
  return { traceId, traceparent: `00-${traceId}-${parentId}-01` };
}

/** URL de consulta: `{traceId}` no modelo é trocado pelo id (ex.: `https://tempo/api/traces/{traceId}`). */
export function traceQueryUrl(template: string, traceId: string): string {
  return template.includes('{traceId}')
    ? template.replace('{traceId}', traceId)
    : `${template.replace(/\/$/, '')}/api/traces/${traceId}`;
}

/** Resposta do Tempo com pelo menos um span (formatos OTLP `batches` ou `resourceSpans`). */
export function hasSpans(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as { batches?: unknown; resourceSpans?: unknown };
  const list = Array.isArray(record.batches) ? record.batches : record.resourceSpans;
  return Array.isArray(list) && list.length > 0;
}

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly fetchJson: (url: string) => Promise<{ status: number; body: unknown }>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Consulta até achar o trace ou estourar o tempo (os spans chegam ao backend com atraso). */
export async function waitForTrace(url: string, options: PollOptions): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    try {
      const response = await options.fetchJson(url);
      if (response.status === 200 && hasSpans(response.body)) return true;
    } catch {
      // Backend ainda indexando ou indisponível: tenta de novo até o prazo.
    }
    if (now() >= deadline) return false;
    await sleep(options.intervalMs);
  }
}
