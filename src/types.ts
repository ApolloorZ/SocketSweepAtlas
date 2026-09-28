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
  tree: FileNode;
}

export interface Toast {
  id: number;
  message: string;
  type: "error" | "success" | "info";
  exiting?: boolean;
}

export type AppPhase = "setup" | "connecting" | "scanning" | "result";
