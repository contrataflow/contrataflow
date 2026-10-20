import { liveResponse } from '@/bff/health';

// HLT-01 (US-085): fora de `/api/v1`; o listener/WAF bloqueia `/health/*` vindo da internet.
export const dynamic = 'force-dynamic';

export function GET() {
  return liveResponse();
}
