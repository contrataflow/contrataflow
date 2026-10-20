'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { classifyExportError, countCsvRows } from './saved-views-model';
import type { ExportFailure } from './saved-views-model';
import { downloadProcessesCsv } from './saved-views.api';

/*
 * `useCsvDownload` (US-003): PRC-34 → `Blob` → download pelo navegador. Uma exportação por vez;
 * "Cancelar" aborta o fetch; a conexão que cai antes do fim (FA-08) chega como erro e nenhum
 * arquivo parcial é salvo. O nome vem do `Content-Disposition` (`processos-AAAAMMDD-HHmm.csv`).
 */

export const FALLBACK_CSV_NAME = 'processos.csv';

export type CsvDownloadState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly fileName: string; readonly rows: number }
  | { readonly status: 'error'; readonly failure: ExportFailure; readonly failedAt: number };

export interface CsvDownloadResult {
  readonly fileName: string;
  readonly rows: number;
}

/** Salva o arquivo: âncora temporária com `download` e URL de objeto liberada depois. */
export function saveBlob(blob: Blob, fileName: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}

export function useCsvDownload(options: { readonly onDone?: (result: CsvDownloadResult) => void }) {
  const [state, setState] = useState<CsvDownloadState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const onDone = useRef(options.onDone);
  useEffect(() => {
    onDone.current = options.onDone;
  });

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState((current) => (current.status === 'running' ? { status: 'idle' } : current));
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState({ status: 'idle' });
  }, []);

  // Fechar a tela durante a exportação cancela o fetch.
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const start = useCallback(async (query: Readonly<Record<string, string>>) => {
    if (controller.current !== null) return;
    const own = new AbortController();
    controller.current = own;
    setState({ status: 'running' });
    try {
      const file = await downloadProcessesCsv(query, own.signal);
      if (own.signal.aborted) return;
      const rows = countCsvRows(await file.blob.text());
      const fileName = file.fileName ?? FALLBACK_CSV_NAME;
      saveBlob(file.blob, fileName);
      controller.current = null;
      setState({ status: 'done', fileName, rows });
      onDone.current?.({ fileName, rows });
    } catch (error) {
      // Cancelado pelo usuário: sem erro (o fetch abortado pode virar 503 em `apiDownload`).
      if (own.signal.aborted) return;
      controller.current = null;
      setState({ status: 'error', failure: classifyExportError(error), failedAt: Date.now() });
    }
  }, []);

  return { state, start, cancel, reset };
}
