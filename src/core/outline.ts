import { isRecord } from "./math";

export interface PdfOutlineNode {
  title: string;
  dest: unknown;
  items: PdfOutlineNode[];
}

export interface FlatOutlineItem {
  title: string;
  depth: number;
  dest: unknown;
  path: number[];
}

export interface OutlineTreeItem {
  title: string;
  level: number;
  dest: unknown;
  path: number[];
  children: OutlineTreeItem[];
}

export type DestinationTarget = { kind: "index"; index: number } | { kind: "reference"; reference: { num: number; gen: number } };

export function flattenOutline(nodes: readonly PdfOutlineNode[], depth = 0, path: number[] = []): FlatOutlineItem[] {
  const result: FlatOutlineItem[] = [];
  nodes.forEach((node, index) => {
    const nextPath = [...path, index];
    const title = node.title.trim() || "Untitled bookmark";
    result.push({ title, depth, dest: node.dest, path: nextPath });
    result.push(...flattenOutline(node.items, depth + 1, nextPath));
  });
  return result;
}

export function outlineTreeStructure(nodes: readonly PdfOutlineNode[], level = 1, path: number[] = []): OutlineTreeItem[] {
  return nodes.map((node, index) => {
    const nextPath = [...path, index];
    return {
      title: node.title.trim() || "Untitled bookmark",
      level,
      dest: node.dest,
      path: nextPath,
      children: outlineTreeStructure(node.items, level + 1, nextPath)
    };
  });
}

export function destinationTarget(destination: unknown): DestinationTarget | undefined {
  if (!Array.isArray(destination) || destination.length === 0) return undefined;
  const target: unknown = destination[0];
  if (typeof target === "number" && Number.isInteger(target) && target >= 0) return { kind: "index", index: target };
  if (isRecord(target) && typeof target.num === "number" && typeof target.gen === "number") {
    return { kind: "reference", reference: { num: target.num, gen: target.gen } };
  }
  return undefined;
}
