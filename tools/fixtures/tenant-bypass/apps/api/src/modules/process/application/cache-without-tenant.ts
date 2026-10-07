import Redis from 'ioredis';

const redis = new Redis();

export function cacheProcess(processId: string, payload: string): Promise<unknown> {
  return redis.set(`process:${processId}`, payload);
}
