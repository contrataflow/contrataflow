// Violação: platform-transaction-allowlist (transação sem tenant fora de identity/tenancy).
import { PlatformTransaction } from '../../../shared/database/platform-transaction.js';

export const transaction = PlatformTransaction;
