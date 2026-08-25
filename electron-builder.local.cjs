const baseConfig = require("./electron-builder.json");

module.exports = {
  ...baseConfig,
  appId: "com.kylecooper.openwhispr.local",
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
