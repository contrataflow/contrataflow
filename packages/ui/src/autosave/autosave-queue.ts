/*
 * Fila de autosave por alvo (US-015 · DEC-182 · RN-DFD-23): o núcleo do `useAutosave`, sem React e
 * sem conhecer o tipo de documento. Cada alvo (uma seção, o cabeçalho, os itens) tem no máximo UMA
 * gravação em voo; alterações feitas durante o voo esperam e seguem com a revisão nova. Gatilhos:
 * 1,5 s depois da última alteração (`debounceMs`), `flush()` (perda de foco, troca de passo,
 * `Ctrl+S`, saída da página) e a volta da conexão (`retryNow()`). Falhas (FA-01..09):
 *
 * | Falha          | Comportamento                                                           |
 * |----------------|-------------------------------------------------------------------------|
 * | `conflict`     | pausa SÓ o alvo e avisa (`onConflict`); os demais continuam salvando    |
 * | `offline`      | guarda a pendência e retenta com backoff 2, 4, 8, 16 e 30 s (máx. 30 s) |
 * | `rateLimited`  | espera o `Retry-After` e coalesce o acumulado numa gravação             |
 * | `invalid`      | "Erro ao salvar" com a explicação; volta a salvar na próxima alteração  |
 * | `blocked`      | para TODO o autosave (documento não editável, sem custódia, processo…)  |
 * | `sessionExpired` | para tudo; a pendência local fica para depois do login               |
 *
 * A pendência é entregue ao armazenamento local (`local.persist`) antes de cada envio e removida
 * depois da gravação confirmada (RN-DFD-33): só o que ainda não chegou ao servidor fica no
 * navegador.
 */

export type AutosaveFailure =
  | { readonly kind: 'conflict'; readonly current?: unknown }
  | { readonly kind: 'offline' }
  | { readonly kind: 'rateLimited'; readonly retryAfterMs: number }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly detail?: unknown }
  | { readonly kind: 'sessionExpired' };

/** Erro que a função `save` lança já classificado (dispensa o `classify`). */
export class AutosaveError extends Error {
  constructor(readonly failure: AutosaveFailure) {
    super(`Autosave: ${failure.kind}`);
    this.name = 'AutosaveError';
  }
}

export type AutosavePhase =
  'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict' | 'blocked';

export interface AutosaveTargetState {
  readonly phase: AutosavePhase;
  /** Última gravação confirmada (ms). */
  readonly savedAt: number | null;
  readonly message: string | null;
  /** Há alteração ainda não confirmada pelo servidor. */
  readonly hasPending: boolean;
  readonly failure: AutosaveFailure | null;
}

export interface AutosaveSnapshot {
  /** Estado agregado do indicador (o pior entre os alvos). */
  readonly status: AutosavePhase;
  readonly savedAt: number | null;
  readonly message: string | null;
  readonly hasPending: boolean;
  readonly blocked: AutosaveFailure | null;
  readonly targets: Readonly<Record<string, AutosaveTargetState>>;
}

/** Como o conflito foi resolvido pela pessoa (RN-DFD-29). */
export type AutosaveResolution = 'keepMine' | null;

export interface AutosaveLocalPort<V> {
  /** Guarda a pendência (cifrada) antes do envio. */
  persist(target: string, value: V): Promise<void>;
  /** Apaga a pendência depois da gravação confirmada ou do descarte. */
  remove(target: string): Promise<void>;
}

export interface AutosaveQueueOptions<V> {
  /** Grava o valor no servidor (lança `AutosaveError` ou um erro que `classify` entende). */
  readonly save: (
    target: string,
    value: V,
    context: { readonly resolution: AutosaveResolution },
  ) => Promise<void>;
  /** Traduz um erro desconhecido (padrão: `offline`). */
  readonly classify?: (error: unknown) => AutosaveFailure;
  readonly local?: AutosaveLocalPort<V> | undefined;
  readonly debounceMs?: number;
  readonly backoffMs?: readonly number[];
  readonly now?: () => number;
  readonly onConflict?: (target: string, failure: AutosaveFailure) => void;
  readonly onBlocked?: (failure: AutosaveFailure) => void;
  readonly onSaved?: (target: string) => void;
}

/** DEC-182: 1,5 s de pausa na digitação. */
export const DEFAULT_DEBOUNCE_MS = 1500;
/** FA-03: 2, 4, 8, 16 e 30 s (máximo 30 s). */
export const DEFAULT_BACKOFF_MS: readonly number[] = [2000, 4000, 8000, 16_000, 30_000];

interface TargetRecord<V> {
  pending: { value: V } | null;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  paused: boolean;
  savedAt: number | null;
  failure: AutosaveFailure | null;
  rateLimited: boolean;
}

/** Prioridade do estado agregado: o mais grave vence. */
const SEVERITY: readonly AutosavePhase[] = [
  'blocked',
  'conflict',
  'error',
  'offline',
  'saving',
  'dirty',
  'saved',
  'idle',
];

const failureMessage = (failure: AutosaveFailure | null): string | null =>
  failure?.kind === 'invalid' ? failure.message : null;

export class AutosaveQueue<V> {
  private readonly records = new Map<string, TargetRecord<V>>();
  private readonly listeners = new Set<() => void>();
  private blocked: AutosaveFailure | null = null;
  private snapshot: AutosaveSnapshot;
  private disposed = false;
  private readonly debounceMs: number;
  private readonly backoffMs: readonly number[];
  private readonly now: () => number;

  constructor(private readonly options: AutosaveQueueOptions<V>) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.snapshot = this.compute();
  }

  // --- Leitura (useSyncExternalStore) ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AutosaveSnapshot => this.snapshot;

  // --- Comandos -------------------------------------------------------------------------------

  /** A pessoa alterou o alvo: marca "Alterações não salvas" e agenda a gravação (debounce). */
  change(target: string, value: V): void {
    if (this.disposed) return;
    const record = this.record(target);
    record.pending = { value };
    if (record.failure?.kind === 'invalid') record.failure = null;
    if (this.blocked === null && !record.paused) {
      this.clearTimer(record);
      record.timer = setTimeout(() => {
        record.timer = null;
        void this.run(target);
      }, this.debounceMs);
    }
    this.emit();
  }

  /**
   * Grava já o que estiver pendente (um alvo ou todos) e espera as gravações em voo — perda de
   * foco, troca de passo, `Ctrl+S` e saída da página.
   */
  async flush(target?: string): Promise<void> {
    const targets = target === undefined ? [...this.records.keys()] : [target];
    await Promise.all(
      targets.map(async (key) => {
        const record = this.records.get(key);
        if (record === undefined) return;
        this.clearTimer(record);
        if (record.inFlight !== null) await record.inFlight;
        await this.run(key);
      }),
    );
  }

  /** A conexão voltou (`online`): reenvia já as pendências em espera de backoff. */
  retryNow(): void {
    for (const [target, record] of this.records) {
      if (record.pending === null || record.paused || record.inFlight !== null) continue;
      if (record.retryTimer !== null) clearTimeout(record.retryTimer);
      record.retryTimer = null;
      void this.run(target);
    }
  }

  /** "Manter a minha versão" (FA-01): reenvia a pendência do alvo pausado sobre a revisão atual. */
  async keepMine(target: string): Promise<void> {
    const record = this.records.get(target);
    if (record === undefined) return;
    record.paused = false;
    record.failure = null;
    this.emit();
    await this.run(target, 'keepMine');
  }

  /** "Descartar a minha e recarregar" (FA-01): esquece a pendência sem chamar o servidor. */
  async discard(target: string): Promise<void> {
    const record = this.records.get(target);
    if (record === undefined) return;
    this.clearTimer(record);
    record.pending = null;
    record.paused = false;
    record.failure = null;
    this.emit();
    await this.options.local?.remove(target).catch(() => undefined);
  }

  /** Há alteração ainda não confirmada (aviso do `beforeunload`). */
  hasPending(): boolean {
    return [...this.records.values()].some(
      (record) => record.pending !== null || record.inFlight !== null,
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const record of this.records.values()) {
      this.clearTimer(record);
      if (record.retryTimer !== null) clearTimeout(record.retryTimer);
    }
    this.listeners.clear();
  }

  // --- Execução --------------------------------------------------------------------------------

  private record(target: string): TargetRecord<V> {
    let record = this.records.get(target);
    if (record === undefined) {
      record = {
        pending: null,
        inFlight: null,
        timer: null,
        retryTimer: null,
        attempt: 0,
        paused: false,
        savedAt: null,
        failure: null,
        rateLimited: false,
      };
      this.records.set(target, record);
    }
    return record;
  }

  private clearTimer(record: TargetRecord<V>): void {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
  }

  private run(target: string, resolution: AutosaveResolution = null): Promise<void> {
    const record = this.record(target);
    if (this.disposed || this.blocked !== null) return Promise.resolve();
    if (record.paused || record.pending === null) return record.inFlight ?? Promise.resolve();
    if (record.inFlight !== null) return record.inFlight;
    if (record.retryTimer !== null) clearTimeout(record.retryTimer);
    record.retryTimer = null;
    const { value } = record.pending;
    record.pending = null;
    const flight = this.send(target, record, value, resolution);
    record.inFlight = flight;
    this.emit();
    return flight;
  }

  private async send(
    target: string,
    record: TargetRecord<V>,
    value: V,
    resolution: AutosaveResolution,
  ): Promise<void> {
    try {
      await this.options.local?.persist(target, value).catch(() => undefined);
      await this.options.save(target, value, { resolution });
      record.attempt = 0;
      record.failure = null;
      record.rateLimited = false;
      record.savedAt = this.now();
      if (record.pending === null) await this.options.local?.remove(target).catch(() => undefined);
      this.options.onSaved?.(target);
    } catch (error) {
      this.fail(target, record, value, this.classify(error));
    } finally {
      record.inFlight = null;
      this.emit();
    }
    // Alteração feita durante o voo: segue já, com a revisão nova (se a pessoa parou de digitar).
    if (
      record.failure === null &&
      record.pending !== null &&
      record.timer === null &&
      record.retryTimer === null
    ) {
      void this.run(target);
    }
  }

  private classify(error: unknown): AutosaveFailure {
    if (error instanceof AutosaveError) return error.failure;
    return this.options.classify?.(error) ?? { kind: 'offline' };
  }

  private fail(target: string, record: TargetRecord<V>, value: V, failure: AutosaveFailure): void {
    // A alteração mais nova (feita durante o voo) vence a que falhou.
    record.pending ??= { value };
    record.failure = failure;
    record.rateLimited = false;
    switch (failure.kind) {
      case 'conflict':
        record.paused = true;
        this.options.onConflict?.(target, failure);
        return;
      case 'offline': {
        const delay = this.backoffMs[Math.min(record.attempt, this.backoffMs.length - 1)] ?? 30_000;
        record.attempt += 1;
        this.retryIn(target, record, delay);
        return;
      }
      case 'rateLimited':
        record.rateLimited = true;
        this.retryIn(target, record, failure.retryAfterMs);
        return;
      case 'invalid':
        return;
      case 'blocked':
      case 'sessionExpired':
        this.blocked = failure;
        for (const other of this.records.values()) {
          this.clearTimer(other);
          if (other.retryTimer !== null) clearTimeout(other.retryTimer);
          other.retryTimer = null;
        }
        this.options.onBlocked?.(failure);
        return;
    }
  }

  private retryIn(target: string, record: TargetRecord<V>, delay: number): void {
    if (record.retryTimer !== null) clearTimeout(record.retryTimer);
    record.retryTimer = setTimeout(() => {
      record.retryTimer = null;
      void this.run(target);
    }, delay);
  }

  // --- Estado ----------------------------------------------------------------------------------

  private phaseOf(record: TargetRecord<V>): AutosavePhase {
    if (this.blocked !== null) return 'blocked';
    if (record.paused) return 'conflict';
    if (record.failure?.kind === 'invalid') return 'error';
    if (record.failure?.kind === 'offline') return 'offline';
    if (record.inFlight !== null || record.rateLimited) return 'saving';
    if (record.pending !== null) return 'dirty';
    return record.savedAt === null ? 'idle' : 'saved';
  }

  private compute(): AutosaveSnapshot {
    const targets: Record<string, AutosaveTargetState> = {};
    let status: AutosavePhase = 'idle';
    let savedAt: number | null = null;
    let message: string | null = null;
    for (const [target, record] of this.records) {
      const phase = this.phaseOf(record);
      targets[target] = {
        phase,
        savedAt: record.savedAt,
        message: failureMessage(record.failure),
        hasPending: record.pending !== null || record.inFlight !== null,
        failure: record.failure,
      };
      if (SEVERITY.indexOf(phase) < SEVERITY.indexOf(status)) {
        status = phase;
        message = failureMessage(record.failure);
      }
      if (record.savedAt !== null && (savedAt === null || record.savedAt > savedAt)) {
        savedAt = record.savedAt;
      }
    }
    if (this.blocked !== null) status = 'blocked';
    return {
      status,
      savedAt,
      message,
      hasPending: this.hasPending(),
      blocked: this.blocked,
      targets,
    };
  }

  private emit(): void {
    this.snapshot = this.compute();
    for (const listener of this.listeners) listener();
  }
}
