import 'reflect-metadata';

import { readFile } from 'node:fs/promises';

import { createLogger, uuidv7 } from '@contrataflow/observability';
import { NestFactory } from '@nestjs/core';

import { ConfigValidationError, loadConfigFromProcess } from '#config/env.js';
import { ApplyTenantSeedersCommand } from '#modules/tenancy/application/apply-tenant-seeders.command.js';
import { ChangeTenantStatusCommand } from '#modules/tenancy/application/change-tenant-status.command.js';
import { ProvisionTenantCommand } from '#modules/tenancy/application/provision-tenant.command.js';
import {
  GetTenantQuery,
  ResendFirstAdminInvitationCommand,
} from '#modules/tenancy/application/tenant.queries.js';
import { PLATFORM_OPERATOR_PORT } from '#shared/auth/ports.js';
import type { PlatformOperatorPort } from '#shared/auth/ports.js';
import { createApiLogger } from '#shared/observability/observability.module.js';

import { EXIT_INCOMPLETE, EXIT_INVALID, runTenantCli } from './tenant-commands.js';
import { AppModule } from '../app.module.js';

/*
 * Entrypoint da CLI de tenants (US-099): `pnpm cf tenant:<comando> …` — tarefa avulsa na rede
 * privada, mesma imagem e configuração da API (inclusive `DATABASE_URL_PLATFORM`). Sobe o contexto
 * Nest sem HTTP e chama os mesmos casos de uso das rotas `/platform/*` (RN-TEN-17).
 */

const output = {
  out: (text: string) => process.stdout.write(`${text}\n`),
  err: (text: string) => process.stderr.write(`${text}\n`),
};

async function main(argv: readonly string[]): Promise<number> {
  let config;
  try {
    config = loadConfigFromProcess();
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) throw error;
    output.err(`Configuração inválida: ${error.keys.join(', ')}`);
    return EXIT_INVALID;
  }
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config, { logger: createApiLogger(config) }),
    { bufferLogs: true },
  );
  try {
    const provision = app.get(ProvisionTenantCommand, { strict: false });
    const lifecycle = app.get(ChangeTenantStatusCommand, { strict: false });
    const detail = app.get(GetTenantQuery, { strict: false });
    const seeders = app.get(ApplyTenantSeedersCommand, { strict: false });
    const resend = app.get(ResendFirstAdminInvitationCommand, { strict: false });
    const operators = app.get<PlatformOperatorPort>(PLATFORM_OPERATOR_PORT, { strict: false });
    return await runTenantCli(
      argv,
      {
        findOperatorByEmail: (email) => operators.findOperatorByEmail(email),
        readFile: (path) => readFile(path, 'utf8'),
        provision: (request) => provision.execute(request),
        dryRun: (input) => provision.dryRun(input),
        status: (slug) => detail.execute({ slug }),
        changeStatus: (request) => lifecycle.execute(request),
        applySeeders: (request) => seeders.execute(request),
        resendInvite: (slug) => resend.execute(slug),
        runId: () => uuidv7(),
      },
      output,
    );
  } finally {
    await app.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  createLogger({ service: 'api', env: 'unknown', version: 'unknown', level: 'info' }).fatal(
    { event: 'tenant_cli.failed', errorName: error instanceof Error ? error.name : 'unknown' },
    'tenant cli failed',
  );
  process.exitCode = EXIT_INCOMPLETE;
}
