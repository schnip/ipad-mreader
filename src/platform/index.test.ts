import { describe, expect, it } from "vitest";
import { platform } from "./index";
import { platform as webPlatform } from "./web";

describe("platform selection", () => {
  it("resolves @mreader/platform to the web implementation outside native modes", () => {
    expect(["android", "ios"]).not.toContain(import.meta.env.MODE);
    expect(platform).toBe(webPlatform);
  });
});
