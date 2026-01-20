// Template for SharedResources/supabase-env.js
// Copy this file to supabase-env.js (or generate it via npm run supabase:env)
// and replace the placeholder strings with your Supabase project values.

window.__NAEI_SUPABASE_CONFIG = Object.freeze({
  url: "https://YOUR-PROJECT.supabase.co",
  key: "sb-publishable-XXXX",
  storageKeyBase: "sb-your-project-auth-token",
  authStorageScope: "app", // Optional: 'global' | 'app' | 'route'
  // authStorageKeySuffix: "linechart" // Optional explicit slug override
});
