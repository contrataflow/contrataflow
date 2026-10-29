'use client';

import {
  Breadcrumb,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Ellipsis,
  buttonClassName,
} from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode, Ref } from 'react';

export interface DocumentFact {
  readonly id: string;
  readonly content: ReactNode;
}

export interface DocumentHeaderProps {
  readonly processId: string;
  /** Código do processo na trilha; sem ele, "Processo". */
  readonly processCode?: string | null | undefined;
  /** Último item da trilha (o documento: código ou título curto). */
  readonly current: string;
  /** Itens entre o processo e o item atual (ex.: o documento, quando o atual é "Versões"). */
  readonly parents?: readonly { readonly label: string; readonly href: string }[] | undefined;
  readonly title: ReactNode;
  /** Com ref, o título recebe `tabIndex=-1` para receber o foco ao carregar. */
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined;
  /** Chips de situação ao lado do título (status, "Em aprovação"). */
  readonly status?: ReactNode;
  /** Fatos em linha sob o título (versão, tipo, processo, link de versões). */
  readonly facts?: readonly DocumentFact[] | undefined;
  /** Indicador do salvamento automático, ao fim da linha de fatos. */
  readonly autosave?: ReactNode;
  /** Ações à direita (Pré-visualizar PDF, Gerar rascunho com IA); a primária por último. */
  readonly actions?: ReactNode;
  /** Itens do menu "Mais" (`DropdownMenuItem`); sem itens, o menu não aparece. */
  readonly more?: ReactNode;
}

/**
 * Cabeçalho comum dos documentos do planejamento (prd-5 · regra 5 · DFD, ETP e TR): trilha
 * (Processos › processo › documento), título com os chips de situação, fatos em linha com o
 * indicador do salvamento automático e as ações — secundárias, menu "Mais" e a primária por último.
 */
export function DocumentHeader({
  processId,
  processCode,
  current,
  parents = [],
  title,
  titleRef,
  status,
  facts = [],
  autosave,
  actions,
  more,
}: DocumentHeaderProps) {
  const t = useTranslations('documents.header');
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <Breadcrumb
        label={t('breadcrumb')}
        linkComponent={Link}
        items={[
          { label: t('processes'), href: '/processos' },
          {
            label: processCode ? t('process', { code: processCode }) : t('processFallback'),
            href: `/processos/${processId}`,
          },
          ...parents,
          { label: current },
        ]}
      />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <h1
              ref={titleRef}
              tabIndex={titleRef ? -1 : undefined}
              className="min-w-0 text-page-title break-words text-brand-ink outline-none"
            >
              {title}
            </h1>
            {status ? <div className="flex flex-wrap items-center gap-2">{status}</div> : null}
          </div>
          {facts.length > 0 || autosave ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {facts.map((fact, index) => (
                <span key={fact.id} className="flex items-center gap-2">
                  {index > 0 ? <span aria-hidden="true">·</span> : null}
                  {fact.content}
                </span>
              ))}
              {autosave ? <span className="flex items-center sm:ml-2">{autosave}</span> : null}
            </div>
          ) : null}
        </div>
        {actions || more ? (
          <div className="flex flex-none flex-wrap items-start gap-2">
            {more ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={buttonClassName({ variant: 'secondary', size: 'md' })}
                  aria-label={t('moreLabel')}
                >
                  <Ellipsis aria-hidden="true" className="size-4" />
                  {t('more')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{more}</DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
