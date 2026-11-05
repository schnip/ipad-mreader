import { describe, expect, it } from "vitest";
import { pdfjsAssetUrls } from "./pdfjs-assets";

describe("pdfjsAssetUrls", () => {
  it("resolves absolute, slash-terminated asset URLs under the app base", () => {
    expect(pdfjsAssetUrls("https://schnip.org/ipad/index.html")).toEqual({
      wasmUrl: "https://schnip.org/ipad/pdfjs/wasm/",
      standardFontDataUrl: "https://schnip.org/ipad/pdfjs/standard_fonts/",
      cMapUrl: "https://schnip.org/ipad/pdfjs/cmaps/",
      cMapPacked: true,
      iccUrl: "https://schnip.org/ipad/pdfjs/iccs/"
    });
  });

  it("supports the Capacitor scheme", () => {
    expect(pdfjsAssetUrls("capacitor://localhost/").wasmUrl).toBe("capacitor://localhost/pdfjs/wasm/");
  });
});
