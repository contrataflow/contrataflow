'use client';

import { toast } from '@contrataflow/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

import { tenantKey } from '@/lib/query/keys';
import { useShellSession } from '@/lib/session/session-context';

import { describeClaimError } from './claim-model';
import { useClaimMutation } from './process-claim.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';

/** Listas que o "assumir" muda além do processo: caixa de tarefas, lista e painel inicial. */
const AFTER_CLAIM_KEYS = ['processes', 'tasks', 'dashboard'] as const;

/**
 * "Assumir" (SCR-115 · ação direta, sem confirmação): dispara o PRC-21, mostra o toast e recarrega o
 * painel e as listas. O 412 do clique duplo vale como sucesso já aplicado (FA-03); o 409 mostra quem
 * assumiu (FA-01). `claim` ignora cliques enquanto o envio está em curso.
 */
export function useClaimProcess(processId: string) {
  const t = useTranslations('processes.claim');
  const queryClient = useQueryClient();
  const tenantId = useShellSession().activeTenant.id;
  const invalidateProcess = useInvalidateProcess(processId);
  const mutation = useClaimMutation();
  const { mutateAsync, isPending } = mutation;

  const refresh = useCallback(() => {
    void invalidateProcess();
    for (const key of AFTER_CLAIM_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
  }, [invalidateProcess, queryClient, tenantId]);

  const claim = useCallback(
    async (version: number | undefined): Promise<void> => {
      if (isPending) return;
      if (version === undefined) {
        // Sem a versão do PRC-04 não há `If-Match`: recarrega e deixa tentar de novo.
        void invalidateProcess();
        toast({ title: t('errors.reload'), tone: 'error' });
        return;
      }
      try {
        await mutateAsync({ processId, version });
      } catch (error) {
        const found = describeClaimError(error);
        switch (found.kind) {
          case 'alreadyDone':
            // O reenvio do clique duplo: já foi aplicado, só atualiza a tela.
            break;
          case 'alreadyAssigned':
            toast({
              title:
                found.name === null
                  ? t('errors.alreadyAssigned')
                  : t('errors.alreadyAssignedBy', { name: found.name }),
              tone: 'error',
            });
            break;
          case 'unexpected':
            toast({
              title: t('errors.unexpected', { correlationId: found.correlationId }),
              tone: 'error',
            });
            break;
          default:
            toast({ title: t(`errors.${found.kind}`), tone: 'error' });
        }
        refresh();
        return;
      }
      toast({ title: t('claimed'), tone: 'success' });
      refresh();
    },
    [isPending, invalidateProcess, mutateAsync, processId, refresh, t],
  );

  return { claim, isPending };
}
