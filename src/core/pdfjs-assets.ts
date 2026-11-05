/**
 * Absolute URLs of the pdf.js runtime files the build ships under `pdfjs/`
 * (see `vite.config.ts`). Without `wasmUrl`, JPEG 2000 images fail to decode
 * and scanned pages render white. They must be absolute because the worker
 * resolves them against its own location.
 */
export function pdfjsAssetUrls(baseUri: string): {
  wasmUrl: string;
  standardFontDataUrl: string;
  cMapUrl: string;
  cMapPacked: boolean;
  iccUrl: string;
} {
  const url = (dir: string) => new URL(`pdfjs/${dir}/`, baseUri).href;
  return {
    wasmUrl: url("wasm"),
    standardFontDataUrl: url("standard_fonts"),
    cMapUrl: url("cmaps"),
    cMapPacked: true,
    iccUrl: url("iccs")
  };
}
