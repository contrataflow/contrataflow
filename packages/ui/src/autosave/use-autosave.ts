'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { AutosaveQueue } from './autosave-queue.js';
import type {
  AutosaveFailure,
  AutosaveQueueOptions,
  AutosaveResolution,
  AutosaveSnapshot,
} from './autosave-queue.js';

/*
 * `useAutosave` (US-015 · DEC-182 · RN-DFD-23): o hook genérico de autosave — não conhece o tipo
 * de documento. Recebe `save(alvo, valor, { resolution })` (que já lê o `If-Match` do alvo), a
 * classificação dos erros da API e, opcionalmente, a contingência local; devolve `change`,
 * `flush`, as resoluções de conflito e o estado para o `AutosaveIndicator`. Liga sozinho a volta
 * da conexão (`online` → reenvio), o `Ctrl+S` ("salvar agora") e o aviso do `beforeunload` com
 * pendência. Uso (DFD, ETP, TR, documentos livres):
 *
 * ```tsx
 * const autosave = useAutosave<SectionValue>({
 *   save: (target, value, { resolution }) => saveSection(target, value, resolution),
 *   classify: classifyApiError,
 *   local: localPortFor(scope),
 *   onConflict: (target, failure) => openConflictDialog(target, failure),
 * });
 * <textarea onChange={(e) => autosave.change('SECTION:JUSTIFICATION', e.target.value)}
 *           onBlur={() => void autosave.flush('SECTION:JUSTIFICATION')} />
 * <AutosaveIndicator snapshot={autosave.snapshot} />
 * ```
 */

export interface UseAutosaveOptions<V> extends Omit<AutosaveQueueOptions<V>, 'save'> {
  readonly save: AutosaveQueueOptions<V>['save'];
  /** `false` (modo leitura): o hook não grava nem liga os atalhos. */
  readonly enabled?: boolean;
}

export interface UseAutosaveResult<V> {
  readonly snapshot: AutosaveSnapshot;
  readonly change: (target: string, value: V) => void;
  readonly flush: (target?: string) => Promise<void>;
  readonly keepMine: (target: string) => Promise<void>;
  readonly discard: (target: string) => Promise<void>;
  readonly hasPending: () => boolean;
}

export function useAutosave<V>(options: UseAutosaveOptions<V>): UseAutosaveResult<V> {
  // As funções mais recentes sem recriar a fila (o estado dela sobrevive às renderizações).
  const latest = useRef(options);
  latest.current = options;
  const [queue] = useState(
    () =>
      new AutosaveQueue<V>({
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
        ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
        save: (target: string, value: V, context: { readonly resolution: AutosaveResolution }) =>
          latest.current.save(target, value, context),
        classify: (error: unknown): AutosaveFailure =>
          latest.current.classify?.(error) ?? { kind: 'offline' },
        local: {
          persist: (target: string, value: V) =>
            latest.current.local?.persist(target, value) ?? Promise.resolve(),
          remove: (target: string) => latest.current.local?.remove(target) ?? Promise.resolve(),
        },
        onConflict: (target: string, failure: AutosaveFailure) => {
          latest.current.onConflict?.(target, failure);
        },
        onBlocked: (failure: AutosaveFailure) => {
          latest.current.onBlocked?.(failure);
        },
        onSaved: (target: string) => {
          latest.current.onSaved?.(target);
        },
      }),
  );
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const enabled = options.enabled !== false;

  useEffect(() => {
    // A fila sobrevive à desmontagem simulada do StrictMode (monta → desmonta → monta): é a mesma
    // instância, então reativa na montagem e descarta de novo na desmontagem real.
    queue.resume();
    return () => {
      queue.dispose();
    };
  }, [queue]);

  useEffect(() => {
    if (!enabled) return;
    const online = () => {
      queue.retryNow();
    };
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void queue.flush();
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!queue.hasPending()) return;
      void queue.flush();
      // Ainda pendente: o navegador pede confirmação (RN-DFD-23 · fluxo principal 10).
      event.preventDefault();
    };
    window.addEventListener('online', online);
    window.addEventListener('keydown', keydown);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [enabled, queue]);

  return {
    snapshot,
    change: (target, value) => {
      if (enabled) queue.change(target, value);
    },
    flush: (target) => queue.flush(target),
    keepMine: (target) => queue.keepMine(target),
    discard: (target) => queue.discard(target),
    hasPending: () => queue.hasPending(),
  };
}
