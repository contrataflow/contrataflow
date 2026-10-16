import { createHash, randomBytes } from 'node:crypto';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { isDeliverableAddress } from './email-source.js';
import type { EmailPreparation, EmailSource } from './email-source.js';
import { renderInvitationEmail } from './invitation-template.js';

interface InvitationRow {
  readonly status: string;
  readonly invite_token_hash: string | null;
  readonly invite_expires_at: Date | string | null;
  /** O mesmo instante em texto, com a precisão completa do banco (microssegundos). */
  readonly invite_expires_raw: string | null;
  readonly job_title: string | null;
  readonly type: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly tenant_name: string;
  readonly tenant_status: string;
}

/** Token do convite: 32 bytes aleatórios em base64url sem padding (43 caracteres). */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash gravado em `tenant_memberships.invite_token_hash`: SHA-256 hexadecimal minúsculo. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface InvitationEmailSourceOptions {
  readonly now?: (() => Date) | undefined;
  readonly generateToken?: (() => string) | undefined;
}

interface Receipt {
  readonly hash: string;
  readonly expiresAt: string;
}

function parseReceipt(receipt: string | undefined): Receipt | null {
  if (receipt === undefined) return null;
  try {
    const value = JSON.parse(receipt) as Partial<Receipt>;
    if (typeof value.hash === 'string' && typeof value.expiresAt === 'string') {
      return { hash: value.hash, expiresAt: value.expiresAt };
    }
  } catch {
    // recibo corrompido: nada é gravado
  }
  return null;
}

/**
 * E-mail do convite de usuário (US-091 · USR-03/04, queues.md §4.3), na `tenantTransaction` do job
 * com o papel `cf_worker` (RLS: o vínculo de outro tenant não é lido nem atualizado). O convite é
 * e-mail OBRIGATÓRIO: não consulta `notifications.emailEnabled`.
 *
 * O token NÃO existe na API: é gerado aqui, no `prepare`, e só o hash é gravado, no `markSent`,
 * depois do envio — `UPDATE ... WHERE invite_token_hash IS NULL AND invite_expires_at = <lido>`.
 * O `invite_expires_at` lido faz de marcador da geração: um reenvio (USR-04) o altera, então o
 * UPDATE do e-mail antigo não aplica e o link velho fica inválido (correto). Se o envio der certo
 * e o `markSent` falhar, a repetição do job gera outro token; o link do primeiro e-mail nunca
 * chegou a valer (nenhum hash foi gravado).
 *
 * Não há coluna de estado de e-mail no convite: `markFailed` e `markSkipped` devolvem `false` sem
 * gravar — o convite continua `INVITED` sem hash (o administrador pode reenviar) e o log do
 * `EmailSender` registra a falha ou o descarte. O token, o link e o endereço nunca vão para log.
 */
export class InvitationEmailSource implements EmailSource {
  private readonly now: () => Date;
  private readonly generateToken: () => string;

  constructor(
    private readonly baseUrl: string,
    options: InvitationEmailSourceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateToken = options.generateToken ?? generateInviteToken;
  }

  async prepare(
    client: SqlClient,
    membershipId: string,
    tenantId: string,
  ): Promise<EmailPreparation> {
    const { rows } = await client.query<InvitationRow>(
      `SELECT m.status::text AS status, m.invite_token_hash, m.invite_expires_at,
              m.invite_expires_at::text AS invite_expires_raw, m.job_title, m.type::text AS type,
              u.email::text AS email, u.name, t.name AS tenant_name, t.status::text AS tenant_status
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.id = $1 AND m.tenant_id = $2`,
      [membershipId, tenantId],
    );
    const row = rows[0];
    if (!row) return { kind: 'missing' };
    if (row.status !== 'INVITED') return { kind: 'not-pending', status: row.status };
    if (row.invite_token_hash !== null) return { kind: 'not-pending', status: 'SENT' };
    const expiresAt = row.invite_expires_at === null ? null : new Date(row.invite_expires_at);
    if (expiresAt === null || row.invite_expires_raw === null || expiresAt <= this.now()) {
      return { kind: 'not-pending', status: 'EXPIRED' };
    }
    if (row.tenant_status !== 'ACTIVE') return { kind: 'skip', reason: 'TENANT_INACTIVE' };
    if (!isDeliverableAddress(row.email)) {
      return { kind: 'fail', code: 'NO_RECIPIENT', error: 'destinatário sem e-mail' };
    }

    const token = this.generateToken();
    const receipt: Receipt = { hash: hashInviteToken(token), expiresAt: row.invite_expires_raw };
    return {
      kind: 'send',
      to: row.email.trim(),
      type: 'INVITATION',
      content: renderInvitationEmail(this.baseUrl, {
        name: row.name,
        tenantName: row.tenant_name,
        jobTitle: row.job_title,
        token,
        expiresAt,
      }),
      receipt: JSON.stringify(receipt),
    };
  }

  async markSent(
    client: SqlClient,
    membershipId: string,
    _sentAt: Date,
    receipt?: string,
  ): Promise<boolean> {
    const generation = parseReceipt(receipt);
    if (!generation) return false;
    // Transição técnica: não incrementa `version` (o convite em si não mudou para o usuário).
    const result = await client.query(
      `UPDATE tenant_memberships
          SET invite_token_hash = $2
        WHERE id = $1 AND status = 'INVITED' AND invite_token_hash IS NULL
          AND invite_expires_at = $3::timestamptz`,
      [membershipId, generation.hash, generation.expiresAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  markFailed(): Promise<boolean> {
    return Promise.resolve(false);
  }

  markSkipped(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
