import { describe, it, expect } from 'vitest';
import { pickAiAction, pickAiReaction } from './ai.js';
import { getLegalActions } from './actions.js';

const player = (overrides = {}) => ({
  id: 'B', lifespan: 50, mainDeck: [], hand: [], purgatory: [],
  effigyDeck: [], effigyPool: [], effigySpentThisTurn: [], keptHand: true, ...overrides,
});

const baseState = (overrides = {}) => ({
  phase: 'playing', turnPlayer: 'B', turnNumber: 5, winner: null, board: {}, groundRelics: {}, altars: { A: [], B: [] }, log: [],
  players: { A: player({ id: 'A' }), B: player({ id: 'B' }) }, ...overrides,
});

const being = (ownerId, strength = 3, arrows = [1, 3, 7]) => ({
  type: 'being', ownerId,
  card: { name: 'B', kind: 'being', strength, lifespan: 5, arrows },
  currentLifespan: 5, engaged: false,
});

describe('pickAiAction', () => {
  it('prefers a real attack over a harmless reposition when both are legal', () => {
    // r4c2 (front row): direction 1 attacks into r2c2 (empty — real damage);
    // directions 3/7 just reposition sideways to r4c1/r4c3 (no effect).
    // It should pick the attack.
    const state = baseState({ board: { r4c2: being('B', 4) } });
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c2', toCellId: 'r2c2', isAttack: true });
  });

  it('passes when no other action is legal', () => {
    const state = baseState();
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'PASS_TURN' });
  });

  // Regression: an Animated Armament (Dancing Swords, or a Relic transformed
  // by Animate) acts as a Being on the board (RULES.md > Keywords) but is
  // stored as a `type: 'armament-stack'` occupant with the card nested under
  // `.armaments[i].card`, not a top-level `.card` the way a real `type:
  // 'being'` occupant has. scoreAction used to call `effectiveStrength`
  // directly on the raw occupant, which crashed reading `.card.strength` off
  // undefined the moment the AI considered attacking (or attacking WITH) one
  // — the exact white-screen crash a live playtest hit. Both directions
  // (animated occupant as the attacker, and as the opponent's target) must
  // resolve without throwing.
  const animatedArmamentStack = (ownerId, strength = 2, lifespan = 3) => ({
    type: 'armament-stack', ownerId,
    armaments: [{
      card: { name: 'Dancing Swords', kind: 'relic-armament', strength, lifespan, arrows: [1, 2, 3, 4, 5, 6, 7, 8], keywords: { animated: true } },
      engaged: false,
      currentLifespan: lifespan,
    }],
  });

  it('does not crash scoring an attack made BY an Animated Armament', () => {
    const state = baseState({ board: { r4c2: animatedArmamentStack('B') } });
    expect(() => pickAiAction(state, 'B')).not.toThrow();
  });

  it('does not crash scoring an attack INTO an Animated Armament', () => {
    const state = baseState({ board: { r4c2: being('B', 4), r2c2: animatedArmamentStack('A') } });
    expect(() => pickAiAction(state, 'B')).not.toThrow();
  });

  // Regression: a "Pay (N) <Color>: <effect>" activated ability with no
  // printed per-turn cap (Blooming Seed, Skeleton Key) can have its own
  // cost reduced all the way to 0 by another permanent, making it legal
  // forever with nothing to ever stop it. Before scoreAction accounted for
  // payEffigyAbilityUsesThisTurn, this tied PASS_TURN's own -100 by a wide
  // margin every single time and the AI just repeated it endlessly
  // (self-play found this as a real, otherwise-endless stall).
  const freeAbilityBeing = (payEffigyAbilityUsesThisTurn = 0) => ({
    type: 'being', ownerId: 'B',
    card: {
      name: 'Free Ability Being', kind: 'being', strength: 0, lifespan: 2, arrows: [],
      keywords: { payEffigyCostAbility: { color: 'living', amount: 1, effect: 'Add (1) Growth Counter.' }, cannotAttack: true, cannotMove: true },
    },
    currentLifespan: 2, engaged: true, payEffigyAbilityUsesThisTurn,
  });

  const livingEffigy = { id: 'e', instanceId: 'e#0', name: 'Living Effigy', kind: 'effigy', effigyType: 'living' };

  it('activates a free Pay-Effigy ability once, when it has not been used yet this turn', () => {
    const state = baseState({ board: { r4c1: freeAbilityBeing(0) }, players: { A: player({ id: 'A' }), B: player({ id: 'B', effigyPool: [livingEffigy] }) } });
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r4c1' });
  });

  it('passes rather than repeating a Pay-Effigy ability already used this turn, even though it is still legal', () => {
    const state = baseState({ board: { r4c1: freeAbilityBeing(1) }, players: { A: player({ id: 'A' }), B: player({ id: 'B', effigyPool: [livingEffigy] }) } });
    expect(getLegalActions(state, 'B')).toContainEqual({ type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r4c1' }); // still legal — only the AI's own preference changes
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'PASS_TURN' });
  });

  // Regression: self-play's own card-impact data (2M+ games) found
  // Anahk-sha — "Once per turn Pay (1) Bleeding Essence: Disengage." —
  // underperforming a plain vanilla Being of the same cost with no ability
  // at all. Root cause: this action used to share the same flat score (8)
  // as every other "Pay X: <generic value-add>" ability, which routinely
  // lost out to SUMMON_BEING/PLAY_PROPHECY, so the AI often just left it
  // stuck engaged instead of paying its own upkeep — unlike a real attack
  // (which recovers nothing, since it doesn't need to), disengaging *does*
  // recover an entire Being's worth of future turns, so it deserves a real
  // priority bump over playing a new card, not a tied one.
  const stuckDisengagerBeing = () => ({
    type: 'being', ownerId: 'B',
    card: {
      name: 'Anahk-sha', kind: 'being', strength: 4, lifespan: 4, arrows: [1],
      keywords: { payEffigyCostAbility: { color: 'bleeding', amount: 1, effect: 'Disengage.', once: true } },
    },
    currentLifespan: 4, engaged: true, timesPerTurnUsed: 0, payEffigyAbilityUsesThisTurn: 0,
  });
  const bleedingEffigy = { id: 'e2', instanceId: 'e2#0', name: 'Bleeding Effigy', kind: 'effigy', effigyType: 'bleeding' };
  const modestBeingCard = { id: 'mb', instanceId: 'mb#0', name: 'Modest Being', kind: 'being', strength: 5, lifespan: 2, timerMax: 0, arrows: [1], castingCost: { faithless: 0, colored: {} } };

  it('prioritizes paying to Disengage a stuck attacker (Anahk-sha) over playing a new card, when both are legal', () => {
    const state = baseState({
      board: { r4c1: stuckDisengagerBeing() },
      players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [modestBeingCard], effigyPool: [bleedingEffigy] }) },
    });
    // SUMMON_BEING (20 + strength 5 = 25) would have beaten the old flat
    // score of 8 for the disengage — confirms this is a real priority
    // fix, not just "disengage always wins regardless".
    expect(getLegalActions(state, 'B')).toContainEqual({ type: 'SUMMON_BEING', instanceId: 'mb#0', cellId: expect.any(String) });
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r4c1' });
  });

  it('still scores a non-Disengage Pay-Effigy ability at the old flat priority (unaffected by the Disengage-specific bump)', () => {
    const state = baseState({ board: { r4c1: freeAbilityBeing(0) }, players: { A: player({ id: 'A' }), B: player({ id: 'B', effigyPool: [livingEffigy] }) } });
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r4c1' }); // still the only real option, but via the unchanged low-priority path
  });
});

describe('pickAiReaction', () => {
  const etherealConjuring = (instanceId) => ({
    id: 'ec', instanceId, name: 'Test Ethereal', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Gain 3 Lifespan.',
  });

  it('reacts with an affordable Ethereal Conjuring rather than passing', () => {
    const state = baseState({ reactiveWindow: { openFor: 'B' }, players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [etherealConjuring('ec#0')] }) } });
    const action = pickAiReaction(state, 'B');
    expect(action).toEqual({ type: 'CAST_CONJURING', instanceId: 'ec#0' });
  });

  it('passes when nothing affordable is available', () => {
    const state = baseState({ reactiveWindow: { openFor: 'B' }, players: { A: player({ id: 'A' }), B: player({ id: 'B' }) } });
    const action = pickAiReaction(state, 'B');
    expect(action).toEqual({ type: 'PASS_PRIORITY' });
  });

  it('returns null when it isn\'t actually B\'s window (getLegalActions offers nothing)', () => {
    const state = baseState({ reactiveWindow: { openFor: 'A' }, players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [etherealConjuring('ec#0')] }) } });
    expect(pickAiReaction(state, 'B')).toBeNull();
  });

  it('reacts with an Engage ability (ethereal speed) rather than passing, when it has no Ethereal Conjuring to cast', () => {
    const engageBeing = {
      type: 'being', ownerId: 'B',
      card: { name: 'B', kind: 'being', strength: 1, lifespan: 3, arrows: [1], keywords: { engage: 'Gain (1) Lifespan.' } },
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ reactiveWindow: { openFor: 'B' }, board: { r4c1: engageBeing }, players: { A: player({ id: 'A' }), B: player({ id: 'B' }) } });
    const action = pickAiReaction(state, 'B');
    expect(action).toEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r4c1' });
  });
});
