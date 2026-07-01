import { useEffect } from "react";

/** Invoke `onEscape` when the Escape key is pressed (for dismissing overlays/menus). */
export function useOnEscape(onEscape: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onEscape]);
}
