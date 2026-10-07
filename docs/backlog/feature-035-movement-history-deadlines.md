---
id: FT-035
title: "Registro e prazos"
epic: EP-008
mvp: 1
priority: P0
stories: [US-054, US-055]
status: Especificada
---

# FT-035 — Registro e prazos

## Título
Registro e prazos

## Épico
EP-008 — Tramitação

## Descrição
Cobre a consulta do histórico completo e imutável de tramitações do processo (aba "Tramitação" de SCR-006) e o cálculo do prazo de cada etapa em dias úteis — com aviso de vencimento próximo e detecção automática de atraso por um job periódico. O histórico apenas lê os `ProcessMovement` já gravados pelas demais features do épico; os prazos são calculados na entrada de cada etapa e reavaliados pela suspensão/retomada do processo.

## Valor para o usuário e para o órgão
- Reconstrói a linha do tempo completa do processo sem depender de memória ou de registros físicos, para prestação de contas.
- Dá visibilidade objetiva e automática sobre atrasos de etapa, antes que eles se acumulem.

## Personas
- Qualquer pessoa com visibilidade do processo — consulta o histórico de tramitações (US-054).
- Responsável pela etapa ou titular da unidade — recebe avisos de prazo próximo e de atraso (US-055).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-054 | Histórico de tramitações | P0 | M | US-047 |
| US-055 | Prazos em dias úteis e detecção de atrasos | P0 | M | US-047, US-083, US-106 |

## Escopo
- Listagem paginada (por cursor) e filtrável de `ProcessMovement`, com o campo `ip` restrito a quem tem `AUDIT_VIEW`.
- Cálculo de `dueAt` na entrada de cada etapa (dias úteis ou corridos, via calendário do tenant), com sobrescrita apenas quando a transição usada permitir.
- Pausa e retomada da contagem de prazo durante a suspensão do processo.
- Job `deadlines` (ciclo de 15 minutos, com lock distribuído) emitindo `ProcessStageDueSoon` e `ProcessStageOverdue` de forma idempotente.

## Fora de escopo
- Geração dos `ProcessMovement` consultados por esta feature — FT-031 a FT-034.
- Atraso do processo por `targetDate` (indicador de planejamento, distinto do atraso de etapa — DEC-031).

## Regras de negócio da feature
- RN-TRAM-72 a RN-TRAM-77 — US-054.
- RN-TRAM-78 a RN-TRAM-85 — US-055.

## Telas
- SCR-006 — Detalhe do processo, aba Tramitação (`/processos/[id]`)

## Endpoints
- PRC-11 `GET /processes/{id}/movements` — histórico de tramitações
- CAL-06 `POST /calendar/add-business-days` — cálculo de dias úteis

## Entidades
- `ProcessMovement` — consulta somente leitura, registro imutável (consumida)
- `ProcessStage` — campos `dueAt`, `overdueSince`, `pausedAt`, `pausedTotalSeconds`, `dueSoonNotifiedAt`, `overdueNotifiedAt` (dono dos campos de prazo)

## Eventos
- `ProcessStageDueSoon` — aviso de vencimento próximo, emitido pelo job `deadlines`
- `ProcessStageOverdue` — detecção de atraso, emitido pelo job `deadlines`

## Permissões
- `PROCESS_VIEW` — consultar histórico e prazos de etapa
- `AUDIT_VIEW` — ver o campo `ip` de cada tramitação (RN-TRAM-74)

## Dependências
- Stories: US-047 (origem do primeiro movimento tramitável), US-048/US-049/US-050/US-052/US-053 (demais ações já registradas no histórico), US-073 (auditoria e `AUDIT_VIEW`), US-083 (infraestrutura de notificações), US-106 (calendário de dias úteis), US-008 (suspender/retomar, consome `pausedAt`/`pausedTotalSeconds`).
- Decisões/ADRs: DEC-010, DEC-013, DEC-014, DEC-015, DEC-024, DEC-031.
- Configurações: `deadlines.warnBeforeBusinessDays` (padrão 2), `calendar.optionalHolidaysAreNonBusiness` (padrão `false`).

## Critérios de aceite da feature
```gherkin
Feature: Registro e prazos
  Scenario: Detectar atraso de etapa e notificar uma única vez
    Given uma "ProcessStage" "ACTIVE" com "dueAt" no passado e "overdueSince" nulo
    When o job "deadlines" executar seu ciclo
    Then a etapa deve receber "overdueSince" preenchido e o evento "ProcessStageOverdue" deve ser emitido uma única vez
```

## Métricas de sucesso
- 100% das etapas com prazo vencido são marcadas com `overdueSince` em até um ciclo do job (15 minutos) após o vencimento.

## Riscos
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Múltiplas instâncias do worker duplicarem avisos de prazo | Baixa | Médio | Lock distribuído por ciclo (RN-TRAM-85) e idempotência por `dueSoonNotifiedAt`/`overdueNotifiedAt` |

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
