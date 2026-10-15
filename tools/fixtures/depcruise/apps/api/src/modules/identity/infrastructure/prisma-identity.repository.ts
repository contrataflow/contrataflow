// Uso legítimo: adaptador de identity lendo users/cf_user_memberships sem tenant (US-087).
import { PlatformTransaction } from '../../../shared/database/platform-transaction.js';

export const transaction = PlatformTransaction;
