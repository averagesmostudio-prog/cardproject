// Shared backdrop styling for the deck screens (the Library's deck picker and
// the Deck Builder): gray linen panels over a mottled dark page background.
const deckAsset = (name) => `${import.meta.env.BASE_URL}deckbuilder/${name}`;
export const LINEN_BG = `#a7a49b url(${deckAsset('linen.jpg')}) center/cover`;
export const PAGE_BG = `#232323 url(${deckAsset('bg.jpg')}) center/cover fixed`;
