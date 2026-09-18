import { describe, it, expect } from 'vitest';
import { pickAiAction } from './ai.js';

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
});
