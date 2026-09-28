export type Category = "video" | "image" | "audio" | "document" | "apk" | "archive" | "other";

const EXTENSIONS: Record<Exclude<Category, "other">, string[]> = {
  video: ["mp4", "mkv", "mov", "avi", "flv", "ts", "m4v", "webm", "rmvb", "rm", "3gp", "wmv", "mpg", "mpeg", "vob", "m2ts"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "ico", "raw", "cr2", "nef", "dng"],
  audio: ["mp3", "flac", "wav", "aac", "m4a", "ogg", "oga", "opus", "ape", "mid", "midi", "amr", "aiff", "mka"],
  document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "epub", "mobi", "azw", "azw3", "fb2", "rtf", "srt", "ass", "sub", "lrc", "json", "xml", "html", "htm"],
  apk: ["apk", "xapk", "apks"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso", "tgz"],
};

const CATEGORY_OF_EXT = new Map<string, Category>();
for (const [category, exts] of Object.entries(EXTENSIONS) as [Category, string[]][]) {
  for (const ext of exts) CATEGORY_OF_EXT.set(ext, category);
}

export const CATEGORY_ORDER: Category[] = ["video", "image", "audio", "document", "apk", "archive", "other"];

export const CATEGORY_LABELS: Record<Category, string> = {
  video: "视频",
  image: "图片",
  audio: "音频",
  document: "文档",
  apk: "安装包",
  archive: "压缩包",
  other: "其他",
};

export function categoryOf(fileName: string): Category {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "other";
  return CATEGORY_OF_EXT.get(fileName.slice(dot + 1).toLowerCase()) ?? "other";
}
