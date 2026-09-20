import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { usePerAppWritingStylesSurface } from "../../hooks/usePerAppWritingStylesSurface";
import { useSettingsStore } from "../../stores/settingsStore";
import type { CleanupOutputMode, CleanupTone } from "../../utils/writingPreferences";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPanel, SettingsPanelRow, SectionHeader } from "../ui/SettingsSection";

const GLOBAL_VALUE = "__global__";
const SELECT_CLASS = "h-7 w-36 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3";

export default function PerAppWritingStyles() {
  const { t } = useTranslation();
  const surface = usePerAppWritingStylesSurface();
  const { cleanupIntensity, perAppWritingStyles, removePerAppWritingStyle, setPerAppWritingStyle } =
    useSettingsStore(
      useShallow((state) => ({
        cleanupIntensity: state.cleanupIntensity,
        perAppWritingStyles: state.perAppWritingStyles,
        removePerAppWritingStyle: state.removePerAppWritingStyle,
        setPerAppWritingStyle: state.setPerAppWritingStyle,
      }))
    );
  if (surface === "hidden") return null;
  const supported = surface === "available";

  return (
    <div className="space-y-3">
      <SectionHeader
        title={t("settingsPage.aiModels.perAppStyles.title")}
        description={t("settingsPage.aiModels.perAppStyles.description")}
      />
      {!supported ? (
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.aiModels.perAppStyles.availability")}
        </p>
      ) : perAppWritingStyles.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.aiModels.perAppStyles.empty")}
        </p>
      ) : (
        <SettingsPanel>
          {perAppWritingStyles.map((style) => (
            <SettingsPanelRow key={style.bundleId}>
              <div className="flex flex-col gap-3">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{style.appName}</p>
                    <p className="truncate text-[11px] text-muted-foreground/80">
                      {style.bundleId}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={t("settingsPage.aiModels.perAppStyles.remove", {
                      app: style.appName,
                    })}
                    onClick={() => removePerAppWritingStyle(style.bundleId)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("settingsPage.aiModels.perAppStyles.output")}</span>
                    <Select
                      value={style.cleanupOutputMode ?? GLOBAL_VALUE}
                      disabled={cleanupIntensity === "none"}
                      onValueChange={(value) =>
                        setPerAppWritingStyle(style.bundleId, {
                          cleanupOutputMode:
                            value === GLOBAL_VALUE ? null : (value as CleanupOutputMode),
                        })
                      }
                    >
                      <SelectTrigger
                        className={SELECT_CLASS}
                        aria-label={t("settingsPage.aiModels.perAppStyles.outputFor", {
                          app: style.appName,
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={GLOBAL_VALUE}>
                          {t("settingsPage.aiModels.perAppStyles.followGlobal")}
                        </SelectItem>
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
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("settingsPage.aiModels.perAppStyles.tone")}</span>
                    <Select
                      value={style.cleanupTone ?? GLOBAL_VALUE}
                      disabled={cleanupIntensity === "none"}
                      onValueChange={(value) =>
                        setPerAppWritingStyle(style.bundleId, {
                          cleanupTone: value === GLOBAL_VALUE ? null : (value as CleanupTone),
                        })
                      }
                    >
                      <SelectTrigger
                        className={SELECT_CLASS}
                        aria-label={t("settingsPage.aiModels.perAppStyles.toneFor", {
                          app: style.appName,
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={GLOBAL_VALUE}>
                          {t("settingsPage.aiModels.perAppStyles.followGlobal")}
                        </SelectItem>
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
                  </label>
                </div>
              </div>
            </SettingsPanelRow>
          ))}
        </SettingsPanel>
      )}
    </div>
  );
}
