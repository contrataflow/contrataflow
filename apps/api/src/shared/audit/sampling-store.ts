/**
 * Contadores da amostragem de `access.denied` (RN-AUD-07): Redis em `modules/platform` (único
 * lugar com cliente Redis — RM-03), em memória nos testes e no modo de identidade fake. Falha do
 * armazenamento → a auditoria grava tudo (sem amostragem), nunca deixa de gravar.
 */
export interface AuditSamplingKey {
  /** `null` = registro de plataforma. */
  readonly tenantId: string | null;
  /** Usuário (`u:<id>`) ou, se anônimo, IP (`ip:<ip>`). */
  readonly subject: string;
  readonly action: string;
}

export interface AuditSamplingDecision {
  /** `true`: grava; `false`: excedente da janela, acumulado para o próximo registro. */
  readonly record: boolean;
  /** Excedentes acumulados desde o último registro gravado (`metadata.suppressedCount`). */
  readonly suppressed: number;
}

export interface AuditSamplingStorePort {
  /** Conta a ocorrência na janela atual e decide (atômico por chave). */
  sample(
    key: AuditSamplingKey,
    windowSeconds: number,
    maxPerWindow: number,
  ): Promise<AuditSamplingDecision>;
}

export const AUDIT_SAMPLING_STORE = Symbol('AuditSamplingStorePort');

/** Por quanto tempo o excedente aguarda o próximo registro da mesma chave. */
export const SUPPRESSED_TTL_SECONDS = 7 * 24 * 3_600;

/** Implementação em memória (testes e identidade fake), com a mesma semântica do Redis. */
export class InMemoryAuditSamplingStore implements AuditSamplingStorePort {
  private readonly windows = new Map<string, { index: number; count: number }>();
  private readonly suppressed = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  sample(
    key: AuditSamplingKey,
    windowSeconds: number,
    maxPerWindow: number,
  ): Promise<AuditSamplingDecision> {
    const id = `${key.tenantId ?? 'platform'}|${key.subject}|${key.action}`;
    const index = Math.floor(this.now() / (windowSeconds * 1_000));
    const current = this.windows.get(id);
    const count = current?.index === index ? current.count + 1 : 1;
    this.windows.set(id, { index, count });
    if (count <= maxPerWindow) {
      const pending = this.suppressed.get(id) ?? 0;
      this.suppressed.delete(id);
      return Promise.resolve({ record: true, suppressed: pending });
    }
    this.suppressed.set(id, (this.suppressed.get(id) ?? 0) + 1);
    return Promise.resolve({ record: false, suppressed: 0 });
  }
}
