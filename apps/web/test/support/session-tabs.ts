// Simula outra aba no canal `cf-session` (cada aba ignora as próprias mensagens — US-088).
import { SESSION_CHANNEL } from '@/lib/session/session-channel';
import type { SessionEvent } from '@/lib/session/session-channel';

export function postFromOtherTab(event: SessionEvent): void {
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ ...event, source: 'outra-aba' });
  channel.close();
}
