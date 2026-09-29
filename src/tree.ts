import type { FileNode } from "./types";
import { CATEGORY_ORDER, categoryOf, type Category } from "./categories";

export function findNode(root: FileNode, path: string): FileNode | null {
  if (root.path === path) return root;
  if (!root.children) return null;
  for (const child of root.children) {
    // Files are leaves, so they can only be matched here — recursing into
    // directories alone made every file lookup come back empty.
    if (child.path === path) return child;
    if (child.type === "directory" && path.startsWith(child.path + "/")) {
      const found = findNode(child, path);
      if (found) return found;
    }
  }
  return null;
}

const statsCache = new Map<string, { files: number; dirs: number }>();

export function clearStatsCache() {
  statsCache.clear();
}

export function subtreeStats(node: FileNode): { files: number; dirs: number } {
  const cached = statsCache.get(node.path);
  if (cached) return cached;
  let files = 0;
  let dirs = 0;
  if (node.type === "file") files = 1;
  else {
    dirs = 1;
    for (const child of node.children ?? []) {
      const s = subtreeStats(child);
      files += s.files;
      dirs += s.dirs;
    }
  }
  const value = { files, dirs };
  statsCache.set(node.path, value);
  return value;
}

export interface CategoryBucket {
  files: FileNode[];
  size: number;
}

export function collectCategories(root: FileNode): Map<Category, CategoryBucket> {
  const buckets = new Map<Category, CategoryBucket>();
  for (const key of CATEGORY_ORDER) buckets.set(key, { files: [], size: 0 });

  const stack: FileNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "directory") {
      for (const child of node.children ?? []) stack.push(child);
    } else {
      const bucket = buckets.get(categoryOf(node.name))!;
      bucket.files.push(node);
      bucket.size += node.size;
    }
  }
  return buckets;
}

/**
 * Removes `path` and returns a new root, copying only the ancestor chain: a real
 * device tree holds ~285k nodes, so a deep clone per delete costs close to a second.
 */
export function removeNode(
  root: FileNode,
  path: string
): { root: FileNode; removed: boolean; size: number; files: number; dirs: number } {
  if (!root.children) return { root, removed: false, size: 0, files: 0, dirs: 0 };

  const index = root.children.findIndex((child) => child.path === path);
  if (index !== -1) {
    const node = root.children[index];
    const stats = node.type === "directory" ? subtreeStats(node) : { files: 1, dirs: 0 };
    const children = root.children.slice();
    children.splice(index, 1);
    return { root: { ...root, children, size: root.size - node.size }, removed: true, size: node.size, ...stats };
  }

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child.type === "directory" && path.startsWith(child.path + "/")) {
      const result = removeNode(child, path);
      if (result.removed) {
        const children = root.children.slice();
        children[i] = result.root;
        return {
          root: { ...root, children, size: root.size - result.size },
          removed: true,
          size: result.size,
          files: result.files,
          dirs: result.dirs,
        };
      }
    }
  }

  return { root, removed: false, size: 0, files: 0, dirs: 0 };
}

/**
 * Inserts an uploaded file under `dirPath`, growing every ancestor's size the way
 * removeNode shrinks them, so the numbers stay honest without another scan.
 */
export function addNode(
  root: FileNode,
  dirPath: string,
  node: FileNode
): { root: FileNode; added: boolean } {
  if (root.path === dirPath) {
    const children = [...(root.children ?? []), node];
    return { root: { ...root, children, size: root.size + node.size }, added: true };
  }
  if (root.type !== "directory" || !root.children) return { root, added: false };

  const children = root.children.slice();
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type !== "directory") continue;
    if (child.path !== dirPath && !dirPath.startsWith(child.path + "/")) continue;
    const result = addNode(child, dirPath, node);
    if (result.added) {
      children[i] = result.root;
      return { root: { ...root, children, size: root.size + node.size }, added: true };
    }
  }
  return { root, added: false };
}

export function breadcrumbs(root: FileNode, path: string): FileNode[] {  const parts: FileNode[] = [root];
  let node: FileNode | null = root;
  while (node && node.path !== path) {
    const next: FileNode | undefined = (node.children ?? []).find(
      (c) => c.type === "directory" && (path === c.path || path.startsWith(c.path + "/"))
    );
    if (!next) break;
    parts.push(next);
    node = next;
  }
  return parts;
}
