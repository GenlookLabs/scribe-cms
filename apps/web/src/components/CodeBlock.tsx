export function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <pre className="code-block">
      <code data-language={language}>{code.trimEnd()}</code>
    </pre>
  );
}
