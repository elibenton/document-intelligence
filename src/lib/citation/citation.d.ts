/**
 * `citeproc` ships no types, and Vite's `?raw` suffix needs declaring for the
 * vendored style sheets. Both are narrow on purpose — `format.ts` describes the
 * slice of the citeproc surface it actually uses.
 */
declare module "citeproc";
declare module "*.csl?raw" {
  const content: string;
  export default content;
}
declare module "*.xml?raw" {
  const content: string;
  export default content;
}
