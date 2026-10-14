import { handleAuthRequest } from '@/bff/auth-handler';

// Rotas de sessão do BFF (authentication.md §15): nunca cacheadas, sempre no runtime Node.
export const dynamic = 'force-dynamic';

interface RouteParams {
  readonly params: Promise<{ action: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  return handleAuthRequest(request, (await params).action);
}

export async function POST(request: Request, { params }: RouteParams) {
  return handleAuthRequest(request, (await params).action);
}
