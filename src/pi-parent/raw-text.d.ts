// A `?raw` import is the file's text: vitest reads it natively, and build.mjs
// inlines it into the bundle, so the pi package needs no file beside its bundle.
declare module '*.md?raw' {
  const text: string;
  export default text;
}
