// Violação: contrataflow/no-direct-redis (cliente Redis sem o TenantCache — RM-03).
import Redis from 'ioredis';

export const cache = new Redis();
