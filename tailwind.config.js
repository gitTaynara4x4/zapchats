/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './frontend/**/*.html',
    './frontend/**/*.{js,ts}',
    './src/**/*.{html,js,ts,jsx,tsx}',
    './templates/**/*.html'
  ],
  theme: { extend: {} },
  plugins: []
};
