/** @type {import('tailwindcss').Config} */
// Mastek theme (white-first). The `ink` scale is the neutral ramp: 950/900 are page and panel
// backgrounds, 700/600 borders, 400 secondary text, 100 primary text.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#F4F6FB",
          900: "#FFFFFF",
          850: "#FFFFFF",
          800: "#EEF2F8",
          700: "#E3E8F0",
          600: "#CDD5E1",
          500: "#94A3B8",
          400: "#6B7280",
          300: "#4B5563",
          200: "#374151",
          100: "#111827",
        },
        accent: { DEFAULT: "#001689", muted: "#0099A8" },
        mastek: {
          blue: "#001689",
          turquoise: "#0099A8",
          green: "#5ECC62",
          sky: "#0FBDFF",
          yellow: "#EBAA01",
          violet: "#AE63E4",
          orange: "#EE8A2B",
        },
      },
      fontFamily: {
        sans: ["Poppins", "Trebuchet MS", "system-ui", "sans-serif"],
        display: ["Titillium Web", "Trebuchet MS", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
      borderRadius: { card: "12px" },
      boxShadow: { soft: "0 1px 2px rgba(0, 22, 137, 0.04), 0 4px 14px rgba(0, 22, 137, 0.06)" },
      backgroundImage: {
        "mastek-strip": "linear-gradient(90deg, #001689 0%, #0099A8 55%, #5ECC62 100%)",
        "mastek-cool": "linear-gradient(135deg, #0099A8 0%, #0FBDFF 100%)",
      },
    },
  },
  plugins: [],
};
