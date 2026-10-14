import { handleCspReport } from '@/bff/csp-report';

// Relatórios de violação de CSP (security.md §8 · `CSP_REPORT_URI`).
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCspReport(request);
}
