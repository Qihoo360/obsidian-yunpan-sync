export const LIST_PAGE_SIZE = 100;

export function pageItems<T>(items: readonly T[], requested: number): { items: readonly T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
  const page = Math.max(0, Math.min(requested, pages - 1));
  return { items: items.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE), page, pages };
}

export function renderPager(container: HTMLElement, page: number, pages: number, change: (page: number) => void): void {
  if (pages <= 1) return;
  const controls = container.createDiv({ cls: "yunpan-sync-pagination" });
  const previous = controls.createEl("button", { text: "上一页" });
  previous.disabled = page === 0;
  previous.addEventListener("click", () => change(page - 1));
  controls.createSpan({ text: `${page + 1} / ${pages}` });
  const next = controls.createEl("button", { text: "下一页" });
  next.disabled = page + 1 === pages;
  next.addEventListener("click", () => change(page + 1));
}
