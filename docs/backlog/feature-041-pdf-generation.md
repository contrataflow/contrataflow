---
id: FT-041
title: "Geração de PDF"
epic: EP-011
mvp: 1
priority: P0
stories: [US-067]
status: Especificada
---

# FT-041 — Geração de PDF

## Título
Geração de PDF

## Épico
EP-011 — Documentos

## Descrição
Renderização assíncrona de PDF a partir do snapshot de uma versão (`CONTENT`, `APPROVAL_STAMPED`) ou do rascunho atual (`PREVIEW`, com marca d'água "RASCUNHO" e validade de 24 h), via worker `document-render` e Gotenberg, com hash SHA-256, contagem de páginas e SLO de latência.

## Valor para o usuário e para o órgão
- Qualquer documento pode ser lido, impresso ou assinado fisicamente fora da plataforma, com integridade verificável pelo hash no rodapé.
- Geração assíncrona evita travar a interface em documentos longos.

## Personas
- Redator, aprovador ou qualquer pessoa com acesso ao processo — solicita prévia ou PDF oficial.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-067 | Gerar PDF de documentos | P0 | L | US-066, US-083 |

## Escopo
- Pedido assíncrono (202) de `PREVIEW`/`CONTENT`/`APPROVAL_STAMPED`.
- Worker `document-render`: HTML sanitizado a partir do snapshot/layout, chamada ao Gotenberg, cálculo de hash/tamanho/páginas em trânsito.
- Classificação de erro (transitório × permanente), *circuit breaker*, fila `dead-letter`.
- Download por URL pré-assinada herdando `PROCESS_VIEW`/POL-09.

## Fora de escopo
- Assinatura eletrônica (`SIGNED`) — MVP 3.
- PDF/A-2b — PEND-09.

## Regras de negócio da feature
- **RN-DOC-63** — Três tipos de rendition: `PREVIEW` (rascunho, 24 h), `CONTENT` (por versão), `APPROVAL_STAMPED` (versão + aprovação).
- **RN-DOC-64** — Resposta sempre `202`; `DocumentRendition` `PENDING` criada na mesma transação do pedido.
- **RN-DOC-66** — Falhas transitórias tentam novamente (até 5, backoff exponencial); 4xx/snapshot ausente são permanentes.
- **RN-DOC-68** — `PREVIEW` nunca é assinado para download fora da validade de 24 h.
- **RN-DOC-69** — Download herda `PROCESS_VIEW`/POL-09 do documento; audita `document.download`.
- **RN-DOC-70** — SLO: `PREVIEW` p95 ≤ 15 s; `CONTENT`/`APPROVAL_STAMPED` p95 ≤ 30 s.

## Telas
- SCR-106 — Versões e comparação (`/processos/[id]/documentos/[docId]/versoes`).

## Endpoints
- DOC-20 `POST /documents/{id}/preview` — pede `PREVIEW`.
- DOC-21 `POST /document-versions/{versionId}/renditions` — pede `CONTENT`/`APPROVAL_STAMPED`.
- DOC-22 `GET /document-renditions/{renditionId}` — status.
- DOC-23 `GET /document-renditions/{renditionId}/download` — URL assinada.

## Entidades
- `DocumentRendition` — dono desta feature.

## Eventos
- `DocumentRenditionReady`, `DocumentRenditionFailed`.

## Permissões
- `PROCESS_VIEW` (+ POL-09 quando o documento for `RESTRICTED`).

## Dependências
- **Stories:** US-066 (snapshot imutável e `contentHash` usados em `CONTENT`/`APPROVAL_STAMPED`); US-083 (worker, filas, *retries*, *dead letter*).
- **Decisões/ADRs:** DEC-056, DEC-060, DEC-084, DEC-132, DEC-136; ADR-006, ADR-007.
- **Lacunas nas fontes canônicas:** nenhuma — pipeline, erros e SLO já descritos em DEC-060/ADR-007/storage.md §10 (confirmado em US-067).

## Critérios de aceite da feature
```gherkin
Feature: Geração de PDF
  Scenario: Gerar o PDF oficial de uma versão aprovada
    Given que a versão 3 do documento "ETP 0003/2026" foi aprovada
    When o aprovador solicitar o PDF "CONTENT" dessa versão
    Then a API deve responder 202 e o worker deve gerar o PDF em até 30 segundos (p95)
    And o PDF deve trazer o hash da versão no rodapé
```

## Métricas de sucesso
- p95 de geração: `PREVIEW` ≤ 15 s; `CONTENT`/`APPROVAL_STAMPED` ≤ 30 s (RN-DOC-70).
- Taxa de falha permanente (após *retries*) monitorada e abaixo do limite acordado em observability.md.

## Riscos
- Fidelidade do PDF (tabelas, quebras de página, fontes) exigir mais esforço (RT-03) — mitigado por Gotenberg + CSS padronizado + testes de regressão visual por hash.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
