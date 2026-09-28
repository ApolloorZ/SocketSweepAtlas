import type { ReactNode } from "react";
import type { FileNode } from "./types";
import { categoryOf } from "./categories";

// Hand-drawn 24×24 glyphs, stroked with currentColor so they follow the type
// colour and stay legible in both themes.
const FOLDER: ReactNode = <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.1l1.9 2h6A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />;
const IMAGE: ReactNode = (
  <>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="M3.5 17.5 8.5 12.5l3 3 3.5-3.5 5 5.5" />
  </>
);
const VIDEO: ReactNode = (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M10.2 9.2 15 12l-4.8 2.8z" fill="currentColor" stroke="none" />
  </>
);
const AUDIO: ReactNode = (
  <>
    <path d="M8 17.5V6.2L18 4v11" />
    <circle cx="5.8" cy="17.6" r="2.4" />
    <circle cx="15.8" cy="15.2" r="2.4" />
  </>
);
const DOCUMENT: ReactNode = (
  <>
    <path d="M5 4h8l5 5v10.5A1.5 1.5 0 0 1 16.5 21h-10A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M13 4v5h5" />
    <path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4.5" />
  </>
);
const ARCHIVE: ReactNode = (
  <>
    <path d="M3.5 5h17v3.5h-17z" />
    <path d="M5.5 8.5h13V19.5h-13z" />
    <path d="M11 11.5h2M11 14h2M11 16.5h2" />
  </>
);
const APK: ReactNode = (
  <>
    <path d="M5 10.5a7 7 0 0 1 14 0V17a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17z" />
    <path d="M8.2 4.2 9.8 7M15.8 4.2 14.2 7" />
    <circle cx="9.5" cy="12" r=".9" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="12" r=".9" fill="currentColor" stroke="none" />
  </>
);
const CODE: ReactNode = <path d="M9 8.5 4.8 12 9 15.5M15 8.5 19.2 12 15 15.5" />;
const UNKNOWN: ReactNode = (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10.2 9.8a1.9 1.9 0 1 1 2.6 1.8c-.7.3-1 .8-1 1.6" />
    <path d="M11.9 16.2h.01" />
  </>
);

export type Kind = "folder" | "image" | "video" | "audio" | "document" | "archive" | "apk" | "code" | "unknown";

const STYLE: Record<Kind, { color: string; glyph: ReactNode }> = {
  folder: { color: "#14b8a6", glyph: FOLDER },
  image: { color: "#10b981", glyph: IMAGE },
  video: { color: "#8b5cf6", glyph: VIDEO },
  audio: { color: "#ec4899", glyph: AUDIO },
  document: { color: "#0ea5e9", glyph: DOCUMENT },
  archive: { color: "#f59e0b", glyph: ARCHIVE },
  apk: { color: "#22c55e", glyph: APK },
  code: { color: "#94a3b8", glyph: CODE },
  unknown: { color: "#71717a", glyph: UNKNOWN },
};

const CODE_EXTENSIONS = new Set([
  "js", "ts", "tsx", "jsx", "json", "xml", "html", "htm", "css", "scss", "py", "java", "kt",
  "sh", "bat", "ps1", "log", "ini", "conf", "yaml", "yml", "toml", "sql", "c", "cpp", "h", "rs", "go",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function kindOf(node: FileNode): Kind {
  if (node.type === "directory") return "folder";
  const category = categoryOf(node.name);
  if (category !== "other") return category as Kind;
  return CODE_EXTENSIONS.has(extensionOf(node.name)) ? "code" : "unknown";
}

export function TypeGlyph({ kind, size = 28 }: { kind: Kind; size?: number }) {
  const { color, glyph } = STYLE[kind];
  return (
    <span
      className="rounded-md flex items-center justify-center shrink-0"
      style={{ width: size, height: size, background: `${color}1f`, color, border: `1px solid ${color}33` }}
    >
      <svg
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph}
      </svg>
    </span>
  );
}

export function TypeIcon({ node, size = 28 }: { node: FileNode; size?: number }) {
  const kind = kindOf(node);
  const { color } = STYLE[kind];
  const ext = extensionOf(node.name);

  // Unclassified files keep showing their extension — a question mark tells you
  // nothing about what the file actually is.
  if (kind === "unknown" && ext.length > 0 && ext.length <= 4) {
    return (
      <span
        className="rounded-md flex items-center justify-center shrink-0"
        style={{ width: size, height: size, background: `${color}1f`, color, border: `1px solid ${color}33` }}
      >
        <span style={{ fontSize: Math.round(size * 0.3), fontWeight: 700, letterSpacing: "-0.02em" }}>
          {ext.toUpperCase()}
        </span>
      </span>
    );
  }

  return <TypeGlyph kind={kind} size={size} />;
}
