import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default {
  extends: [core, antiSlop],
  env: core.env,
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist/**"],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: false }],
  },
};
