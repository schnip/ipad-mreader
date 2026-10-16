import { describe, expect, it } from "vitest";
import { platform } from "./index";
import { platform as webPlatform } from "./web";

describe("platform selection", () => {
  it("resolves @mreader/platform to the web implementation outside android mode", () => {
    expect(import.meta.env.MODE).not.toBe("android");
    expect(platform).toBe(webPlatform);
  });
});
