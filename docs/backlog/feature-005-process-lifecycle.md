---
id: FT-005
title: "Ciclo de vida do processo"
epic: EP-001
mvp: 1
priority: P0
stories: [US-008, US-009, US-010]
status: Especificada
---

# FT-005 — Ciclo de vida do processo

## Título
Ciclo de vida do processo

## Épico
EP-001 — Processo de contratação

## Descrição
Ciclo de vida macro do processo além da tramitação: suspender e retomar (pausa formal com prazos congelados), cancelar ou descartar (encerramento antes do fim) e concluir (fim da fase preparatória, manual ou automático ao entrar na etapa final).

## Valor para o usuário e para o órgão
- Formaliza paralisações (ex.: decisão de tribunal de contas) sem que prazos corram ou alguém decida indevidamente.
- Encerra demandas que não devem seguir, com motivo registrado, sem perder o histórico.
- Marca o fim do planejamento com rastreabilidade completa, manual ou automaticamente.

## Personas
- Gestor de contratações e Autoridade competente — suspender, cancelar, concluir.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-008 | Suspender e retomar processo | P1 | M | US-047, US-055 |
| US-009 | Cancelar processo ou descartar rascunho | P0 | M | US-001, US-051 |
| US-010 | Concluir processo (planejamento da contratação) | P0 | M | US-047, US-052 |

## Escopo
- Transições de status `SUSPENDED` ↔ (status anterior), → `CANCELED`, → `COMPLETED`, e exclusão lógica do rascunho sem número.
- Extensão de prazo na retomada; cancelamento de aprovações pendentes; conclusão automática via aprovação.

## Fora de escopo
- Reabertura de processo `COMPLETED`/`CANCELED` (PEND-03) e publicação (`PUBLISHED`, MVP 3).

## Regras de negócio da feature
- RN-PROC-93 a RN-PROC-102 (US-008): status de origem, motivo obrigatório, pausa e extensão de prazo, congelamento de ações.
- RN-PROC-103 a RN-PROC-110 (US-009): status permitidos, motivo, cancelamento de aprovações pendentes, descarte restrito a rascunho sem número.
- RN-PROC-111 a RN-PROC-117 (US-010): conclusão manual vs. automática, regras `BLOCKING`/`WARNING`, status final.

## Telas
- SCR-116 — Suspender, retomar, cancelar e concluir (diálogos em SCR-006)

## Endpoints
- PRC-23 `POST /processes/{id}/suspend`, PRC-24 `POST /processes/{id}/resume`
- PRC-25 `POST /processes/{id}/cancel`, PRC-06 `DELETE /processes/{id}` (descartar)
- PRC-26 `POST /processes/{id}/complete`

## Entidades
- `Process`, `ProcessStage`, `ProcessAssignment`, `Approval` (cancelada/congelada)

## Eventos
- `ProcessStatusChanged` (e especializações `ProcessSuspended`/`ProcessResumed`/`ProcessCanceled`/`ProcessCompleted`), `ApprovalCanceled`, `ProcessDraftDiscarded`

## Permissões
- `PROCESS_SUSPEND`, `PROCESS_CANCEL`, `PROCESS_COMPLETE`, `PROCESS_CREATE` (descarte pelo criador)

## Dependências
- US-047 (tramitação), US-055 (prazos/calendário), US-051/US-052 (aprovações), US-001.
- Decisões: DEC-013, DEC-015, DEC-018, DEC-024, DEC-031, DEC-034, DEC-055, DEC-104, DEC-105, DEC-132, DEC-161, DEC-162.

## Critérios de aceite da feature
```gherkin
Feature: Ciclo de vida do processo
  Scenario: Suspender, retomar e depois concluir
    Given que o processo "0012/2026" está "IN_PROGRESS"
    When "Carla" suspender com motivo e, dias depois, retomar
    Then o prazo da etapa deve ser estendido pelos dias úteis pausados
    When o processo alcançar a etapa final com todas as regras satisfeitas
    Then ele deve ser concluído, manual ou automaticamente, com "completedAt" registrado
```

## Métricas de sucesso
- 100% das suspensões e cancelamentos com motivo registrado; 0 alertas de prazo emitidos durante a suspensão.

## Riscos
- Congelamento incompleto permitindo ação indevida durante a suspensão — mitigado por POL-01/POL-02/POL-03/POL-08/POL-11 retornando `INVALID_PROCESS_STATUS` (RN-PROC-96).

## Definition of Done da feature
- [ ] US-008 (P1), US-009 e US-010 (P0) concluídas e aceitas
- [ ] Jornada E2E (suspender → retomar → concluir; cancelar; descartar) automatizada
- [ ] Documentação atualizada
