import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import landmines from "ultracite/oxlint/landmines";

export default {
  extends: [core, antiSlop, landmines],
  jsPlugins: [...antiSlop.jsPlugins, ...landmines.jsPlugins],
  env: core.env,
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist/**"],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: false }],
    "landmines-testing/no-flake-masking": [
      "error",
      { allow: { "test/live.test.ts": 3 } },
    ],
  },
};
