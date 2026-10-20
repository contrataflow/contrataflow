import { readyResponse } from '@/bff/health';

// HLT-02 (US-085): fora de `/api/v1`; o listener/WAF bloqueia `/health/*` vindo da internet.
export const dynamic = 'force-dynamic';

export async function GET() {
  return readyResponse();
}
