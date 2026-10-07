export function SanitizedHtmlPreview({ sanitizedHtml }: { readonly sanitizedHtml: string }) {
  return <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
}
