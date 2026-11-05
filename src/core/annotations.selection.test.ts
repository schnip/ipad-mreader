import { describe, expect, it } from "vitest";
import { selectionRangeGeometry } from "./annotations";
import type { SearchPageText } from "./search";

describe("selection text joining", () => {
  it("copies a word split across adjacent items without an inner space", () => {
    const page: SearchPageText = {
      pageNumber: 1,
      width: 200,
      height: 100,
      items: [
        { text: "Hel", x: 10, y: 10, width: 18, height: 10 },
        { text: "lo", x: 28, y: 10, width: 12, height: 10 },
        { text: "there", x: 46, y: 10, width: 30, height: 10 }
      ]
    };
    const geometry = selectionRangeGeometry(page, { itemIndex: 0, offset: 0 }, { itemIndex: 2, offset: 5 });
    expect(geometry?.text).toBe("Hello there");
    expect(geometry?.context).toBe("Hello there");
    expect(geometry?.rects).toHaveLength(3);
  });
});
