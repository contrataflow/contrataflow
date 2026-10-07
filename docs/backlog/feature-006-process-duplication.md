---
id: FT-006
title: "Duplicar processo"
epic: EP-001
mvp: 1
priority: P1
stories: [US-011]
status: Especificada
---

# FT-006 — Duplicar processo

## Título
Duplicar processo

## Épico
EP-001 — Processo de contratação

## Descrição
Duplicação de um processo existente para abrir um novo, reaproveitando metadados, itens e etiquetas e, opcionalmente, o conteúdo de documentos estruturados (como novos rascunhos) e anexos — sem copiar número, aprovações, tramitações, timeline, comentários, auditoria ou participantes.

## Valor para o usuário e para o órgão
- Reaproveita contratações recorrentes (ex.: a mesma aquisição todo ano) sem redigitar do zero.

## Personas
- Gestor de contratações.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-011 | Duplicar processo | P1 | M | US-001, US-065 |

## Escopo
- Diálogo com as opções `copyDocuments`/`copyAttachments`; novo processo com as mesmas regras de criação da US-001.

## Fora de escopo
- Cópia de cotações de pesquisa de preços (nunca copiadas).
- Edição do processo duplicado — FT-004.

## Regras de negócio da feature
- RN-PROC-118 a RN-PROC-125 (US-011): o que é sempre copiado, o que nunca é copiado, cópia condicional de documentos/anexos, `duplicatedFromId` imutável, permissões cruzadas (`PROCESS_DUPLICATE` + `PROCESS_CREATE`).

## Telas
- SCR-113 — Duplicar processo (diálogo em SCR-006)

## Endpoints
- PRC-27 `POST /processes/{id}/duplicate`

## Entidades
- `Process` (novo, com `duplicatedFromId`), `ProcessItem`, `ProcessTag`, `Document` (cópia condicional)

## Eventos
- `ProcessCreated`, `ProcessDuplicated`, `DocumentCreated`

## Permissões
- `PROCESS_DUPLICATE` (sobre a origem) + `PROCESS_CREATE` (sobre a unidade solicitante do novo processo)

## Dependências
- US-001 (regras de criação), US-065 (pré-requisito funcional indicado no backlog do épico).
- Decisões: DEC-017, DEC-028, DEC-032, DEC-033, DEC-034, DEC-055, DEC-105.

## Critérios de aceite da feature
```gherkin
Feature: Duplicar processo
  Scenario: Duplicar com documentos e anexos
    Given que o processo "0012/2026" está "COMPLETED" e "Carla" tem "PROCESS_DUPLICATE" e "PROCESS_CREATE"
    When ela duplicar o processo marcando "copyDocuments" e "copyAttachments"
    Then um novo processo deve ser criado com número próprio e "duplicatedFromId" apontando para "0012/2026"
    And os documentos estruturados elegíveis devem existir como novos rascunhos no novo processo
```

## Métricas de sucesso
- Redução do tempo de abertura de contratações recorrentes (medida junto de E1 — tempo de ciclo do planejamento).

## Riscos
- Copiar dados desatualizados de um processo antigo — mitigado por usar sempre o conteúdo mais recente disponível (RN-PROC-120) e pela revalidação de referências na criação do novo processo.

## Definition of Done da feature
- [ ] US-011 concluída e aceita
- [ ] Jornada E2E (duplicar com e sem documentos/anexos) automatizada
- [ ] Documentação atualizada
