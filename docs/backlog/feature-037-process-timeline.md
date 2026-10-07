---
id: FT-037
title: "Timeline do processo"
epic: EP-010
mvp: 1
priority: P0
stories: [US-059, US-060]
status: Especificada
---

# FT-037 — Timeline do processo

## Título
Timeline do processo

## Épico
EP-010 — Timeline

## Descrição
A feature entrega a narrativa cronológica do processo de contratação: de um lado, a projeção síncrona que transforma eventos de domínio em entradas de timeline legíveis e idempotentes (US-059); de outro, a leitura paginada dessas entradas na aba "Timeline" de SCR-006, com filtros por grupo, autor e período, agrupada por dia (US-060).

## Valor para o usuário e para o órgão
- Reduz o tempo para entender "o que aconteceu" em um processo, sem abrir tramitação, documentos e aprovações separadamente.
- Mantém uma narrativa estável mesmo quando nomes de pessoas, unidades ou documentos mudam depois (nomes congelados no momento do fato).
- Preserva o sigilo orçamentário (POL-09) sem exigir telas ou permissões adicionais.

## Personas
- Requisitante (`REQUISITANTE`) — acompanha o próprio processo.
- Gestor de Contratações (`GESTOR_CONTRATACOES`) — entende o histórico ao assumir um processo.
- Autoridade/aprovador — revisa o que levou à aprovação pendente.
- Planejamento / Controle Interno (`PLANEJAMENTO`) — consulta a narrativa sem acessar auditoria técnica.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-059 | Projetar eventos do processo na timeline | P0 | M | US-082 |
| US-060 | Visualizar timeline com filtros | P0 | M | US-059 |

## Escopo
- Projeção síncrona, idempotente e com nomes congelados dos eventos de domínio do processo (US-059).
- Consulta paginada por cursor com filtros de grupo/autor/período e agrupamento visual por dia (US-060).
- Aplicação da visibilidade orçamentária sigilosa (POL-09) tanto na escrita (`visibility`) quanto na leitura (exclusão de `BUDGET_RESTRICTED`).

## Fora de escopo
- Auditoria de conformidade (`AuditLog`) — outro épico.
- Notificações derivadas dos mesmos eventos — consumidor assíncrono próprio (events.md §6).
- Exportação ou busca textual na timeline — não previstas no MVP 1.

## Regras de negócio da feature
- RN-TML-01 a RN-TML-08 (US-059) — mapeamento evento→tipo, idempotência, nomes congelados, visibilidade na escrita.
- RN-TML-09 a RN-TML-16 (US-060) — paginação por cursor, filtros, visibilidade na leitura, agrupamento por dia, meta de performance.

## Telas
- SCR-006 — Detalhe do processo, aba "Timeline" (`/processos/[id]`)

## Endpoints
- `PRC-12` `GET /api/v1/processes/{id}/timeline` — lista paginada e filtrável da timeline do processo (US-060).

## Entidades
- `ProcessTimelineEntry` — registro imutável de cada entrada da narrativa (dono da feature).

## Eventos
- Consome (não publica) os eventos mapeados em events.md §5 — tabela completa na RN-TML-02 de US-059.

## Permissões
- `PROCESS_VIEW` — acesso à timeline padrão do processo.
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — acesso às entradas `BUDGET_RESTRICTED` (POL-09).

## Dependências
- **Features/épicos:** EP-015 (Fundação — outbox, RLS, autorização).
- **Stories:** US-082 (outbox).

## Critérios de aceite da feature
```gherkin
Feature: Timeline do processo
  Scenario: Jornada ponta a ponta — do evento à visualização
    Given que o processo "0012/2026" está ativo no tenant "Prefeitura de São José"
    When o processo for encaminhado para a próxima etapa
    Then uma entrada de timeline do tipo "PROCESS_FORWARDED" deve ser gravada de forma síncrona e idempotente
    And qualquer usuário com "PROCESS_VIEW" sobre o processo deve conseguir ver essa entrada na aba "Timeline" de "/processos/{id}", agrupada no dia correspondente
```

## Métricas de sucesso
- p95 de `GET /processes/{id}/timeline` < 300 ms.
- 0 entradas de timeline duplicadas por reprocessamento de evento.

## Riscos
- Tabela de mapeamento evento→tipo desatualizada conforme novos eventos são criados em outros épicos — mitigado por checklist de Definition of Done e teste de cobertura.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
