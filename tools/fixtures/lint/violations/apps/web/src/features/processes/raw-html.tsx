// Violação: contrataflow/no-dangerous-html (HTML sem a pré-visualização sanitizada).
export function RawHtml({ html }: { readonly html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
