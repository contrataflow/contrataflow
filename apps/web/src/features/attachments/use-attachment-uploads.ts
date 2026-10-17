'use client';

import type { AttachmentReasonCode, AttachmentTargetType } from '@contrataflow/types';
import type { AttachmentDto } from '@contrataflow/validation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';

import {
  confirmAttachment,
  createAttachmentIntent,
  deleteAttachment,
  fetchAttachment,
  uploadToStorage,
} from './attachments.api';
import { checkLocalFile } from './upload-rules';

/*
 * Estado dos envios da tela (US-068 · fluxo principal 1–7): seleção → validação local → intenção →
 * PUT com progresso → confirmação → *polling* de ATT-04 (1 s a 15 s) até `AVAILABLE`, `INFECTED` ou
 * `REJECTED`. A lista completa do alvo (ATT-01) é da US-069; aqui ficam os anexos enviados nesta
 * sessão da tela. Erro de rede ou de URL vencida: "Enviar novamente" gera NOVA intenção (FA-02).
 */

export type UploadPhase =
  'uploading' | 'scanning' | 'available' | 'rejected' | 'failed' | 'deleted';

export interface UploadItem {
  readonly key: string;
  readonly file: File;
  readonly phase: UploadPhase;
  readonly progress: number;
  readonly attachment: AttachmentDto | null;
  /** Motivo resumido da rejeição (sem detalhe técnico). */
  readonly reasonCode: AttachmentReasonCode | null;
  /** Código da falha (API ou rede) para a mensagem. */
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
}

export interface AttachmentTarget {
  readonly targetType: AttachmentTargetType;
  readonly targetId: string;
}

export interface LocalRejection {
  readonly fileName: string;
  readonly reason: 'TYPE' | 'SIZE' | 'EMPTY';
}

const POLL_START_MS = 1_000;
const POLL_MAX_MS = 15_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface UploadDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly createRequest?: () => XMLHttpRequest;
}

function phaseOf(status: AttachmentDto['status']): UploadPhase {
  switch (status) {
    case 'AVAILABLE':
      return 'available';
    case 'INFECTED':
    case 'REJECTED':
      return 'rejected';
    case 'DELETED':
      return 'deleted';
    default:
      return 'scanning';
  }
}

export function useAttachmentUploads(target: AttachmentTarget, deps: UploadDeps = {}) {
  const [items, setItems] = useState<readonly UploadItem[]>([]);
  const [rejection, setRejection] = useState<LocalRejection | null>(null);
  const alive = useRef(true);
  const { createRequest, sleep = defaultSleep } = deps;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = useCallback((key: string, changes: Partial<UploadItem>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    );
  }, []);

  const poll = useCallback(
    async (key: string, attachmentId: string) => {
      const mounted = () => alive.current;
      let wait = POLL_START_MS;
      while (mounted()) {
        await sleep(wait);
        if (!mounted()) return;
        try {
          const attachment = await fetchAttachment(attachmentId);
          const phase = phaseOf(attachment.status);
          patch(key, { attachment, phase, reasonCode: attachment.reasonCode });
          if (phase !== 'scanning') return;
        } catch {
          // Falha momentânea da consulta: tenta de novo no próximo intervalo.
        }
        wait = Math.min(wait * 2, POLL_MAX_MS);
      }
    },
    [patch, sleep],
  );

  const send = useCallback(
    async (key: string, file: File, mimeType: string) => {
      try {
        const { attachment, upload } = await createAttachmentIntent(
          {
            targetType: target.targetType,
            targetId: target.targetId,
            fileName: file.name,
            declaredMimeType: mimeType,
            sizeBytes: file.size,
          },
          newIdempotencyKey(),
        );
        patch(key, { attachment });
        await uploadToStorage(
          upload,
          file,
          (progress) => {
            patch(key, { progress });
          },
          createRequest,
        );
        patch(key, { progress: 100, phase: 'scanning' });
        const confirmation = await confirmAttachment(attachment.id, newIdempotencyKey());
        if (confirmation.status === 'REJECTED' || confirmation.status === 'INFECTED') {
          patch(key, { phase: 'rejected', reasonCode: confirmation.reasonCode ?? null });
          return;
        }
        await poll(key, attachment.id);
      } catch (error) {
        patch(key, {
          phase: 'failed',
          errorCode: isApiError(error) ? error.code : 'NETWORK',
          errorDetail: isApiError(error) ? error.message : null,
        });
      }
    },
    [createRequest, patch, poll, target.targetId, target.targetType],
  );

  /** Seleção (input ou soltar): valida localmente e envia cada arquivo aceito. */
  const add = useCallback(
    (files: readonly File[]) => {
      setRejection(null);
      for (const file of files) {
        const check = checkLocalFile(file);
        if (!check.ok) {
          setRejection({ fileName: file.name, reason: check.reason });
          continue;
        }
        const key = newIdempotencyKey();
        setItems((current) => [
          ...current,
          {
            key,
            file,
            phase: 'uploading',
            progress: 0,
            attachment: null,
            reasonCode: null,
            errorCode: null,
            errorDetail: null,
          },
        ]);
        void send(key, file, check.mimeType);
      }
    },
    [send],
  );

  /** "Enviar novamente": nova intenção (a URL anterior pode ter vencido — FA-02). */
  const retry = useCallback(
    (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (!item) return;
      const check = checkLocalFile(item.file);
      if (!check.ok) return;
      patch(key, {
        phase: 'uploading',
        progress: 0,
        attachment: null,
        reasonCode: null,
        errorCode: null,
        errorDetail: null,
      });
      void send(key, item.file, check.mimeType);
    },
    [items, patch, send],
  );

  /** ATT-06: exclusão com motivo; a versão vem da última leitura do anexo. */
  const remove = useCallback(
    async (key: string, reason: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (!item?.attachment) return;
      const current = await fetchAttachment(item.attachment.id);
      await deleteAttachment(current, reason);
      patch(key, { phase: 'deleted' });
    },
    [items, patch],
  );

  const dismiss = useCallback((key: string) => {
    setItems((current) => current.filter((item) => item.key !== key));
  }, []);

  return { items, rejection, add, retry, remove, dismiss };
}
