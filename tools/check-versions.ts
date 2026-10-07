// pnpm check:versions — política de versões fixadas (RN-FND-01 · V-02 · V-08).
import { checkRepository, formatViolation } from './lib/versions.js';
import { REPO_ROOT } from './lib/workspace.js';

const violations = checkRepository(REPO_ROOT);

if (violations.length === 0) {
  console.log('✔ check:versions — todas as dependências usam versões exatas do catálogo.');
} else {
  for (const violation of violations) console.error(formatViolation(violation));
  console.error(
    `\n✖ check:versions — ${violations.length} violação(ões). Veja CONTRIBUTING.md §Dependências.`,
  );
  process.exitCode = 1;
}
