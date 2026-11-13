/** Maximum visible length for a sync path, including the four-dot separator. */
export const MAX_DISPLAY_PATH_LENGTH = 40;
const DISPLAY_SEPARATOR = "....";

/**
 * Keep the beginning and filename portion of long paths visible while keeping
 * every sync surface at the same predictable length. The original path must
 * still be used for searching and actions.
 */
export function formatDisplayPath(path: string): string {
  const characters = [...path];
  if (characters.length <= MAX_DISPLAY_PATH_LENGTH) return path;
  const visible = MAX_DISPLAY_PATH_LENGTH - DISPLAY_SEPARATOR.length;
  const headLength = Math.ceil(visible / 2);
  const tailLength = visible - headLength;
  return `${characters.slice(0, headLength).join("")}${DISPLAY_SEPARATOR}${characters.slice(-tailLength).join("")}`;
}

export function pathDisplayAttributes(path: string): { title: string; "aria-label": string } {
  return { title: path, "aria-label": path };
}
