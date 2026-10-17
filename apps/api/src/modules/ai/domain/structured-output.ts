import { z } from 'zod';

/*
 * Saída estruturada pedida ao provedor (RN-AI-07 · DEC-079): blocos simples por seção, nunca HTML.
 * O `OutputConverter` transforma os blocos em TipTap só com os nós permitidos. Texto em linha aceita
 * `**negrito**`, `*itálico*` e marcações `[a confirmar: <o que falta>]`. Os geradores do mapa de
 * riscos (US-119) estendem o schema com `risks`; os demais usam este.
 */

const MAX_INLINE_CHARS = 20_000;

const inline = z.string().max(MAX_INLINE_CHARS);

export const structuredBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('paragraph'), text: inline }),
  z.strictObject({
    type: z.literal('heading'),
    level: z.union([z.literal(3), z.literal(4)]),
    text: inline,
  }),
  z.strictObject({ type: z.literal('bulletList'), items: z.array(inline).min(1).max(100) }),
  z.strictObject({ type: z.literal('orderedList'), items: z.array(inline).min(1).max(100) }),
  z.strictObject({
    type: z.literal('table'),
    header: z.array(inline).min(1).max(10),
    rows: z.array(z.array(inline).min(1).max(10)).max(100),
  }),
]);
export type StructuredBlock = z.infer<typeof structuredBlockSchema>;

export const structuredSectionSchema = z.strictObject({
  sectionKey: z.string().min(1).max(60),
  blocks: z.array(structuredBlockSchema).max(200),
});
export type StructuredSection = z.infer<typeof structuredSectionSchema>;

/** Resposta comum dos geradores (rascunho e ajuste de seção). */
export const structuredResponseSchema = z.strictObject({
  sections: z.array(structuredSectionSchema).max(60),
  risks: z.array(z.record(z.string(), z.unknown())).max(60).optional(),
});
export type StructuredResponse = z.infer<typeof structuredResponseSchema>;

/** JSON Schema da resposta, entregue ao provedor (independente de SDK — DEC-079). */
export function responseJsonSchema(schema: z.ZodType = structuredResponseSchema) {
  return z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}
