import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";


export default [
  { ignores: ["dist/"] }, // Ignore the dist folder globally
  // Use the spread syntax for the recommended config
  { files: ["**/*.{js,mjs,cjs,ts}"], ...js.configs.recommended },
  // Add node globals since this is backend code, keep browser globals too if needed
  { files: ["**/*.{js,mjs,cjs,ts}"], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  // Spread the typescript-eslint recommended configs directly into the array
  ...tseslint.configs.recommended,
];
