/*
 * Health checks (US-085 · RN-FND-79..81 · observability.md §6): `/health/live` (HLT-01) e
 * `/health/ready` (HLT-02) no formato `application/health+json` (rascunho IETF), comuns a api,
 * worker e web. O corpo é montado só a partir de campos e mensagens fixas (allowlist — V-01):
 * nunca host, stack, credencial ou dado de tenant; o detalhe do erro vai para o log.
 */

export type HealthStatus = 'pass' | 'warn' | 'fail';

/** Matriz de criticidade (observability.md §6.2): crítica → `fail` (503); degradável → `warn`. */
export type DependencyCriticality = 'critical' | 'degradable';

export const HEALTH_CONTENT_TYPE = 'application/health+json';

/** Únicas mensagens aceitas em `output` (RN-FND-80): códigos fechados, texto fixo em pt-BR. */
export const HEALTH_OUTPUTS = {
  unavailable: 'dependência indisponível',
  timeout: 'tempo de verificação esgotado',
  stale_cache: 'refresh falhou; usando dados em cache',
  not_loaded: 'dados ainda não carregados',
  event_loop_blocked: 'event loop travado',
} as const;

export type HealthOutputCode = keyof typeof HEALTH_OUTPUTS;

/** Campos permitidos em cada *check* (V-01: o teste de contrato confere esta lista). */
export const HEALTH_CHECK_FIELDS = [
  'status',
  'observedValue',
  'observedUnit',
  'output',
  'time',
] as const;

/** Campos permitidos no corpo (V-01). */
export const HEALTH_RESPONSE_FIELDS = [
  'status',
  'serviceId',
  'version',
  'releaseId',
  'checks',
] as const;

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly observedValue?: number;
  readonly observedUnit?: 'ms' | 's';
  readonly output?: (typeof HEALTH_OUTPUTS)[HealthOutputCode];
  readonly time: string;
}

export interface HealthResponse {
  readonly status: HealthStatus;
  readonly serviceId: string;
  readonly version: string;
  readonly releaseId?: string;
  readonly checks?: Readonly<Record<string, readonly HealthCheckResult[]>>;
}

/** Resultado devolvido pela verificação de uma dependência (ausente = `pass`). */
export interface DependencyProbeResult {
  readonly status?: HealthStatus;
  readonly observedValue?: number;
  readonly observedUnit?: 'ms' | 's';
  readonly output?: HealthOutputCode;
}

/** *Health indicator* de uma dependência (registrado pelo módulo de infraestrutura que a possui). */
export interface HealthCheck {
  /** Nome estável da dependência (`postgresql`, `redis-cache`…), parte da chave do *check*. */
  readonly name: string;
  /** Medida do *check* (`responseTime`, `connection`, `cacheAge`). */
  readonly measurement: 'responseTime' | 'connection' | 'cacheAge';
  readonly criticality: DependencyCriticality;
  /** Timeout desta verificação (padrão: 1 s PostgreSQL, 500 ms Redis — HEALTH_CHECK_TIMEOUT_MS). */
  readonly timeoutMs: number;
  /** Lança (ou devolve `fail`) quando a dependência está indisponível. */
  probe(): Promise<DependencyProbeResult | undefined>;
}

/** `<versão>+g<commit>` (APP_VERSION — US-079) → `version` e `releaseId`. */
export function splitVersion(appVersion: string): { version: string; releaseId?: string } {
  const [version = appVersion, build] = appVersion.split('+', 2);
  const releaseId = build?.replace(/^g/, '');
  return releaseId ? { version, releaseId } : { version };
}

/** Pior estado entre os *checks* (`fail` > `warn` > `pass`). */
export function aggregateStatus(statuses: Iterable<HealthStatus>): HealthStatus {
  let result: HealthStatus = 'pass';
  for (const status of statuses) {
    if (status === 'fail') return 'fail';
    if (status === 'warn') result = 'warn';
  }
  return result;
}

/** HTTP do `health+json` (RN-FND-80): `pass`/`warn` → 200, `fail` → 503; nunca em cache HTTP. */
export function healthHttpResponse(response: HealthResponse): {
  statusCode: 200 | 503;
  headers: Readonly<Record<string, string>>;
  body: string;
} {
  return {
    statusCode: response.status === 'fail' ? 503 : 200,
    headers: { 'content-type': HEALTH_CONTENT_TYPE, 'cache-control': 'no-store' },
    body: JSON.stringify(response),
  };
}

class ProbeTimeoutError extends Error {
  constructor() {
    super('health probe timeout');
    this.name = 'ProbeTimeoutError';
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProbeTimeoutError());
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Tipo do erro para o log (nome da classe ou código do Node), nunca a mensagem (pode ter host). */
export function errorTypeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name.slice(0, 60) : 'unknown';
}

/** Logger das transições (pino ou o `Logger` do Nest adaptado): objeto de campos + mensagem. */
export interface HealthLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface ReadinessProbeOptions {
  /** `api`, `worker` ou `web`. */
  readonly serviceId: string;
  /** APP_VERSION (`<versão>+g<commit>`). */
  readonly appVersion: string;
  /** HEALTH_CACHE_TTL_MS (padrão 5 s — RN-FND-80). */
  readonly cacheTtlMs?: number;
  readonly checks?: readonly HealthCheck[];
  readonly logger?: HealthLogger;
  readonly now?: () => number;
}

interface Evaluated {
  readonly response: HealthResponse;
  readonly at: number;
}

/**
 * `/health/ready` (HLT-02): verifica as dependências registradas em paralelo, cada uma com timeout
 * curto; o resultado vale por `cacheTtlMs` no processo (FA-03) e chamadas simultâneas sem cache
 * compartilham a mesma verificação (*single-flight*). Transições de estado vão para o log:
 * `warn health.dependency_degraded`, `error health.dependency_critical_down`,
 * `info health.dependency_recovered` — só nome da dependência, motivo e tipo do erro.
 */
export class ReadinessProbe {
  private readonly checks: HealthCheck[] = [];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly lastStatus = new Map<string, HealthStatus>();
  private cached: Evaluated | null = null;
  private inflight: Promise<HealthResponse> | null = null;

  constructor(private readonly options: ReadinessProbeOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? 5_000;
    this.now = options.now ?? Date.now;
    for (const check of options.checks ?? []) this.register(check);
  }

  /** Registra o *health indicator* de uma dependência (nome único por processo). */
  register(check: HealthCheck): void {
    if (this.checks.some((existing) => existing.name === check.name)) {
      throw new Error(`Health check duplicado: ${check.name}`);
    }
    this.checks.push(check);
    this.cached = null;
  }

  get registered(): readonly string[] {
    return this.checks.map((check) => check.name);
  }

  check(): Promise<HealthResponse> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < this.cacheTtlMs) return Promise.resolve(cached.response);
    this.inflight ??= this.evaluate().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async evaluate(): Promise<HealthResponse> {
    const results = await Promise.all(this.checks.map((check) => this.run(check)));
    const checks: Record<string, HealthCheckResult[]> = {};
    for (const [index, check] of this.checks.entries()) {
      const result = results[index];
      if (result) checks[`${check.name}:${check.measurement}`] = [result];
    }
    const response: HealthResponse = {
      status: aggregateStatus(results.map((result) => result.status)),
      serviceId: this.options.serviceId,
      ...splitVersion(this.options.appVersion),
      checks,
    };
    this.cached = { response, at: this.now() };
    return response;
  }

  private async run(check: HealthCheck): Promise<HealthCheckResult> {
    const startedAt = performance.now();
    let probed: DependencyProbeResult;
    let failure: unknown = null;
    try {
      probed = (await withTimeout(check.probe(), check.timeoutMs)) ?? {};
    } catch (error) {
      failure = error;
      probed = {
        status: 'fail',
        output: error instanceof ProbeTimeoutError ? 'timeout' : 'unavailable',
      };
    }
    const reported = probed.status ?? 'pass';
    // Dependência degradável nunca derruba a readiness (FA-01 · RN-FND-81).
    const status: HealthStatus =
      reported === 'fail' && check.criticality === 'degradable' ? 'warn' : reported;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const observed =
      probed.observedValue !== undefined
        ? { observedValue: probed.observedValue, observedUnit: probed.observedUnit ?? 'ms' }
        : check.measurement === 'responseTime' && status === 'pass'
          ? { observedValue: elapsedMs, observedUnit: 'ms' as const }
          : {};
    const output = probed.output ?? (status === 'pass' ? undefined : 'unavailable');
    this.logTransition(check, status, output, failure);
    return {
      status,
      ...observed,
      ...(output ? { output: HEALTH_OUTPUTS[output] } : {}),
      time: new Date(this.now()).toISOString(),
    };
  }

  private logTransition(
    check: HealthCheck,
    status: HealthStatus,
    reason: HealthOutputCode | undefined,
    failure: unknown,
  ): void {
    const previous = this.lastStatus.get(check.name) ?? 'pass';
    this.lastStatus.set(check.name, status);
    const logger = this.options.logger;
    if (!logger || previous === status) return;
    const fields = {
      dependency: check.name,
      criticality: check.criticality,
      ...(reason ? { reason } : {}),
      ...(failure ? { errorType: errorTypeOf(failure) } : {}),
    };
    if (status === 'fail') {
      logger.error({ event: 'health.dependency_critical_down', ...fields }, 'dependency down');
    } else if (status === 'warn') {
      logger.warn({ event: 'health.dependency_degraded', ...fields }, 'dependency degraded');
    } else {
      logger.info({ event: 'health.dependency_recovered', ...fields }, 'dependency recovered');
    }
  }
}

/** Atraso máximo do *event loop* aceito pelo `/health/live` (RN-FND-79). */
export const MAX_EVENT_LOOP_DELAY_MS = 2_000;

export interface LivenessProbeOptions {
  readonly serviceId: string;
  readonly appVersion: string;
  readonly maxDelayMs?: number;
  /** Intervalo do temporizador que mede o atraso (padrão 500 ms). */
  readonly sampleIntervalMs?: number;
  readonly now?: () => number;
}

/**
 * `/health/live` (HLT-01): processo respondendo e *event loop* sem travamento (atraso < 2 s), sem
 * verificar nenhuma dependência. O atraso é o desvio de um temporizador `unref` — inclui o bloqueio
 * em curso, medido no momento da requisição.
 */
export class LivenessProbe {
  private readonly maxDelayMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: number;
  private lastDelayMs = 0;

  constructor(private readonly options: LivenessProbeOptions) {
    this.maxDelayMs = options.maxDelayMs ?? MAX_EVENT_LOOP_DELAY_MS;
    this.intervalMs = options.sampleIntervalMs ?? 500;
    this.now = options.now ?? Date.now;
    this.lastTickAt = this.now();
  }

  start(): this {
    if (this.timer) return this;
    this.lastTickAt = this.now();
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Registra uma amostra (o temporizador chama a cada intervalo). */
  tick(): void {
    const now = this.now();
    this.lastDelayMs = Math.max(0, now - this.lastTickAt - this.intervalMs);
    this.lastTickAt = now;
  }

  /** Maior atraso entre a última amostra e o bloqueio em curso (sem amostra há muito tempo). */
  delayMs(): number {
    if (!this.timer) return this.lastDelayMs;
    const pending = Math.max(0, this.now() - this.lastTickAt - this.intervalMs);
    return Math.max(this.lastDelayMs, pending);
  }

  check(): HealthResponse {
    const delay = Math.round(this.delayMs());
    const status: HealthStatus = delay < this.maxDelayMs ? 'pass' : 'fail';
    return {
      status,
      serviceId: this.options.serviceId,
      ...splitVersion(this.options.appVersion),
      checks: {
        'eventloop:delay': [
          {
            status,
            observedValue: delay,
            observedUnit: 'ms',
            ...(status === 'fail' ? { output: HEALTH_OUTPUTS.event_loop_blocked } : {}),
            time: new Date(this.now()).toISOString(),
          },
        ],
      },
    };
  }
}

/** Caminhos de saúde (fora de `/api/v1` — RN-FND-79). */
export const HEALTH_PATHS = { live: '/health/live', ready: '/health/ready' } as const;

interface NodeHealthRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
}

interface NodeHealthResponse {
  writeHead(statusCode: number, headers: Readonly<Record<string, string>>): unknown;
  end(body?: string): unknown;
}

/**
 * Handler Node/Express de `/health/live` e `/health/ready`: devolve `true` quando respondeu.
 * Fica fora do pipeline da aplicação (sem guards, sem log automático — FA-05 da US-084).
 */
export function healthRequestHandler(probes: {
  readonly live: Pick<LivenessProbe, 'check'>;
  readonly ready: Pick<ReadinessProbe, 'check'>;
}): (request: NodeHealthRequest, response: NodeHealthResponse) => boolean {
  const send = (response: NodeHealthResponse, health: HealthResponse) => {
    const http = healthHttpResponse(health);
    response.writeHead(http.statusCode, http.headers);
    response.end(http.body);
  };
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const path = (request.url ?? '').split('?', 1)[0];
    if (path === HEALTH_PATHS.live) {
      send(response, probes.live.check());
      return true;
    }
    if (path !== HEALTH_PATHS.ready) return false;
    probes.ready.check().then(
      (health) => {
        send(response, health);
      },
      () => {
        send(response, { status: 'fail', serviceId: 'unknown', version: 'unknown' });
      },
    );
    return true;
  };
}
