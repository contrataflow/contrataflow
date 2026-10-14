// Casos de teste da regra (semgrep --test .semgrep/rules).
declare const logger: {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
declare const req: { method: string; url: string; headers: Record<string, string> };

export function handle(request: typeof req) {
  // ruleid: cf-no-log-request
  logger.info(req);
  // ruleid: cf-no-log-request
  logger.error('falhou', request);
  // ruleid: cf-no-log-request
  logger.info({ event: 'http.request', req });
  // ok: cf-no-log-request
  logger.info({ event: 'http.request', method: req.method, route: req.url });
}
