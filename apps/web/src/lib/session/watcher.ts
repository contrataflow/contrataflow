/*
 * Contador local da sessão no shell (US-088 · RN-IAM-21..23): função pura, sem relógio próprio —
 * o `SessionWatcher` a consulta a cada segundo. Aviso de ociosidade 2 min antes do prazo; aviso de
 * término absoluto 5 min antes; o prazo de ociosidade nunca passa do absoluto.
 */

export const IDLE_WARNING_MS = 2 * 60_000;
export const ABSOLUTE_WARNING_MS = 5 * 60_000;

export interface SessionDeadlines {
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly idleMinutes: number;
}

export interface SessionPhase {
  /** "Você continua aí?" (RN-IAM-23). */
  readonly idleWarning: boolean;
  /** Aviso não bloqueante do fim absoluto. */
  readonly absoluteWarning: boolean;
  /** Algum limite já passou (o BFF confirma na próxima chamada). */
  readonly expired: boolean;
  /** Segundos até o primeiro limite (contagem regressiva do diálogo). */
  readonly secondsLeft: number;
}

export function deadlinesFrom(session: {
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly idleMinutes: number;
}): SessionDeadlines {
  return {
    idleExpiresAt: Date.parse(session.idleExpiresAt),
    absoluteExpiresAt: Date.parse(session.absoluteExpiresAt),
    idleMinutes: session.idleMinutes,
  };
}

export function sessionPhase(deadlines: SessionDeadlines, now: number): SessionPhase {
  const end = Math.min(deadlines.idleExpiresAt, deadlines.absoluteExpiresAt);
  const expired = now >= end;
  return {
    // Quando o fim absoluto vem antes, só o aviso absoluto vale: não há o que prorrogar.
    idleWarning:
      !expired &&
      deadlines.idleExpiresAt < deadlines.absoluteExpiresAt &&
      now >= deadlines.idleExpiresAt - IDLE_WARNING_MS,
    absoluteWarning: !expired && now >= deadlines.absoluteExpiresAt - ABSOLUTE_WARNING_MS,
    expired,
    secondsLeft: Math.max(0, Math.ceil((end - now) / 1000)),
  };
}

/** Ação do usuário atendida: a ociosidade recomeça, sem passar do fim absoluto (FA-02). */
export function afterActivity(deadlines: SessionDeadlines, now: number): SessionDeadlines {
  return {
    ...deadlines,
    idleExpiresAt: Math.min(now + deadlines.idleMinutes * 60_000, deadlines.absoluteExpiresAt),
  };
}

/** `mm:ss` da contagem regressiva. */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
