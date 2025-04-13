import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

// Import colors

// Constants adapted from agents-playground config
const shades = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const colorList = [
  "gray",
  "green",
  "cyan",
  "amber",
  "violet",
  "blue",
  "rose",
  "pink",
  "teal",
  "red",
];
const uiElements = [
  "bg",
  "selection:bg",
  "border",
  "text",
  "hover:bg",
  "hover:border",
  "hover:text",
  "ring",
  "focus:ring",
  `focus:border`,
]; // Added focus:border
const customColors = {
  cyan: colors.cyan,
  green: colors.green,
  amber: colors.amber,
  violet: colors.violet,
  blue: colors.blue,
  rose: colors.rose,
  pink: colors.pink,
  teal: colors.teal,
  red: colors.red,
};

// Generate shadows based on custom colors
// Use const as these are not reassigned after the loop
const customShadows: Record<string, string> = {};
const shadowNames: string[] = [];
const textShadows: Record<string, string> = {};
const textShadowNames: string[] = [];

for (const [name, color] of Object.entries(customColors)) {
  // Use a more specific type assertion if possible, or keep as Record<string, string>
  const colorShades = color as Record<string, string>;
  const color500 = colorShades["500"] || "#000";
  const color600 = colorShades["600"] || "#000";
  const color700 = colorShades["700"] || "#000";

  customShadows[`${name}`] = `0px 0px 10px ${color500}`;
  customShadows[`lg-${name}`] = `0px 0px 20px ${color600}`;
  textShadows[`${name}`] = `0px 0px 4px ${color700}`;
  // Note: The arrays below *are* modified in the loop, so they should remain 'let' if declared outside,
  // but since they are declared with const here, we push to them which is allowed.
  textShadowNames.push(`drop-shadow-${name}`);
  shadowNames.push(`shadow-${name}`);
  shadowNames.push(`shadow-lg-${name}`);
  shadowNames.push(`hover:shadow-${name}`);
}

// Generate safelist for dynamic classes
const safelist = [
  "bg-black",
  "bg-white",
  "transparent",
  "object-cover",
  "object-contain",
  ...shadowNames,
  ...textShadowNames,
  ...shades.flatMap((shade) => [
    ...colorList.flatMap((color) => [
      ...uiElements.flatMap((element) => [`${element}-${color}-${shade}`]),
    ]),
  ]),
];

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}", // Keep existing paths
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    // Add colors from agents-playground
    colors: {
      transparent: "transparent",
      current: "currentColor",
      black: colors.black,
      white: colors.white,
      gray: colors.neutral, // Use neutral for gray
      ...customColors,
    },
    // Add extensions from agents-playground
    extend: {
      dropShadow: {
        ...textShadows,
      },
      boxShadow: {
        ...customShadows,
      },
    },
  },
  plugins: [],
  safelist, // Add the safelist
};
export default config;
