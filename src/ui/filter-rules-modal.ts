import { Modal, Setting, type App } from "obsidian";
import type { FilterRule } from "../settings.js";
import { trackModalViewport } from "./modal-viewport.js";

export class FilterRulesModal extends Modal {
  private rules: FilterRule[];
  private stopViewport?: () => void;
  private saving = false;
  private opened = false;

  constructor(app: App, rules: readonly FilterRule[],
    private readonly save: (rules: FilterRule[]) => Promise<void>) {
    super(app);
    this.rules = rules.map((rule) => ({ ...rule }));
  }

  onOpen(): void {
    this.opened = true;
    this.modalEl.addClass("yunpan-sync-filter-modal");
    this.render();
    this.stopViewport = trackModalViewport(this.modalEl);
  }

  onClose(): void {
    this.opened = false;
    this.stopViewport?.();
    this.stopViewport = undefined;
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "过滤规则" });
    this.contentEl.createEl("p", {
      text: "选择参与或不参与同步的文件或文件夹。规则按列表从上到下匹配，最后命中的规则生效；Aa 控制是否区分大小写。通过“忽略此文件”添加的路径排除规则也在这里，删除或停用后保存即可取消忽略。",
      cls: "setting-item-description",
    });
    const actions = this.contentEl.createDiv({ cls: "yunpan-sync-filter-actions" });
    actions.createEl("button", { text: "添加规则" }).addEventListener("click", () => {
      this.rules.unshift({ id: crypto.randomUUID(), enabled: true, pattern: "", action: "exclude", caseSensitive: false });
      this.render();
    });
    const list = this.contentEl.createDiv({ cls: "yunpan-sync-filter-list" });
    this.rules.forEach((rule, index) => this.renderRule(list, rule, index));

    const saveError = this.contentEl.createDiv({ cls: "yunpan-sync-editor-error",
      attr: { role: "alert" } });
    const footer = this.contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const saveButton = footer.createEl("button", { text: "保存", cls: "mod-cta" });
    saveButton.addEventListener("click", async () => {
      if (this.saving) return;
      this.saving = true;
      saveButton.disabled = true;
      saveError.setText("");
      const rules = this.rules.map((rule) => ({ ...rule, pattern: rule.pattern.trim() }))
        .filter((rule) => rule.pattern.length > 0);
      const controls = this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select");
      const enabledControls = Array.from(controls).filter(control => !control.disabled);
      enabledControls.forEach(control => { control.disabled = true; });
      try {
        await this.save(rules);
        if (this.opened) this.close();
      } catch (error) {
        if (this.opened) saveError.setText(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.saving = false;
        enabledControls.forEach(control => { control.disabled = false; });
        saveButton.disabled = false;
      }
    });
  }

  private renderRule(container: HTMLElement, rule: FilterRule, index: number): void {
    const setting = new Setting(container).setClass("yunpan-sync-filter-rule")
      .addToggle((toggle) => toggle.setValue(rule.enabled).setTooltip("启用规则")
        .onChange((value) => { rule.enabled = value; }))
      .addDropdown((dropdown) => dropdown.addOption("exclude", "排除").addOption("include", "包含")
        .setValue(rule.action === "include" ? "include" : "exclude")
        .onChange((value) => { rule.action = value === "include" ? "include" : "exclude"; }))
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
