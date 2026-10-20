'use client';

import type { DfdTemplateSectionDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { AttachmentsSection } from '../attachments/attachments-section';
import type { UploadDeps } from '../attachments/use-attachment-uploads';
import { FormField, TEXTAREA_CLASS } from '../processes/form-field';

export interface DfdSectionFieldProps {
  readonly section: DfdTemplateSectionDto;
  readonly value: string;
  readonly editable: boolean;
  readonly onChange: (key: string, value: string) => void;
  /** US-121: o `AiSectionMenu` da seção (ajuste com IA), no cabeçalho do campo. */
  readonly aiMenu?: ReactNode;
}

/**
 * Seção do template no wizard (SCR-007): rótulo com a obrigatoriedade, orientação recolhível
 * (`helpText`) e base legal (`legalBasis`) associadas ao campo por `aria-describedby`. O `id`
 * `dfd-section-<KEY>` é o alvo do "Ir para o campo" da revisão.
 */
export function DfdSectionField({
  section,
  value,
  editable,
  onChange,
  aiMenu,
}: DfdSectionFieldProps) {
  const t = useTranslations('dfd.justification');
  const id = `dfd-section-${section.key}`;
  const required = section.requirement !== 'OPTIONAL';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {aiMenu ? <div className="flex justify-end">{aiMenu}</div> : null}
      <FormField
        id={id}
        label={`${section.title}${required ? ' *' : ''}`}
        hint={
          <>
            {section.legalBasis ? (
              <span className="block">{t('legalBasis', { basis: section.legalBasis })}</span>
            ) : null}
            <span className="block">
              {t('maxChars', { max: section.maxChars.toLocaleString('pt-BR') })}
            </span>
          </>
        }
        required={required}
      >
        {(control) => (
          <textarea
            {...control}
            className={`${TEXTAREA_CLASS} min-h-40`}
            maxLength={section.maxChars}
            value={value}
            readOnly={!editable}
            onChange={(event) => {
              onChange(section.key, event.target.value);
            }}
          />
        )}
      </FormField>
      {section.helpText ? (
        <details className="rounded-control border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t('help')}</summary>
          <p className="mt-2 text-muted-foreground">{section.helpText}</p>
        </details>
      ) : null}
    </div>
  );
}

export interface DfdJustificationStepProps {
  readonly processId: string;
  readonly documentId: string;
  /** Seções do passo (todas menos `NOTES`, que fica no Planejamento). */
  readonly sections: readonly DfdTemplateSectionDto[];
  readonly values: Readonly<Record<string, string>>;
  readonly editable: boolean;
  readonly allowedActions: readonly string[];
  readonly onChange: (key: string, value: string) => void;
  /** US-121: o menu de ajuste com IA de cada seção. */
  readonly aiMenuFor?: ((section: DfdTemplateSectionDto) => ReactNode) | undefined;
  /** Testes: sondagem e XHR simulados do upload. */
  readonly uploadDeps?: UploadDeps | undefined;
}

/**
 * `DfdJustificationStep` (SCR-007 · passo 2 · Decreto 10.947/2022, art. 8º, I): justificativa da
 * necessidade e resultados esperados (seções do template) e os anexos de apoio pelo fluxo seguro
 * de US-068 (`targetType = DOCUMENT`), editáveis enquanto o DFD aceita `UPDATE`.
 */
export function DfdJustificationStep({
  processId,
  documentId,
  sections,
  values,
  editable,
  allowedActions,
  onChange,
  aiMenuFor,
  uploadDeps,
}: DfdJustificationStepProps) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {sections.map((section) => (
        <DfdSectionField
          key={section.key}
          section={section}
          value={values[section.key] ?? ''}
          editable={editable}
          onChange={onChange}
          aiMenu={aiMenuFor?.(section)}
        />
      ))}
      <div id="dfd-field-attachments" tabIndex={-1}>
        <AttachmentsSection
          targetType="DOCUMENT"
          targetId={documentId}
          processId={processId}
          action="UPDATE"
          allowedActions={allowedActions}
          deps={uploadDeps}
        />
      </div>
    </div>
  );
}
