/**
 * FACTORY-432: pipeline-proving placeholder only — this app is not linked
 * from the server-rendered dashboard (src/web/view.ts) yet. It exists so the
 * bundler/TypeScript/JSX config has something real to build and type-check.
 * A later Story in the epic (FACTORY-427) replaces this with the actual
 * dashboard UI.
 */
export function App() {
  return <div>butchr dashboard — React pipeline placeholder</div>;
}
