/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',

    // frontend
    './frontend/**/*.html',
    './frontend/**/*.js',
    './frontend/**/*.ts',
    './frontend/partials/**/*.html',
    './frontend/pages/**/*.html',

    // se renderiza pelo backend
    './templates/**/*.html',
  ],
  // evita escanear lixo
  safelist: [
    // classes dark usadas no login:
    'dark:bg-neutral-950','dark:text-neutral-200','dark:bg-neutral-900',
    'dark:border-neutral-700','dark:border-neutral-800','dark:shadow-black/40',
    'dark:text-white','dark:text-gray-400','dark:hidden','dark:block',
  ],
  theme: { extend: {} },
  plugins: [],
};
