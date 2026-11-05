interface SettingsController {
  open(): void;
  openTabById(id: string): void;
}

interface AppWithSettings {
  setting: SettingsController;
}

export function openPluginSettings(app: AppWithSettings, pluginId: string): void {
  app.setting.open();
  app.setting.openTabById(pluginId);
}
