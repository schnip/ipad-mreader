import tseslint from "typescript-eslint";

// P0 probe modules are retained only as diagnostic references; they are not
// part of the app bundle, so they are excluded from type-aware lint and tsc.
const probes = [
  "src/device-report.ts",
  "src/interaction-probes.ts",
  "src/opfs-probe.ts",
  "src/pdf-probe.ts",
  "src/gesture-math.ts",
  "src/gesture-math.test.ts"
];

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "public/**", "android/**", ...probes] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "vite.config.ts", "capacitor.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked
  }
);
