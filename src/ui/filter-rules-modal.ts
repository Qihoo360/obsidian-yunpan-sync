import { Modal, Setting, type App } from "obsidian";
import type { FilterRule } from "../settings.js";

export class FilterRulesModal extends Modal {
  private rules: FilterRule[];

  constructor(app: App, rules: readonly FilterRule[],
    private readonly save: (rules: FilterRule[]) => Promise<void>) {
    super(app);
    this.rules = rules.map((rule) => ({ ...rule }));
  }

  onOpen(): void {
    this.modalEl.addClass("yunpan-sync-filter-modal");
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "过滤规则" });
    this.contentEl.createEl("p", {
      text: "选择不参与同步的文件或文件夹。支持路径和通配符，例如“图片”或“**/*.tmp”；Aa 控制是否区分大小写。",
      cls: "setting-item-description",
    });
    const actions = this.contentEl.createDiv({ cls: "yunpan-sync-filter-actions" });
    actions.createEl("button", { text: "添加规则" }).addEventListener("click", () => {
      this.rules.unshift({ id: crypto.randomUUID(), enabled: true, pattern: "", caseSensitive: false });
      this.render();
    });
    const list = this.contentEl.createDiv({ cls: "yunpan-sync-filter-list" });
    this.rules.forEach((rule, index) => this.renderRule(list, rule, index));

    const footer = this.contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: "保存", cls: "mod-cta" }).addEventListener("click", async () => {
      const rules = this.rules.map((rule) => ({ ...rule, pattern: rule.pattern.trim() }))
        .filter((rule) => rule.pattern.length > 0);
      await this.save(rules);
      this.close();
    });
  }

  private renderRule(container: HTMLElement, rule: FilterRule, index: number): void {
    const setting = new Setting(container).setClass("yunpan-sync-filter-rule")
      .addToggle((toggle) => toggle.setValue(rule.enabled).setTooltip("启用规则")
        .onChange((value) => { rule.enabled = value; }))
      .addDropdown((dropdown) => dropdown.addOption("exclude", "排除").setValue("exclude"))
      .addText((text) => text.setPlaceholder("例如：**/*.tmp").setValue(rule.pattern)
        .onChange((value) => { rule.pattern = value; }))
      .addExtraButton((button) => button.setIcon("arrow-up").setTooltip("上移")
        .setDisabled(index === 0).onClick(() => this.move(index, index - 1)))
      .addExtraButton((button) => {
        button.setIcon("arrow-down").setTooltip("下移").setDisabled(index === this.rules.length - 1)
          .onClick(() => this.move(index, index + 1));
      })
      .addExtraButton((button) => {
        button.setIcon("case-sensitive").setTooltip("区分大小写")
          .onClick(() => { rule.caseSensitive = !rule.caseSensitive; this.render(); });
        button.extraSettingsEl.toggleClass("is-active", rule.caseSensitive);
      })
      .addExtraButton((button) => button.setIcon("trash-2").setTooltip("删除")
        .onClick(() => { this.rules.splice(index, 1); this.render(); }));
    setting.infoEl.remove();
  }

  private move(from: number, to: number): void {
    if (to < 0 || to >= this.rules.length) return;
    const [rule] = this.rules.splice(from, 1);
    if (!rule) return;
    this.rules.splice(to, 0, rule);
    this.render();
  }
}
