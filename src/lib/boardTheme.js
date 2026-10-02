// Persistent storage for the player's board theme choice — plain
// localStorage, matching relayAddress.js's/deckLibrary.js's existing
// convention (no Electron IPC/preload infra for this app, and none needed
// here either).

const THEME_KEY = 'scripturas-board-theme';
export const BOARD_THEMES = ['light', 'dark'];
const DEFAULT_THEME = 'light';

export const getBoardTheme = () => {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return BOARD_THEMES.includes(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

export const setBoardTheme = (theme) => {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable — the toggle just won't remember the last value.
  }
};
