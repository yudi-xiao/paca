/** One pass substitution only. Missing variables remain literal, matching the
 * product contract; values cannot introduce recursive templates or execution. */
export function renderAutomationText(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  return template.replace(
    /\{\{\s*([\w.]+)\s*\}\}/gu,
    (original: string, key: string) => variables[key] ?? original,
  );
}
