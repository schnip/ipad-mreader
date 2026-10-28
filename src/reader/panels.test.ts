// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PanelController } from "./panels";

function setup(): { panels: PanelController; elements: Record<string, HTMLElement>; closed: string[] } {
  document.body.replaceChildren();
  const make = (id: string, tag = "section") => {
    const element = document.createElement(tag);
    element.id = id;
    element.hidden = true;
    document.body.append(element);
    return element;
  };
  const elements = { find: make("find"), more: make("more"), drawer: make("drawer"), note: make("note"), backdrop: make("backdrop", "div") };
  const closed: string[] = [];
  const panels = new PanelController(elements, (kind) => closed.push(kind));
  return { panels, elements, closed };
}

describe("panel controller", () => {
  it("keeps exactly one panel open and reports what closed", () => {
    const { panels, elements, closed } = setup();
    panels.open("find");
    expect(elements.find?.hidden).toBe(false);
    expect(elements.backdrop?.hidden).toBe(false);
    panels.open("more");
    expect(elements.find?.hidden).toBe(true);
    expect(elements.more?.hidden).toBe(false);
    expect(panels.active).toBe("more");
    expect(panels.close()).toBe("more");
    expect(closed).toEqual(["find", "more"]);
    expect(elements.backdrop?.hidden).toBe(true);
    expect(panels.close()).toBeUndefined();
    expect(closed).toHaveLength(2);
  });

  it("moves focus into the panel and back to the opener", () => {
    const { panels, elements } = setup();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const input = document.createElement("input");
    elements.find?.append(input);
    panels.open("find", input);
    expect(document.activeElement).toBe(input);
    panels.close();
    expect(document.activeElement).toBe(opener);
  });

  it("does not return focus to an element that became hidden", () => {
    const { panels } = setup();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    panels.open("drawer");
    opener.hidden = true;
    const focus = vi.spyOn(opener, "focus");
    panels.close();
    expect(focus).not.toHaveBeenCalled();
  });
});
