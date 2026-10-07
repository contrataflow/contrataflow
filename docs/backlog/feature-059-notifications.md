---
id: FT-059
title: "Notificações"
epic: EP-019
mvp: 1
priority: P0
stories: [US-111, US-112, US-113, US-114]
status: Especificada
---

# FT-059 — Notificações

## Título
Notificações

## Épico
EP-019 — Notificações

## Descrição
A feature entrega o caminho completo de um aviso: um evento de domínio qualquer (devolução de processo, aprovação pendente, menção, atraso de etapa etc.) é traduzido pelo registro `NotificationType` (events.md §6) em uma notificação in-app e, quando elegível, em e-mail — sem duplicidade, sem vazar dados sigilosos e sem notificar quem não deveria.

Além do motor genérico e dos canais, a feature dá ao usuário controle sobre o que recebe (preferências por tipo/canal) e cobre o caso de negócio mais sensível a atraso silencioso: o vencimento e o atraso de prazo de etapa, com escalonamento à chefia da unidade.

## Valor para o usuário e para o órgão
- Reduz o tempo entre "algo aconteceu no processo" e "a pessoa certa sabe disso" de horas/dias (hoje informal) para menos de 1 minuto.
- Dá suporte ao controle tempestivo de prazos exigido pelo art. 169 da Lei 14.133/2021, tornando o atraso visível para o responsável e para a chefia, não só para quem consulta o painel.
- Evita fadiga de notificação: cada usuário decide quais avisos quer por e-mail, mantendo apenas os obrigatórios (segurança e bloqueios de trabalho) sempre ativos.

## Personas
- Qualquer usuário com vínculo ativo (`todos os perfis`) — recebe e gerencia seus próprios avisos.
- Responsável por etapa / titular de unidade — recebe os lembretes de prazo e os alertas de atraso.
- Administrador do órgão — controla `notifications.emailEnabled` para o tenant.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-111 | Central de notificações in-app | P0 | M | US-083, US-086 |
| US-112 | E-mails transacionais | P0 | M | US-078, US-083 |
| US-113 | Preferências de notificação | P2 | S | US-111 |
| US-114 | Lembretes de prazo e alertas de atraso | P1 | M | US-055, US-111, US-112 |

## Escopo
- Motor de despacho genérico (`NotificationDispatcher`) orientado pelo registro `NotificationType`.
- Central in-app: sininho, lista paginada, contagem de não lidas, marcação de leitura e arquivamento.
- Envio de e-mail transacional (`EmailSender`) com templates pt-BR, retentativas e registro de falha; mesma infraestrutura usada pelo envio técnico do convite de usuário.
- Preferências de notificação por `(tipo, canal)`, com trava para tipos obrigatórios.
- Lembretes de vencimento próximo e alertas de atraso de etapa, com escalonamento ao titular da unidade.

## Fora de escopo
- Cálculo de `dueAt` e detecção de vencimento/atraso (EP-010/tramitação, US-055).
- Conteúdo e disparo do e-mail de convite de usuário (EP-016/identidade, US-091).
- Notificações push nativas, digest periódico e webhooks externos (fora do MVP 1).

## Regras de negócio da feature
- Nunca notificar o próprio ator; respeitar a visibilidade do processo (DEC-024); nunca incluir dados sigilosos (POL-09) — RN-NTF-02, RN-NTF-06, RN-NTF-07.
- Idempotência por `(tenant_id, recipient_id, source_event_id, type)` e agrupamento de eventos iguais em 5 minutos — RN-NTF-03, RN-NTF-04.
- E-mail só quando `notifications.emailEnabled` (tenant) e a preferência do usuário permitirem; tipos obrigatórios nunca têm o canal `IN_APP` desativado — RN-NTF-05, RN-NTF-23.
- Atraso de etapa notifica responsável **e** titular da unidade (sem duplicar se forem a mesma pessoa) — RN-NTF-27, RN-NTF-28.

## Telas
- SCR-036 — Notificações (`/notificacoes`)
- SCR-039 — Perfil, aba Notificações (`/perfil`)

## Endpoints
- NTF-01 `GET /api/v1/notifications` — lista paginada por cursor
- NTF-02 `GET /api/v1/notifications/unread-count` — contagem de não lidas
- NTF-03 `POST /api/v1/notifications/{id}/read` — marcar como lida
- NTF-04 `POST /api/v1/notifications/read-all` — marcar todas como lidas
- NTF-05 `POST /api/v1/notifications/{id}/archive` — arquivar
- ME-05 `GET /api/v1/me/notification-preferences` — ler preferências
- ME-06 `PUT /api/v1/me/notification-preferences` — atualizar preferências

## Entidades
- `Notification` — registro de cada aviso, canais e status de e-mail.
- `NotificationPreference` — preferência do usuário por `(tipo, canal)`.

## Eventos
- `ProcessStageDueSoon` / `ProcessStageOverdue` — acionam os lembretes de prazo (US-114).
- Demais eventos do catálogo mapeados em `NotificationType` (events.md §6) — acionam o despacho genérico (US-111).
- Nenhum evento de domínio é produzido por esta feature.

## Permissões
- Nenhuma permissão própria no catálogo; capacidade implícita sobre o próprio recurso (padrão `ME-*`/`NTF-*`).

## Dependências
- **Features/stories:** EP-015 (outbox, filas, auditoria, RLS); US-055 (prazos e atraso); US-091 (convite de usuário, infraestrutura de e-mail compartilhada).
- **Decisões/ADRs:** DEC-024, DEC-050, DEC-161, DEC-163, DEC-138.

## Critérios de aceite da feature
```gherkin
Feature: Notificações — jornada ponta a ponta

  Scenario: Processo devolvido gera aviso in-app e e-mail, respeitando a preferência do usuário
    Given que "Fábio" tem vínculo ativo e preferência de e-mail ativada para "PROCESS_RETURNED"
    When o processo sob sua responsabilidade for devolvido
    Then "Fábio" deve ver a notificação "PROCESS_RETURNED" no sininho em até 1 minuto
    And deve receber o e-mail correspondente em até 5 minutos
    And nenhum dado sigiloso do processo deve aparecer no título, no corpo ou no e-mail
```

## Métricas de sucesso
- p95 do tempo entre evento e notificação in-app < 1 min.
- ≥ 99% dos e-mails elegíveis entregues em até 5 min.
- < 1% dos eventos `STAGE_OVERDUE` sem destinatário resolvido.

## Riscos
- Pico de eventos atrasando as filas `notifications`/`email` — mitigado por alertas de fila e *circuit breaker* (queues.md §12).
- Novo tipo de notificação sem template de e-mail — mitigado por teste cobrindo 100% do registro `NotificationType`.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas (US-111, US-112, US-114); US-113 (P2) concluída conforme priorização do backlog
- [ ] Jornada E2E da feature automatizada (evento → notificação → e-mail)
- [ ] Documentação atualizada
