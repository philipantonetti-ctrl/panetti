import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Isolated worktrees live here. Each is a second checkout of this same
    // repo, so without this every source file is linted twice and `npm run
    // lint` reports thousands of problems that are all one file.
    ".claude/**",
  ]),
]);

export default eslintConfig;
