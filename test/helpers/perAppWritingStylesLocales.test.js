const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const locales = ["de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"];
const requiredKeys = [
  "title",
  "description",
  "availability",
  "empty",
  "output",
  "tone",
  "followGlobal",
  "outputFor",
  "toneFor",
  "remove",
];

test("every locale includes the per-app writing-style controls", () => {
  for (const locale of locales) {
    const file = path.join(__dirname, "..", "..", "src", "locales", locale, "translation.json");
    const messages = JSON.parse(fs.readFileSync(file, "utf8"));
    const perAppStyles = messages.settingsPage.aiModels.perAppStyles;
    for (const key of requiredKeys) {
      assert.equal(
        typeof perAppStyles?.[key],
        "string",
        `${locale} is missing perAppStyles.${key}`
      );
      assert.ok(perAppStyles[key].trim(), `${locale} perAppStyles.${key} is empty`);
    }
  }
});
