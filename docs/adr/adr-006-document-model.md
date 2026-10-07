# ADR-006 — Modelo documental híbrido com versões imutáveis

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-017, DEC-018, DEC-019, DEC-084 |
| **Documentos** | [entities.md §4.7, §5.3](../mvp-01/entities.md) · [permissions.md POL-02](../mvp-01/permissions.md) · [story-061](../backlog/story-061-document-types.md) · [story-065](../backlog/story-065-document-lifecycle.md) · [story-066](../backlog/story-066-document-versioning.md) |

## Contexto
- O processo de contratação produz documentos de natureza muito diferente: módulos **tipados** com regras de negócio e campos que o sistema precisa calcular, filtrar, validar e reportar (DFD, ETP, Termo de Referência, Mapa de Riscos, Pesquisa de Preços), textos **livres** redigidos a partir de template (despacho, ofício, nota técnica…) e **arquivos externos** anexados (`UPLOADED`). Todos precisam do mesmo ciclo de vida, das mesmas permissões, da mesma trilha de versões e, no fim, do mesmo pipeline de PDF (ADR-007) — não faz sentido duplicar esse encanamento por tipo.
- Um blob JSON totalmente livre por documento é simples de estender, mas impede o motor de regras (DEC-016/ADR-008) de validar caminhos tipados, impede relatórios/filtros sobre valores e itens, e impede o aviso determinístico de divergência de quantidade entre ETP e TR (US-039) sem *parsing* ad hoc.
- Tabelas totalmente tipadas por tipo de documento (uma modelagem relacional própria por DFD, ETP, TR…) dariam a maior garantia de tipo, mas não comportam tipos `FREE_TEXT`/`UPLOADED` definidos pelo próprio tenant, e exigiriam migração de banco a cada novo tipo — inclusive nos MVPs futuros.
- O conteúdo de uma versão publicada é evidência para fins da Lei 14.133/2021: precisa ser imutável, íntegro (hash verificável) e reproduzível em PDF (ADR-007) e, no MVP 3, assinável — sem se misturar com o rascunho de trabalho, que é salvo continuamente (autosave) e não deve gerar ruído de versões.
- Requisitos: um único ciclo de vida e uma única política de edição para os três `kind`s; cabeçalho e coleções tipadas consultáveis pelo motor de regras e por relatórios; seções narrativas flexíveis vindas do template; versões imutáveis e hasheáveis; rascunho de trabalho desacoplado de versão.

## Decisão
1. `Document` é o artefato genérico do processo — tipo, número, status, versão atual/aprovada e rascunho de trabalho — comum aos três `kind`s de `DocumentType` (DEC-017).
2. `DocumentType` é configurável por tenant com `kind`: `STRUCTURED` (módulos tipados semeados — DFD, ETP, TR, `RISK_MAP`, `PRICE_RESEARCH` —, `isSystem = true`, `kind`/`systemModule` imutáveis), `FREE_TEXT` (template rico) ou `UPLOADED` (arquivo externo); o tenant só cria `FREE_TEXT`/`UPLOADED` (RN-DOC-01, RN-DOC-02).
3. Documentos tipados têm uma **tabela de cabeçalho 1:1** (`Dfd`, `Etp`, `TermOfReference`, `PriceResearch`) com os campos que o sistema precisa calcular, filtrar, validar ou reportar; **seções narrativas** vêm do template (`DocumentTemplateVersion.sections`) e ficam em `Document.draftContent` (TipTap JSON por `sectionKey`, entities.md §5.3.1); **coleções** (itens, alternativas, cotações, riscos…) em tabelas tipadas próprias (`DocumentItem`, `EtpAlternative`, `PriceItem`, `Quotation`, `Risk`…), nunca dentro do JSON.
4. `DocumentVersion` é um **snapshot imutável** (cabeçalho + seções + coleções, entities.md §5.3.2) com `contentHash` SHA-256 do JSON canonicalizado por RFC 8785/JCS (DEC-084); trigger de banco bloqueia `UPDATE`/`DELETE` (RN-DOC-58) e `versionNumber` é sequencial 1..n sem lacunas, sob *lock* de linha do `Document`. Renderizações em PDF vivem em `DocumentRendition`, fora da versão (ADR-007).
5. Versões só nascem em transições específicas — salvar versão manual, submissão para aprovação, importação, upload de nova versão e a *próxima* finalização/submissão após uma reabertura. **Autosave nunca cria versão:** atualiza o rascunho e incrementa `draftRevision`.
6. Ciclo de vida único (`DocumentStatus`: `DRAFT`, `IN_REVIEW`, `RETURNED`, `FINALIZED`, `APPROVED`, `REJECTED`, `CANCELED`) para os três `kind`s, de competência exclusiva do `DocumentLifecycleService` — nunca por `PATCH` direto no campo `status` (RN-DOC-41).
7. Itens canônicos do processo (DEC-019) separam identidade (`ProcessItem`), linha por documento (`DocumentItem`) e linha na pesquisa de preços (`PriceItem`) sem duplicar o conceito de item, viabilizando o aviso determinístico de divergência ETP × TR (US-039).
8. Edição unificada por POL-02: permissão do tipo + (custódia **ou** participação `COLLABORATOR`/`CONSULTANT`) + documento em `DRAFT`/`RETURNED` + tipo permitido na etapa atual + processo em `DRAFT`/`IN_PROGRESS`/`RETURNED`; vale igualmente para cabeçalho e para as coleções tipadas, mesmo quando o documento dono ainda não existe (ex.: riscos antes do `RISK_MAP`).

## Alternativas consideradas
| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **JSON livre por documento** (sem cabeçalho tipado) | Modelagem mínima; extensão trivial para qualquer tipo | Motor de regras (ADR-008) não consegue validar caminhos tipados; sem filtro/relatório sobre valores e itens; aviso de divergência ETP × TR exigiria *parsing* ad hoc | **Rejeitada:** quebra o `RuleContext` tipado e os relatórios/validações centrais do MVP 1 |
| **Tabelas totalmente tipadas por tipo** (uma modelagem própria por DFD/ETP/TR, sem `Document` genérico) | Tipagem e consulta mais fortes por tipo | Não comporta `FREE_TEXT`/`UPLOADED` definidos pelo tenant; cada tipo futuro exige migração; duplica ciclo de vida, versionamento, permissão e auditoria em cada módulo | **Rejeitada:** incompatível com tipos configuráveis pelo tenant e multiplica manutenção a cada módulo novo |
| **Editor colaborativo CRDT** (ex.: Yjs) no lugar de versões discretas | Edição simultânea real; *merge* automático | Estado CRDT é um log de *merge*, não uma "versão N aprovada por X em Y" juridicamente defensável; hash/assinatura de um fluxo CRDT é artificial | **Rejeitada por ora:** evidência jurídica (Lei 14.133/2021) e a cadeia de aprovação/assinatura (ADR-007, MVP 3) exigem versões discretas e imutáveis; CRDT pode ser revisitado só na camada de rascunho |

## Consequências
**Positivas**
- Um único ciclo de vida, uma única política de edição (POL-02) e um único pipeline de versão/auditoria/PDF atendem os três `kind`s — novo tipo `FREE_TEXT`/`UPLOADED` é configuração pura, sem código.
- Versões imutáveis e hasheadas são evidência defensável e entrada estável para o PDF (ADR-007) e para a assinatura futura (MVP 3), sem rederivar conteúdo.
- Cabeçalho e coleções tipadas mantêm consultável pelo motor de regras (ADR-008) e pelos relatórios o que o sistema precisa calcular, sem *parsing* de texto livre.
- Rascunho/autosave desacoplado de versão evita ruído de `versionNumber` e ainda dá gravação contínua ao usuário.

**Negativas**
- Cada módulo `STRUCTURED` novo ainda exige tabelas próprias e um adaptador `DocumentValidator`/`typedSummary` (RN-DOC-51/52) — não é só configuração.
- Recalcular snapshot e hash em toda transição que gera versão adiciona latência e depende de a canonicalização RFC 8785 permanecer estável entre versões da biblioteca (DEC-084).
- A indireção `Document` + `DocumentType` exige um `join`/`lookup` extra que um modelo 1:1 por tipo não teria, e a exceção de POL-02 para "documento dono ainda não existe" é um caso não óbvio para quem desenvolve.

## Riscos e mitigação
| Risco | Mitigação |
|---|---|
| Deriva da biblioteca de canonicalização (JCS) invalidando hashes históricos | Versão fixada da biblioteca; testes de regressão com snapshots de referência; divergência de hash tratada como incidente SEV-2 |
| Módulo `STRUCTURED` novo sem `DocumentValidator`/`typedSummary` registrado | Teste de contrato exigindo validador por `systemModule` antes de semear o tipo |
| `PATCH` direto no campo `status`, contornando o `DocumentLifecycleService` | Guarda de serviço/trigger (RN-DOC-41) e checklist de revisão de código |
| Exceção de POL-02 para coleções sem documento dono aplicada incorretamente | Matriz de teste por tipo de coleção e etapa do processo |

## Critérios de revisão
- Demanda real por tipos `STRUCTURED` sem cabeçalho fixo (estrutura decidida pelo próprio tenant) → reavaliar JSON livre para esse subconjunto.
- Necessidade real de edição simultânea multiusuário na mesma seção → avaliar CRDT isolado na camada de rascunho, nunca na versão.
- Crescimento do número de módulos `STRUCTURED` tornando as tabelas 1:1 difíceis de manter → avaliar um mecanismo de campo tipado mais genérico.
- Antes de implementar `SIGNED` (MVP 3) ou verificação pública de hash → revisitar o formato do snapshot (§5.3/§5.3.2).

## Referências
- DEC-017, DEC-018, DEC-019, DEC-084 — [decisions.md](../architecture/decisions.md).
- [entities.md](../mvp-01/entities.md) §4.7 (`Document`, `DocumentType`, `DocumentVersion`), §5.3 (`DraftContent`, `DocumentSnapshot`); [permissions.md](../mvp-01/permissions.md) POL-02.
- Stories: [US-061](../backlog/story-061-document-types.md) (RN-DOC-01…12), [US-065](../backlog/story-065-document-lifecycle.md) (RN-DOC-41…55), [US-066](../backlog/story-066-document-versioning.md) (RN-DOC-56…62).
- [ADR-007](adr-007-pdf-generation.md) (renderiza `DocumentVersion.content`), [ADR-008](adr-008-configurable-rules.md) (`RuleContext` lê cabeçalho e coleções tipadas).
