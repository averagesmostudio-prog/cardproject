// Preloaded, ready-to-play decks shown on the "Play a Game" screen
// (PreconSelect.jsx) — each is a real 40-card mono-color Main Deck (plus a
// matching 15-card mono-color Effigy Deck, built the same way the AI's own
// old random deck was: autoBuildEffigyCounts, deck.js) lifted straight from
// a real exported deck list. `icon` is a lucide-react component reference
// so PreconSelect can render it directly without a lookup table.
import { Swords, Hourglass, Skull } from 'lucide-react';

export const PRECON_DECKS = [
  {
    id: 'swords',
    name: 'Armed and Ready',
    tagline: 'Bleeding — Armaments and forge-craft aggression',
    color: 'bleeding',
    icon: Swords,
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
];
