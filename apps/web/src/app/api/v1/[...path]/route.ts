import { handleProxyRequest } from '@/bff/proxy-handler';

// Proxy autenticado para a API interna (architecture.md §8.4).
export const dynamic = 'force-dynamic';

interface RouteParams {
  readonly params: Promise<{ path: string[] }>;
}

async function proxy(request: Request, { params }: RouteParams) {
  return handleProxyRequest(request, (await params).path);
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
