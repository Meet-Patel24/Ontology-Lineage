/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0b0e14",
          900: "#10141c",
          850: "#151a24",
          800: "#1a202c",
          700: "#252d3b",
          600: "#323c4e",
          500: "#4a5568",
          400: "#7a8699",
          300: "#a6b0c0",
          200: "#cdd4df",
          100: "#e8ecf2",
        },
        accent: { DEFAULT: "#4f9cf9", muted: "#2b5d9c" },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
