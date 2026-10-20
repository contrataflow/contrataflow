import type { QuotationImportPreview, QuotationImportResult } from '@contrataflow/validation';

import { apiDownload, apiRequest } from '@/lib/api/client';
import type { ApiDownload } from '@/lib/api/client';

/*
 * Importação de cotações por planilha (US-028 · SCR-009, diálogo "Importar planilha"): PRS-24
 * (modelo `.xlsx` gerado pela API), PRS-18 (prévia — `multipart/form-data` com o campo `file`) e
 * PRS-19 (aplicação com o token da prévia e `Idempotency-Key` — a mesma em cada reenvio da mesma
 * aplicação, FA-05).
 */

/** PRS-24: o modelo pré-preenchido (itens × fontes com os preços atuais). */
export function downloadImportTemplate(
  researchId: string,
  signal?: AbortSignal,
): Promise<ApiDownload> {
  return apiDownload(`/price-research/${researchId}/import-template`, { signal });
}

/** PRS-18: envia a planilha e recebe a prévia com o token de 15 minutos. */
export async function previewQuotationImport(
  researchId: string,
  file: File,
): Promise<QuotationImportPreview> {
  const body = new FormData();
  body.append('file', file, file.name);
  const result = await apiRequest<QuotationImportPreview>(
    `/price-research/${researchId}/import-preview`,
    { method: 'POST', body },
  );
  return result.data;
}

/** PRS-19: aplica as células válidas da prévia. */
export async function applyQuotationImport(
  researchId: string,
  previewToken: string,
  idempotencyKey: string,
): Promise<QuotationImportResult> {
  const result = await apiRequest<QuotationImportResult>(`/price-research/${researchId}/import`, {
    method: 'POST',
    body: { previewToken },
    idempotencyKey,
  });
  return result.data;
}
