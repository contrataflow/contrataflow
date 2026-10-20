import { CalendarView } from '@/features/calendar/calendar-view';

/**
 * SCR-110 — Administração › Calendário (US-106). Os feriados são lidos no cliente com o `CAL-01`
 * (leitura é capacidade implícita do vínculo ativo); as ações de escrita dependem de
 * `CALENDAR_MANAGE`, e é a API quem decide (RN-FND-92).
 */
export default function CalendarPage() {
  return <CalendarView />;
}
