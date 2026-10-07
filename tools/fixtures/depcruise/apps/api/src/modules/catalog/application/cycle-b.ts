// Violação: no-circular.
import { a } from './cycle-a.js';

export const b = (): string => String(a);
