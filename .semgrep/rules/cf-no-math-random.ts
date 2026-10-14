// Casos de teste da regra (semgrep --test .semgrep/rules).
import { randomUUID } from 'node:crypto';

export function resetToken() {
  // ruleid: cf-no-math-random
  const weak = Math.random().toString(36).slice(2);
  // ok: cf-no-math-random
  const strong = randomUUID();
  return [weak, strong];
}
