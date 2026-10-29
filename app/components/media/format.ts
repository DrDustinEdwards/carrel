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

/**
 * The types the crop editor opens and writes back: rasters a browser's canvas exports. Never an SVG,
 * which served from Carrel's own origin would be script running as Carrel.
 */
export const CROPPABLE: readonly string[] = ["image/jpeg", "image/png", "image/webp"];

/** A content type without its parameters, lower case. */
export function cropType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}
