import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  useSettingsStore,
} from "../../stores/settingsStore";
import type {
  CleanupIntensity,
  CleanupOutputMode,
  CleanupTone,
} from "../../utils/writingPreferences";
import { Toggle } from "../ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPanel, SettingsPanelRow, SettingsRow, SectionHeader } from "../ui/SettingsSection";

const SELECT_CLASS = "h-7 w-36 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3";

export default function WritingSettings() {
  const { t } = useTranslation();
  const policyState = usePolicySnapshot();
  const cleanupIntensity = useSettingsStore((s) => s.cleanupIntensity);
  const cleanupMode = useSettingsStore(
    useShallow(
      (settings) =>
        selectResolvedLLMConfig(
          selectPolicyEffectiveSettings(settings, policyState),
          "dictationCleanup"
        ).mode
    )
  );
  const cleanupOutputMode = useSettingsStore((s) => s.cleanupOutputMode);
  const cleanupTone = useSettingsStore((s) => s.cleanupTone);
  const backgroundCleanupEnabled = useSettingsStore((s) => s.backgroundCleanupEnabled);
  const setCleanupIntensity = useSettingsStore((s) => s.setCleanupIntensity);
  const setCleanupOutputMode = useSettingsStore((s) => s.setCleanupOutputMode);
  const setCleanupTone = useSettingsStore((s) => s.setCleanupTone);
  const setBackgroundCleanupEnabled = useSettingsStore((s) => s.setBackgroundCleanupEnabled);
  const supportsWritingPreferences = cleanupMode !== "openwhispr";

  return (
    <div className="space-y-3">
      <SectionHeader
        title={t("settingsPage.aiModels.writing.title")}
        description={t("settingsPage.aiModels.writing.description")}
      />
      {!supportsWritingPreferences ? (
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.aiModels.writing.availability")}
        </p>
      ) : (
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.aiModels.writing.intensity")}
              description={t("settingsPage.aiModels.writing.intensityDescription")}
            >
              <Select
                value={cleanupIntensity}
                onValueChange={(value) => setCleanupIntensity(value as CleanupIntensity)}
              >
                <SelectTrigger
                  className={SELECT_CLASS}
                  aria-label={t("settingsPage.aiModels.writing.intensity")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("settingsPage.aiModels.writing.intensityOptions.none")}
                  </SelectItem>
                  <SelectItem value="light">
                    {t("settingsPage.aiModels.writing.intensityOptions.light")}
                  </SelectItem>
                  <SelectItem value="polished">
                    {t("settingsPage.aiModels.writing.intensityOptions.polished")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.aiModels.writing.outputMode")}
              description={t("settingsPage.aiModels.writing.outputModeDescription")}
            >
              <Select
                value={cleanupOutputMode}
                onValueChange={(value) => setCleanupOutputMode(value as CleanupOutputMode)}
                disabled={cleanupIntensity === "none"}
              >
                <SelectTrigger
                  className={SELECT_CLASS}
                  aria-label={t("settingsPage.aiModels.writing.outputMode")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dictation">
                    {t("settingsPage.aiModels.writing.outputModeOptions.dictation")}
                  </SelectItem>
                  <SelectItem value="notes-to-dos">
                    {t("settingsPage.aiModels.writing.outputModeOptions.notesToDos")}
                  </SelectItem>
                  <SelectItem value="email">
                    {t("settingsPage.aiModels.writing.outputModeOptions.email")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.aiModels.writing.tone")}
              description={t("settingsPage.aiModels.writing.toneDescription")}
            >
              <Select
                value={cleanupTone}
                onValueChange={(value) => setCleanupTone(value as CleanupTone)}
                disabled={cleanupIntensity === "none"}
              >
                <SelectTrigger
                  className={SELECT_CLASS}
                  aria-label={t("settingsPage.aiModels.writing.tone")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    {t("settingsPage.aiModels.writing.toneOptions.default")}
                  </SelectItem>
                  <SelectItem value="formal">
                    {t("settingsPage.aiModels.writing.toneOptions.formal")}
                  </SelectItem>
                  <SelectItem value="casual">
                    {t("settingsPage.aiModels.writing.toneOptions.casual")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.aiModels.writing.backgroundCleanup")}
              description={t("settingsPage.aiModels.writing.backgroundCleanupDescription")}
            >
              <Toggle
                checked={backgroundCleanupEnabled}
                onChange={setBackgroundCleanupEnabled}
                ariaLabel={t("settingsPage.aiModels.writing.backgroundCleanup")}
              />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      )}
    </div>
  );
}
