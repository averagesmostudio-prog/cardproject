// Preloaded, ready-to-play decks shown on the "Play a Game" screen
// (PreconSelect.jsx) — each is a real 40-card mono-color Main Deck (plus a
// matching 15-card mono-color Effigy Deck, built the same way the AI's own
// old random deck was: autoBuildEffigyCounts, deck.js) lifted straight from
// a real exported deck list. `icon` is a lucide-react component reference
// so PreconSelect can render it directly without a lookup table.
//
// `aiDifficulty` ('standard' | 'hard') scopes which precons GameApp.jsx's
// pickAiDeck draws the AI opponent's own deck from, per the human's chosen
// AI Difficulty (PreconSelect.jsx): Easy skips precons entirely (a plain
// random mono-color deck, the old default); Standard draws only from the
// precons tagged 'standard'; Hard draws only from the ones tagged 'hard'.
// A precon with no `aiDifficulty` (there are none right now, but a future
// one could omit it) is never picked as an AI deck at any difficulty — the
// human can still always pick it for themself regardless.
import { Swords, Hourglass, Skull, Ghost, Orbit, Rat } from 'lucide-react';

export const PRECON_DECKS = [
  {
    id: 'swords',
    name: 'Armed and Ready',
    tagline: 'Bleeding — Armaments and forge-craft aggression',
    color: 'bleeding',
    icon: Swords,
    aiDifficulty: 'hard',
    entries: [
      { name: 'Dancing Swords', count: 3 },
      { name: 'Rhak-tùrin Zealot', count: 3 },
      { name: 'Happy Hammer', count: 3 },
      { name: 'Mahka-Rahva', count: 2 },
      { name: 'Sharpshoot', count: 3 },
      { name: 'Crucible', count: 3 },
      { name: 'Tiny Forge Master', count: 3 },
      { name: 'Persitent Recruit', count: 3 },
      { name: 'Scrap removal', count: 3 },
      { name: 'Animate', count: 3 },
      { name: 'Desecration', count: 2 },
      { name: 'Blacksmithing', count: 3 },
      { name: 'Broken Broom', count: 2 },
      { name: 'Feathers of the Fallen', count: 2 },
      { name: 'Anahk-sha', count: 2 },
    ],
  },
  {
    id: 'timeless',
    name: 'Tick Tock',
    tagline: 'Timeless — Prophecies, Time Counters, and clockwork value',
    color: 'timeless',
    icon: Hourglass,
    aiDifficulty: 'standard',
    entries: [
      { name: 'Clock Tower Custodian', count: 3 },
      { name: 'Daylight Savings', count: 3 },
      { name: 'Eònion Zealot', count: 3 },
      { name: 'Mini Mage', count: 3 },
      { name: 'Orbital Acceleration', count: 3 },
      { name: 'Timeline Tinker', count: 3 },
      { name: 'Recollect', count: 2 },
      { name: 'Medium Mage', count: 3 },
      { name: 'Eònion Altar', count: 3 },
      { name: 'Horological Horror', count: 3 },
      { name: 'Hourglass', count: 3 },
      { name: 'Singularity', count: 3 },
      { name: 'Dial of Metatoris', count: 3 },
      { name: 'MetaToris', count: 2 },
    ],
  },
  {
    id: 'bones',
    name: 'Graveyard Bash',
    tagline: 'Shifting — Undead, Crossing Counters, and the grave',
    color: 'shifting',
    icon: Skull,
    aiDifficulty: 'standard',
    entries: [
      { name: 'Kalduran Altar', count: 3 },
      { name: 'Osteomancer', count: 3 },
      { name: 'Ditch Digger Steve', count: 3 },
      { name: 'Bone collector', count: 3 },
      { name: 'Cemetery Physician', count: 2 },
      { name: 'Cookie', count: 3 },
      { name: 'Grave robber', count: 1 },
      { name: 'Mausoleum Gates', count: 1 },
      { name: 'Skeletal Colossus', count: 3 },
      { name: 'Venefica', count: 3 },
      { name: 'Al khali the Empty', count: 2 },
      { name: 'Kalduran Zealot', count: 3 },
      { name: 'Martyrdom', count: 3 },
      { name: 'Shifting Sands', count: 3 },
      { name: 'Fetch', count: 1 },
      { name: 'Surveyor', count: 3 },
    ],
  },
  {
    id: 'hunger',
    name: 'Famished Phantoms',
    tagline: 'Formless — Hunger tribal, Effigy tempo, and self-inflicted damage',
    color: 'formless',
    icon: Ghost,
    aiDifficulty: 'standard',
    // From /Users/shawnmichael/Desktop/Script/Script samples/FormlessTest.json.
    entries: [
      { name: 'Cycle of Hunger', count: 3 },
      { name: 'Immen Gorta, the Boundless Hunger', count: 2 },
      { name: 'Mouth of Madness', count: 2 },
      { name: 'NamKaranian Altar', count: 2 },
      { name: 'Onagīous Hunger', count: 2 },
      { name: 'Ounati Hunger', count: 2 },
      { name: 'Pangs of Hunger', count: 2 },
      { name: 'Sanative Siphon', count: 2 },
      { name: 'Saan tachīan Hunger', count: 2 },
      { name: 'Scā-vuhk Hunger', count: 3 },
      { name: 'Simple Summoner', count: 2 },
      { name: 'Terranean Gates', count: 2 },
      { name: 'Thōgrakin Hunger', count: 3 },
      { name: 'Údarik Hunger', count: 3 },
      { name: 'By Teeth and bounds', count: 2 },
      { name: 'Divine Winds', count: 2 },
      { name: 'Priestly Practitioner', count: 2 },
      { name: 'Drown out the Screams', count: 2 },
    ],
  },
  {
    id: 'void',
    name: 'Call of the Void',
    tagline: 'Formless/Timeless — Hunger threats fueled by Time Counter combos',
    color: 'formless',
    icon: Orbit,
    aiDifficulty: 'hard',
    // From /Users/shawnmichael/Desktop/Script/Script samples/ComboTest.json.
    // Mixes Formless and Timeless Main Deck cards, so its own Effigy Deck
    // is an explicit 8 Formless / 7 Timeless split (effigyCounts below)
    // instead of the plain mono-color fallback every other precon uses.
    entries: [
      { name: 'Orbital Acceleration', count: 3 },
      { name: 'Freeze Frame', count: 3 },
      { name: 'Immen Gorta, the Boundless Hunger', count: 2 },
      { name: 'Terranean Gates', count: 2 },
      { name: 'Mouth of Madness', count: 2 },
      { name: 'Eònion Altar', count: 3 },
      { name: 'Pangs of Hunger', count: 2 },
      { name: 'By Teeth and bounds', count: 2 },
      { name: 'Daylight Savings', count: 3 },
      { name: 'Equanimity', count: 3 },
      { name: 'Clock Tower Custodian', count: 3 },
      { name: 'Surveyor', count: 2 },
      { name: 'Training dummy', count: 3 },
      { name: 'Priestly Practitioner', count: 3 },
      { name: 'Hourglass', count: 2 },
      { name: 'Instigator', count: 2 },
    ],
    effigyCounts: { formless: 8, timeless: 7 },
  },
  {
    id: 'rats',
    name: 'Plague Rats',
    tagline: 'Living/Shifting — Growth Counters feeding a graveyard grind',
    color: 'living',
    icon: Rat,
    aiDifficulty: 'hard',
    // From /Users/shawnmichael/Desktop/Script/Script samples/RatsTest.json.
    // Mixes Living and Shifting Main Deck cards, so its own Effigy Deck is
    // an explicit 8 Living / 7 Shifting split (effigyCounts below) instead
    // of the plain mono-color fallback every other precon uses.
    entries: [
      { name: 'Hoarder', count: 3 },
      { name: 'Greenseer', count: 2 },
      { name: 'Al khali the Empty', count: 2 },
      { name: 'Shifting Sands', count: 3 },
      { name: 'Arbosalis Altar', count: 3 },
      { name: 'Kalduran Zealot', count: 2 },
      { name: 'Divine Winds', count: 3 },
      { name: 'Blooming Seed', count: 2 },
      { name: 'Classic Familiar', count: 2 },
      { name: 'White Whisker', count: 1 },
      { name: "Greenseer's assistant", count: 3 },
      { name: 'Onoushara', count: 2 },
      { name: 'Strike Down', count: 3 },
      { name: 'Martyrdom', count: 2 },
      { name: 'Canopic Jar', count: 2 },
      { name: 'Balance the Scales', count: 2 },
      { name: 'Antiquities Dealer', count: 2 },
      { name: 'Stray', count: 1 },
    ],
    effigyCounts: { living: 8, shifting: 7 },
  },
];
