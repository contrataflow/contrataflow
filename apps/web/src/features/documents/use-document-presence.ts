'use client';

import { PRESENCE_HEARTBEAT_INTERVAL_MS } from '@contrataflow/validation';
import type { DocumentPresenceEditorDto } from '@contrataflow/validation';
import { useEffect, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';

import { leaveDocumentPresence, sendPresenceHeartbeat } from './document-presence.api';

/*
 * `useDocumentPresence` (US-070 · RN-DOC-88..92): heartbeat do DOC-24 a cada 20 s enquanto o editor
 * está em foco (aba visível e janela focada) — o primeiro sai ao abrir/voltar o foco; a seção em
 * foco vai no próximo heartbeat. Ao fechar o editor (desmontar) ou a aba (`pagehide`), DOC-25 de
 * melhor esforço. Sem permissão de edição o hook não envia nada (FA-02). Respostas:
 * - 200 → `editors` (os demais; Redis fora do ar = `[]`, o indicador some — RN-DOC-92);
 * - 422 `SECTION_NOT_IN_TEMPLATE` → silencioso (a API manteve a seção anterior);
 * - 403/404/409/422 → para de enviar e oculta o indicador (documento não editável ou invisível);
 * - falha de rede → oculta o indicador e tenta no próximo ciclo.
 * Nunca bloqueia a digitação: tudo assíncrono, sem estado de carregamento.
 */

export interface UseDocumentPresenceOptions {
  readonly documentId: string;
  /** Seção em foco no editor. */
  readonly sectionKey: string | undefined;
  /** Permissão de edição (sem ela não há heartbeat). */
  readonly enabled: boolean;
}

const EMPTY: readonly DocumentPresenceEditorDto[] = [];

function isFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useDocumentPresence({
  documentId,
  sectionKey,
  enabled,
}: UseDocumentPresenceOptions): readonly DocumentPresenceEditorDto[] {
  const [editors, setEditors] = useState<readonly DocumentPresenceEditorDto[]>(EMPTY);
  // Recusa definitiva (409/404…) para este documento: não insiste até mudar o documento ou a permissão.
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const section = useRef(sectionKey);
  useEffect(() => {
    section.current = sectionKey;
  }, [sectionKey]);

  const scope = `${documentId}:${String(enabled)}`;
  const refused = refusedFor === scope;

  useEffect(() => {
    if (!enabled || refused) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending: AbortController | null = null;
    let disposed = false;
    let joined = false;

    const beat = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      joined = true;
      try {
        const list = await sendPresenceHeartbeat(documentId, section.current, controller.signal);
        if (!disposed && !controller.signal.aborted) setEditors(list);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        if (isApiError(error) && error.code === 'SECTION_NOT_IN_TEMPLATE') return;
        setEditors(EMPTY);
        if (isApiError(error) && [403, 404, 409, 422].includes(error.status)) {
          setRefusedFor(scope);
        }
      }
    };
    const start = () => {
      if (timer !== undefined) return;
      void beat();
      timer = setInterval(() => void beat(), PRESENCE_HEARTBEAT_INTERVAL_MS);
    };
    const pause = () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };
    const sync = () => {
      if (isFocused()) start();
      else pause();
    };
    const leave = () => {
      if (joined) leaveDocumentPresence(documentId);
      joined = false;
    };

    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', leave);
    return () => {
      disposed = true;
      pause();
      pending?.abort();
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [documentId, enabled, refused, scope]);

  return enabled && !refused ? editors : EMPTY;
}
