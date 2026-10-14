// Casos de teste da regra (semgrep --test .semgrep/rules).
declare const html: string;

export function Unsafe() {
  // ruleid: cf-no-dangerous-html
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export function UnsafeWithChildren() {
  // ruleid: cf-no-dangerous-html
  return <section dangerouslySetInnerHTML={{ __html: html }}></section>;
}

// ruleid: cf-no-dangerous-html
export const props = { dangerouslySetInnerHTML: { __html: html } };

export function Safe() {
  // ok: cf-no-dangerous-html
  return <div>{html}</div>;
}
