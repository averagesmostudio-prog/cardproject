import React, { useState } from 'react';

// Rules text is the user's own verbatim ruling draft — cross-checked
// against the live engine (deck sizes, mulligan floor, draw-fail
// penalty, turn-step order/names, the Down Tick cost + effigy reshuffle,
// win condition) with no discrepancies found, so it's reproduced as-is
// rather than rewritten. Broken into the same sections the user already
// wrote it in.
const RULES_SECTIONS = [
  {
    title: 'Deck Building',
    body: `Your Main Deck consists of 40 cards, no more no less. You can add up to 3 copies of any card to your Main Deck, other than Deities which are restricted to a maximum of 2 Deities per deck. You must also construct a 15 card Effigy deck consisting of any combination of Effigy cards. The two decks remain separate during gameplay.`,
  },
  {
    title: 'Starting the Game',
    body: `Each Player begins with a starting Lifespan of (50). Shuffle both the Main Deck and Effigy Deck (separately). Offer both decks to be cut by your opponent before proceeding. Flip a coin to decide turn order with one Player flipping while the other calls the result. The winner chooses the turn order. Once decided, each Player draws (5) cards from their Main Deck. A Player may choose to mulligan, reshuffling and drawing a new hand. If a Player decides to Mulligan they must reduce their starting Lifespan by (5). A Player may not reduce their starting Lifespan below (5). This loss of Lifespan is considered to have happened outside of the game.`,
  },
  {
    title: 'Turns / Game Play',
    steps: [
      {
        name: 'Time Step',
        body: `Active Player begins the Time Step by removing (1) Time Counter from each Prophecy that they control, moving from left to right. If a Prophecy has (0) Time Counters on it reveal it before moving to the next one. After resolving the effect, if a revealed Prophecy has (0) Time Counters on it, send it to Purgatory. After the Ethereal Realm, Active Player continues to the Mortal Realm and removes (1) Time Counter on each applicable Being or Relic still moving left to right. Resolve any effects from having (0) Time Counters remaining as the Time Counter is removed. If all Time Counters have been removed from applicable cards, move to Disengage Step.`,
      },
      {
        name: 'Disengagement Step',
        body: `Active Player Disengages all Beings/Relics they control, moving from left to the right. Resolve each effect that occurs or is triggered before continuing to the next Disengage. If all applicable Beings/Relics have been Disengaged and all effects resolved, move to Craft.`,
      },
      {
        name: 'Craft Step',
        body: `All Players Craft (1) Effigy from their Effigy Deck. During the Starting Player's first Turn, the Starting Player Crafts (1) additional Effigy. Resolve each effect that occurs or is triggered before moving forward. If all Effigy have been Crafted and any effects resolved, move to Draw.`,
      },
      {
        name: 'Draw Step',
        body: `Except for the Starting Player's first turn, the active Player Draws (1) Card from their Main Deck after Craft Step. During the Starting Player's first Turn, the Starting Player does not draw. Resolve each effect that occurs or is triggered before moving forward. If a Player attempts to draw a card from their deck and is not able to, they lose (10) Lifespan. If all cards have been drawn and any effects resolved, move to Main.`,
      },
      {
        name: 'Main',
        body: `Players may play any amount of cards from their hand assuming that they meet the requirements to do so. These requirements include the Effigy Cost in the top left of the card as well as any that may be listed in the text box. To meet the required Effigy Cost a Player may burn Effigies to do so. This means that the Effigy becomes engaged and then is returned to the Effigy Deck at the start of Down Tick Step.

When a Being is Summoned to the Mortal Realm it enters Engaged, Deities do not follow this rule of engagement. A Player may Engage a Being to move it to an open tile which that Being's directional arrows point to. If a Being is in the front row (one row before the Ethereal Realm) it may be Engaged to Fight, see rulings in Fighting below. A Being may also be Engaged as a cost requirement to activate its effect. Relics also have Engageable actions written in their text box, however they can not move or Fight unless otherwise noted. Like Deities, Relics do not Engage when entering the Mortal Realm.

When a Being's Lifespan hits 0 (or below) it dies and is sent to Purgatory from the Mortal Realm. If a Being dies you lose Lifespan equal to that Being's original Lifespan; this is also true for a sacrificed Being.

Prophecies are Conjured into the Ethereal Realm face down with a number of Time Counters on them denoted in the top right of the card. When a Prophecy has (0) Time Counters on it, it is revealed and then set to your Purgatory when the effect is resolved. The Ethereal Realm is a shared Realm for both Players so tile management is important.

Conjurings and Ethereal Conjurings are different from the other card typings as they do not require a tile to be played on. Both are conjured directly from hand and are sent to Purgatory after resolving their effect. Conjurings may only be played on your turn and can only be played when no other action is occurring, whereas Ethereal Conjurings can be played on anyone's turn and in response to any effect resolving or triggering.

When you have no more actions to resolve, or cards you wish to play, move to Down Tick.`,
      },
      {
        name: 'Down Tick',
        body: `Active Player resolves any end of turn effects starting in the Ethereal Realm moving from left to right. Any Players who have burned Effigies return them to and then shuffle their Effigy Decks. Active Player loses (1) Lifespan as the final action before the next Player starts their turn.`,
      },
    ],
  },
  {
    title: 'Fighting',
    body: `The Active Player may begin a Fight at any point during their turn. To do so the Active Player may engage a Being in the front row, declaring the Fight. When Fighting, a Being deals damage in the lane directly in front of it, bypassing the Ethereal Realm. If no Being is present in the opposing lane the damage is dealt directly to the opposing Player instead. The damage dealt is equal to the Fighting Being's current Strength. When a Fight occurs and there is a different Being in the lane directly in front of it, damage is dealt to both Beings. The damage dealt to each Being is equal to the opposing Being's current Strength. Damage dealt is permanent and remains between turns.`,
  },
  {
    title: 'Winning the Game',
    body: `When the opposing Player reaches (0) Lifespan at the end of an action resolution you win the game.`,
  },
  {
    title: 'Q & A',
    qa: [
      `If a Player mulligans and a card would restore them to their starting total, it would restore them to their total Lifespan after the mulligans.`,
      `A Player's Lifespan may go beyond their starting total — they may restore Lifespan even if it would put them above their starting total.`,
      `Lifespan reduction due to mulligan occurs outside of the game and reduces total Lifespan; it would not trigger the effects of cards that refer to Starting Lifespan vs. Current Lifespan, since you have not actively lost life after the start of the game.`,
    ],
  },
];

// Distilled from RULES.md's own Keywords section — that file is a
// developer implementation log (regex references, "Trigger point
// implemented", per-card engineering caveats), not something to hand a
// player, so this keeps just the one-sentence rules definition for each
// real keyword and drops everything else.
const KEYWORDS = [
  { name: 'Persist', body: `This Being does not Engage when it enters the Mortal Realm (whether summoned, or moving in from elsewhere).` },
  { name: 'Favored', body: `Gain a Favor Counter. The next time this Being would take damage, remove the Favor Counter instead and prevent that damage.` },
  { name: 'Depart: "X"', body: `When this Being dies, "X" happens. (Sometimes printed as "When this Being dies, X" instead — same meaning.)` },
  { name: 'Martyr: "X"', body: `Engage this Being, then sacrifice it: "X" happens. Costs an Engage as part of activating it, so it needs to be disengaged first, same as attacking.` },
  { name: 'Engage: "X"', body: `A generic activated ability: engage this card (its action for the turn), then "X" happens. Printed on both Beings and Relics.` },
  { name: 'Engage (generic term)', body: `The generic term for taking an action with a Being (moving, attacking, activating an Engage-costed ability) or a Relic that carries "Engage: X" text. A Being can only take one Engage action per turn — once engaged it can't act again until Disengaged, at the start of its controller's next turn.` },
  { name: 'Engage, X: Y', body: `A comma right after "Engage" means X is a required second part of the cost, not the effect: both Engage and X must be paid before Y happens.` },
  { name: 'Modulate (±X)', body: `Add or remove X Time Counters from a target card — the same mechanic as the automatic Time Step, generalized into a keyword so card effects can apply it (any sign, any target) outside of that step.` },
  { name: 'Shift (X)', body: `Engage this card, then move it onto an Ethereal Realm tile: it becomes a Prophecy (losing all other text and typings while it is one) and gains (X) Time Counters. When it reaches (0) Time Counters, it moves back onto a Mortal Realm tile, Engaged.` },
  { name: 'Animated', body: `While in the Mortal Realm, this (normally a Relic — Armament) is treated as a Being: it has its own Strength/Lifespan, other Beings may still move onto its tile, and any effect that targets a Being or an Armament may target it.` },
  { name: 'Dryad', body: `This Being may move onto another Being with the TreeFolk, Vine, or Seed typing (stacking on its tile, like an Armament would). While attached this way, it gains that Being's Strength and Lifespan on top of its own.` },
  { name: 'Invoke', body: `Search your deck for a card of the named type, reveal it, add it to hand, then immediately summon/conjure it — a tutor plus a free cast/summon in one.` },
  { name: 'Unruly', body: `Whenever this Being attacks, lose Lifespan equal to its current Strength.` },
  { name: 'When Summoned: "X"', body: `A Being's enter-the-battlefield trigger — fires the moment it's placed on the board, whether by a normal summon or any other effect that puts it into play.` },
];

function RulesPanel() {
  return (
    <div className="space-y-8 text-left">
      {RULES_SECTIONS.map(section => (
        <section key={section.title}>
          <h2 className="text-lg font-bold text-stone-800 mb-2">{section.title}</h2>
          {section.body && (
            <p className="text-sm text-stone-600 whitespace-pre-line leading-relaxed">{section.body}</p>
          )}
          {section.steps && (
            <div className="space-y-4 mt-2">
              {section.steps.map(step => (
                <div key={step.name}>
                  <h3 className="text-sm font-semibold text-stone-700 mb-1">{step.name}</h3>
                  <p className="text-sm text-stone-600 whitespace-pre-line leading-relaxed">{step.body}</p>
                </div>
              ))}
            </div>
          )}
          {section.qa && (
            <ul className="list-disc list-outside pl-5 space-y-2 mt-1">
              {section.qa.map((item, i) => (
                <li key={i} className="text-sm text-stone-600 leading-relaxed">{item}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function KeywordsPanel() {
  return (
    <div className="space-y-5 text-left">
      {KEYWORDS.map(kw => (
        <div key={kw.name}>
          <h3 className="text-sm font-bold text-stone-800">{kw.name}</h3>
          <p className="text-sm text-stone-600 leading-relaxed">{kw.body}</p>
        </div>
      ))}
    </div>
  );
}

export default function HowToPlay({ onBack }) {
  const [tab, setTab] = useState('rules'); // 'rules' | 'keywords'

  return (
    <div className="min-h-dvh bg-black p-8 short:p-2">
      <button
        onClick={onBack}
        className="fixed top-3 left-3 z-40 text-xs bg-white/90 border border-stone-300 rounded px-3 py-1.5 shadow hover:bg-white"
      >
        ← Menu
      </button>
      <div className="max-w-2xl mx-auto pt-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-white mb-2">How to Play</h1>
          <p className="text-stone-400 text-sm">The rules of Scripturas Alpha, plus a glossary of printed keywords.</p>
        </div>

        <div className="flex items-center justify-center gap-2 mb-6">
          <button
            onClick={() => setTab('rules')}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${tab === 'rules' ? 'bg-white text-stone-800' : 'bg-white/10 text-stone-300 hover:bg-white/20'}`}
          >
            Rules
          </button>
          <button
            onClick={() => setTab('keywords')}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${tab === 'keywords' ? 'bg-white text-stone-800' : 'bg-white/10 text-stone-300 hover:bg-white/20'}`}
          >
            Keywords
          </button>
        </div>

        <div className="bg-white rounded-xl shadow p-6 sm:p-8">
          {tab === 'rules' ? <RulesPanel /> : <KeywordsPanel />}
        </div>
      </div>
    </div>
  );
}
