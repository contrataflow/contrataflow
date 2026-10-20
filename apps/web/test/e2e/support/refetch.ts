// Espera a releitura (GET) que a tela faz depois de uma mutação (`invalidateQueries`).
import type { Page, Response } from '@playwright/test';

const pathnameOf = (response: Response): string => new URL(response.url()).pathname;

/**
 * Registre ANTES do clique que dispara a mutação e aguarde depois do aviso de sucesso. Telas que
 * guardam o registro ao abrir um diálogo (`If-Match` com `version`) só têm a versão nova quando a
 * releitura chega; agir antes disso dá 412 — sob a suíte em paralelo isso acontece. Só vale o GET
 * que chega depois da resposta da mutação (uma releitura anterior traria a versão antiga).
 */
export async function refetchOf(
  page: Page,
  { mutation, refetch }: { readonly mutation: RegExp; readonly refetch: RegExp },
): Promise<Response> {
  await page.waitForResponse(
    (candidate) =>
      candidate.request().method() !== 'GET' &&
      candidate.ok() &&
      mutation.test(pathnameOf(candidate)),
  );
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'GET' &&
      candidate.ok() &&
      refetch.test(pathnameOf(candidate)),
  );
  await response.finished();
  return response;
}
