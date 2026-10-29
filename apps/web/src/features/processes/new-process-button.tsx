'use client';

import { Tooltip, TooltipContent, TooltipTrigger, buttonClassName } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Icon } from '@/components/shell/icons';
import { Can } from '@/lib/permissions/can';

/** Rota do wizard SCR-005. */
export const NEW_PROCESS_PATH = '/processos/novo';

/**
 * Botão global "Novo processo" do cabeçalho do shell (US-001 · passo 1): só aparece para quem tem
 * `PROCESS_CREATE` (a API decide o escopo — FA-08). Abaixo de `sm` mostra só o ícone, mantendo o
 * nome acessível e uma dica. É o CTA global: o cabeçalho das páginas não o repete (prd-5 · regra 1).
 */
export function NewProcessButton() {
  const t = useTranslations('processes.newButton');
  return (
    <Can permission="PROCESS_CREATE">
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={NEW_PROCESS_PATH}
            className={buttonClassName({ className: 'px-3 sm:px-[1.125rem]' })}
          >
            <Icon name="plus" />
            <span className="sr-only sm:not-sr-only">{t('label')}</span>
          </Link>
        </TooltipTrigger>
        {/* Só no celular, onde o botão mostra apenas o ícone. */}
        <TooltipContent className="sm:hidden">{t('label')}</TooltipContent>
      </Tooltip>
    </Can>
  );
}
