// Sizes and dimensions as the media library says them, and the shape of a place that uses a file.

export type MediaUse = { type: string; id: string; title: string; detail: string };

export function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function dims(width: number | null, height: number | null): string {
  return width && height ? `${width} by ${height}` : "not measured";
}
