/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './**/*.{html,js}',
    '!./node_modules/**',
    '!./dist/**',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

