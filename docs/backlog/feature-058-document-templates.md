---
id: FT-058
title: "Templates de documentos"
epic: EP-018
mvp: 1
priority: P0
stories: [US-107, US-108, US-109, US-110]
status: Especificada
---

# FT-058 — Templates de documentos

## Título
Templates de documentos

## Épico
EP-018 — Templates de documentos

## Descrição
Entrega o ciclo completo de templates de documento: um editor de seções com variáveis e campos tipados, um ciclo de publicação em versões imutáveis com padrão por tipo de documento, um layout de impressão com timbre/cabeçalho/rodapé e prévia em PDF, e uma biblioteca padrão — já publicada e orientada à Lei 14.133/2021 — semeada no provisionamento de cada tenant, com adoção opcional de atualizações futuras dessa biblioteca.

## Valor para o usuário e para o órgão
- O órgão começa a operar no primeiro dia com modelos prontos e juridicamente orientados para DFD, ETP, TR, mapa de riscos, pesquisa de preços e documentos livres.
- A Procuradoria do tenant mantém o controle total do texto-base, podendo revisar e publicar novas versões sem depender da plataforma.
- Documentos sempre nascem de uma versão de template publicada e imutável, com hash verificável — reduz risco de divergência entre o que foi aprovado e o que foi impresso.

## Personas
- Administrador de configurações documentais (`TEMPLATE_MANAGE`/`TEMPLATE_PUBLISH`) — cria, versiona e publica templates.
- Procuradoria/assessoria jurídica (mesmo perfil) — revisa o texto-base e a base legal.
- Redator (`REQUISITANTE`/`GESTOR_CONTRATACOES`) — usa o template publicado ao elaborar DFD/ETP/TR.
- Operador da plataforma — dispara o provisionamento que semeia a biblioteca padrão (US-110).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-107 | Criar e editar template de documento | P0 | L | US-061 |
| US-108 | Publicar versão de template e definir padrão do tipo | P0 | M | US-107 |
| US-109 | Layout de impressão (timbre, cabeçalho, rodapé) | P1 | M | US-067, US-107 |
| US-110 | Biblioteca de templates padrão | P0 | M | US-108 |

## Escopo
- Edição de seções (`SectionDefinition`), variáveis e `fieldConfig` por versão rascunho.
- Publicação imutável com `contentHash`, aposentadoria de versão e padrão por `DocumentType`.
- Layout de impressão (A4, margens, fonte, timbre, numeração, marca d'água) e prévia renderizada.
- Biblioteca padrão semeada para 10 tipos de documento, com legislação de referência, e adoção opcional de atualizações futuras da biblioteca.

## Fora de escopo
- Conteúdo de negócio de DFD/ETP/TR/mapa de riscos/pesquisa de preços (módulos próprios).
- Assinatura eletrônica (MVP 3) e PDF/A-2b (PEND-09).

## Regras de negócio da feature
- Só a versão `DRAFT` de um template é editável; publicação torna `sections`/`layout`/`fieldConfig`/`importMappings` imutáveis (RN-TPL-03, RN-TPL-15).
- Existe no máximo um rascunho por template (RN-TPL-10/RN-TPL-13).
- Cada `DocumentType` tem no máximo um template padrão por vez (`defaultTemplateId`, RN-TPL-19/RN-TPL-20).
- A biblioteca padrão semeada (`isSystem = true`) segue as mesmas regras de edição/publicação de qualquer template — sem bloqueio especial (RN-TPL-32) — e pode receber atualizações opcionais da plataforma (RN-TPL-35 a RN-TPL-37).

## Telas
- SCR-033 — Templates (`/admin/templates`)
- SCR-114 — Editor de template, seções e layout (`/admin/templates/[id]/versoes/[versionId]`)

## Endpoints
- `DTY-04` `PUT /document-types/{id}/default-template` — define o template padrão do tipo
- `TPL-01` `GET /templates` — lista templates
- `TPL-02` `POST /templates` — cria template
- `TPL-03` `GET /templates/{id}` — detalha template
- `TPL-04` `PATCH /templates/{id}` — atualiza metadados do template
- `TPL-05` `GET /templates/{id}/versions` — lista versões
- `TPL-06` `POST /templates/{id}/versions` — cria novo rascunho de versão
- `TPL-07` `GET /template-versions/{versionId}` — detalha versão
- `TPL-08` `PATCH /template-versions/{versionId}` — edita rascunho (seções/layout/fieldConfig/importMappings)
- `TPL-09` `POST /template-versions/{versionId}/preview` — enfileira prévia em PDF
- `TPL-10` `POST /template-versions/{versionId}/publish` — publica a versão
- `TPL-11` `POST /template-versions/{versionId}/retire` — aposenta a versão publicada
- `TPL-12`/`TPL-13` `GET` — status e download da prévia
- `TPL-14` `GET /templates/{id}/library-update` — verifica atualização disponível na biblioteca padrão (US-110)
- `TPL-15` `POST /templates/{id}/versions/from-library-update` — cria rascunho a partir da atualização da biblioteca (US-110)

## Entidades
- `DocumentTemplate` — template por tipo de documento, com nome e template padrão do tenant.
- `DocumentTemplateVersion` — versão imutável após publicação, com seções, layout, campos e mapeamentos de importação.
- `DocumentType` — consumida para `defaultTemplateId` e `kind`/`systemModule`.

## Eventos
- `TemplateVersionPublished` — ao publicar uma versão (`TPL-10`)
- `TemplateVersionRetired` — ao aposentar uma versão publicada (`TPL-11`)
- `DocumentTypeChanged` — ao trocar o template padrão de um tipo (`DTY-04`)

## Permissões
- `TEMPLATE_VIEW` — ver templates, versões publicadas e indicador de atualização
- `TEMPLATE_MANAGE` — editar rascunhos, criar versões e templates
- `TEMPLATE_PUBLISH` — publicar/aposentar versões e definir padrão do tipo
- `DOCUMENT_TYPE_MANAGE` — gerenciar tipos de documento associados

## Dependências
- Stories: US-061 (tipos de documento), US-067 (anexos/logo), US-099 (provisionamento — invoca o seeder da biblioteca padrão).
- Decisões/ADRs: DEC-016, DEC-017 (ADR-006), DEC-056, DEC-060 (ADR-007).

## Critérios de aceite da feature
```gherkin
Feature: Templates de documentos
  Scenario: Da semeadura ao template publicado e impresso
    Given que o tenant "Prefeitura de São José" foi provisionado
    Then o template "Termo de Referência — Modelo padrão" já está publicado e é o padrão do tipo TR
    When o administrador cria uma nova versão, ajusta a seção "SPECIFICATIONS" e o layout com o timbre do órgão
    And publica a nova versão
    Then a versão publicada anterior permanece imutável e acessível para documentos já criados
    And o novo documento TR criado a partir daqui usa a versão recém-publicada
    When o administrador gera uma prévia em PDF do layout
    Then a prévia é produzida com o timbre, cabeçalho e marca d'água de rascunho corretos
```

## Métricas de sucesso
- 100% dos tenants provisionados com os 10 templates padrão publicados e `defaultTemplateId` preenchido.
- Tempo médio entre "nova versão" e "publicação" de um template ≤ 15 minutos (fluxo simples, sem fricção).

## Riscos
- Validação incompleta na publicação permite template com variável/seção inválida — mitigado pela revalidação integral em `TPL-10` (RN-TPL-14).
- Adoção de atualização da biblioteca sobrescrever customizações sem revisão — mitigado por ser sempre opt-in e gerar rascunho revisável, nunca publicação automática (RN-TPL-36).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
