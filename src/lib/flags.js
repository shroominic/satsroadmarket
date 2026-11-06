/** Dev/E2E-only features (local relay and mint, test mints, fake-money funding). False in the production build. */
export const DEV_FEATURES = typeof import.meta.env === 'undefined' ? false : !!(import.meta.env.DEV || import.meta.env.VITE_E2E === '1');
