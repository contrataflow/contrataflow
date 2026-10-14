// pnpm env:blueprint — regenera o blueprint de usuários do Authentik a partir do dataset do seed.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../lib/workspace.js';
import { renderUsersBlueprint, USERS_BLUEPRINT_FILE } from './seed/blueprint.js';

writeFileSync(path.join(REPO_ROOT, USERS_BLUEPRINT_FILE), renderUsersBlueprint());
console.log(`✔ ${USERS_BLUEPRINT_FILE} atualizado.`);
