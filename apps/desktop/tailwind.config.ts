import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        mist: "#eef2f6",
        panel: "#ffffff",
        line: "#d7dee7",
        accent: "#0f766e",
        success: "#15803d",
        warn: "#b45309",
        danger: "#b91c1c",
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "Segoe UI",
          "sans-serif"
        ],
        mono: [
          "var(--font-mono)",
          "monospace"
        ],
      },
      boxShadow: {
        panel: "0 12px 32px rgba(15, 23, 42, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
