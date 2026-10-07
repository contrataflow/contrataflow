---
id: FT-003
title: "Painel do processo"
epic: EP-001
mvp: 1
priority: P0
stories: [US-004]
status: Especificada
---

# FT-003 — Painel do processo

## Título
Painel do processo

## Épico
EP-001 — Processo de contratação

## Descrição
Painel situacional do processo (DEC-180): ao abrir o detalhe, o usuário sabe, sem cliques, onde o processo está, quem é o responsável, o que falta, o próximo passo, se está atrasado, quais documentos existem e quais aprovações estão pendentes. Esta feature entrega a estrutura da tela (cabeçalho, barra de ações, painel, stepper, abas); o conteúdo de cada aba é entregue por outras stories/épicos.

## Valor para o usuário e para o órgão
- Acaba com o "onde está o processo?" por telefone.
- Reduz a necessidade de treinamento: a tela sempre orienta a próxima ação.

## Personas
- Qualquer servidor que acompanha ou conduz um processo.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-004 | Visualizar detalhe do processo com painel situacional | P0 | L | US-001, US-041 |

## Escopo
- Cabeçalho, barra de ações (`available-actions`), painel das 7 perguntas (`summary`), checklist, stepper de etapas, navegação por abas.

## Fora de escopo
- Conteúdo de cada aba (Documentos, Itens, Tramitação, Timeline, Comentários, Participantes) — entregue pelas stories donas.

## Regras de negócio da feature
- RN-PROC-47 a RN-PROC-58 (US-004): visibilidade (404, nunca 403), as 7 perguntas, ação primária, ações disponíveis com `reasons[]`, checklist fail-closed, stepper, badges de prazo, mascaramento de sigilo, consistência transacional, performance (p95 < 500 ms).

## Telas
- SCR-006 — Detalhe do processo (`/processos/[id]`)

## Endpoints
- PRC-04 `GET /processes/{id}`
- PRC-07 `GET /processes/{id}/summary`
- PRC-08 `GET /processes/{id}/available-actions`
- PRC-09 `GET /processes/{id}/checklist`
- PRC-10 `GET /processes/{id}/stages`

## Entidades
- `Process`, `ProcessStage` — consulta
- `Document`, `Approval` — resumo, somente leitura

## Eventos
- Nenhum evento próprio (consulta); a UI refaz as consultas após qualquer comando.

## Permissões
- `PROCESS_VIEW`, `PROCESS_VIEW_CONFIDENTIAL_BUDGET`

## Dependências
- US-001 (processo e runtime da etapa), US-041 (motor de regras: transições disponíveis e avaliação).
- Decisões: DEC-013, DEC-014, DEC-016, DEC-023, DEC-024, DEC-030, DEC-031, DEC-102, DEC-134, DEC-180, DEC-181, DEC-183, DEC-184.

## Critérios de aceite da feature
```gherkin
Feature: Painel do processo
  Scenario: Responder às 7 perguntas sem cliques
    Given que o processo "0012/2026" está "AWAITING_APPROVAL" com uma aprovação pendente
    When "Bruno" abrir o detalhe do processo
    Then o painel deve mostrar a etapa atual, o aprovador designado, o que falta, a ação primária, o prazo, os documentos e a aprovação pendente
```

## Métricas de sucesso
- C2 — latência p95 do painel situacional ≤ 800 ms.

## Riscos
- Falha na avaliação de uma regra do checklist mascarando uma pendência real — mitigado por fail-closed (item tratado como não satisfeito).

## Definition of Done da feature
- [ ] US-004 concluída e aceita
- [ ] Jornada E2E (abrir processo → painel completo) automatizada
- [ ] Documentação atualizada
