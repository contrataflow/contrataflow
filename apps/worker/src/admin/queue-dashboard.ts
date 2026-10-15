import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { uuidv7 } from '@contrataflow/observability';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { OperatorAccessError } from './operator-authenticator.js';
import type { OperatorAccessCode, OperatorAuthenticator } from './operator-authenticator.js';
import type { QueueAuditPort } from './platform-audit.js';

/*
 * Bull Board (RN-FND-69 · queues.md §15.1): servidor HTTP na porta INTERNA `WORKER_ADMIN_PORT`
 * (sub-rede privada; acesso por VPN ou port forwarding — nunca exposto à internet). Toda rota do
 * painel exige operador de plataforma com `PLATFORM_QUEUE_ADMIN` + MFA e registra
 * `queue_dashboard.access` (concedido ou negado, uma vez por token). Os adaptadores rodam em
 * `readOnlyMode` e, por garantia, qualquer método além de GET/HEAD é recusado antes do painel:
 * retry, descarte e limpeza só pela CLI auditada. Fora do painel, só `/health`.
 */

export const DASHBOARD_BASE_PATH = '/queues';
export const OPS_TOKEN_COOKIE = 'cf_ops_token';

const MESSAGES: Readonly<Record<OperatorAccessCode, string>> = {
  UNAUTHENTICATED: 'Sua sessão de operação expirou. Entre novamente.',
  PERMISSION_DENIED: 'Você não tem permissão para acessar o painel de filas.',
  MFA_REQUIRED: 'Esta ação exige verificação adicional.',
};

export interface QueueDashboardDeps {
  readonly queues: readonly Queue[];
  readonly authenticator: Pick<OperatorAuthenticator, 'authenticate'>;
  readonly audit: QueueAuditPort;
}

function tokenOf(request: Request): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === OPS_TOKEN_COOKIE) return decodeURIComponent(value.join('=')) || null;
  }
  return null;
}

/** Cria o app Express do painel (separado do `listen` para os testes). */
export function createQueueDashboardApp(deps: QueueDashboardDeps): express.Express {
  const logger = new Logger('QueueDashboard');
  /** Tokens já auditados (concedido/negado): o painel faz várias chamadas por página. */
  const audited = new Set<string>();

  const auditOnce = async (
    token: string,
    request: Request,
    outcome: { result: 'SUCCESS' | 'DENIED'; code?: OperatorAccessCode },
    operator: { userId: string; name: string } | null,
  ): Promise<void> => {
    const key = `${createHash('sha256').update(token).digest('hex')}:${outcome.code ?? 'OK'}`;
    if (audited.has(key)) return;
    await deps.audit.record({
      action: 'queue_dashboard.access',
      result: outcome.result,
      ...(outcome.code ? { reasonCode: outcome.code } : {}),
      actorUserId: operator?.userId ?? null,
      actorName: operator?.name ?? null,
      tenantId: null,
      metadata: { actorType: 'PLATFORM_OPERATOR', path: request.path.slice(0, 200) },
      correlationId: uuidv7(),
      ip: request.socket.remoteAddress ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });
    audited.add(key);
  };

  const readOnly = (request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      next();
      return;
    }
    response.status(405).json({
      code: 'METHOD_NOT_ALLOWED',
      message: 'Painel somente leitura: use a CLI auditada para reprocessar ou descartar jobs.',
    });
  };

  const authenticate = (request: Request, response: Response, next: NextFunction) => {
    const token = tokenOf(request);
    deps.authenticator
      .authenticate(token)
      .then(async (operator) => {
        if (token) await auditOnce(token, request, { result: 'SUCCESS' }, operator);
        next();
      })
      .catch(async (error: unknown) => {
        const code = error instanceof OperatorAccessError ? error.code : 'UNAUTHENTICATED';
        const operator = error instanceof OperatorAccessError ? error.operator : null;
        if (token && code !== 'UNAUTHENTICATED') {
          await auditOnce(token, request, { result: 'DENIED', code }, operator).catch(
            (auditError: unknown) => {
              logger.error({ event: 'queue_dashboard.audit_failed', cause: String(auditError) });
            },
          );
        }
        logger.warn({ event: 'queue_dashboard.access_denied', code });
        response
          .status(code === 'UNAUTHENTICATED' ? 401 : 403)
          .json({ code, message: MESSAGES[code] });
      });
  };

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(DASHBOARD_BASE_PATH);
  createBullBoard({
    queues: deps.queues.map((queue) => new BullMQAdapter(queue, { readOnlyMode: true })),
    serverAdapter,
  });

  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });
  app.use(DASHBOARD_BASE_PATH, readOnly, authenticate, serverAdapter.getRouter() as express.Router);
  return app;
}

export interface RunningDashboard {
  readonly port: number;
  close(): Promise<void>;
}

export async function startQueueDashboard(
  deps: QueueDashboardDeps,
  port: number,
  host = '0.0.0.0',
): Promise<RunningDashboard> {
  const app = createQueueDashboardApp(deps);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, () => {
      resolve(listening);
    });
    listening.once('error', reject);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
