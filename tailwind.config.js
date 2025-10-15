/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './frontend/**/*.html',
    './frontend/**/*.js',
    './frontend/**/*.ts',
    './frontend/pages/**/*.html',
    './frontend/partials/**/*.html',
    './src/**/*.html',
    './src/**/*.js',
    './templates/**/*.html',
  ],
  safelist: [
    'dark:bg-neutral-950','dark:text-neutral-200','dark:bg-neutral-900',
    'dark:border-neutral-700','dark:border-neutral-800','dark:shadow-black/40',
    'dark:text-white','dark:text-gray-400','dark:hidden','dark:block',
  ],
  theme: { extend: {} },
  plugins: [],
};
