// Shared source for "the current card CSV" used by Build, Open a Pack, and
// Play a Game. A custom CSV set via the Settings panel (passcode-gated) is
// stored in localStorage and takes priority over the bundled default file.

const CUSTOM_CSV_KEY = 'scripturas-custom-csv';
const CUSTOM_CSV_NAME_KEY = 'scripturas-custom-csv-name';
// Relative (no leading slash): the packaged Electron app loads index.html via
// file://, where an absolute "/..." path resolves to the filesystem root
// instead of the app's dist/ folder. A relative path resolves correctly in
// both the Vite dev server and the packaged file:// build.
const DEFAULT_CSV_URL = 'default-card-set.csv';

export const getCustomCsvName = () => {
  try {
    return localStorage.getItem(CUSTOM_CSV_NAME_KEY);
  } catch {
    return null;
  }
};

export const setCustomCsv = (text, fileName) => {
  localStorage.setItem(CUSTOM_CSV_KEY, text);
  localStorage.setItem(CUSTOM_CSV_NAME_KEY, fileName || 'custom.csv');
};

export const clearCustomCsv = () => {
  localStorage.removeItem(CUSTOM_CSV_KEY);
  localStorage.removeItem(CUSTOM_CSV_NAME_KEY);
};

// Resolves to the CSV text every screen should load: the stored custom set
// if one exists, otherwise the bundled default.
export const getActiveCsvText = async () => {
  let custom = null;
  try {
    custom = localStorage.getItem(CUSTOM_CSV_KEY);
  } catch {
    custom = null;
  }
  if (custom) return custom;

  const res = await fetch(DEFAULT_CSV_URL);
  if (!res.ok) return null;
  return res.text();
};
