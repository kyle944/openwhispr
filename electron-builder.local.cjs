const os = require("os");
const path = require("path");
const baseConfig = require("./electron-builder.json");

module.exports = {
  ...baseConfig,
  appId: "com.kylecooper.openwhispr.local",
  // A local .app left under the repository is indexed by LaunchServices and
  // becomes indistinguishable from the installed bundle by app ID. Keep build
  // products in the user's cache, outside normal application discovery.
  directories: {
    ...baseConfig.directories,
    output: path.join(os.homedir(), "Library", "Caches", "OpenWhispr Local", "build"),
  },
  mac: {
    ...baseConfig.mac,
    identity: "OpenWhispr Local Code Signing",
    notarize: false,
    extendInfo: {
      ...baseConfig.mac.extendInfo,
      CFBundleDisplayName: "OpenWhispr Local",
    },
  },
};
