import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogsForTests, log } from '@/bff/logger';
import { startWebTelemetry } from '@/bff/telemetry';
import { register } from '@/instrumentation';

vi.mock('@/bff/telemetry', async (importOriginal) => {
  const original = await importOriginal<{ startWebTelemetry: typeof startWebTelemetry }>();
  return { startWebTelemetry: vi.fn(original.startWebTelemetry) };
});

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
  vi.unstubAllEnvs();
  vi.mocked(startWebTelemetry).mockClear();
});

describe('logger do BFF (RN-FND-71/73)', () => {
  it('emite JSON com os campos obrigatórios e o event como msg', () => {
    log('info', 'bff.proxy_request_completed', {
      correlationId: 'corr-0000001',
      method: 'GET',
      statusCode: 200,
    });
    const line = JSON.parse(logs.lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      service: 'web',
      event: 'bff.proxy_request_completed',
      msg: 'bff.proxy_request_completed',
      correlationId: 'corr-0000001',
      statusCode: 200,
    });
    expect(typeof line.env).toBe('string');
    expect(typeof line.version).toBe('string');
    expect(line.time).toMatch(/Z$/);
  });

  it('redige token, cookie e e-mail mesmo se um campo proibido for passado', () => {
    log('warn', 'auth.callback_rejected', {
      accessToken: 'segredo-token',
      cookie: '__Host-cf_session=segredo-cookie',
      email: 'ana.souza@orgao.gov.br',
      reason: 'STATE_MISMATCH',
    });
    const raw = logs.lines.join('\n');
    expect(raw).not.toMatch(/segredo-token|segredo-cookie|ana\.souza/);
    expect(JSON.parse(logs.lines.at(-1) ?? '{}')).toMatchObject({
      email: 'a***@orgao.gov.br',
      reason: 'STATE_MISMATCH',
    });
  });
});

describe('OpenTelemetry no web (RN-FND-75)', () => {
  it('sem endpoint, não sobe o SDK e avisa tracing.disabled', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    expect(startWebTelemetry()).toBeNull();
    expect(logs.lines.some((line) => line.includes('"tracing.disabled"'))).toBe(true);
  });

  it('com endpoint, sobe o SDK com as instrumentações HTTP e undici', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:1');
    const sdk = startWebTelemetry();
    expect(sdk).not.toBeNull();
    await sdk?.shutdown();
  });

  it('V-03: LOG_LEVEL=debug em produção impede a inicialização', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_LEVEL', 'debug');
    expect(() => startWebTelemetry()).toThrow(/LOG_LEVEL/);
  });

  it('instrumentation.ts só inicia o SDK no runtime Node', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(startWebTelemetry).not.toHaveBeenCalled();

    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    await register();
    expect(startWebTelemetry).toHaveBeenCalledOnce();
  });
});
