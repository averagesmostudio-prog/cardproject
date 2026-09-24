import { describe, it, expect } from 'vitest';
import { parseKeywords, stripFlavorText, parseEffigyCost, totalCastingCost, createTokenCard, getCardKind, toGameCard, getBorderTypeForCard, parseCSV } from './cardData.js';

describe('parseCSV', () => {
  it('collapses an RFC4180 doubled quote ("") inside a quoted field into one literal quote, instead of dropping both', () => {
    // Mirrors Scā-vuhk Hunger's real printed row (public/default-card-set.csv):
    // the Text Box field is itself CSV-quoted, and prints a literal quoted
    // clause — "Shift (1): "At the end..."" — encoded per RFC4180 as a
    // doubled "" pair. A parser that just toggles in-quotes on every `"`
    // (the pre-fix behavior) drops BOTH characters of the pair, silently
    // stripping the literal quote marks the downstream shiftMatch regex
    // requires (cardData.js's own onOwnBeingShift-style anchored patterns).
    const csv = 'Card Name,Text Box\n'
      + 'Test Card,"Shift (1): ""At the end of your turn remove (1) Time Counter from this""\nSecond line."';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Text Box']).toBe('Shift (1): "At the end of your turn remove (1) Time Counter from this"\nSecond line.');
  });

  it('still strips the outer CSV-quoting quotes from a field with no embedded quotes', () => {
    const csv = 'Card Name,Text Box\nTest Card,"Gain +1/+1."';
    const rows = parseCSV(csv);
    expect(rows[0]['Text Box']).toBe('Gain +1/+1.');
  });
});

describe('parseKeywords', () => {
  it('returns all-false/null for text with no keywords', () => {
    const kw = parseKeywords('Gains +0/+3 if you control another Turanga.');
    expect(kw).toEqual({
      animated: false, dryad: false, persist: false, favored: false, invoke: false, unruly: false,
      depart: null, martyr: null, whenSummoned: null, whenConjureProphecy: null, engage: null, engageLifespanCost: null, engageCondition: null, engageExtraCost: null,
      engageCounterCost: null,
      shift: null, craftBonus: null,
      craftBonusCondition: null, conjureCost: null, statBonus: null, grantedEngage: null,
      armamentCounterGrant: null, sacrificeForFavored: false, onProphecyCounterRemoved: null,
      gathersArmamentsOnSummon: false, movesToNewlySummonedBeing: false, costReduction: null, beingsMayMoveAcross: false,
      engageAbilities: [], cannotAttack: false, sacrificeXSummon: null,
      payEffigyCostAbility: null, counterCostSacrificeAbility: null, onMove: null, onTypedSummonedUnderControl: null,
      engageBeingGrantCounter: null, removeCountersXSearchArmament: null, allCardsCostReduction: null,
      payLifespanCostAbility: null, sacrificeAtZeroTimeCounters: false, armamentIdentityOverride: false,
      cannotMove: false, neverAutoDisengages: false,
      onOwnMartyrTyped: null, onLifespanPaidGrowth: null, reanimateOnSacrificedTypedToken: null, onAllyFights: null,
      statBonusPerOwnDeathThisTurn: null, downTickLifespanReduction: null, onOwnBeingDiedGrowth: null,
      skipsControllerDraw: false, beingsEnterDisengaged: false, xEqualsTimeCountersControlled: false, statPenaltyEqualsTimeCountersControlled: false,
      collectsRemovedProphecyTimeCounters: false, timesPerTurnAbility: null,
      otherSameTypingBonus: null, allTypingsBonus: null, perOtherTypingBonus: null, perNonArmamentRelicLifespan: null,
      combatOpponentStrengthPenaltyIfNotFaithless: null, onModulateGrowth: null, endOfTurnGrowthPerName: null,
      moveForwardAtTurnStart: false, moveBackwardAtTurnEnd: false,
      dejaVu: false, dejaVuDeitySurcharge: null, additionalSummonCostSacrificeBeings: null,
      martyrCounterCost: null, martyrEffigyCost: null, onAttachedBeingDied: null, onConjure: null,
      alternateSummonAsProphecy: null, grantedMartyr: null, endOfTurnLoseLifespanEqualToCoLocatedBeing: false,
      searchDeckArmamentCostX: false, endOfTurnDamageNamedFamily: null, onModulateMinusOneAddCounter: null,
      onAnyBeingDiedGiveDifferentBuff: null,
      gainCounterOnAnyBeingDeath: null, removeCountersSacrificeSearchTypedCost: null, deckSearchOnTypedDeath: null,
      onRevealedTopOfDeck: null, engageEffigyCost: null, sacrificeIfEngagedAtEndOfTurn: false,
      removeCountersEngageRestoreLifespan: null,
      craftEffigyOnPointedRelicConjure: null, seedActivationCostReduction: null, onDryadAttachedOnto: null,
      preventOpenLaneDamageCraftEffigy: false, onOwnBeingDiedGainTextBox: false,
      onMovedIntoMortalRealm: null, endOfTurnRemoveOwnTimeCounters: null, onOwnBeingShift: null,
      duringEndStepForceShift: null, duringEndStepLoseTimeCounters: null, onDealsCombatDamageForceShift: null,
      onAnyBeingDiedMayShiftInstead: null, sacrificeSelfOnSummonTyping: null,
      boardWideAllyBonus: null, boardWideEnemyBonus: null, whenConjuredEnterUpTo: null,
    });
  });

  it('detects Persist as a standalone flag', () => {
    expect(parseKeywords('Persist').persist).toBe(true);
    expect(parseKeywords('Some other text.\nPersist').persist).toBe(true);
  });

  it('captures Depart\'s trailing effect text', () => {
    const kw = parseKeywords('Depart: Summon a Snake Skin token on this tile.\n(1 cost - Relic - Armament token).');
    expect(kw.depart).toBe('Summon a Snake Skin token on this tile.');
  });

  it('also captures "When this Being dies, X" as Depart (Thespian)', () => {
    const kw = parseKeywords("When summoned this Being's Strength and Lifespan becomes equal to target Being you control. \nWhen this Being dies you lose (4) Lifespan.");
    expect(kw.depart).toBe('you lose (4) Lifespan.');
    expect(kw.whenSummoned).toBe("this Being's Strength and Lifespan becomes equal to target Being you control.");
  });

  it('also captures "When this dies X" (no "Being") as Depart (Horological Horror)', () => {
    const kw = parseKeywords('When this dies you take (5) Lifespan Damage');
    expect(kw.depart).toBe('you take (5) Lifespan Damage');
  });

  it('captures Martyr\'s trailing effect text', () => {
    const kw = parseKeywords('Martyr: Add a Spirit to hand from deck.');
    expect(kw.martyr).toBe('Add a Spirit to hand from deck.');
  });

  it('captures Engage\'s trailing effect text', () => {
    const kw = parseKeywords('Engage: Move target Armament you control to a tile this points to.');
    expect(kw.engage).toBe('Move target Armament you control to a tile this points to.');
  });

  it('keeps Engage and Martyr independent when both are present', () => {
    const kw = parseKeywords('Engage: Discard a Spirit, add a Turanga to hand from your Purgatory.\nMartyr: Add a Spirit to hand from deck.');
    expect(kw.engage).toBe('Discard a Spirit, add a Turanga to hand from your Purgatory.');
    expect(kw.martyr).toBe('Add a Spirit to hand from deck.');
  });

  it('captures a bare "Martyr" (no colon, no effect) as an empty string — distinct from no Martyr at all (Bag o\' Bones)', () => {
    expect(parseKeywords('Martyr').martyr).toBe('');
    expect(parseKeywords('Gains +0/+3 if you control another Turanga.').martyr).toBeNull();
  });

  it('also accepts the real CSV\'s "Matyr" typo (missing the second "r") as bare Martyr', () => {
    expect(parseKeywords('Matyr').martyr).toBe('');
  });

  it('detects Animated (with or without trailing period)', () => {
    expect(parseKeywords('Animated. (While in the Mortal Realm this is treated as a Being.)').animated).toBe(true);
    expect(parseKeywords('Animated\nBeing gains +1/+1.').animated).toBe(true);
  });

  it('detects Dryad, Favored, and Invoke', () => {
    expect(parseKeywords('Dryad\nMay move onto a TreeFolk.').dryad).toBe(true);
    expect(parseKeywords('Favored').favored).toBe(true);
    expect(parseKeywords('Invoke a Being.').invoke).toBe(true);
  });

  it('captures an Altar\'s "Craft (N) additional Effigy" bonus (e.g. "Arbosalis Altar")', () => {
    const kw = parseKeywords('Craft (1) additional Effigy on your turn\n(Conjures in the Effigy Zone).');
    expect(kw.craftBonus).toBe(1);
  });

  it('captures the craft bonus even alongside other unrecognized Altar clauses (e.g. "Rhak-tùrin Altar")', () => {
    const kw = parseKeywords('As an aditional cost to Conjure: Deal (3) Damage to a Turanga you control.\nCraft (1) additional Effigy on your turn.\n(Conjures in the Effigy Zone)');
    expect(kw.craftBonus).toBe(1);
  });

  it('captures an Altar\'s "additional cost to Conjure" (e.g. "Kalduran Altar")', () => {
    const kw = parseKeywords('As an additional cost to conjure, send the top (3) cards of your deck to your Purgatory.\n Craft (1) additional Effigy on your turn\n(Conjures in the Effigy Zone).');
    expect(kw.conjureCost).toBe('send the top (3) cards of your deck to your Purgatory.');
  });

  it('tolerates the real CSV\'s "aditional" misspelling (e.g. "Rhak-tùrin Altar")', () => {
    const kw = parseKeywords('As an aditional cost to Conjure: Deal (3) Damage to a Turanga you control.\nCraft (1) additional Effigy on your turn.\n(Conjures in the Effigy Zone)');
    expect(kw.conjureCost).toBe('Deal (3) Damage to a Turanga you control.');
  });

  it('captures the "control only Faithless permanents" condition on the craft bonus (e.g. "Faithless Altar")', () => {
    const kw = parseKeywords('If you control only Faithless Permaments: Craft (1) additional Effigy on your turn\n(Conjures in the Effigy Zone).');
    expect(kw.craftBonus).toBe(1);
    expect(kw.craftBonusCondition).toBe('faithless-only');
  });

  it('leaves craftBonusCondition null for an unconditional craft bonus (e.g. "Arbosalis Altar")', () => {
    const kw = parseKeywords('Craft (1) additional Effigy on your turn\n(Conjures in the Effigy Zone).');
    expect(kw.craftBonusCondition).toBeNull();
  });

  it('captures an Armament\'s stat bonus (e.g. "Rusted Rapier")', () => {
    expect(parseKeywords('Being has +1/+0.').statBonus).toEqual({ strength: 1, lifespan: 0 });
  });

  it('captures a negative stat bonus (e.g. "Gargantuan hammer")', () => {
    expect(parseKeywords('Being gains +6/-3.').statBonus).toEqual({ strength: 6, lifespan: -3 });
  });

  it('captures "Attached Being has +N/+N" too (e.g. "Cutlass")', () => {
    const kw = parseKeywords('Attached Being has +1/+0\nWhen the attached Being dies sacrifice this and summon a Cursed Cutlass token on this tile.');
    expect(kw.statBonus).toEqual({ strength: 1, lifespan: 0 });
  });

  it('captures an Armament-granted Engage ability with the effect quoted (e.g. "Darmah-Triya Bracers")', () => {
    const kw = parseKeywords('Attached Being has: Engage: "Deal (2) Damage to this, then add (1) Bleeding Essence". \n\n"My Flesh for My people, My Blood for my Deity"');
    expect(kw.grantedEngage).toBe('Deal (2) Damage to this, then add (1) Bleeding Essence.');
  });

  it('captures an Armament-granted Engage ability with the whole clause quoted (e.g. "Brick")', () => {
    const kw = parseKeywords('Being gains: \n"Engage: Deal (1) Damge to target Being, then move Brick to the tile occupied by the targeted Being".\n \n"When Life deals you a bad hand. Throw it at the opponent" -  Ken the Gambler');
    expect(kw.grantedEngage).toBe('Deal (1) Damge to target Being, then move Brick to the tile occupied by the targeted Being.');
  });

  it('does not confuse an Armament\'s own Engage (acting on itself) with a granted one (e.g. "Feathers of the Fallen")', () => {
    const kw = parseKeywords('When summoned gain (2) Crossing Counters.\nEngage: Remove (1) Crossing Counter, then move attached Being one tile in any direction.');
    expect(kw.grantedEngage).toBeNull();
    expect(kw.engage).toBe('Remove (1) Crossing Counter, then move attached Being one tile in any direction.');
  });

  it('captures an Armament\'s ETB counter grant (e.g. "Feathers of the Fallen": 2 Crossing Counters)', () => {
    const kw = parseKeywords('When summoned gain (2) Crossing Counters.\nEngage: Remove (1) Crossing Counter, then move attached Being one tile in any direction.');
    expect(kw.armamentCounterGrant).toEqual({ type: 'crossing', amount: 2 });
  });

  it('captures the sacrifice-for-Favored pattern (e.g. "Mahka-Rahva\'s Tiger Skin")', () => {
    const kw = parseKeywords('Sacrifice this to give attached being a Favored Counter until the end of turn.');
    expect(kw.sacrificeForFavored).toBe(true);
  });

  it('captures an extra Lifespan cost on Engage (e.g. "NamKaranian Zealot")', () => {
    const kw = parseKeywords('Pay (2) Lifespan, Engage: Add (1) Formless Essence.');
    expect(kw.engageLifespanCost).toBe(2);
    expect(kw.engage).toBe('Add (1) Formless Essence.');
    expect(kw.engageCondition).toBeNull();
  });

  it('classifies a "control only Faithless" Engage condition (e.g. "Zealot")', () => {
    const kw = parseKeywords('If you control only Faithless permaments you may Engage: Add (1) Faithless Essence.');
    expect(kw.engageCondition).toBe('faithless-only');
    expect(kw.engage).toBe('Add (1) Faithless Essence.');
    expect(kw.engageLifespanCost).toBeNull();
  });

  it('classifies a "control a Relic" Engage condition (e.g. "Kalduran Zealot")', () => {
    const kw = parseKeywords('If you control a non Armament Relic you may Engage: Add (1) Shifting Essence.');
    expect(kw.engageCondition).toBe('controls-relic');
    expect(kw.engage).toBe('Add (1) Shifting Essence.');
  });

  it('still captures a plain unconditional Engage with no extra cost (e.g. "Arbosalis Zealot")', () => {
    const kw = parseKeywords('Engage: Add (1) Living Essence.');
    expect(kw.engage).toBe('Add (1) Living Essence.');
    expect(kw.engageLifespanCost).toBeNull();
    expect(kw.engageCondition).toBeNull();
  });

  it('captures "Engage, X: Y" as a required second cost, not part of the effect (e.g. "Osteomancer")', () => {
    const kw = parseKeywords("Engage, Sacrfiice a Bag o' Bones: Add an Undead to hand from your Purgatory");
    expect(kw.engageExtraCost).toBe("Sacrfiice a Bag o' Bones");
    expect(kw.engage).toBe('Add an Undead to hand from your Purgatory');
    expect(kw.engageLifespanCost).toBeNull();
    expect(kw.engageCondition).toBeNull();
  });

  it('captures "Engage, X: Y" with a counter-removal cost (e.g. "Smithing Tools")', () => {
    const kw = parseKeywords('Engage, Remove (X) Forge Counters: Add an Armament from deck to hand with conjuring cost (X)');
    expect(kw.engageExtraCost).toBe('Remove (X) Forge Counters');
    expect(kw.engage).toBe('Add an Armament from deck to hand with conjuring cost (X)');
  });

  it('captures "Engage, X: Y" with a sacrifice-the-Being-here cost (e.g. "Vadē Rah")', () => {
    const kw = parseKeywords("Engage, Sacrifice the Being on this tile: add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being.");
    expect(kw.engageExtraCost).toBe('Sacrifice the Being on this tile');
    expect(kw.engage).toBe("add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being.");
  });

  it('captures both independent Engage abilities on a card that prints two (Osteomancer)', () => {
    const kw = parseKeywords("Engage, Sacrfiice a Bag o' Bones: Add an Undead to hand from your Purgatory\nEngage, Sacrifice an Undead: Summon a different Undead from your Purgatory.");
    expect(kw.engageAbilities).toEqual([
      { effect: 'Add an Undead to hand from your Purgatory', lifespanCost: null, condition: null, extraCost: "Sacrfiice a Bag o' Bones" },
      { effect: 'Summon a different Undead from your Purgatory.', lifespanCost: null, condition: null, extraCost: 'Sacrifice an Undead' },
    ]);
    // The singular fields still just reflect the first, for every
    // existing single-Engage call site that doesn't know about the array.
    expect(kw.engage).toBe('Add an Undead to hand from your Purgatory');
    expect(kw.engageExtraCost).toBe("Sacrfiice a Bag o' Bones");
  });

  it('a single "Engage: X" card still gets exactly one entry in engageAbilities', () => {
    const kw = parseKeywords('Engage: Move target Armament you control to a tile this points to.');
    expect(kw.engageAbilities).toEqual([
      { effect: 'Move target Armament you control to a tile this points to.', lifespanCost: null, condition: null, extraCost: null },
    ]);
  });

  it('captures the once-per-turn Prophecy-counter-removal trigger (e.g. "Eònion Zealot")', () => {
    const kw = parseKeywords('Once per turn when a Time Counter is removed from a Prophecy you control add (1) Timeless Essence.');
    expect(kw.onProphecyCounterRemoved).toEqual({ type: 'timeless', amount: 1 });
    expect(kw.engage).toBeNull(); // not an Engage-costed ability at all
    // Its own "Once per turn" is a reaction condition on an automatic
    // trigger, not a player-activated ability — must not also match
    // timesPerTurnMatch (MetaToris's "Twice per turn Modulate (±1)."
    // shape), which would wrongly offer an "Activate" button for it.
    expect(kw.timesPerTurnAbility).toBeNull();
  });

  it('captures Shift\'s amount and quoted prophecy text', () => {
    const kw = parseKeywords('Shift (2): "Draw a card."');
    expect(kw.shift).toEqual({ amount: 2, effect: 'Draw a card.' });
  });

  it('detects the "All Armaments you control move to the tile this is summoned on" flag (Mahka-Rahva), separate from whenSummoned', () => {
    const kw = parseKeywords("All Armaments you control move to the tile this is summoned on.\n When summoned this Diety immediately moves without engaging.");
    expect(kw.gathersArmamentsOnSummon).toBe(true);
    expect(kw.whenSummoned).toBe('this Diety immediately moves without engaging.');
  });

  it('detects the "move and attach ... to that Being" flag (Happy Hammer), plus its separate stat bonus', () => {
    const kw = parseKeywords('Whenever a Being is summoned under your control, move and attach Happy Hammer to that Being.\nBeing gains +3/+0.');
    expect(kw.movesToNewlySummonedBeing).toBe(true);
    expect(kw.statBonus).toEqual({ strength: 3, lifespan: 0 });
  });

  it('captures "Costs (-N) <Color> for each <Name> you control" (Skeletal Colossus)', () => {
    const kw = parseKeywords("Costs (-1) Faithless for each Bag o' Bones you control.");
    expect(kw.costReduction).toEqual({ amount: 1, color: 'faithless', name: "Bag o' Bones" });
  });

  it('detects "Beings may move across this" regardless of how the self-reference is worded', () => {
    expect(parseKeywords('Beings may move across Shifting Sands.').beingsMayMoveAcross).toBe(true);
    expect(parseKeywords('Beings may move across this Relic.').beingsMayMoveAcross).toBe(true);
    expect(parseKeywords('Beings may move across this.').beingsMayMoveAcross).toBe(true);
    expect(parseKeywords('Gains +0/+3 if you control another Turanga.').beingsMayMoveAcross).toBe(false);
  });

  it('handles multiple keywords on the same card independently', () => {
    const kw = parseKeywords('Persist\nDepart: Deal 2 damage to target Being.');
    expect(kw.persist).toBe(true);
    expect(kw.depart).toBe('Deal 2 damage to target Being.');
  });

  it('captures a Being\'s When Summoned trigger text (e.g. "Quake Goliath")', () => {
    const kw = parseKeywords('When summoned deal (1) Damage to all other Beings.');
    expect(kw.whenSummoned).toBe('deal (1) Damage to all other Beings.');
  });

  it('tolerates a comma after "When summoned" (e.g. "Instigator")', () => {
    const kw = parseKeywords('When summoned, engage target non Deity Being, until the start of your next turn it gains "This does not disengage during Disengage Step".');
    expect(kw.whenSummoned).toContain('engage target non Deity Being');
  });

  it('stops capturing at the next line, leaving a separate keyword (e.g. "Thespian"\'s death trigger) uncaptured', () => {
    const kw = parseKeywords('When summoned this Being\'s Strength and Lifespan becomes equal to target Being you control. \nWhen this Being dies you lose (4) Lifespan.');
    expect(kw.whenSummoned).toBe('this Being\'s Strength and Lifespan becomes equal to target Being you control.');
  });

  it('detects "Can not attack" (Training dummy)', () => {
    expect(parseKeywords('Can not attack.').cannotAttack).toBe(true);
  });

  it('captures "Remove (N) <Type> Counter(s): Engage then <effect>" (Crucible)', () => {
    const kw = parseKeywords('When Summoned gain (2) Forge Counters. \nRemove (1) Forge Counter: Engage then add an Armament to hand from your Purgatory.');
    expect(kw.armamentCounterGrant).toEqual({ type: 'forge', amount: 2 });
    expect(kw.engageCounterCost).toEqual({ type: 'forge', amount: 1 });
    expect(kw.engage).toBe('add an Armament to hand from your Purgatory.');
  });

  it('does not false-positive engageCounterCost on an ordinary bare "Engage:" line', () => {
    expect(parseKeywords('Engage: Deal (1) Damage to target Being.').engageCounterCost).toBe(null);
  });

  it('captures "Once per turn sacrifice (X) <Name>: Summon a Being from your Purgatory with cost (X)" (Cemetery Physician)', () => {
    const kw = parseKeywords("Once per turn sacrifice (X) Bag o' Bones: Summon a Being from your Purgatory with cost (X).");
    expect(kw.sacrificeXSummon).toEqual({ fodderName: "Bag o' Bones" });
  });

  it('captures "Pay (1) Living: Add (1) Growth Counter." / "Remove (1) Growth Counter: Sacrifice this, ..." (Blooming Seed, real CSV text)', () => {
    const kw = parseKeywords('Pay (1) Living: Add (1) Growth Counter.\nRemove (1) Growth Counter: Sacrifice this, summon (1) Blooming Vine Token (0/3 Being - vine token with "Engage: Add (1) Living") on any tile this points to.');
    expect(kw.payEffigyCostAbility).toEqual({ color: 'living', amount: 1, effect: 'Add (1) Growth Counter.', once: false });
    expect(kw.counterCostSacrificeAbility).toEqual({
      type: 'growth', amount: 1,
      effect: 'summon (1) Blooming Vine Token (0/3 Being - vine token with "Engage: Add (1) Living") on any tile this points to.',
    });
  });

  it('does not misread "Pay (N) Lifespan, Engage: X" as a payEffigyCostAbility', () => {
    const kw = parseKeywords('Pay (2) Lifespan, Engage: Deal (1) Damage to target Being.');
    expect(kw.payEffigyCostAbility).toBe(null);
  });

  it('"Burn (N) <Color>: X" (Skeleton Key, real CSV text) is the same payEffigyCostAbility mechanism as "Pay"', () => {
    const kw = parseKeywords('Burn (2) Shifting: Trigger the Depart of a Being you control.');
    expect(kw.payEffigyCostAbility).toEqual({ color: 'shifting', amount: 2, effect: 'Trigger the Depart of a Being you control.', once: false });
  });

  it('Metal Worker — "Once per turn, you may Pay (1) Bleeding Essence: X" (real CSV text) is captured with once: true, tolerating the "Essence" suffix', () => {
    const kw = parseKeywords('Once per turn, you may Pay (1) Bleeding Essence: The next Relic you summon this turn costs (-2) Faithless.');
    expect(kw.payEffigyCostAbility).toEqual({
      color: 'bleeding', amount: 1, effect: 'The next Relic you summon this turn costs (-2) Faithless.', once: true,
    });
  });

  it('captures "Each time this moves create a Rat token on the tile it moved from." (Hoarder, real CSV text)', () => {
    const kw = parseKeywords('Each time this moves create a Rat token on the tile it moved from.');
    expect(kw.onMove).toBe('create a Rat token on the tile it moved from.');
  });

  it('captures "When a Familiar is summoned under your control draw (1) card." (Greenseer\'s assistant, real CSV text)', () => {
    const kw = parseKeywords('When a Familiar is summoned under your control draw (1) card.');
    expect(kw.onTypedSummonedUnderControl).toEqual({ typing: 'Familiar', effect: 'draw (1) card.' });
  });

  it('does not misread "Whenever a Being is summoned under your control, move and attach..." (Happy Hammer) as onTypedSummonedUnderControl', () => {
    const kw = parseKeywords('Whenever a Being is summoned under your control, move and attach Happy Hammer to that Being.');
    expect(kw.onTypedSummonedUnderControl).toBe(null);
    expect(kw.movesToNewlySummonedBeing).toBe(true);
  });

  it('detects "You do not draw during the start of your turn" (Daylight Savings)', () => {
    const kw = parseKeywords('Gain (3) Time Counters. \nDraw three Cards.\nYou do not draw during the start of your turn.');
    expect(kw.skipsControllerDraw).toBe(true);
  });

  it('detects "Beings do not enter the Mortal Realm engaged" (The Persistence of Memory)', () => {
    const kw = parseKeywords('Gain (2) Time Counters. \nBeings do not enter the Mortal Realm engaged.');
    expect(kw.beingsEnterDisengaged).toBe(true);
  });

  it('captures "Twice per turn Modulate (±1)." (MetaToris)', () => {
    const kw = parseKeywords('Twice per turn Modulate (±1). \nWhen summoned Shuffle (3) cards into deck from your Purgatory (can not target MetaToris) or draw (3) Cards.');
    expect(kw.timesPerTurnAbility).toEqual({ times: 2, effect: 'Modulate (±1).' });
    expect(kw.whenSummoned).toContain('Shuffle (3) cards');
  });

  it('detects "(X) is equal to the total number of Time Counters you control" (Horological Horror)', () => {
    const kw = parseKeywords('(X) is equal to the total number of Time Counters you control.\nWhen this dies you take (5) Lifespan Damage');
    expect(kw.xEqualsTimeCountersControlled).toBe(true);
  });

  it('captures Eònion Altar\'s full text: ETB Time Counters + the zero-Time-Counters craft condition', () => {
    const kw = parseKeywords('When conjured gain (3) Time Counters. \nIf this has (0) Time Counters: Craft (1) additional Effigy on your turn.\n(Conjures in the Effigy Zone).');
    expect(kw.armamentCounterGrant).toEqual({ type: 'time', amount: 3 });
    expect(kw.craftBonus).toBe(1);
    expect(kw.craftBonusCondition).toBe('zero-time-counters');
  });

  it('"When conjured gain" is recognized the same way "When summoned gain" already is', () => {
    expect(parseKeywords('When summoned gain (2) Crossing Counters.').armamentCounterGrant).toEqual({ type: 'crossing', amount: 2 });
    expect(parseKeywords('When conjured gain (2) Crossing Counters.').armamentCounterGrant).toEqual({ type: 'crossing', amount: 2 });
  });

  it('does not false-positive cannotAttack on unrelated text', () => {
    expect(parseKeywords('Engage: Deal (1) Damage to target Being.').cannotAttack).toBe(false);
  });

  it('captures "Whenever you Martyr a Seed, Craft (1) Effigy." (Sapling, real CSV text)', () => {
    const kw = parseKeywords('Whenever you Martyr a Seed, Craft (1) Effigy.');
    expect(kw.onOwnMartyrTyped).toEqual({ typing: 'Seed', effect: 'Craft (1) Effigy.' });
  });

  it('captures "Whenever you pay Lifespan gain +1/+1." (Ravenous Lamtukka, real CSV text)', () => {
    const kw = parseKeywords('Whenever you pay Lifespan gain +1/+1.');
    expect(kw.onLifespanPaidGrowth).toEqual({ strength: 1, lifespan: 1 });
  });

  it('captures Roots of Eternity\'s Purgatory reanimate ability (real CSV text), and does NOT also duplicate it into the generic timesPerTurnAbility field', () => {
    const kw = parseKeywords('Once per turn you may sacrifice a Vine token, summon this from Purgatory on the tile that the sacrificed vine token was on ');
    expect(kw.reanimateOnSacrificedTypedToken).toEqual({ typing: 'Vine' });
    // Without this exclusion, the same "Once per turn ..." text also
    // matched the generic bare-timesPerTurnMatch below, which — unlike
    // the dedicated reanimate path — is only ever readable while this
    // card is still on the board, offering a second, broken activation
    // button that always fell through to "isn't automated yet".
    expect(kw.timesPerTurnAbility).toBeNull();
  });

  it('captures "Whenever a different Being you control Fights, gain +1/+0 until the end of turn." (Spirit of War, real CSV text)', () => {
    const kw = parseKeywords('Whenever a different Being you control Fights, gain +1/+0 until the end of turn.');
    expect(kw.onAllyFights).toEqual({ strength: 1, lifespan: 0 });
  });

  it('captures "Restless Dead has +2/+0 until end of turn for each Being that died under your control this turn." (real CSV text)', () => {
    const kw = parseKeywords('Restless Dead has +2/+0 until end of turn for each Being that died under your control this turn.');
    expect(kw.statBonusPerOwnDeathThisTurn).toEqual({ strength: 2, lifespan: 0 });
  });

  it('captures "You take (1) less Lifespan Damage during the Down Tick Step" (The Fountain, real CSV text)', () => {
    const kw = parseKeywords('You take (1) less Lifespan Damage during the Down Tick Step');
    expect(kw.downTickLifespanReduction).toBe(1);
  });

  it('captures "When Onoushara is summoned..." as whenSummoned given the card\'s own name (real CSV text)', () => {
    const kw = parseKeywords(
      'When Onoushara is summoned all Beings lose -1/-1. Onoushara gains +1/+1 for each Being affected. \nWhenever a Being you control dies, Onoushara gains +1/+1.',
      'Onoushara'
    );
    expect(kw.whenSummoned).toBe('all Beings lose -1/-1. Onoushara gains +1/+1 for each Being affected.');
  });

  it('does not treat "When Onoushara is summoned..." as whenSummoned without the name passed in', () => {
    const kw = parseKeywords('When Onoushara is summoned all Beings lose -1/-1.');
    expect(kw.whenSummoned).toBe(null);
  });

  it('does not misfire the own-name whenSummoned match for a DIFFERENT card\'s name', () => {
    const kw = parseKeywords('When Onoushara is summoned all Beings lose -1/-1.', 'Some Other Card');
    expect(kw.whenSummoned).toBe(null);
  });

  it('captures "When Defective Demon moves sacrifice it." as onMove given the card\'s own name (real CSV text)', () => {
    const kw = parseKeywords('When Defective Demon moves sacrifice it.', 'Defective Demon');
    expect(kw.onMove).toBe('sacrifice it.');
  });

  it('captures "Gains +0/+3 if you control a Turanaga other than Darmah-Triya" given the card\'s own name (real CSV text, including its typo)', () => {
    const kw = parseKeywords('Gains +0/+3 if you control a Turanaga other than Darmah-Triya.', 'Darmah-Triya');
    expect(kw.otherSameTypingBonus).toEqual({ strength: 0, lifespan: 3 });
  });

  it('does not capture otherSameTypingBonus without the card\'s own name passed in', () => {
    const kw = parseKeywords('Gains +0/+3 if you control a Turanaga other than Darmah-Triya.');
    expect(kw.otherSameTypingBonus).toBe(null);
  });

  it('captures "While you control an Imp, Cat, and a Rat, Menagerie Mistress has +3/+6." given the card\'s own name (real CSV text)', () => {
    const kw = parseKeywords('While you control an Imp, Cat, and a Rat, Menagerie Mistress has +3/+6.', 'Menagerie Mistress');
    expect(kw.allTypingsBonus).toEqual({ typings: ['Imp', 'Cat', 'Rat'], strength: 3, lifespan: 6 });
  });

  it('captures "This has +1/+1 for each other Rat you have in play." (Mischief of Rats, real CSV text)', () => {
    const kw = parseKeywords('This has +1/+1 for each other Rat you have in play.');
    expect(kw.perOtherTypingBonus).toEqual({ typing: 'Rat', strength: 1, lifespan: 1 });
  });

  it('captures "Has (+1) Lifespan for each Non Armament Relic you control." (Temple Guardian, real CSV text)', () => {
    const kw = parseKeywords('Has (+1) Lifespan for each Non Armament Relic you control.');
    expect(kw.perNonArmamentRelicLifespan).toBe(1);
  });

  it('captures "During Combat if the opposing Being is not Faithless it has (-1) Strength." (Fidian Nol, real CSV text)', () => {
    const kw = parseKeywords('During Combat if the opposing Being is not Faithless it has (-1) Strength.');
    expect(kw.combatOpponentStrengthPenaltyIfNotFaithless).toBe(1);
  });

  it('captures "This gains +1/+1 whenever you Modulate (±1) except due to the Modulate Step" (Temporal Anomaly, real CSV text, trailing comma typo included)', () => {
    const kw = parseKeywords('This gains +1/+1 whenever you Modulate (±1) except due to the Modulate Step,');
    expect(kw.onModulateGrowth).toEqual({ strength: 1, lifespan: 1 });
  });

  it('captures "At the end of your turn gain +1/+1 for each other Doubt you control." (Lingering Doubt, real CSV text)', () => {
    const kw = parseKeywords('At the end of your turn gain +1/+1 for each other Doubt you control.');
    expect(kw.endOfTurnGrowthPerName).toEqual({ strength: 1, lifespan: 1, namePart: 'Doubt' });
  });

  it('captures Minute-taur\'s forward/backward forced moves (real CSV text)', () => {
    const kw = parseKeywords('At the start of your turn move forward.\nAt the end of your turn move backward.\n\n"Time charges blindly forward...and sometimes also backwards" ');
    expect(kw.moveForwardAtTurnStart).toBe(true);
    expect(kw.moveBackwardAtTurnEnd).toBe(true);
  });

  it('captures Death\'s Decanter\'s pair of clauses (real CSV text)', () => {
    const kw = parseKeywords("Gain (1) Crossing Counter whenever a Being Dies. \nRemove (X) Crossing Counters: Sacrifice this Relic, then add a Formless Being with Conjuring cost (X) from your Purgatory to hand.");
    expect(kw.gainCounterOnAnyBeingDeath).toEqual({ type: 'crossing', amount: 1 });
    expect(kw.removeCountersSacrificeSearchTypedCost).toEqual({ counterType: 'crossing', typing: 'Formless' });
  });

  it('captures Lotus\'s pair of once-per-turn typed-death reactions (real CSV text)', () => {
    const kw = parseKeywords("Once per turn, when a Turanga you control dies: Add a Spirit from deck to hand. \nOnce per turn, when a Spirit you control dies: Add a Turanga from deck to hand.");
    expect(kw.deckSearchOnTypedDeath).toEqual([
      { dyingTyping: 'Turanga', addTyping: 'Spirit' },
      { dyingTyping: 'Spirit', addTyping: 'Turanga' },
    ]);
  });

  it('captures "When revealed on the top of your deck, ..." (Distant Debator, real CSV text)', () => {
    const kw = parseKeywords('When revealed on the top of your deck, you may engage a non Deity Being in the Mortal Realm until your next turn.');
    expect(kw.onRevealedTopOfDeck).toBe('you may engage a non Deity Being in the Mortal Realm until your next turn.');
  });

  it('captures Tilled Fields\' three clauses (real CSV text)', () => {
    const kw = parseKeywords('Pay (1) Living Essence, Engage: Until end of turn Plants summoned on this tile come in Disengaged.\nIf this is Engaged at the end of the turn, sacrifice it.\nBeings may move across this Relic.');
    expect(kw.engageEffigyCost).toEqual({ color: 'living', amount: 1 });
    expect(kw.engage).toBe('Until end of turn Plants summoned on this tile come in Disengaged.');
    expect(kw.sacrificeIfEngagedAtEndOfTurn).toBe(true);
    expect(kw.beingsMayMoveAcross).toBe(true);
  });

  it('does not misread "Pay (N) Lifespan, Engage: X" as an engageEffigyCost', () => {
    const kw = parseKeywords('Pay (2) Lifespan, Engage: Deal (1) Damage to target Being.');
    expect(kw.engageLifespanCost).toBe(2);
    expect(kw.engageEffigyCost).toBe(null);
  });

  it('captures Sanative Siphon\'s "Remove (X) Crossing Counters, Engage: Restore (X) Lifespan to target" (real CSV text)', () => {
    const kw = parseKeywords('Gain (1) Crossing Counter whenever a Being you control Shifts.\nRemove (X) Crossing Counters, Engage: Restore (X) Lifespan to target.');
    expect(kw.removeCountersEngageRestoreLifespan).toEqual({ counterType: 'crossing' });
    expect(kw.engage).toBe(null);
  });

  it('captures Monumental Mason\'s "If you conjure a non Armament Relic on a tile this points to, Craft an Effigy" (real CSV text)', () => {
    const kw = parseKeywords('If you conjure a non Armament Relic on a tile this points to, Craft an Effigy.');
    expect(kw.craftEffigyOnPointedRelicConjure).toEqual({ amount: 1 });
  });

  it('captures Nursery Attendant\'s "Seed Beings that Nursery Attendant Points to cost (-1) Living to activate" (real CSV text, own-name substitution)', () => {
    const kw = parseKeywords('Seed Beings that Nursery Attendant Points to cost (-1) Living to activate.', 'Nursery Attendant');
    expect(kw.seedActivationCostReduction).toEqual({ typing: 'Seed', amount: 1, color: 'living' });
  });

  it('does not capture seedActivationCostReduction without a cardName (no own-name to match against)', () => {
    const kw = parseKeywords('Seed Beings that Nursery Attendant Points to cost (-1) Living to activate.');
    expect(kw.seedActivationCostReduction).toBe(null);
  });

  it('captures Sporangium\'s "When a Being with Dryad moves onto this, summon a 0/2 Vine token on a tile this points to" (real CSV text)', () => {
    const kw = parseKeywords('When a Being with Dryad moves onto this, summon a 0/2 Vine token on a tile this points to.');
    expect(kw.onDryadAttachedOnto).toBe('summon a 0/2 Vine token on a tile this points to.');
  });

  it('captures bare "Shift (X)." (Shifting Shade, real CSV text)', () => {
    const kw = parseKeywords('Shift (1).\n(Engage: Move this onto a tile in the Ethereal Realm, it becomes a Prophecy, then gains (1) Time Counter and "When this has (0) Time Counters on it move it onto a tile in the Mortal Realm Engaged"; While it is a Prophecy it loses all other text and typings.)');
    expect(kw.shift).toEqual({ amount: 1, effect: null });
  });

  it('captures "Shift (X): "quoted prophecy text"" and the separate "moves into the Mortal Realm" line (Scā-vuhk Hunger, real CSV text)', () => {
    const kw = parseKeywords('Shift (1): "At the end of your turn remove (1) Time Counter from this"\nWhen this moves into the Mortal Realm, sacrifice this and create (2) Scā-vuhk Hunger tokens.');
    expect(kw.shift).toEqual({ amount: 1, effect: 'At the end of your turn remove (1) Time Counter from this' });
    expect(kw.onMovedIntoMortalRealm).toBe('sacrifice this and create (2) Scā-vuhk Hunger tokens.');
  });

  it('captures the shifted form\'s own "At the end of your turn remove (N) Time Counter(s) from this" once its quoted text is re-parsed', () => {
    const kw = parseKeywords('At the end of your turn remove (1) Time Counter from this');
    expect(kw.endOfTurnRemoveOwnTimeCounters).toBe(1);
  });

  it('captures Sanative Siphon\'s "Gain (1) Crossing Counter whenever a Being you control Shifts" (real CSV text, effect before "whenever")', () => {
    const kw = parseKeywords('Gain (1) Crossing Counter whenever a Being you control Shifts.');
    expect(kw.onOwnBeingShift).toEqual({ effect: 'Gain (1) Crossing Counter', exceptEndStep: false });
  });

  it('still captures it when the REAL printed card has a second line after it (Sanative Siphon\'s actual full CSV row — a bare `$`-anchored regex here would silently never match the real card at all)', () => {
    const kw = parseKeywords('Gain (1) Crossing Counter whenever a Being you control Shifts.\nRemove (X) Crossing Counters, Engage: Restore (X) Lifespan to target.');
    expect(kw.onOwnBeingShift).toEqual({ effect: 'Gain (1) Crossing Counter', exceptEndStep: false });
    expect(kw.removeCountersEngageRestoreLifespan).toEqual({ counterType: 'crossing' });
  });

  it('captures Thōgrakin Hunger\'s "Whenever a Being you control Shifts, except during the end step, add (1) Formless Essence" (real CSV text, effect after "whenever")', () => {
    const kw = parseKeywords('Whenever a Being you control Shifts, except during the end step, add (1) Formless Essence.');
    expect(kw.onOwnBeingShift).toEqual({ effect: 'add (1) Formless Essence', exceptEndStep: true });
  });

  it('captures Mouth of Madness\'s "If a Being moves into the Mortal Realm during End Phase it Shifts (1)" (real CSV text)', () => {
    const kw = parseKeywords('If a Being moves into the Mortal Realm during End Phase it Shifts (1).');
    expect(kw.duringEndStepForceShift).toBe(1);
  });

  it('captures Terranean Gates\' "If a Being moves into the Ethereal Realm during End Phase it loses (2) Time Counters" (real CSV text)', () => {
    const kw = parseKeywords('If a Being moves into the Ethereal Realm during End Phase it loses (2) Time Counters');
    expect(kw.duringEndStepLoseTimeCounters).toBe(2);
  });

  it('captures Formless Fangs\' "Any Being dealt damage by this Shifts (2)" (real CSV text)', () => {
    const kw = parseKeywords('Any Being dealt damage by this Shifts (2).');
    expect(kw.onDealsCombatDamageForceShift).toBe(2);
  });

  it('captures Echoes of the Boundless\' "Whenever another Being dies its controller may pay its Summoning cost to Shift (1) instead of sending it to Purgatory" (real CSV text)', () => {
    const kw = parseKeywords('Whenever another Being dies it\'s controller may pay its Summoning cost to Shift (1) instead of sending it to Purgatory. Damage is still dealt from it dying.');
    expect(kw.onAnyBeingDiedMayShiftInstead).toBe(1);
  });

  it('captures Immen Gorta\'s own quoted Shift decay, "this loses (2) Time Counters" phrasing', () => {
    const kw = parseKeywords('Shift (1): "At the end of your turn, this loses (2) Time Counters"\nWhen this moves into the Mortal Realm, deal (1) damage to any target.');
    expect(kw.shift).toEqual({ amount: 1, effect: 'At the end of your turn, this loses (2) Time Counters' });
    expect(kw.onMovedIntoMortalRealm).toBe('deal (1) damage to any target.');
    expect(parseKeywords(kw.shift.effect).endOfTurnRemoveOwnTimeCounters).toBe(2);
  });

  it('detects Dryad as a standalone flag (real CSV text)', () => {
    expect(parseKeywords('Dryad (May move onto another TreeFolk, Vine, or Seed.\nThis has that Beings Strength and Lifespan while attached).').dryad).toBe(true);
  });

  it('captures Unruly Fiend\'s own spelled-out "When [name] attacks you lose (X) Lifespan..." as the reusable Unruly keyword (real CSV text)', () => {
    const kw = parseKeywords('When Unruly Fiend attacks you lose (X) Lifespan where (X) is it\'s current strength\nDepart: Discard a card at random.', 'Unruly Fiend');
    expect(kw.unruly).toBe(true);
    expect(kw.depart).toBe('Discard a card at random.');
  });

  it('detects a bare "Unruly" keyword too, for a future card that prints it directly', () => {
    expect(parseKeywords('Unruly').unruly).toBe(true);
  });

  it('does not false-positive Unruly without a cardName to substitute (no own-name match) or the bare word', () => {
    expect(parseKeywords('When Unruly Fiend attacks you lose (X) Lifespan where (X) is it\'s current strength').unruly).toBe(false);
  });

  it('captures Degrisch Vassal\'s "prevent that damage and craft Effigies" (real CSV text)', () => {
    const kw = parseKeywords('When this Being deals damage to an opponent, prevent that damage and craft (X) Effigies where (X) is the damage that would have been dealt. ');
    expect(kw.preventOpenLaneDamageCraftEffigy).toBe(true);
  });

  it('captures Wretched Remnants\' "gain its effect(s) until end of turn" (real CSV text)', () => {
    const kw = parseKeywords('Once per turn when a Being you control dies you may have this Relic gain its effect(s) until end of turn. ');
    expect(kw.onOwnBeingDiedGainTextBox).toBe(true);
  });
});

describe('totalCastingCost', () => {
  it('sums faithless pips and every colored pip into one number', () => {
    expect(totalCastingCost({ castingCost: { faithless: 2, colored: { bleeding: 1, living: 3 } } })).toBe(6);
  });

  it('treats a missing castingCost as 0', () => {
    expect(totalCastingCost({})).toBe(0);
  });
});

describe('parseEffigyCost', () => {
  it('parses a mixed faithless/colored cost', () => {
    expect(parseEffigyCost('2, 1 Bleeding, X Living')).toEqual([
      { number: '2', type: '' },
      { number: '1', type: 'bleeding' },
      { number: 'X', type: 'living' },
    ]);
  });

  it('normalizes the real CSV\'s "Shifitng" misspelling to "shifting" (e.g. "Kalduran Altar")', () => {
    expect(parseEffigyCost('2 Shifitng')).toEqual([{ number: '2', type: 'shifting' }]);
  });
});

describe('stripFlavorText', () => {
  it('leaves plain rules text untouched', () => {
    expect(stripFlavorText('Depart: Add an Armament to hand from deck.')).toBe('Depart: Add an Armament to hand from deck.');
  });

  it('removes a fully quoted flavor line with a trailing attribution', () => {
    const text = 'Gain 1 Lifespan.\n"The illustrations are so life like." - Garrus';
    expect(stripFlavorText(text)).toBe('Gain 1 Lifespan.');
  });

  it('removes a fully quoted flavor line with no attribution', () => {
    const text = 'Draw a card.\n"He\'s not your regular moron."';
    expect(stripFlavorText(text)).toBe('Draw a card.');
  });

  it('returns an empty result for text that is pure flavor', () => {
    expect(stripFlavorText('"Perceived as weak for releasing their inner spirits."')).toBe('');
  });

  it('passes through falsy input unchanged', () => {
    expect(stripFlavorText('')).toBe('');
    expect(stripFlavorText(null)).toBe(null);
    expect(stripFlavorText(undefined)).toBe(undefined);
  });
});

describe('createTokenCard', () => {
  it('builds a fully game-ready card, parsed exactly like a real CSV row', () => {
    const token = createTokenCard({ name: "Bag o' Bones", typing: 'Relic, Token', effigyCost: '1' });
    expect(token.name).toBe("Bag o' Bones");
    expect(token.kind).toBe('relic');
    expect(token.isToken).toBe(true);
    expect(token.castingCost).toEqual({ faithless: 1, colored: {} });
    expect(token.strength).toBe(0);
    expect(token.lifespan).toBe(0);
  });

  it('parses a Being token\'s stats and typing', () => {
    const token = createTokenCard({ name: 'Vine', typing: 'Being, Token', strength: 0, lifespan: 2 });
    expect(token.kind).toBe('being');
    expect(token.strength).toBe(0);
    expect(token.lifespan).toBe(2);
  });

  it('detects an Armament token\'s stat bonus through the same parseKeywords every printed card uses', () => {
    const token = createTokenCard({ name: 'Snake Skin', typing: 'Relic, Armament, Token', effigyCost: '1', textBox: 'Being gains +0/+2' });
    expect(token.kind).toBe('relic-armament');
    expect(token.keywords.statBonus).toEqual({ strength: 0, lifespan: 2 });
  });

  it('gives each created token a fresh, unique instanceId', () => {
    const a = createTokenCard({ name: 'Vine', typing: 'Being, Token', strength: 0, lifespan: 2 });
    const b = createTokenCard({ name: 'Vine', typing: 'Being, Token', strength: 0, lifespan: 2 });
    expect(a.instanceId).not.toBe(b.instanceId);
  });
});

describe('toGameCard trims a stray leading/trailing space off "Card Name"', () => {
  // Regression: the real CSV has dozens of rows with an accidental trailing
  // (or, for Sporangium, leading) space in "Card Name" — confirmed real
  // example: "Locust swarm " (public/default-card-set.csv). Left untrimmed,
  // that space survives into `.name` and breaks anything doing exact-string
  // matching against it — concretely, actions.js's own
  // selfReferentialWhenSummonedText substitutes a card's own printed name
  // for "this" in its own text (Locust Swarm's Depart: "Locust Swarm Shifts
  // (3)."); the untrimmed name's own trailing space gets consumed as part
  // of the matched span, producing "thisShifts (3)." — no space — which no
  // longer matches SELF_SHIFT_RE, so the Shift silently never fires.
  it('produces a clean .name with no leading/trailing whitespace', () => {
    const card = toGameCard({ 'Card Name': 'Locust swarm ', 'Card Typing': 'Insect, Being', 'Text Box': 'Depart: Locust Swarm Shifts (3).' }, 0);
    expect(card.name).toBe('Locust swarm');
  });

  it('trims a leading space too (real example: "  Sporangium")', () => {
    const card = toGameCard({ 'Card Name': '  Sporangium', 'Card Typing': 'Being', 'Text Box': '' }, 0);
    expect(card.name).toBe('Sporangium');
  });

  it('leaves the untrimmed raw CSV row intact under .raw (cardRender.js reads display fields from there)', () => {
    const card = toGameCard({ 'Card Name': 'Locust swarm ', 'Card Typing': 'Insect, Being', 'Text Box': '' }, 0);
    expect(card.raw['Card Name']).toBe('Locust swarm ');
  });
});

describe('"Ethereal, Conjuring" classification (RULES.md > Conjurings)', () => {
  it('classifies as "ethereal-conjuring", not "conjuring" — the real CSV always separates the words with a comma', () => {
    expect(getCardKind({ 'Card Typing': 'Ethereal, Conjuring' })).toBe('ethereal-conjuring');
  });

  it('a plain "Conjuring" (no Ethereal) still classifies as "conjuring" — unaffected', () => {
    expect(getCardKind({ 'Card Typing': 'Conjuring' })).toBe('conjuring');
  });

  it('toGameCard produces kind "ethereal-conjuring" end to end', () => {
    const card = toGameCard({
      'Card Name': 'Sharpshoot', 'Card Typing': 'Ethereal, Conjuring', 'Effigy Costs': '1 Bleeding',
      'Text Box': 'Deal (1) damage to any target.',
    }, 0);
    expect(card.kind).toBe('ethereal-conjuring');
  });
});

describe('An "X" pip in a card\'s own printed cost (Deja Vu: "X, 2 Timeless")', () => {
  it('contributes 0 to the printed base cost but records which slot carried it', () => {
    const card = toGameCard({
      'Card Name': 'Deja Vu', 'Card Typing': 'Ethereal, Conjuring', 'Effigy Costs': 'X, 2 Timeless',
      'Text Box': 'Return target Being that you control with cost (X) to your hand, then Summon it without paying its summoning cost\nPay (2) additional Timeless Essence to target a Deity.',
    }, 0);
    expect(card.castingCost).toEqual({ faithless: 0, colored: { timeless: 2 }, xCostColor: '' });
  });

  it('Blood Rites\' own "X, Bleeding" — the bare "Bleeding" segment (no leading number) is a real fixed "1 Bleeding" pip, per the user\'s own ruling', () => {
    const card = toGameCard({ 'Card Name': 'Blood Rites', 'Card Typing': 'Conjuring', 'Effigy Costs': 'X, Bleeding', 'Text Box': 'irrelevant here' }, 0);
    expect(card.castingCost).toEqual({ faithless: 0, colored: { bleeding: 1 }, xCostColor: '' });
  });

  it('leaves castingCost with no xCostColor key at all for an ordinary card', () => {
    const card = toGameCard({ 'Card Name': 'Plain', 'Card Typing': 'Being', 'Effigy Costs': '1 Bleeding', 'Text Box': '' }, 0);
    expect(card.castingCost).toEqual({ faithless: 0, colored: { bleeding: 1 } });
    expect('xCostColor' in card.castingCost).toBe(false);
  });
});

describe('Deja Vu\'s own keywords', () => {
  const card = toGameCard({
    'Card Name': 'Deja Vu', 'Card Typing': 'Ethereal, Conjuring', 'Effigy Costs': 'X, 2 Timeless',
    'Text Box': 'Return target Being that you control with cost (X) to your hand, then Summon it without paying its summoning cost\nPay (2) additional Timeless Essence to target a Deity.',
  }, 0);

  it('parses dejaVu as true', () => {
    expect(card.keywords.dejaVu).toBe(true);
  });

  it('parses the Deity surcharge line', () => {
    expect(card.keywords.dejaVuDeitySurcharge).toEqual({ amount: 2, color: 'timeless' });
  });

  it('leaves dejaVu false for an unrelated Conjuring', () => {
    const other = toGameCard({ 'Card Name': 'Sharpshoot', 'Card Typing': 'Ethereal, Conjuring', 'Effigy Costs': '1 Bleeding', 'Text Box': 'Deal (1) damage to any target.' }, 0);
    expect(other.keywords.dejaVu).toBe(false);
    expect(other.keywords.dejaVuDeitySurcharge).toBe(null);
  });
});

describe('"As an additional cost to summon, Sacrifice (2) Beings." (Immen Gorta)', () => {
  it('parses the sacrifice count', () => {
    const card = toGameCard({
      'Card Name': 'Immen Gorta, the Boundless Hunger', 'Card Typing': 'Hunger, Being, Deity', 'Effigy Costs': '5 Formless',
      'Text Box': 'As an additional cost to summon, Sacrifice (2) Beings.\nShift (1): "At the end of your turn, this loses (2) Time Counters"\nWhen this moves into the Mortal Realm, deal (1) damage to any target.',
    }, 0);
    expect(card.keywords.additionalSummonCostSacrificeBeings).toBe(2);
  });

  it('leaves it null for an ordinary Being', () => {
    const card = toGameCard({ 'Card Name': 'Plain', 'Card Typing': 'Being', 'Effigy Costs': '1 Bleeding', 'Text Box': '' }, 0);
    expect(card.keywords.additionalSummonCostSacrificeBeings).toBe(null);
  });
});

describe('"Relic, Being" (RULES.md > Card types — Training dummy, Crumbling Sphinx)', () => {
  const row = (overrides = {}) => ({
    'Card Name': 'Training dummy', 'Card Typing': 'Relic, Being', 'Effigy Costs': '',
    'Text Box': 'Can not attack.', 'Strength': '0', 'Lifespan': '3', 'Timer': 'XXX',
    'Arrows (Clockwise top center = 1)': '1', 'Rarity': 'C', 'Effigy type': 'Faithless',
    ...overrides,
  });

  it('classifies as kind "being", not "relic" — full Being mechanics', () => {
    expect(getCardKind(row())).toBe('being');
  });

  it('a plain "Relic" (no Being) still classifies as "relic" — unaffected', () => {
    expect(getCardKind(row({ 'Card Typing': 'Relic' }))).toBe('relic');
  });

  it('a plain "Being" (no Relic) still classifies as "being" — unaffected', () => {
    expect(getCardKind(row({ 'Card Typing': 'Turanga, Being' }))).toBe('being');
  });

  it('toGameCard sets isRelicBeing: true', () => {
    const card = toGameCard(row(), 0);
    expect(card.kind).toBe('being');
    expect(card.isRelicBeing).toBe(true);
  });

  it('an ordinary Being does not get isRelicBeing', () => {
    const card = toGameCard(row({ 'Card Typing': 'Turanga, Being' }), 0);
    expect(card.isRelicBeing).toBe(false);
  });

  it('a plain Relic does not get isRelicBeing', () => {
    const card = toGameCard(row({ 'Card Typing': 'Relic' }), 0);
    expect(card.isRelicBeing).toBe(false);
  });

  it('uses the Being border (beingProphecy), not the Relic border', () => {
    expect(getBorderTypeForCard(row())).toBe('beingProphecy');
    expect(getBorderTypeForCard(row(), 'onboard')).toBe('onboardBeing');
  });

  it('picks up its own textBox keywords normally (e.g. cannotAttack)', () => {
    const card = toGameCard(row(), 0);
    expect(card.keywords.cannotAttack).toBe(true);
  });

  it('Crumbling Sphinx\'s own Engage ability parses and resolves like any Being\'s', () => {
    const card = toGameCard(row({
      'Card Name': 'Crumbling Sphinx', 'Text Box': 'Engage: Deal (1) Lifespan Damage to a Being you control and (1) to a different Being.',
    }), 0);
    expect(card.isRelicBeing).toBe(true);
    expect(card.keywords.engage).toBe('Deal (1) Lifespan Damage to a Being you control and (1) to a different Being.');
  });

  it('does not mistake a summoned token\'s own granted "Engage:" ability (inside a parenthetical description) for this card\'s own — Blooming Seed / Elderflower Ancient', () => {
    // Real CSV text (after CSV unescaping strips away the "" ""-quoting
    // the source file uses around the token's own reminder text, leaving
    // no quote character to key off — only the parenthetical nesting is
    // left as a signal). Neither card prints a real top-level Engage line.
    const bloomingSeed = parseKeywords('Pay (1) Living: Add (1) Growth Counter.\nRemove (1) Growth Counter: Sacrifice this, summon (1) Blooming Vine Token (0/3 Being - vine token with Engage: Add (1) Living) on any tile this points to.');
    expect(bloomingSeed.engage).toBeNull();
    const elderflowerAncient = parseKeywords('Depart: Restore (6) Lifespan or Summon (2) Blooming Vine tokens  (0/3 Being - Vine token with Engage: Add (1) Living).');
    expect(elderflowerAncient.engage).toBeNull();
    expect(elderflowerAncient.depart).toBe('Restore (6) Lifespan or Summon (2) Blooming Vine tokens  (0/3 Being - Vine token with Engage: Add (1) Living).');
  });

  it('still parses a real Engage ability normally when a token-description parenthetical is also present elsewhere in the text', () => {
    const kw = parseKeywords('Pay (1) Living Essence, Engage: Until end of turn Plants summoned on this tile come in Disengaged.\nIf this is Engaged at the end of the turn, sacrifice it.\nBeings may move across this Relic.');
    expect(kw.engage).toBe('Until end of turn Plants summoned on this tile come in Disengaged.');
  });

  it('Smithing Tools: two bare activated abilities, "Engage a Being, Gain (1) Forge Counter" and "Engage, Remove (X) Forge Counters: ..."', () => {
    const kw = parseKeywords('Engage a Being, Gain (1) Forge Counter.\nEngage, Remove (X) Forge Counters: Add an Armament from deck to hand with conjuring cost (X)');
    expect(kw.engageBeingGrantCounter).toEqual({ amount: 1, counterType: 'forge' });
    expect(kw.removeCountersXSearchArmament).toEqual({ counterType: 'forge' });
  });

  it('Sha-KaRah: "Pay (5) Lifespan to move an adjacent Armament one tile in any direction."', () => {
    const kw = parseKeywords('Pay (5) Lifespan to move an adjacent Armament one tile in any direction.');
    expect(kw.payLifespanCostAbility).toEqual({ amount: 5, effect: 'move an adjacent Armament one tile in any direction.' });
  });

  it('AfterImage token: "When this Being has (0) Time Counters on it, sacrifice it."', () => {
    const kw = parseKeywords('When this Being has (0) Time Counters on it, sacrifice it.');
    expect(kw.sacrificeAtZeroTimeCounters).toBe(true);
  });

  it('Kalmahka: "Armaments you control are 3/1 Relic - Armaments with \\"Animated. Attached Being has +0/+0\\" and lose all other text"', () => {
    const kw = parseKeywords('Gain (1) Time Counter\nArmaments you control are 3/1 Relic - Armaments with "Animated. Attached Being has +0/+0" and lose all other text');
    expect(kw.armamentIdentityOverride).toBe(true);
  });
});
