const test = require("node:test");
const assert = require("node:assert/strict");

const globalPreferences = {
  cleanupIntensity: "polished",
  cleanupOutputMode: "dictation",
  cleanupTone: "default",
  backgroundCleanupEnabled: true,
};

test("absent targets and unknown apps use global writing preferences", async () => {
  const { resolvePerAppWritingPreferences } =
    await import("../../src/utils/perAppWritingStyles.ts");
  const styles = [
    {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
      cleanupOutputMode: "notes-to-dos",
      cleanupTone: "formal",
    },
  ];

  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, null),
    globalPreferences
  );
  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, {
      bundleId: "com.apple.Mail",
      appName: "Mail",
    }),
    globalPreferences
  );
});

test("exact bundle-id matches override only output mode and tone", async () => {
  const { resolvePerAppWritingPreferences } =
    await import("../../src/utils/perAppWritingStyles.ts");
  const styles = [
    {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
      cleanupOutputMode: "notes-to-dos",
      cleanupTone: "formal",
    },
  ];

  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
    }),
    {
      ...globalPreferences,
      cleanupOutputMode: "notes-to-dos",
      cleanupTone: "formal",
    }
  );
  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, {
      bundleId: "COM.APPLE.TEXTEDIT",
      appName: "TextEdit",
    }),
    globalPreferences,
    "bundle identifiers are matched exactly, without fuzzy app-name matching"
  );
});

test("default per-app records are a no-op and invalid overrides fall back globally", async () => {
  const { normalizePerAppWritingStyles, resolvePerAppWritingPreferences } =
    await import("../../src/utils/perAppWritingStyles.ts");
  const styles = normalizePerAppWritingStyles([
    {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
      cleanupOutputMode: "invalid",
      cleanupTone: "invalid",
    },
  ]);

  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
    }),
    globalPreferences
  );
});

test("a new dictation target replaces the session input instead of inheriting an old app", async () => {
  const { rememberDictationTargetApp, resolvePerAppWritingPreferences } =
    await import("../../src/utils/perAppWritingStyles.ts");
  let styles = rememberDictationTargetApp([], {
    bundleId: "com.apple.TextEdit",
    appName: "TextEdit",
  });
  styles = styles.map((entry) => ({
    ...entry,
    cleanupOutputMode: "email",
    cleanupTone: "casual",
  }));

  const firstSession = { bundleId: "com.apple.TextEdit", appName: "TextEdit" };
  const secondSession = { bundleId: "com.apple.Mail", appName: "Mail" };
  assert.equal(
    resolvePerAppWritingPreferences(globalPreferences, styles, firstSession).cleanupOutputMode,
    "email"
  );
  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, secondSession),
    globalPreferences
  );
  assert.deepEqual(
    resolvePerAppWritingPreferences(globalPreferences, styles, null),
    globalPreferences
  );
});

test("remembered targets contain only app identity and bounded style fields", async () => {
  const { rememberDictationTargetApp } = await import("../../src/utils/perAppWritingStyles.ts");
  const styles = rememberDictationTargetApp([], {
    bundleId: "com.apple.TextEdit",
    appName: "TextEdit",
    title: "Private document",
    text: "secret",
    selection: "secret selection",
    axValue: "secret field",
  });

  assert.deepEqual(styles, [
    {
      bundleId: "com.apple.TextEdit",
      appName: "TextEdit",
      cleanupOutputMode: null,
      cleanupTone: null,
    },
  ]);
});
