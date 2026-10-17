# `supplier`

Cadastro de fornecedores, compartilhado com o MVP 4 (DEC-040). Recurso do tenant, sem processo e sem
escopo por unidade (DEC-010).

- **US-025** — SUP-01..06: cadastrar, listar, consultar, editar/inativar, excluir (lógico) e consultar
  por documento (`lookup`). Permissões `SUPPLIER_VIEW` (consulta) e `SUPPLIER_MANAGE` (escrita).
- **Documento** — CNPJ numérico ou alfanumérico (IN RFB 2.229/2024), CPF ou estrangeiro; o dígito
  verificador é validado pelos schemas compartilhados de `@contrataflow/validation`
  (`isValidCnpj`/`isValidCpf`). Tipo e número são imutáveis depois da criação (RN-PRICE-14).
- **CPF** — dado pessoal (DEC-086): guardado cifrado (AES-256-GCM, envelope) e devolvido sempre
  mascarado (`***.444.777-**`). A unicidade `(tenant, tipo, hash)` e o `lookup` usam o _blind index_
  HMAC, nunca o número. A porta é `FIELD_PROTECTION` (`#shared/crypto/field-protection.ts`), fornecida
  pelo `platform`; em produção o `KeyWrapper` local troca pelo adaptador do KMS.
- **Exclusão** — lógica e só sem uso (RN-PRICE-19). Quem referencia o fornecedor (`price-research`,
  US-026) registra um `SupplierUsageProvider` pela `SupplierFacade.registerUsageProvider` no
  `onModuleInit`; sem provedor, nenhum fornecedor está em uso.
- **Eventos** — `SupplierCreated`/`SupplierUpdated` (sem consumidor assíncrono no MVP 1). A exclusão só
  gera auditoria (`supplier.delete`).
