import { parseArgs } from 'node:util';

import { maskEmail, provisionTenantSchema, tenantReasonSchema } from '@contrataflow/validation';
import type { ProvisionTenant } from '@contrataflow/validation';

import type { AppliedSeeder } from '#modules/tenancy/application/apply-tenant-seeders.command.js';
import type {
  ChangeTenantStatusRequest,
  ChangeTenantStatusResult,
} from '#modules/tenancy/application/change-tenant-status.command.js';
import type {
  ProvisionTenantRequest,
  ProvisioningDryRun,
  ProvisioningOutcome,
} from '#modules/tenancy/application/provision-tenant.command.js';
import type { PlatformOperatorRef } from '#modules/tenancy/application/tenancy-support.js';
import type { TenantDetail } from '#modules/tenancy/application/tenant.queries.js';
import type { ProvisioningChecklist } from '#modules/tenancy/domain/seeding-plan.js';
import type { Tenant } from '#modules/tenancy/domain/tenant.js';
import type { PlatformOperator } from '#shared/auth/ports.js';
import { ApiError } from '#shared/errors/api-error.js';
import type { FirstAdminInvitation } from '#shared/tenancy/tenant-seeding.js';
import { toFieldErrors } from '#shared/validation/zod-issues.js';

/*
 * CLI de operação de tenants (US-099 · DT-07 · RN-TEN-17): mesmos casos de uso da API de
 * plataforma, em processo, só na rede privada. Códigos de saída: 0 (ok), 1 (validação ou
 * autorização — nada foi feito), 2 (incompleto ou dependência indisponível — repetir o comando).
 */

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_INCOMPLETE = 2;

export const TENANT_CLI_USAGE = `Uso: pnpm cf <comando> [opções] --operator <e-mail>

  tenant:provision --file <tenant.json> [--no-activate] [--dry-run] [--json]
  tenant:status <slug> [--json]
  tenant:activate <slug>
  tenant:suspend <slug> --reason "<motivo>"
  tenant:offboard <slug> --reason "<motivo>" [--ends-at <AAAA-MM-DD>]
  tenant:deactivate <slug> --confirm-slug <slug>
  tenant:seed <slug> [--seeder <chave>] [--dry-run]
  tenant:resend-invite <slug>`;

/** Casos de uso usados pela CLI (o entrypoint os resolve do contexto Nest). */
export interface TenantCliDeps {
  readonly findOperatorByEmail: (email: string) => Promise<PlatformOperator | null>;
  readonly readFile: (path: string) => Promise<string>;
  readonly provision: (request: ProvisionTenantRequest) => Promise<ProvisioningOutcome>;
  readonly dryRun: (input: ProvisionTenant) => Promise<ProvisioningDryRun>;
  readonly status: (slug: string) => Promise<TenantDetail>;
  readonly changeStatus: (request: ChangeTenantStatusRequest) => Promise<ChangeTenantStatusResult>;
  readonly applySeeders: (request: {
    slug: string;
    seederKey?: string;
    dryRun: boolean;
  }) => Promise<AppliedSeeder[]>;
  readonly resendInvite: (slug: string) => Promise<FirstAdminInvitation | null>;
  /** Identificador da execução (`metadata.runId`). */
  readonly runId: () => string;
}

export interface CliOutput {
  out(text: string): void;
  err(text: string): void;
}

class CliUsageError extends Error {}

const OPTIONS = {
  operator: { type: 'string' },
  file: { type: 'string' },
  'no-activate': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  reason: { type: 'string' },
  'confirm-slug': { type: 'string' },
  'ends-at': { type: 'string' },
  seeder: { type: 'string' },
} as const;

type Values = ReturnType<typeof parse>['values'];

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

function slugArg(positionals: readonly string[]): string {
  const slug = positionals[1];
  if (!slug) throw new CliUsageError('Informe o identificador (slug) do tenant.');
  return slug;
}

function checklistTable(checklist: ProvisioningChecklist): string {
  const rows = checklist.steps.map((step) => [
    step.key,
    step.status,
    step.version ?? '',
    Object.entries(step.details ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(' '),
  ]);
  const header = ['Etapa', 'Situação', 'Versão', 'Detalhes'];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

function tenantLine(tenant: Tenant): string {
  return `${tenant.name} (${tenant.slug}) — ${tenant.status} · versão ${tenant.version} · id ${tenant.id}`;
}

function invitationLine(invitation: FirstAdminInvitation | null): string {
  if (!invitation) return 'Primeiro administrador: ainda não cadastrado.';
  return `Primeiro administrador: ${maskEmail(invitation.email)} · vínculo ${invitation.membershipStatus} · convite ${invitation.invitationDispatched ? 'enviado' : 'NÃO enviado (use tenant:resend-invite)'}`;
}

function errorLines(error: ApiError): string {
  const fields = error.errors.map(
    (field) => `  - ${field.field}: ${field.code} — ${field.message}`,
  );
  return [`${error.code}: ${error.detail}`, ...fields].join('\n');
}

/** Executa um comando; nunca lança (erros viram mensagem e código de saída). */
export async function runTenantCli(
  argv: readonly string[],
  deps: TenantCliDeps,
  output: CliOutput,
): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parse(argv));
  } catch (error) {
    output.err(`${error instanceof Error ? error.message : String(error)}\n${TENANT_CLI_USAGE}`);
    return EXIT_INVALID;
  }
  const command = positionals[0];
  if (!command?.startsWith('tenant:')) {
    output.err(TENANT_CLI_USAGE);
    return EXIT_INVALID;
  }

  try {
    const operator = await authorize(values.operator, deps);
    const options = { operator, channel: 'CLI' as const, runId: deps.runId() };
    switch (command) {
      case 'tenant:provision':
        return await provision(values, options, deps, output);
      case 'tenant:status': {
        const detail = await deps.status(slugArg(positionals));
        output.out(
          values.json
            ? JSON.stringify(detail, null, 2)
            : `${tenantLine(detail.tenant)}\n\n${checklistTable(detail.provisioning)}`,
        );
        return EXIT_OK;
      }
      case 'tenant:activate':
        return await changeStatus(positionals, options, 'ACTIVATE', {}, deps, output);
      case 'tenant:suspend':
        return await changeStatus(
          positionals,
          options,
          'SUSPEND',
          { reason: reasonOf(values.reason) },
          deps,
          output,
        );
      case 'tenant:offboard': {
        const reason = reasonOf(values.reason);
        const endsAt = endsAtOf(values['ends-at']);
        return await changeStatus(
          positionals,
          options,
          'OFFBOARD',
          { reason, ...(endsAt ? { offboardingEndsAt: endsAt } : {}) },
          deps,
          output,
        );
      }
      case 'tenant:deactivate': {
        const slug = slugArg(positionals);
        if (values['confirm-slug'] !== slug) {
          // V-10: sem efeito.
          output.err('A confirmação não corresponde ao identificador.');
          return EXIT_INVALID;
        }
        return await changeStatus(positionals, options, 'DEACTIVATE', {}, deps, output);
      }
      case 'tenant:seed': {
        const results = await deps.applySeeders({
          slug: slugArg(positionals),
          ...(values.seeder === undefined ? {} : { seederKey: values.seeder }),
          dryRun: values['dry-run'] === true,
        });
        output.out(
          results.length === 0
            ? 'Nenhum seeder aplicável.'
            : results
                .map(
                  (result) =>
                    `${result.key}@${result.version}: ${result.result}${result.created === undefined ? '' : ` (${result.created} criados)`}${result.errorCode ? ` — ${result.errorCode}` : ''}`,
                )
                .join('\n'),
        );
        return results.some((result) => result.result === 'FAILED') ? EXIT_INCOMPLETE : EXIT_OK;
      }
      case 'tenant:resend-invite': {
        const invitation = await deps.resendInvite(slugArg(positionals));
        output.out(invitationLine(invitation));
        return invitation?.invitationDispatched ? EXIT_OK : EXIT_INCOMPLETE;
      }
      default:
        output.err(`Comando desconhecido: ${command}\n${TENANT_CLI_USAGE}`);
        return EXIT_INVALID;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      output.err(`${error.message}\n${TENANT_CLI_USAGE}`);
      return EXIT_INVALID;
    }
    if (error instanceof ApiError) {
      output.err(errorLines(error));
      return error.status >= 500 ? EXIT_INCOMPLETE : EXIT_INVALID;
    }
    output.err(`Erro inesperado: ${error instanceof Error ? error.name : 'desconhecido'}.`);
    return EXIT_INCOMPLETE;
  }
}

/** Operador válido no ambiente de operação (o MFA vem do papel IAM assumido — permissões). */
async function authorize(
  email: string | undefined,
  deps: TenantCliDeps,
): Promise<PlatformOperatorRef> {
  if (!email) throw new CliUsageError('Informe --operator <e-mail> de um operador da plataforma.');
  const operator = await deps.findOperatorByEmail(email.trim().toLowerCase());
  if (operator?.status !== 'ACTIVE' || !operator.isPlatformOperator) {
    throw new ApiError('PERMISSION_DENIED', {
      detail: 'Acesso restrito a operadores da plataforma.',
    });
  }
  return { id: operator.id, name: operator.name };
}

/** `--ends-at`: fim do prazo de encerramento (data futura); ausente → padrão de 90 dias. */
function endsAtOf(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59-03:00` : value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new ApiError('VALIDATION_ERROR', {
      errors: [
        {
          field: 'ends-at',
          code: 'INVALID_FORMAT',
          message: 'Informe uma data futura (AAAA-MM-DD).',
        },
      ],
    });
  }
  return date;
}

function reasonOf(reason: string | undefined): string {
  const parsed = tenantReasonSchema.safeParse({ reason });
  if (!parsed.success) {
    throw new ApiError('VALIDATION_ERROR', { errors: toFieldErrors(parsed.error.issues) });
  }
  return parsed.data.reason;
}

async function provision(
  values: Values,
  options: { operator: PlatformOperatorRef; channel: 'CLI'; runId: string },
  deps: TenantCliDeps,
  output: CliOutput,
): Promise<number> {
  if (!values.file) throw new CliUsageError('Informe --file <tenant.json>.');
  let raw: unknown;
  try {
    raw = JSON.parse(await deps.readFile(values.file));
  } catch (error) {
    output.err(
      `Não foi possível ler ${values.file}: ${error instanceof Error ? error.message : 'erro'}`,
    );
    return EXIT_INVALID;
  }
  const withActivation =
    values['no-activate'] === true && typeof raw === 'object' && raw !== null
      ? { ...raw, activate: false }
      : raw;
  const parsed = provisionTenantSchema.safeParse(withActivation, { reportInput: true });
  if (!parsed.success) {
    throw new ApiError('VALIDATION_ERROR', { errors: toFieldErrors(parsed.error.issues) });
  }

  if (values['dry-run']) {
    const plan = await deps.dryRun(parsed.data);
    output.out(
      values.json
        ? JSON.stringify(plan, null, 2)
        : [
            plan.existingTenantId
              ? `Retomada do tenant ${parsed.data.slug} (${plan.existingTenantId}) — nada foi gravado.`
              : `Novo tenant ${parsed.data.slug} — nada foi gravado.`,
            ...plan.steps.map((step) => `  ${step.action.padEnd(6)} ${step.key}`),
          ].join('\n'),
    );
    return EXIT_OK;
  }

  const outcome = await deps.provision({ input: parsed.data, idempotencyKey: null, ...options });
  if (values.json) {
    output.out(
      JSON.stringify(
        {
          kind: outcome.kind,
          tenant: outcome.tenant,
          provisioning: outcome.checklist,
          firstAdmin: outcome.firstAdmin
            ? { ...outcome.firstAdmin, email: maskEmail(outcome.firstAdmin.email) }
            : null,
          ...(outcome.failedStep ? { failedStep: outcome.failedStep } : {}),
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    output.out(`${tenantLine(outcome.tenant)}\n\n${checklistTable(outcome.checklist)}`);
    if (outcome.kind === 'complete') output.out(`\n${invitationLine(outcome.firstAdmin)}`);
  }
  if (outcome.kind === 'incomplete') {
    output.err(
      `Provisionamento incompleto na etapa ${outcome.failedStep ?? '?'} (${outcome.errorCode ?? 'erro'}). Os passos concluídos foram mantidos; repita o comando.`,
    );
    return EXIT_INCOMPLETE;
  }
  return EXIT_OK;
}

async function changeStatus(
  positionals: readonly string[],
  options: { operator: PlatformOperatorRef; channel: 'CLI'; runId: string },
  action: ChangeTenantStatusRequest['action'],
  extra: { readonly reason?: string; readonly offboardingEndsAt?: Date },
  deps: TenantCliDeps,
  output: CliOutput,
): Promise<number> {
  const result = await deps.changeStatus({
    tenant: { slug: slugArg(positionals) },
    action,
    expectedVersion: null,
    ...extra,
    ...options,
  });
  output.out(tenantLine(result.tenant));
  if (result.invitation) output.out(invitationLine(result.invitation));
  return EXIT_OK;
}
