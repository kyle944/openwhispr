import { useShallow } from "zustand/react/shallow";
import { usePolicySnapshot } from "./usePolicy";
import { useManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import {
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  useSettingsStore,
} from "../stores/settingsStore";
import {
  resolvePerAppWritingStylesSurface,
  type PerAppWritingStylesSurface,
} from "../utils/perAppWritingStyles";
import { getCachedPlatform } from "../utils/platform";

export function usePerAppWritingStylesSurface(): PerAppWritingStylesSurface {
  const policyState = usePolicySnapshot();
  const enterpriseSetupMode = useSettingsStore((state) => state.enterpriseSetupMode);
  useManagedScopeResolution("dictationCleanup", enterpriseSetupMode);
  const effectiveCleanupMode = useSettingsStore(
    useShallow(
      (state) =>
        selectResolvedLLMConfig(
          selectPolicyEffectiveSettings(state, policyState),
          "dictationCleanup"
        ).mode
    )
  );

  return resolvePerAppWritingStylesSurface(getCachedPlatform(), effectiveCleanupMode);
}
