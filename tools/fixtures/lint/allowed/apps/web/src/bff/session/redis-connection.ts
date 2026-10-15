import 'server-only';

import { Redis } from 'ioredis';

export const sessions = new Redis();
