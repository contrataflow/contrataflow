// Blueprint de usuários de desenvolvimento do Authentik (RN-FND-17 · DEC-065), gerado a partir do
// dataset do seed: `pnpm env:blueprint` reescreve o arquivo e o teste `env-blueprint.test.ts` falha
// se o arquivo versionado divergir do dataset. A senha vem do ambiente (`!Env`), nunca do arquivo.
import { PERSONA_KEYS, personaSlug, seedUsers } from './dataset.js';
import type { PersonaKey } from './dataset.js';

export const USERS_BLUEPRINT_FILE = 'infra/authentik/blueprints/20-contrataflow-dev-users.yaml';

/** Caminho (pasta) dos usuários semeados no Authentik — usado pelo seed para encontrá-los. */
export const SEED_USER_PATH = 'contrataflow/dev';

export const DEV_GROUP_NAME = 'ContrataFlow — desenvolvimento';

export function personaGroupName(persona: PersonaKey): string {
  return `ContrataFlow — ${persona}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Grupos e usuários são só informativos: o Authentik autentica e o ContrataFlow autoriza
 * (authentication.md P1) — perfis e vínculos por tenant vivem no banco da aplicação.
 */
export function renderUsersBlueprint(): string {
  const lines = [
    '# GERADO por `pnpm env:blueprint` a partir de tools/env/seed/dataset.ts — não edite à mão.',
    '# Usuários de desenvolvimento (um por persona de DEC-035 em cada tenant semeado — US-078).',
    '# A senha vem de CF_DEV_USER_PASSWORD (.env); nenhum segredo neste arquivo (RN-FND-19).',
    'version: 1',
    'metadata:',
    `  name: ${quote('ContrataFlow — usuários de desenvolvimento')}`,
    '  labels:',
    `    blueprints.goauthentik.io/description: ${quote('Usuários por persona dos tenants semeados (US-078). Somente ambiente local/CI.')}`,
    'entries:',
    '  - model: authentik_core.group',
    '    id: group-dev',
    '    identifiers:',
    `      name: ${quote(DEV_GROUP_NAME)}`,
  ];

  for (const persona of PERSONA_KEYS) {
    lines.push(
      '  - model: authentik_core.group',
      `    id: group-${personaSlug(persona)}`,
      '    identifiers:',
      `      name: ${quote(personaGroupName(persona))}`,
    );
  }

  for (const user of seedUsers()) {
    lines.push(
      '  - model: authentik_core.user',
      '    identifiers:',
      `      username: ${quote(user.username)}`,
      '    attrs:',
      `      name: ${quote(user.name)}`,
      `      email: ${quote(user.email)}`,
      `      path: ${quote(SEED_USER_PATH)}`,
      '      type: internal',
      '      is_active: true',
      '      password: !Env CF_DEV_USER_PASSWORD',
      '      groups:',
      '        - !KeyOf group-dev',
      `        - !KeyOf group-${personaSlug(user.persona)}`,
    );
  }

  return `${lines.join('\n')}\n`;
}
