---
id: EP-019
title: "Notificações"
mvp: 1
priority: P0
features: [FT-059]
status: Especificado
---

# EP-019 — Notificações

## Título
Notificações

## Objetivo
Garantir que todo evento relevante do produto chegue à pessoa certa, pelo canal certo, sem ruído e sem atraso — fechando o ciclo que hoje depende de o usuário abrir o produto por conta própria ou ser avisado informalmente (corredor, WhatsApp, planilha paralela).

## Contexto e problema
- Hoje, processo recebido, devolução, aprovação pendente, menção, anexo rejeitado ou etapa atrasada só aparecem para quem abre o produto e olha a caixa de tarefas. Não há aviso proativo, e o atraso em particular é um risco de conformidade: o art. 169 da Lei 14.133/2021 exige controle e fiscalização tempestivos da tramitação, o que depende de alguém ser avisado a tempo (US-055 calcula o prazo; este épico entrega o aviso).
- O produto já define, de forma declarativa, quem deve ser avisado de cada evento de domínio e se há e-mail por padrão (registro `NotificationType`, events.md §6); faltava o motor que lê esse registro e o executa, mais os canais (in-app, e-mail) e o controle do próprio usuário sobre o que recebe.
- Decisões relacionadas: DEC-024 (visibilidade do processo), DEC-161/163 (outbox, filas e entrega *at-least-once*), DEC-138 (logs seguros), POL-09 (orçamento sigiloso nunca aparece em notificação).

## Escopo
- Central de notificações in-app: motor de despacho (`NotificationDispatcher`) que aplica o registro `NotificationType` a todo evento do catálogo, mais sininho, lista, contagem de não lidas, leitura e arquivamento (US-111).
- Envio de e-mails transacionais (`EmailSender`) para os tipos elegíveis, com templates pt-BR, retentativas e registro de falhas; infraestrutura também usada pelo e-mail de convite de usuário (US-112).
- Preferências de notificação por tipo e canal, respeitando os tipos obrigatórios (US-113).
- Lembretes de prazo e alertas de atraso de etapa, incluindo o escalonamento ao titular da unidade no atraso (US-114).
- O registro `NotificationType` (events.md §6) como contrato único entre qualquer módulo que produza eventos e este épico.

## Fora de escopo
- Cálculo de prazo em dias úteis e detecção de vencimento/atraso de etapa — pertence a EP-010/tramitação (US-055); este épico só reage aos eventos resultantes.
- Conteúdo e disparo do e-mail de convite de usuário — pertence a EP-016/identidade (US-091); este épico só garante a entrega técnica pela mesma infraestrutura de e-mail.
- Notificações push nativas de mobile/desktop (não há aplicativo nativo no MVP 1).
- Resumo/digest periódico de notificações (não solicitado no MVP 1).
- Webhooks para sistemas externos (previsto para MVP 3).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Qualquer usuário com vínculo ativo | todos os perfis | Saber o que precisa de atenção sem precisar abrir o produto por hábito ou perguntar a colegas |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Acompanhar aprovações, devoluções e atrasos da sua carteira de processos |
| Responsável por etapa / titular de unidade | perfis operacionais e chefias | Receber o aviso de prazo a vencer e o alerta de atraso (escalonamento) |
| Administrador do órgão | administração do tenant | Decidir se o e-mail está habilitado para o órgão (`notifications.emailEnabled`) e diagnosticar falhas de entrega |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-059 | Notificações | US-111, US-112, US-113, US-114 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-111 | Central de notificações in-app | P0 | M | 5 |
| US-112 | E-mails transacionais | P0 | M | 5 |
| US-113 | Preferências de notificação | P2 | S | 2 |
| US-114 | Lembretes de prazo e alertas de atraso | P1 | M | 5 |
| **Total** | | | | **17** |

## Módulos e entidades
- Módulos: `notification`
- Entidades: `Notification` (dono), `NotificationPreference` (dono); consome (leitura) `Process`, `ProcessStage`, `Department`, `User` de outros módulos.

## Telas
- SCR-036 — Notificações (`/notificacoes`)
- SCR-039 — Perfil, aba Notificações (`/perfil`)

## Integrações
- Interna: outbox → roteador de domain-events → filas `notifications` e `email` (DEC-161/163).
- Externa: provedor de e-mail (SMTP/Mailpit em desenvolvimento, Amazon SES em produção — DEC-050).

## Eventos principais
- Consome todo evento mapeado no registro `NotificationType` (events.md §6) — entre outros, `ProcessStageChanged`, `ProcessAssigned`, `ProcessStatusChanged`, `ApprovalRequested`, `ApprovalCompleted`/`Returned`/`Rejected`, `ApprovalReassigned`, `UserMentioned`, `CommentCreated`, `ProcessStageDueSoon`, `ProcessStageOverdue`, `ProcessParticipantAdded`, `AttachmentRejected`, `DocumentRenditionFailed`, `RoleAssigned`/`RoleRevoked`.
- Não produz eventos de domínio novos.

## Permissões envolvidas
- Nenhuma permissão própria no catálogo; endpoints são capacidade implícita sobre o próprio recurso (padrão `ME-*`/`NTF-*`, permissions.md §1.1).

## Regras configuráveis
- `notifications.emailEnabled` — liga/desliga o canal de e-mail para o tenant inteiro (padrão `true`).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo entre evento e notificação in-app | p95 < 1 min | métrica `notification_dispatched_total` / logs |
| Taxa de entrega de e-mail elegível | ≥ 99% em até 5 min | `email_sent_total` / `email_failed_total` |
| Eventos de atraso sem destinatário resolvido | < 1% dos eventos `STAGE_OVERDUE` | log `notification.deadline_recipient_missing` |
| Uso das preferências de notificação | acompanhar (sem meta no MVP 1) | log `notification_preferences.updated` |

## Dependências
- **Depende de:** EP-015 (fundação — outbox, filas, auditoria, RLS, identidade e tenancy).
- **Habilita:** EP-012 Comentários (as notificações `MENTIONED` e `COMMENT_REPLY` dependem deste épico para chegar ao usuário).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Filas `notifications`/`email` acumulam atraso em picos de eventos | Média | Médio | Alertas de fila (queues.md §12), *circuit breaker*, prioridades por tipo de job |
| Provedor de e-mail (SES) indisponível ou com reputação de domínio comprometida | Baixa | Alto | SPF/DKIM/DMARC corretos, monitoramento de bounce, retentativas com backoff |
| Novo `NotificationType` adicionado ao registro sem template de e-mail correspondente | Média | Baixo | Teste cobrindo 100% dos tipos do registro (US-111/US-112); alerta em `email.failed` por template ausente |

## Pontos em aberto
- Processamento automático de bounce/queixa via *webhook* do provedor de e-mail não está previsto no MVP 1 (ver US-112); hoje a falha é tratada manualmente pelo suporte a partir de `emailError`.
- Cache de curta duração para preferências de notificação, a avaliar se o volume de eventos por tenant exigir (otimização de US-113, não bloqueante).

## Definition of Done do épico
- [ ] Todas as features concluídas (FT-059)
- [ ] KPIs instrumentados (métricas de despacho e de entrega de e-mail)
- [ ] Testes E2E das jornadas do épico passando (evento → notificação in-app → e-mail; preferências; lembretes de prazo)
- [ ] Documentação e treinamento (guia do usuário) atualizados
