import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { edgeHeaders } from '@/bff/edge';
import { cspSources, isDevelopmentBuild } from '@/config/env';

/** Proxy do Next 16 (antigo middleware): CSP com nonce e cabeçalhos de segurança (security.md §8). */
export function proxy(request: NextRequest) {
  const sources = cspSources();
  const { requestHeaders, responseHeaders } = edgeHeaders(
    request.nextUrl.pathname,
    request.nextUrl.search,
    request.headers,
    {
      connectSources: sources.connectSources,
      reportUri: sources.cspReportUri,
      secure: sources.secure,
      development: isDevelopmentBuild(),
    },
  );
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(responseHeaders)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
