export function Prose({ children }: { children: React.ReactNode }) {
  return (
    <div className="prose prose-neutral max-w-none prose-headings:tracking-tight prose-a:underline-offset-2">
      {children}
    </div>
  );
}
