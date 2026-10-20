'use client';

import { useFormatter } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { MEMBERSHIP_INACTIVE_HREF, loginHref } from '@/lib/api/error-policy';
import { extendSession, fetchSessionState } from '@/lib/session/session-actions';
import type { SessionState } from '@/lib/session/session-actions';
import { publishSessionEvent, subscribeSessionEvents } from '@/lib/session/session-channel';
import { useShellSession } from '@/lib/session/session-context';
import { onSessionSignal } from '@/lib/session/session-signals';
import { afterActivity, deadlinesFrom, sessionPhase } from '@/lib/session/watcher';
import type { SessionDeadlines } from '@/lib/session/watcher';

import { IdleWarningDialog } from './idle-warning-dialog';
import { useLogout } from './logout-guard';
import { SessionExpiredModal } from './session-expired-modal';
import { AbsoluteEndNotice, UnavailableBanner } from './session-notices';

/** Intervalo mínimo entre consultas ao BFF quando ele não responde. */
const UNAVAILABLE_RETRY_MS = 30_000;

/**
 * `SessionWatcher` (US-088 · RN-IAM-21..23/29/33): contador local da sessão alimentado por
 * `GET /api/auth/session` (sondagem, sem renovar), reiniciado a cada ação do usuário atendida pela
 * API (FA-02). Antes de avisar ou de declarar a expiração, confere o BFF — outra aba pode ter
 * mantido a sessão viva. Mostra o diálogo de ociosidade, o aviso de fim absoluto, o modal "Sua
 * sessão expirou" (também quando a API responde 401 `SESSION_EXPIRED` ou outra aba avisa) e o
 * banner de indisponibilidade (503 — nunca "sessão expirada").
 */
export function SessionWatcher({
  onNavigate,
  tickMs = 1_000,
}: {
  readonly onNavigate?: ((href: string) => void) | undefined;
  readonly tickMs?: number | undefined;
}) {
  const session = useShellSession();
  const format = useFormatter();
  const { requestLogout } = useLogout();
  const [deadlines, setDeadlines] = useState<SessionDeadlines>(() => deadlinesFrom(session));
  const [now, setNow] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState(false);
  /** Prazo de ociosidade confirmado pelo BFF: o diálogo só abre depois da conferência. */
  const [confirmedIdle, setConfirmedIdle] = useState<number | null>(null);
  const deadlinesRef = useRef(deadlines);
  useEffect(() => {
    deadlinesRef.current = deadlines;
  }, [deadlines]);
  const checking = useRef(false);
  const lastCheck = useRef<{ deadline: number; at: number } | null>(null);

  const navigate = useCallback(
    (href: string) => {
      if (onNavigate) onNavigate(href);
      else window.location.assign(href);
    },
    [onNavigate],
  );

  const expiredRef = useRef(false);
  const markExpired = useCallback((broadcast: boolean) => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    // Detectada aqui: avisa as outras abas (RN-IAM-29); vinda de outra aba: não reenvia.
    if (broadcast) publishSessionEvent({ type: 'expired' });
    setExpired(true);
  }, []);

  /** Aplica a resposta do BFF ao contador e à tela. */
  const apply = useCallback(
    (state: SessionState) => {
      switch (state.kind) {
        case 'active': {
          const confirmed = deadlinesFrom(state.session);
          setUnavailable(false);
          setDeadlines(confirmed);
          setConfirmedIdle(confirmed.idleExpiresAt);
          return;
        }
        case 'expired':
          markExpired(true);
          return;
        case 'no-session':
          navigate(loginHref(`${window.location.pathname}${window.location.search}`));
          return;
        case 'membership-inactive':
          navigate(MEMBERSHIP_INACTIVE_HREF);
          return;
        case 'unavailable':
          // Sem como conferir: vale o contador local (o aviso aparece mesmo assim).
          setUnavailable(true);
          setConfirmedIdle(deadlinesRef.current.idleExpiresAt);
      }
    },
    [markExpired, navigate],
  );

  const check = useCallback(
    async (load: () => Promise<SessionState>) => {
      if (checking.current) return;
      checking.current = true;
      setPending(true);
      try {
        apply(await load());
      } finally {
        checking.current = false;
        setPending(false);
      }
    },
    [apply],
  );

  // Relógio do contador.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      clearInterval(timer);
    };
  }, [tickMs]);

  // Sinais desta aba (cliente de API) e das outras abas (BroadcastChannel).
  useEffect(() => {
    const stopSignals = onSessionSignal((signal) => {
      if (signal.type === 'activity') {
        setUnavailable(false);
        setDeadlines((current) => afterActivity(current, Date.now()));
        setNow(Date.now());
      } else if (signal.type === 'expired') {
        markExpired(true);
      } else {
        setUnavailable(true);
      }
    });
    const stopChannel = subscribeSessionEvents((event) => {
      if (event.type === 'expired') markExpired(false);
      if (event.type === 'extended') {
        setDeadlines((current) => ({ ...current, idleExpiresAt: Date.parse(event.idleExpiresAt) }));
        setNow(Date.now());
      }
    });
    return () => {
      stopSignals();
      stopChannel();
    };
  }, [markExpired]);

  const phase = sessionPhase(deadlines, now);
  const deadline = Math.min(deadlines.idleExpiresAt, deadlines.absoluteExpiresAt);
  // Ao entrar na janela de aviso e ao vencer: confere o BFF (uma vez por prazo; com o BFF fora do
  // ar, no máximo a cada 30 s).
  const needsCheck = !expired && (phase.idleWarning || phase.expired);
  useEffect(() => {
    if (!needsCheck) return;
    const last = lastCheck.current;
    const stage = phase.expired ? -deadline : deadline;
    if (last?.deadline === stage && now - last.at < UNAVAILABLE_RETRY_MS) return;
    lastCheck.current = { deadline: stage, at: now };
    void check(() => fetchSessionState());
  }, [needsCheck, phase.expired, deadline, now, check]);

  const stay = () => {
    void check(async () => {
      const state = await extendSession();
      if (state.kind === 'active') {
        publishSessionEvent({ type: 'extended', idleExpiresAt: state.session.idleExpiresAt });
      }
      return state;
    });
  };

  const currentPath = () =>
    typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;

  return (
    <>
      <IdleWarningDialog
        open={!expired && phase.idleWarning && confirmedIdle === deadlines.idleExpiresAt}
        secondsLeft={phase.secondsLeft}
        pending={pending}
        onStay={stay}
        onLogout={requestLogout}
      />
      {!expired && phase.absoluteWarning ? (
        <AbsoluteEndNotice
          endsAt={format.dateTime(new Date(deadlines.absoluteExpiresAt), {
            hour: '2-digit',
            minute: '2-digit',
          })}
        />
      ) : null}
      {!expired && unavailable ? (
        <UnavailableBanner
          pending={pending}
          onRetry={() => {
            void check(() => fetchSessionState());
          }}
        />
      ) : null}
      <SessionExpiredModal
        open={expired}
        loginHref={loginHref(currentPath(), { reauthenticate: true })}
      />
    </>
  );
}
