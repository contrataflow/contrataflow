import { sha256Hex } from './canonical-json.js';

/*
 * Selagem de integridade da trilha (US-074 · ADR-009 · RN-AUD-11..16). Um selo cobre uma hora
 * cheia UTC de um tenant: `digest` = SHA-256 (hex) da concatenação dos `rowHash` (hex) do período,
 * na ordem `(occurredAt, id)`; `chainHash` = SHA-256 (hex) da concatenação do `chainHash` anterior
 * (64 zeros no primeiro selo do tenant) com o `digest`. O worker (`AuditSealer`, apps/worker) grava
 * pela mesma definição — os vetores fixos de `audit-seal.spec.ts` valem para os dois lados.
 */

/** `chainHash` "anterior" do primeiro selo do tenant (RN-AUD-11). */
export const GENESIS_CHAIN_HASH = '0'.repeat(64);

export const SEAL_PERIOD_MS = 3_600_000;

export interface SealPeriod {
  readonly start: Date;
  /** Último milissegundo da hora (`14:59:59.999`). */
  readonly end: Date;
}

/** A hora cheia UTC que contém `at`. */
export function sealPeriodOf(at: Date): SealPeriod {
  const start = Math.floor(at.getTime() / SEAL_PERIOD_MS) * SEAL_PERIOD_MS;
  return { start: new Date(start), end: new Date(start + SEAL_PERIOD_MS - 1) };
}

/** `digest` do período a partir dos `rowHash` já ordenados por `(occurredAt, id)`. */
export function periodDigest(rowHashes: readonly string[]): string {
  return sha256Hex(rowHashes.join(''));
}

export function chainHashOf(previousChainHash: string, digest: string): string {
  return sha256Hex(previousChainHash + digest);
}

/** Registro do período como entra no selo (ordenado por `(occurredAt, id)`). */
export interface SealableRecord {
  readonly id: string;
  readonly rowHash: string;
}

/** `AuditSeal` (entities.md §4 `audit_seals`), imutável. */
export interface AuditSeal {
  readonly id: string;
  readonly tenantId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly firstAuditId: string;
  readonly lastAuditId: string;
  readonly recordCount: number;
  readonly digest: string;
  readonly previousSealId: string | null;
  readonly chainHash: string;
  readonly sealedAt: Date;
}

export interface CreateSealInput {
  readonly id: string;
  readonly tenantId: string;
  readonly period: SealPeriod;
  /** Último selo do tenant (o mais recente), ou `null` no primeiro. */
  readonly previous: Pick<AuditSeal, 'id' | 'chainHash'> | null;
  readonly records: readonly SealableRecord[];
  readonly sealedAt: Date;
}

export const AuditSeal = {
  /**
   * Fábrica de RN-AUD-11/12: sem registros no período não há selo (`null`) — o próximo selo não
   * vazio encadeia no último existente.
   */
  create(input: CreateSealInput): AuditSeal | null {
    const first = input.records[0];
    const last = input.records.at(-1);
    if (first === undefined || last === undefined) return null;
    const digest = periodDigest(input.records.map((record) => record.rowHash));
    return {
      id: input.id,
      tenantId: input.tenantId,
      periodStart: input.period.start,
      periodEnd: input.period.end,
      firstAuditId: first.id,
      lastAuditId: last.id,
      recordCount: input.records.length,
      digest,
      previousSealId: input.previous?.id ?? null,
      chainHash: chainHashOf(input.previous?.chainHash ?? GENESIS_CHAIN_HASH, digest),
      sealedAt: input.sealedAt,
    };
  },
};

export type SealBreak = 'digest' | 'chain';

export interface SealCheck {
  readonly seal: AuditSeal;
  /** Registros ATUAIS do período, com o `rowHash` recalculado do conteúdo, em ordem. */
  readonly records: readonly SealableRecord[];
}

export interface SealVerificationResult {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** Registros encontrados agora no período. */
  readonly recordCount: number;
  readonly status: 'VALID' | 'INVALID';
  readonly brokenAt?: SealBreak;
}

export interface SealChainVerification {
  /** Primeira quebra (RN-AUD-16); `null` = intervalo íntegro. */
  readonly brokenAtPeriodStart: Date | null;
  readonly results: readonly SealVerificationResult[];
}

function digestHolds(check: SealCheck): boolean {
  const { seal, records } = check;
  return (
    records.length === seal.recordCount &&
    records[0]?.id === seal.firstAuditId &&
    records.at(-1)?.id === seal.lastAuditId &&
    periodDigest(records.map((record) => record.rowHash)) === seal.digest
  );
}

/** O selo aponta para o seu antecessor real e o `chainHash` fecha com ele (RN-AUD-15). */
function chainHolds(seal: AuditSeal, predecessor: AuditSeal | null): boolean {
  return (
    seal.previousSealId === (predecessor?.id ?? null) &&
    seal.chainHash === chainHashOf(predecessor?.chainHash ?? GENESIS_CHAIN_HASH, seal.digest)
  );
}

export const SealChainVerifier = {
  /**
   * RN-AUD-15/16: avalia selo a selo, em ordem de período. `predecessor` é o selo do tenant
   * imediatamente anterior ao primeiro do intervalo (ou `null` se não houver). A quebra é:
   * - `digest` — os registros atuais do período não reproduzem o `digest` selado (linha alterada,
   *   removida ou inserida; inclui o `rowHash` recalculado do conteúdo);
   * - `chain` — o selo não aponta para o antecessor real (selo removido ou inserido) ou o
   *   `chainHash` não fecha com o antecessor (selo anterior ou o próprio alterado).
   * Cada selo é avaliado isoladamente; a cadeia é tida por comprometida desde a primeira quebra.
   */
  verify(predecessor: AuditSeal | null, checks: readonly SealCheck[]): SealChainVerification {
    const ordered = [...checks].sort(
      (left, right) => left.seal.periodStart.getTime() - right.seal.periodStart.getTime(),
    );
    let previous = predecessor;
    let brokenAtPeriodStart: Date | null = null;
    const results = ordered.map((check): SealVerificationResult => {
      const { seal } = check;
      const brokenAt: SealBreak | undefined = !digestHolds(check)
        ? 'digest'
        : chainHolds(seal, previous)
          ? undefined
          : 'chain';
      previous = seal;
      if (brokenAt !== undefined && brokenAtPeriodStart === null) {
        brokenAtPeriodStart = seal.periodStart;
      }
      return {
        periodStart: seal.periodStart,
        periodEnd: seal.periodEnd,
        recordCount: check.records.length,
        ...(brokenAt === undefined
          ? { status: 'VALID' as const }
          : { status: 'INVALID' as const, brokenAt }),
      };
    });
    return { brokenAtPeriodStart, results };
  },
};
