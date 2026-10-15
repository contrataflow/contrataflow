import {
  DEFAULT_SESSION_POLICY,
  SESSION_END_REASONS,
  SESSION_ENDED_RETENTION_MS,
} from '@contrataflow/types';
import type { SessionEndReason, SessionKeyspace } from '@contrataflow/types';
import { z } from 'zod';

/*
 * Protocolo do Redis de sessões compartilhado por BFF, api (varredura) e worker (eventos de
 * vínculo) — US-088 · authentication.md §4/§7. O registro vivo guarda os tokens cifrados (só o BFF
 * os lê); o encerramento troca o registro vivo por um registro de encerramento SEM tokens, que a
 * varredura audita (`auth.session_end`/`auth.session_expired`) e então apaga (RN-IAM-28).
 *
 * Ordem do encerramento (sem script Lua — compatível com Redis em cluster): 1) registro de
 * encerramento `SET NX` (só um encerramento por sessão vence: auditoria única); 2) `DEL` do registro
 * vivo — o BFF grava a sessão com `SET XX`, então uma requisição em voo não ressuscita a sessão;
 * 3) saída dos índices; 4) prazo vencido no conjunto da varredura.
 */

/** Campos do registro vivo que não são segredo (os tokens ficam em `sealedTokens`, cifrados). */
export const sessionHeaderSchema = z.object({
  key: z.string().min(1),
  userId: z.string().min(1),
  displayName: z.string(),
  activeTenantId: z.string().nullable(),
  membershipId: z.string().nullable(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  idleExpiresAt: z.number(),
  absoluteExpiresAt: z.number(),
  /** Ociosidade da instituição ativa; ausente nas sessões criadas antes da US-088. */
  idleMinutes: z.number().int().positive().optional(),
});

export type SessionHeader = z.infer<typeof sessionHeaderSchema>;

/** Registro de encerramento (sem tokens), retido até a auditoria — no máximo 24 h. */
export const sessionTombstoneSchema = z.object({
  key: z.string().min(1),
  userId: z.string().min(1),
  displayName: z.string(),
  activeTenantId: z.string().nullable(),
  membershipId: z.string().nullable(),
  reason: z.enum(SESSION_END_REASONS),
  /** Horário real do fato (epoch ms): o limite atingido, não o da detecção (RN-IAM-24). */
  occurredAt: z.number(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  idleMinutes: z.number(),
  /** Cliente da requisição que encerrou (logout, expiração detectada); nulo na varredura. */
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});

export type SessionTombstone = z.infer<typeof sessionTombstoneSchema>;

function parseJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Registro vivo ilegível (JSON inválido, campo faltando) → `null`. */
export function parseSessionHeader(raw: string | null): SessionHeader | null {
  return parseJson(raw, sessionHeaderSchema);
}

export function parseSessionTombstone(raw: string | null): SessionTombstone | null {
  return parseJson(raw, sessionTombstoneSchema);
}

/** Próximo limite da sessão (ociosidade ou absoluto) — pontuação no conjunto da varredura. */
export function sessionDeadline(
  header: Pick<SessionHeader, 'idleExpiresAt' | 'absoluteExpiresAt'>,
): number {
  return Math.min(header.idleExpiresAt, header.absoluteExpiresAt);
}

/**
 * Limite atingido em `now`, com o horário do fato (RN-IAM-24): o primeiro a vencer. Ociosidade
 * que coincide com o fim absoluto (atividade nos últimos minutos) conta como `ABSOLUTE` — a
 * duração absoluta nunca é prorrogada (RN-IAM-22).
 */
export function sessionExpiry(
  header: Pick<SessionHeader, 'idleExpiresAt' | 'absoluteExpiresAt'>,
  now: number,
): { readonly reason: 'IDLE' | 'ABSOLUTE'; readonly occurredAt: number } | null {
  const { idleExpiresAt, absoluteExpiresAt } = header;
  if (idleExpiresAt < absoluteExpiresAt && now >= idleExpiresAt) {
    return { reason: 'IDLE', occurredAt: idleExpiresAt };
  }
  if (now >= absoluteExpiresAt) return { reason: 'ABSOLUTE', occurredAt: absoluteExpiresAt };
  return null;
}

/** Subconjunto de comandos do encerramento (ioredis em produção; em memória nos testes). */
export interface SessionEndRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
}

export interface EndSessionInput {
  readonly header: SessionHeader;
  readonly reason: SessionEndReason;
  /** Horário real do fato (epoch ms). */
  readonly occurredAt: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Encerra a sessão: apaga tokens e índices e deixa o registro de encerramento para a varredura.
 * Devolve `true` só para quem de fato encerrou (concorrentes recebem `false`, sem segunda
 * auditoria — logout repetido, expiração detectada por duas réplicas, evento reentregue).
 */
export async function endSession(
  redis: SessionEndRedis,
  keys: SessionKeyspace,
  input: EndSessionInput,
): Promise<boolean> {
  const { header } = input;
  const tombstone: SessionTombstone = {
    key: header.key,
    userId: header.userId,
    displayName: header.displayName,
    activeTenantId: header.activeTenantId,
    membershipId: header.membershipId,
    reason: input.reason,
    occurredAt: input.occurredAt,
    createdAt: header.createdAt,
    lastSeenAt: header.lastSeenAt,
    idleMinutes: header.idleMinutes ?? DEFAULT_SESSION_POLICY.idleMinutes,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
  const created = await redis.set(
    keys.ended(header.key),
    JSON.stringify(tombstone),
    'PX',
    SESSION_ENDED_RETENTION_MS,
    'NX',
  );
  await redis.del(keys.record(header.key));
  await redis.zrem(keys.user(header.userId), header.key);
  if (header.membershipId) await redis.srem(keys.membership(header.membershipId), header.key);
  if (created === null) return false;
  await redis.zadd(keys.expiry, input.occurredAt, header.key);
  return true;
}
