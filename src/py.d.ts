// FACTORY-625: the file-execution veto checker is a standalone python3 script,
// embedded as TEXT at build time exactly as `briefs/*.md` are (see src/md.d.ts).
// That is not a stylistic choice: the daemon ships as a bundled `dist/butchr.js`
// and the published package carries only `dist/`, so a script referenced by its
// path in the checkout would simply not exist in an installed daemon. Embedding
// makes the hook's path-stability problem disappear rather than be managed.
declare module "*.py" {
  const content: string;
  export default content;
}
