import { SettingsView } from '@/features/settings/settings-view';

/**
 * SCR-041 — Administração › Configurações (US-103). As chaves são lidas no cliente com o `SET-01`:
 * só quem tem `SETTINGS_MANAGE` recebe os dados, e a própria tela trata o 403 (a API é quem decide
 * — RN-FND-92).
 */
export default function SettingsPage() {
  return <SettingsView />;
}
