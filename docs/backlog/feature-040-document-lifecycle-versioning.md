---
id: FT-040
title: "Ciclo de vida e versões"
epic: EP-011
mvp: 1
priority: P0
stories: [US-065, US-066]
status: Especificada
---

# FT-040 — Ciclo de vida e versões

## Título
Ciclo de vida e versões

## Épico
EP-011 — Documentos

## Descrição
Implementa o `DocumentLifecycleService` único (DEC-018) — transições de status, cálculo de `meta.allowedActions`, verificação de documento singular por tipo e validação de completude (`DOC-08`, combinando regras genéricas com as do `DocumentValidator` de cada módulo tipado) — e o versionamento imutável com hash SHA-256 e comparação entre quaisquer duas versões.

## Valor para o usuário e para o órgão
- Todo documento do sistema (de qualquer `kind`) segue as mesmas regras de status, sem comportamento divergente por módulo.
- Histórico confiável de "quem mudou o quê", com versões que nunca são alteradas depois de criadas.

## Personas
- Redator/aprovador de documento — finaliza, submete, reabre, cancela e compara versões.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-065 | Ciclo de vida do documento | P0 | L | US-061, US-108 |
| US-066 | Versionamento imutável e comparação de versões | P0 | M | US-065 |

## Escopo
- Transições `DRAFT`/`RETURNED` → `FINALIZED`/`IN_REVIEW`, decisão de aprovação, reabertura, cancelamento, exclusão lógica antes da primeira submissão.
- Validação de completude (`DOC-08`) combinando seções/campos genéricos e regras específicas via `DocumentValidator`.
- Versão manual, listagem ordenada, comparação `header`/`sections`/`collections` com marcadores de mudança.

## Fora de escopo
- Regras de completude específicas de cada módulo tipado (`DFD_*`, `ETP_*`, `PRICE_*`, `RISK_*`, `TR_*`) — outros épicos.
- A decisão de aprovação em si (quem aprova, SLA) — módulo de aprovações, fora deste épico.

## Regras de negócio da feature
- **RN-DOC-41** — Toda transição de status é exclusiva do `DocumentLifecycleService`; nunca por `PATCH` direto.
- **RN-DOC-50** — `singletonKey` impede um segundo documento ativo do mesmo tipo singular no processo, mesmo sob concorrência.
- **RN-DOC-51/52** — `DOC-08` combina regras genéricas e do `DocumentValidator` tipado; `typedSummary` alimenta `DocumentFinalized`.
- **RN-DOC-54** — Auditoria de rascunho é coalescida (10 min); transições de status nunca são coalescidas.
- **RN-DOC-56/58** — Versão manual só em `DRAFT`/`RETURNED` para `STRUCTURED`/`FREE_TEXT`; `DocumentVersion` é imutável e sequencial sem lacunas.
- **RN-DOC-60/61** — Comparação marca `ADDED`/`REMOVED`/`CHANGED`/`UNCHANGED`/`MASKED` (POL-09) por campo/seção/coleção.

## Telas
- SCR-006, SCR-105 — ações de ciclo de vida no editor/painel.
- SCR-106 — Versões e comparação (`/processos/[id]/documentos/[docId]/versoes`).

## Endpoints
- DOC-04, DOC-08, DOC-09, DOC-10, DOC-11, DOC-12, DOC-13, DOC-14 — ciclo de vida.
- DOC-15, DOC-16, DOC-17, DOC-18 — versões e comparação.

## Entidades
- `Document`, `DocumentVersion` — dono desta feature.

## Eventos
- `DocumentSubmitted`, `DocumentFinalized`, `DocumentApproved`, `DocumentReturned`, `DocumentRejected`, `DocumentReopened`, `DocumentCanceled`, `DocumentVersionCreated`.

## Permissões
- `DOCUMENT_UPDATE`, `DOCUMENT_SUBMIT`, `DOCUMENT_REOPEN`, `DOCUMENT_CANCEL`.

## Dependências
- **Stories:** US-061 (`requiresApproval`/`approvalPolicy` do tipo), US-108 (modelos publicados). Consomem esta feature: FT-039 (`allowedActions`), FT-041 (PDF a partir da versão).
- **Decisões:** DEC-017, DEC-018, DEC-019, DEC-024, DEC-034, DEC-056, DEC-084.
- **Lacunas nas fontes canônicas:** formato de resposta de `DOC-18` (comparação) não está definido em api.md/entities.md; US-066 já propôs o contrato (`header`/`sections`/`collections` com marcadores), pendente de registro formal em api.md §3.

## Critérios de aceite da feature
```gherkin
Feature: Ciclo de vida e versões
  Scenario: Finalizar um documento cria uma versão imutável
    Given que o documento "Despacho 0007/2026" está em "DRAFT" e completo
    When o redator finalizar o documento
    Then o status deve passar a "FINALIZED"
    And uma "DocumentVersion" com "reason" "FINALIZATION" deve ser criada e nunca mais alterada
```

## Métricas de sucesso
- 100% das transições de status passam pelo `DocumentLifecycleService` (nenhum `PATCH` direto em produção).
- 0 versões com `contentHash` divergente do snapshot armazenado (verificação de fixidez).

## Riscos
- Validação de completude incorreta por falha na composição de `DocumentValidator` — mitigado por testes de contrato da porta/adaptador (US-065).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
