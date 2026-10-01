export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  mtime?: number;
  children?: FileNode[];
}

export interface Capacity {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
}

export interface ScanResponse {
  status: string;
  scan_time_ms: number;
  total_files: number;
  total_dirs: number;
  total_size: number;
  errors: number;
  /** The phone's own phase breakdown; absent from a daemon that predates it. */
  traverse_ms?: number;
  sort_ms?: number;
  serialize_ms?: number;
  send_ms?: number;
  /** Bytes handed to the socket — the compressed answer, not the tree. */
  bytes_sent?: number;
  tree: FileNode;
}

export interface Toast {
  id: number;
  /** A dictionary key, an `E#code` from the Rust side, or plain text from adb. */
  message: string;
  params?: Record<string, string | number>;
  type: "error" | "success" | "info";
  exiting?: boolean;
}

export type AppPhase = "setup" | "connecting" | "scanning" | "result";

/** What went wrong, kept as written so it can be re-worded per language. */
export interface FlowError {
  message: string;
  params?: Record<string, string | number>;
  hints: string[];
}
