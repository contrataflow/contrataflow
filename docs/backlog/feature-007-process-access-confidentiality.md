---
id: FT-007
title: "Acesso e sigilo"
epic: EP-001
mvp: 1
priority: P1
stories: [US-012, US-013]
status: Especificada
---

# FT-007 — Acesso e sigilo

## Título
Acesso e sigilo

## Épico
EP-001 — Processo de contratação

## Descrição
Acesso explícito e sigilo no processo: participantes (observador, colaborador, consultor) que recebem visibilidade e, para alguns papéis, capacidade de colaborar sem assumir a custódia (US-012); e o controle de sigilo do orçamento estimado exigido pelo art. 24 da Lei 14.133/2021, com máscara central de valores e preservação do acesso dos órgãos de controle (US-013).

## Valor para o usuário e para o órgão
- Permite incluir consultores externos e interessados pontuais sem comprometer a segregação de funções (DEC-036).
- Cumpre a exigência legal de sigilo do orçamento sem perder o controle interno/externo nem a rastreabilidade (art. 24, parágrafo único, I).

## Personas
- Gestor de contratações, Área requisitante, Planejamento (`PROCESS_MANAGE_PARTICIPANTS`) — gerenciam participantes.
- Autoridade competente — também define o sigilo do orçamento.
- Controle Interno, Auditor — veem valores mesmo sigilosos.
- Consultoria externa — participa como consultor, com validade.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-012 | Gerenciar participantes do processo | P1 | M | US-001, US-097 |
| US-013 | Sigilo do orçamento estimado | P1 | M | US-001, US-097 |

## Escopo
- Conceder/revogar participação (observador, colaborador, consultor); seguir/deixar de seguir; expiração automática de consultores.
- Ativar/desativar o sigilo do orçamento; máscara central de valores; cascata para documentos de pesquisa de preços.

## Fora de escopo
- Qualquer ação de tramitação ou aprovação por participantes (DEC-036) — permanece em EP-008.
- Mascaramento específico de cada módulo de documento (pesquisa, ETP, TR) — aplicado nas respectivas stories, reaproveitando a mesma política central (POL-09).

## Regras de negócio da feature
- RN-PROC-126 a RN-PROC-136 (US-012): unicidade de participante ativo, elegibilidade por papel (POL-10), idempotência do "seguir", expiração automática.
- RN-PROC-137 a RN-PROC-145 (US-013): máscara central (POL-09), cascata para documentos de pesquisa, acesso preservado de Controle Interno/Auditor (art. 24, I), auditoria de visualização.

## Telas
- SCR-112 — Participantes do processo (aba em SCR-006)
- SCR-006 — Detalhe do processo (botão "Seguir" e interruptor "Orçamento sigiloso")

## Endpoints
- PRC-28, PRC-29, PRC-30, PRC-31, PRC-32 — participantes e seguir/deixar de seguir
- PRC-33 `PUT /processes/{id}/confidentiality` — definir sigilo do orçamento

## Entidades
- `ProcessParticipant`, `ProcessAccess` (US-012)
- `Process.isBudgetConfidential`, `Document.confidentiality` (US-013)

## Eventos
- `ProcessParticipantAdded`, `ProcessParticipantRemoved`, `ProcessConfidentialityChanged`

## Permissões
- `PROCESS_MANAGE_PARTICIPANTS`, `PROCESS_FOLLOW`, `PROCESS_SET_CONFIDENTIAL_BUDGET`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Dependências
- US-001, US-097 (ambas as stories).
- Decisões: DEC-024, DEC-030, DEC-036, DEC-055, DEC-104, DEC-105, DEC-106.

## Critérios de aceite da feature
```gherkin
Feature: Acesso e sigilo
  Scenario: Incluir um consultor e tornar o orçamento sigiloso
    Given que o processo "0012/2026" pertence à "Secretaria de Obras"
    When "Carla" adicionar "Diego" (vínculo externo) como "Consultor" com validade de 30 dias
    And "Carla" marcar o orçamento do processo como sigiloso
    Then "Diego" deve ver e comentar o processo, mas não o valor estimado
    And apenas quem tem a permissão específica, custódia ou é dos órgãos de controle deve ver o valor real
```

## Métricas de sucesso
- 0 vazamentos de valor sigiloso detectados em auditoria (alinhado ao KPI C5 — incidentes de isolamento).
- 100% das participações expiradas revogadas automaticamente pelo job `participants-expire` dentro do SLA diário.

## Riscos
- Uso de participante para contornar a custódia — mitigado por DEC-036/POL-02 (RN-PROC-131/RN-PROC-132).
- Vazamento de orçamento sigiloso em canal secundário (PDF, exportação, notificação) — mitigado por POL-09 aplicada centralmente (RL-04).

## Definition of Done da feature
- [ ] US-012 e US-013 concluídas e aceitas
- [ ] Jornada E2E (participante + sigilo) automatizada
- [ ] Documentação atualizada
