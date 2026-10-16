import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "public/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "vite.config.ts", "capacitor.config.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
