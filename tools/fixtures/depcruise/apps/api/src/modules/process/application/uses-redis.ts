// Violação: redis-only-in-cache-or-platform (RM-03).
import Redis from 'ioredis';

export const client = Redis;
