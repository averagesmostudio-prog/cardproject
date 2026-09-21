import { describe, it, expect, vi } from 'vitest';
import { gameReducer, getLegalActions, createInitialState, canPayCost, resolveOrLogEffect, faithlessPaymentNeedsChoice, faithlessPaymentCandidates, resolveProphecyModulateHitZero, dealDamageToBeing, effectiveCastingCost } from './actions.js';
import { beginTurn, endTurn } from './turn.js';
import { effectiveStrength, deathDamageFor } from './combat.js';
import { computeMoveDestination } from './board.js';
import { toGameCard } from '../../lib/cardData.js';

const player = (overrides = {}) => ({
  id: 'A',
  lifespan: 50,
  mainDeck: [],
  hand: [],
  purgatory: [],
  effigyDeck: [],
  effigyPool: [],
  effigySpentThisTurn: [],
  keptHand: true,
  ...overrides,
});

const baseState = (overrides = {}) => ({
  phase: 'playing',
  turnPlayer: 'A',
  turnNumber: 5, // avoid the turn-1 double-effigy special case in unrelated tests
  winner: null,
  board: {},
  groundRelics: {},
  altars: { A: [], B: [] },
  log: [],
  players: { A: player({ id: 'A' }), B: player({ id: 'B' }) },
  pendingChoice: null,
  reactiveWindow: null,
  pendingResolution: null,
  ...overrides,
});

const beingCard = (overrides = {}) => ({
  id: 'being-1', instanceId: 'being-1#0', name: 'Test Being', kind: 'being', isDeity: false, isToken: false,
  castingCost: { faithless: 1, colored: {} }, strength: 3, lifespan: 5, timerMax: 0, arrows: [1], ...overrides,
});

const effigy = (color, n = 1) => ({ instanceId: `${color}#${n}`, effigyType: color, kind: 'effigy' });

// Armaments are stored on a board occupant as { card, engaged } wrappers —
// each one is its own independently engageable permanent (ACTIVATE_ARMAMENT_ENGAGE).
const equip = (card, engaged = false) => ({ card, engaged });

describe('canPayCost / SUMMON_BEING', () => {
  it('summons when the pool covers the cost, moving the card from hand to board', () => {
    const card = beingCard();
    const state = baseState({
      players: {
        A: player({ hand: [card], effigyPool: [effigy('bleeding')] }),
        B: player(),
      },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.board.r1c2.currentLifespan).toBe(5);
    expect(next.board.r1c2.engaged).toBe(true);
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('spends temporary (end-of-turn) Essence before a real Effigy of the same color, given a choice', () => {
    const card = beingCard({ castingCost: { faithless: 0, colored: { bleeding: 1 } } });
    const permanentEffigy = effigy('bleeding', 1);
    const temporaryEssence = { instanceId: 'bleeding-temp#0', effigyType: 'bleeding', kind: 'effigy', temporary: true };
    const state = baseState({
      players: { A: player({ hand: [card], effigyPool: [permanentEffigy, temporaryEssence] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    // The permanent Effigy survives — the temporary one (which expires at
    // end of turn regardless) was spent instead.
    expect(next.players.A.effigyPool).toEqual([permanentEffigy]);
  });

  it('a Deity enters the board disengaged', () => {
    const card = beingCard({ id: 'deity-1', instanceId: 'deity-1#0', kind: 'deity', isDeity: true, castingCost: { faithless: 0, colored: {} } });
    const state = baseState({ players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.engaged).toBe(false);
  });

  it('a Being with the Persist keyword enters the board disengaged', () => {
    const card = beingCard({ keywords: { persist: true } });
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.engaged).toBe(false);
  });

  it('a normal Being without Persist still enters engaged as usual', () => {
    const card = beingCard({ keywords: { persist: false } });
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.engaged).toBe(true);
  });

  it('refuses to summon when the pool cannot cover a colored pip', () => {
    const card = beingCard({ castingCost: { faithless: 0, colored: { bleeding: 1 } } });
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('living')] }), B: player() } });
    expect(canPayCost(state.players.A.effigyPool, card.castingCost)).toBe(false);
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next).toBe(state); // unchanged
  });

  it('refuses to summon onto an occupied cell', () => {
    const card = beingCard();
    const existing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'other' }), currentLifespan: 1, engaged: false };
    const state = baseState({
      board: { r1c2: existing },
      players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2).toBe(existing);
  });
});

describe('Faithless payment choice (faithlessPaymentNeedsChoice / explicit faithlessInstanceIds)', () => {
  it('needs no choice with only one Effigy color available', () => {
    const cost = { faithless: 2, colored: {} };
    const pool = [effigy('bleeding', 1), effigy('bleeding', 2), effigy('bleeding', 3)];
    expect(faithlessPaymentNeedsChoice(pool, cost)).toBe(false);
  });

  it('needs no choice when every remaining Effigy must be spent regardless (no real choice of which to keep)', () => {
    const cost = { faithless: 2, colored: {} };
    const pool = [effigy('bleeding', 1), effigy('living', 1)];
    expect(faithlessPaymentNeedsChoice(pool, cost)).toBe(false);
  });

  it('needs a choice when more than one color is available and some would be left over', () => {
    const cost = { faithless: 1, colored: {} };
    const pool = [effigy('bleeding', 1), effigy('living', 1)];
    expect(faithlessPaymentNeedsChoice(pool, cost)).toBe(true);
  });

  it('candidates exclude whatever is reserved for colored pips', () => {
    const cost = { faithless: 1, colored: { formless: 1 } };
    const pool = [effigy('formless', 1), effigy('bleeding', 1), effigy('living', 1)];
    const candidates = faithlessPaymentCandidates(pool, cost);
    expect(candidates.map(e => e.effigyType).sort()).toEqual(['bleeding', 'living']);
  });

  it('needs no choice at all when there is no Faithless component', () => {
    const cost = { faithless: 0, colored: { bleeding: 1 } };
    const pool = [effigy('bleeding', 1), effigy('living', 1)];
    expect(faithlessPaymentNeedsChoice(pool, cost)).toBe(false);
  });

  it('SUMMON_BEING spends the explicitly chosen Effigies for the Faithless portion, not the automatic FIFO pick', () => {
    const card = beingCard({ castingCost: { faithless: 1, colored: {} } });
    const pool = [effigy('bleeding', 1), effigy('living', 1)]; // FIFO would spend "bleeding" first
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: pool }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2', faithlessInstanceIds: ['living#1'] });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.players.A.effigyPool).toEqual([effigy('bleeding', 1)]); // the chosen "living" one was spent, "bleeding" kept
  });

  it('falls back to the automatic pick when the explicit selection is malformed (wrong count, or an id not in the pool)', () => {
    const card = beingCard({ castingCost: { faithless: 1, colored: {} } });
    const pool = [effigy('bleeding', 1), effigy('living', 1)];
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: pool }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2', faithlessInstanceIds: ['not-in-pool'] });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.players.A.effigyPool).toEqual([effigy('living', 1)]); // automatic FIFO pick — "bleeding" (first in pool) spent
  });
});

describe('"Whenever a Being is summoned under your control, move and attach Happy Hammer to that Being." (Happy Hammer)', () => {
  const happyHammer = (n = 1) => equip({
    id: 'hh', instanceId: `hh#${n}`, name: 'Happy Hammer', kind: 'relic-armament',
    keywords: { movesToNewlySummonedBeing: true, statBonus: { strength: 3, lifespan: 0 } },
  });
  const newBeing = beingCard({ instanceId: 'new#0', strength: 2 });

  it('moves off an existing wielder onto a freshly summoned Being', () => {
    const wielder = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wielder#0', strength: 1 }), currentLifespan: 5, engaged: false, armaments: [happyHammer()] };
    const state = baseState({
      board: { r2c1: wielder },
      players: { A: player({ hand: [newBeing], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: newBeing.instanceId, cellId: 'r1c2' });
    expect(next.board.r2c1.armaments).toEqual([]);
    expect(next.board.r1c2.armaments).toHaveLength(1);
    expect(next.board.r1c2.armaments[0].card.name).toBe('Happy Hammer');
    expect(effectiveStrength(next.board.r1c2)).toBe(5); // 2 printed + 3 from Happy Hammer
    expect(effectiveStrength(next.board.r2c1)).toBe(1); // no longer boosted
  });

  it('moves off a freestanding pile, removing the now-empty pile entirely', () => {
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [happyHammer()] };
    const state = baseState({
      board: { r2c1: pile },
      players: { A: player({ hand: [newBeing], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: newBeing.instanceId, cellId: 'r1c2' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.board.r1c2.armaments).toHaveLength(1);
  });

  it('does not move the opponent\'s Happy Hammer when this player summons', () => {
    const oppWielder = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'oppwielder#0' }), currentLifespan: 5, engaged: false, armaments: [happyHammer()] };
    const state = baseState({
      board: { r4c1: oppWielder },
      players: { A: player({ hand: [newBeing], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: newBeing.instanceId, cellId: 'r1c2' });
    expect(next.board.r4c1.armaments).toHaveLength(1); // untouched
    expect(next.board.r1c2.armaments).toBeUndefined();
  });

  it('does nothing (no crash) when the player controls no Happy Hammer', () => {
    const state = baseState({ players: { A: player({ hand: [newBeing], effigyPool: [effigy('bleeding')] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: newBeing.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.armaments).toBeUndefined();
  });

  it('moves every copy independently when the player controls more than one', () => {
    const wielderA = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wa#0' }), currentLifespan: 5, engaged: false, armaments: [happyHammer(1)] };
    const wielderB = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wb#0' }), currentLifespan: 5, engaged: false, armaments: [happyHammer(2)] };
    const state = baseState({
      board: { r2c1: wielderA, r2c2: wielderB },
      players: { A: player({ hand: [newBeing], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: newBeing.instanceId, cellId: 'r1c2' });
    expect(next.board.r2c1.armaments).toEqual([]);
    expect(next.board.r2c2.armaments).toEqual([]);
    expect(next.board.r1c2.armaments).toHaveLength(2);
    expect(effectiveStrength(next.board.r1c2)).toBe(8); // 2 printed + 3 + 3
  });

  it('is a no-op when the newly summoned Being picks up a waiting pile that already includes it', () => {
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [happyHammer()] };
    const state = baseState({
      board: { r1c2: pile },
      players: { A: player({ hand: [newBeing], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: newBeing.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.armaments).toHaveLength(1);
    expect(effectiveStrength(next.board.r1c2)).toBe(5);
  });
});

describe('Deity legend rule: at most one same-named Deity per side', () => {
  const deityCard = (overrides = {}) => beingCard({
    id: 'metatoris', instanceId: 'metatoris#0', name: 'MetaToris', kind: 'deity', isDeity: true,
    castingCost: { faithless: 0, colored: {} }, ...overrides,
  });

  it('does nothing when the player controls only one', () => {
    const card = deityCard();
    const state = baseState({ players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r1c2.card.name).toBe('MetaToris');
  });

  it('opens a choice when a second same-named Deity is summoned', () => {
    const existing = { type: 'being', ownerId: 'A', card: deityCard({ instanceId: 'old#0' }), currentLifespan: 4, engaged: false };
    const card = deityCard({ instanceId: 'new#0' });
    const state = baseState({ board: { r2c1: existing }, players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.pendingChoice).toEqual({ kind: 'legend-rule-keep', playerId: 'A', cardName: 'MetaToris', deityName: 'MetaToris' });
    // Both copies are still on the board until the choice resolves.
    expect(next.board.r2c1).toBeDefined();
    expect(next.board.r1c2).toBeDefined();
  });

  it('keeping the chosen copy sacrifices every other same-named copy (no Lifespan loss)', () => {
    const existing = { type: 'being', ownerId: 'A', card: deityCard({ instanceId: 'old#0' }), currentLifespan: 4, engaged: false };
    const card = deityCard({ instanceId: 'new#0' });
    const state = baseState({ board: { r2c1: existing }, players: { A: player({ hand: [card], lifespan: 50 }), B: player() } });
    const summoned = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    const next = gameReducer(summoned, { type: 'RESOLVE_LEGEND_RULE_KEEP', cellId: 'r1c2' });
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r1c2).toBeDefined(); // kept
    expect(next.board.r2c1).toBeUndefined(); // sacrificed
    expect(next.players.A.purgatory.some(c => c.instanceId === 'old#0')).toBe(true);
    expect(next.players.A.lifespan).toBe(50); // no Lifespan loss — a sacrifice, not combat/damage
  });

  it('keeping the OTHER (older) copy sacrifices the newly summoned one instead', () => {
    const existing = { type: 'being', ownerId: 'A', card: deityCard({ instanceId: 'old#0' }), currentLifespan: 4, engaged: false };
    const card = deityCard({ instanceId: 'new#0' });
    const state = baseState({ board: { r2c1: existing }, players: { A: player({ hand: [card] }), B: player() } });
    const summoned = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    const next = gameReducer(summoned, { type: 'RESOLVE_LEGEND_RULE_KEEP', cellId: 'r2c1' });
    expect(next.board.r2c1).toBeDefined(); // kept
    expect(next.board.r1c2).toBeUndefined(); // sacrificed
    expect(next.players.A.purgatory.some(c => c.instanceId === 'new#0')).toBe(true);
  });

  it('does not trigger for a differently-named Deity, or for the opponent\'s own copy', () => {
    const ownOther = { type: 'being', ownerId: 'A', card: deityCard({ instanceId: 'other#0', name: 'Other Deity' }), currentLifespan: 4, engaged: false };
    const opponentsSame = { type: 'being', ownerId: 'B', card: deityCard({ instanceId: 'opp#0' }), currentLifespan: 4, engaged: false };
    const card = deityCard({ instanceId: 'new#0' });
    const state = baseState({ board: { r2c1: ownOther, r4c1: opponentsSame }, players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r2c1).toEqual(ownOther);
    expect(next.board.r4c1).toEqual(opponentsSame);
    expect(next.board.r1c2).toBeDefined();
  });
});

describe('"Relic, Being" (RULES.md > Card types — Training dummy, Crumbling Sphinx)', () => {
  const relicBeingCard = (overrides = {}) => beingCard({
    name: 'Training dummy', isRelicBeing: true, keywords: { cannotAttack: true }, ...overrides,
  });

  it('enters the board disengaged, unlike a normal Being', () => {
    const card = relicBeingCard();
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.board.r1c2.engaged).toBe(false);
  });

  it('may be summoned directly into the front row, unlike a normal Being', () => {
    const card = relicBeingCard();
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r2c1' });
    expect(next.board.r2c1.type).toBe('being');
  });

  it('getLegalActions offers every Mortal Realm cell, not just the home-row summon cells', () => {
    const card = relicBeingCard();
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() } });
    const cells = getLegalActions(state, 'A').filter(a => a.type === 'SUMMON_BEING').map(a => a.cellId);
    expect(cells).toEqual(expect.arrayContaining(['r1c2', 'r1c3', 'r1c4', 'r2c1', 'r2c2', 'r2c3', 'r2c4', 'r2c5']));
    expect(cells).not.toContain('r1c5'); // the reserved Effigy Zone cell still isn't legal for anything
  });

  it('a normal Being (not a Relic Being) is still restricted to the home-row summon cells', () => {
    const card = beingCard();
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('bleeding')] }), B: player() } });
    const cells = getLegalActions(state, 'A').filter(a => a.type === 'SUMMON_BEING').map(a => a.cellId);
    expect(cells.sort()).toEqual(['r1c2', 'r1c3', 'r1c4']);
  });

  it('blocks an attack and takes/deals combat damage exactly like a normal Being — real mutual combat, not bypassed like a plain Relic', () => {
    const relicBeing = { type: 'being', ownerId: 'A', card: relicBeingCard({ strength: 1, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk', strength: 3, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: attacker, r2c1: relicBeing }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(next.board.r2c1.currentLifespan).toBe(2); // 5 - 3 (attacker's Strength) — still alive, took real damage
    expect(next.board.r4c1.currentLifespan).toBe(4); // 5 - 1 (defender's own Strength)
  });

  it('dying deals its controller death-damage equal to its own printed Lifespan, same as a Being', () => {
    const relicBeing = { type: 'being', ownerId: 'A', card: relicBeingCard({ strength: 1, lifespan: 3 }), currentLifespan: 1, engaged: false };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: attacker, r2c1: relicBeing }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.lifespan).toBe(47); // 50 - 3 (its own printed Lifespan)
    expect(next.players.A.purgatory).toHaveLength(1);
  });

  it('"Can not attack" (Training dummy) is never offered as a legal attack', () => {
    const relicBeing = { type: 'being', ownerId: 'A', card: relicBeingCard(), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: relicBeing } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'MOVE_OR_ATTACK' && a.isAttack)).toBe(false);
  });

  it('the reducer itself also refuses a "Can not attack" attack directly dispatched', () => {
    const relicBeing = { type: 'being', ownerId: 'A', card: relicBeingCard(), currentLifespan: 3, engaged: false };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: relicBeing, r4c1: attacker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next).toBe(state);
  });

  it('an Engage ability (e.g. Crumbling Sphinx) works exactly like a normal Being\'s', () => {
    const sphinx = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Crumbling Sphinx', isRelicBeing: true, keywords: { engage: 'Deal (1) Lifespan Damage to a Being you control and (1) to a different Being.' } }),
      currentLifespan: 1, engaged: false,
    };
    const state = baseState({ board: { r2c1: sphinx } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(true);
  });
});

describe('"Costs (-N) <Color> for each <Name> you control" (Skeletal Colossus)', () => {
  const colossusCard = (overrides = {}) => beingCard({
    name: 'Skeletal Colossus',
    castingCost: { faithless: 3, colored: { shifting: 2 } },
    keywords: { costReduction: { amount: 1, color: 'faithless', name: "Bag o' Bones" } },
    ...overrides,
  });
  const bagOBones = (id = 'bag#0') => ({ type: 'relic', ownerId: 'A', card: { id: 'bag', instanceId: id, name: "Bag o' Bones", kind: 'relic' } });

  it('costs its full printed cost with none of the named permanent on board', () => {
    const card = colossusCard();
    // Enough for the *reduced* cost (1 Faithless + 2 Shifting = 3 total)
    // but not the full printed one (3 Faithless + 2 Shifting = 5 total) —
    // with no Bag o' Bones on board, no reduction should apply.
    const pool = [effigy('shifting'), effigy('shifting'), effigy('bleeding')];
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: pool }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2).toBeUndefined();
  });

  it('reduces Faithless by (amount × count controlled), letting a cheaper pool pay it', () => {
    const card = colossusCard();
    // Full cost is 3 Faithless + 2 Shifting; with 2 Bag o' Bones controlled,
    // effective cost is 1 Faithless + 2 Shifting.
    const pool = [effigy('shifting'), effigy('shifting'), effigy('bleeding')];
    const state = baseState({
      board: { r1c3: bagOBones('b1#0'), r1c4: bagOBones('b2#0') },
      players: { A: player({ hand: [card], effigyPool: pool }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.players.A.effigyPool).toHaveLength(0); // spent exactly the reduced cost
  });

  it('never reduces a cost component below 0, even with more than enough controlled', () => {
    const card = colossusCard();
    const pool = [effigy('shifting'), effigy('shifting')]; // 0 Faithless-payable effigies
    const state = baseState({
      board: { r1c3: bagOBones('b1#0'), r1c4: bagOBones('b2#0'), r5c3: bagOBones('b3#0'), r5c4: bagOBones('b4#0') },
      players: { A: player({ hand: [card], effigyPool: pool }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being'); // Faithless clamped to 0, only the 2 Shifting still owed
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('only counts the controlling player\'s own — an opponent\'s does not reduce the cost', () => {
    const card = colossusCard();
    const pool = [effigy('shifting'), effigy('shifting'), effigy('bleeding'), effigy('bleeding'), effigy('bleeding')];
    const state = baseState({
      board: { r5c3: { ...bagOBones('opp#0'), ownerId: 'B' } },
      players: { A: player({ hand: [card], effigyPool: pool }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being'); // still needed the full 3 Faithless — paid it
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('getLegalActions only offers SUMMON_BEING once the reduced cost is affordable', () => {
    const card = colossusCard();
    const pool = [effigy('shifting'), effigy('shifting'), effigy('bleeding')]; // only 1 Faithless-equivalent
    const withoutBones = baseState({ players: { A: player({ hand: [card], effigyPool: pool }), B: player() } });
    expect(getLegalActions(withoutBones, 'A').some(a => a.type === 'SUMMON_BEING')).toBe(false);
    const withBones = { ...withoutBones, board: { r1c3: bagOBones('b1#0'), r1c4: bagOBones('b2#0') } };
    expect(getLegalActions(withBones, 'A').some(a => a.type === 'SUMMON_BEING')).toBe(true);
  });

  it('counts a Bag o\' Bones attached as an Armament, not just a freestanding Relic', () => {
    const card = colossusCard();
    const being = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [equip({ id: 'bag', instanceId: 'bag#0', name: "Bag o' Bones", kind: 'relic' })] };
    const pool = [effigy('shifting'), effigy('shifting'), effigy('bleeding'), effigy('bleeding')];
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [card], effigyPool: pool }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.players.A.effigyPool).toHaveLength(0); // paid the reduced 2 Faithless + 2 Shifting
  });
});

describe('Singularity: "Costs (-1) Faithless for each Time Counter that you control." + "has -X/-X where X equals the number of Time Counters that you control."', () => {
  const singularityCard = (overrides = {}) => beingCard({
    name: 'Singularity', strength: 13, lifespan: 13,
    castingCost: { faithless: 12, colored: { timeless: 1 } },
    keywords: {
      costReduction: { amount: 1, color: 'faithless', name: 'Time Counter' },
      statPenaltyEqualsTimeCountersControlled: true,
    },
    ...overrides,
  });

  it('costs its full printed cost with no Time Counters controlled', () => {
    const card = singularityCard();
    const pool = Array.from({ length: 11 }, () => effigy('faithless')).concat(effigy('timeless'));
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: pool }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2).toBeUndefined(); // 11 Faithless isn't enough for the full 12
  });

  it('reduces Faithless by 1 per Time Counter controlled (Prophecy timers + an Altar\'s own), letting a cheaper pool pay it', () => {
    const card = singularityCard();
    // 2 (face-down Prophecy) + 3 (Altar) = 5 Time Counters -> costs 7 Faithless + 1 Timeless.
    const pool = Array.from({ length: 7 }, () => effigy('faithless')).concat(effigy('timeless'));
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 2, faceDown: true } },
      altars: { A: [{ card: { name: 'Eònion Altar' }, counters: { time: 3 } }], B: [] },
      players: { A: player({ hand: [card], effigyPool: pool }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('never reduces Faithless below 0, even with more Time Counters than the printed cost', () => {
    const card = singularityCard();
    const pool = [effigy('timeless')]; // 0 Faithless-payable effigies
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 20, faceDown: true } },
      players: { A: player({ hand: [card], effigyPool: pool }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    // 20 Time Counters also floors its own -X/-X at 0 Lifespan (its printed
    // Lifespan is 13), a real death the instant it recomputes — so this only
    // checks it was actually payable/summoned (Faithless clamped to 0, just
    // the 1 Timeless owed), not that it survives; see the death test below
    // for that separate concern.
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('is -X/-X at summon, where X is the Time Counters controlled at that moment', () => {
    const card = singularityCard();
    const pool = Array.from({ length: 9 }, () => effigy('faithless')).concat(effigy('timeless'));
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 3, faceDown: true } },
      players: { A: player({ hand: [card], effigyPool: pool }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
    expect(effectiveStrength(next.board.r1c2)).toBe(10); // 13 - 3
    expect(next.board.r1c2.currentLifespan).toBe(10);
  });

  it('adjusts live, mid-turn, as Time Counters controlled change — not just at summon', () => {
    const singularity = { type: 'being', ownerId: 'A', card: singularityCard(), currentLifespan: 13, engaged: false, timeCounterStatPenalty: 0 };
    const target = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Target Being', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: true };
    const state = baseState({
      board: { r2c1: singularity, r2c2: target },
      pendingChoice: { kind: 'time-counter-block-move', playerId: 'A', cardName: 'Moment of Doubt', label: 'When Summoned', amount: 4 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_TIME_COUNTER_BLOCK_MOVE', cellId: 'r2c2' });
    expect(effectiveStrength(next.board.r2c1)).toBe(9); // 13 - 4, updated in the same reducer call
    expect(next.board.r2c1.currentLifespan).toBe(9);
  });

  it('a live X big enough to floor its Lifespan at 0 is a real death, not a silent floor — Depart/Purgatory/owner Lifespan loss all fire', () => {
    const singularity = { type: 'being', ownerId: 'A', card: singularityCard(), currentLifespan: 13, engaged: false, timeCounterStatPenalty: 0 };
    const state = baseState({
      turnNumber: 3,
      board: { r2c1: singularity, r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 40, faceDown: false } },
      // A real card to draw at the start of the turn — an empty deck would
      // also cost its own unrelated 10 Lifespan penalty, confounding this
      // test's own assertion below.
      players: { A: player({ lifespan: 50, mainDeck: [beingCard({ instanceId: 'd1#0' })] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.lifespan).toBe(50 - 13); // Singularity's own printed Lifespan, same death-damage rule as any other Being
    expect(next.players.A.purgatory.some(c => c.name === 'Singularity')).toBe(true);
  });

  it('does not affect an unrelated Being\'s Strength/Lifespan', () => {
    const singularity = { type: 'being', ownerId: 'A', card: singularityCard(), currentLifespan: 13, engaged: false, timeCounterStatPenalty: 0 };
    const other = { type: 'being', ownerId: 'A', card: beingCard({ strength: 3, lifespan: 4 }), currentLifespan: 4, engaged: false };
    const state = baseState({
      turnNumber: 3,
      board: { r2c1: singularity, r2c2: other, r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 5, faceDown: false } },
    });
    const next = beginTurn(state);
    expect(effectiveStrength(next.board.r2c2)).toBe(3);
    expect(next.board.r2c2.currentLifespan).toBe(4);
  });
});

describe('"Destroy a Relic." (Desecration) — plain Relics, Relic-Beings, and Relic-Armaments', () => {
  const desecration = {
    id: 'des-1', instanceId: 'des-1#0', name: 'Desecration', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Destroy a Relic.',
  };

  it('destroys the only plain freestanding Relic', () => {
    const relic = { type: 'relic', ownerId: 'B', card: { id: 'r', instanceId: 'r#0', name: 'Some Relic', kind: 'relic' } };
    const state = baseState({ board: { r2c1: relic }, players: { A: player({ hand: [desecration] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.B.purgatory.some(c => c.instanceId === 'r#0')).toBe(true);
  });

  it('can also destroy a Relic-Being (a full Being, via Depart/Purgatory — no owner Lifespan loss)', () => {
    const relicBeing = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'rb#0', name: 'Training dummy', isRelicBeing: true, keywords: { depart: 'Draw (1) card.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({
      board: { r2c1: relicBeing },
      players: { A: player({ hand: [desecration] }), B: player({ mainDeck: [{ id: 'c', instanceId: 'c#0', name: 'Card' }] }) },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.B.purgatory.some(c => c.instanceId === 'rb#0')).toBe(true);
    expect(next.players.B.lifespan).toBe(50); // destroyed, not dealt combat damage
    expect(next.players.B.hand).toHaveLength(1); // its Depart still fired
  });

  it('can also destroy a Relic-Armament attached to a Being', () => {
    const armament = equip({ id: 'ra', instanceId: 'ra#0', name: 'Rusted Rapier', kind: 'relic-armament' });
    const wielder = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'wielder#0' }), currentLifespan: 5, engaged: false, armaments: [armament] };
    const state = baseState({ board: { r2c1: wielder }, players: { A: player({ hand: [desecration] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.board.r2c1.armaments).toEqual([]); // the Being keeps its (now-empty) armaments list
    expect(next.board.r2c1.type).toBe('being'); // the Being itself is untouched, only the Armament is destroyed
    expect(next.players.B.purgatory.some(c => c.instanceId === 'ra#0')).toBe(true);
  });

  it('can also destroy a Relic-Armament sitting in a freestanding pile', () => {
    const pile = { type: 'armament-stack', ownerId: 'B', armaments: [equip({ id: 'ra', instanceId: 'ra#0', name: 'Rusted Rapier', kind: 'relic-armament' })] };
    const state = baseState({ board: { r2c1: pile }, players: { A: player({ hand: [desecration] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.board.r2c1).toBeUndefined(); // the pile is now empty, removed entirely
    expect(next.players.B.purgatory.some(c => c.instanceId === 'ra#0')).toBe(true);
  });

  it('targets either player\'s Relics, and offers a choice among multiple legal targets', () => {
    const ownRelic = { type: 'relic', ownerId: 'A', card: { id: 'r1', instanceId: 'r1#0', name: 'Mine', kind: 'relic' } };
    const oppRelic = { type: 'relic', ownerId: 'B', card: { id: 'r2', instanceId: 'r2#0', name: 'Theirs', kind: 'relic' } };
    const state = baseState({ board: { r2c1: ownRelic, r4c1: oppRelic }, players: { A: player({ hand: [desecration] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.pendingChoice.kind).toBe('destroy-relic-target');
    const resolved = gameReducer(next, { type: 'RESOLVE_DESTROY_RELIC_TARGET', cellId: 'r4c1', armamentInstanceId: null });
    expect(resolved.board.r4c1).toBeUndefined();
    expect(resolved.board.r2c1).toEqual(ownRelic); // untouched
  });

  it('logs an honest "no Relic to destroy" instead of crashing with nothing to target', () => {
    const state = baseState({ players: { A: player({ hand: [desecration] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.log.some(e => e.message.includes('no Relic to destroy'))).toBe(true);
  });

  it('never targets a plain Being (not a Relic-Being)', () => {
    const plainBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'plain#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: plainBeing }, players: { A: player({ hand: [desecration] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'des-1#0' });
    expect(next.log.some(e => e.message.includes('no Relic to destroy'))).toBe(true);
    expect(next.board.r2c1).toEqual(plainBeing);
  });
});

describe('"Once per turn target Familiar becomes Favored until end of turn." (Greenseer)', () => {
  const greenseer = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Greenseer', keywords: { timesPerTurnAbility: { times: 1, effect: 'target Familiar becomes Favored until end of turn.' } } }), currentLifespan: 3, engaged: false };

  it('grants a real Favored Counter to the only legal Familiar (either owner, no "you control")', () => {
    const familiar = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'fam#0', typing: 'Cat, Being, Familiar' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: greenseer, r4c1: familiar }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r4c1.favorCounter).toBe(true);
    expect(next.board.r4c1.favorCounterExpiresEndOfTurn).toBe(true);
  });

  it('never targets a non-Familiar Being', () => {
    const plain = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'plain#0', typing: 'Human, Being' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: greenseer, r2c2: plain }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('no Familiar to target'))).toBe(true);
    expect(next.board.r2c2.favorCounter).toBeUndefined();
  });

  it('offers a choice among multiple legal Familiars, either owner', () => {
    const famA = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0', typing: 'Cat, Being, Familiar' }), currentLifespan: 2, engaged: false };
    const famB = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'b#0', typing: 'Owl, Being, Familiar' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: greenseer, r2c2: famA, r4c1: famB }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'grant-favor', playerId: 'A', cardName: 'Greenseer', anyOwner: true, permanent: false, typing: 'Familiar' });
    const resolved = gameReducer(next, { type: 'RESOLVE_GRANT_FAVOR', cellId: 'r4c1' });
    expect(resolved.board.r4c1.favorCounter).toBe(true);
    expect(resolved.board.r2c2.favorCounter).toBeUndefined();
  });
});

describe('"Once per turn sacrifice a Relic: Craft (1) Effigy." (Antiquities Dealer) — any Relic shape, own side only', () => {
  const dealer = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Antiquities Dealer', keywords: { timesPerTurnAbility: { times: 1, effect: 'sacrifice a Relic: Craft (1) Effigy.' } } }), currentLifespan: 3, engaged: false };

  it('sacrifices the only own plain Relic and crafts 1 Effigy', () => {
    const relic = { type: 'relic', ownerId: 'A', card: { id: 'r', instanceId: 'r#0', name: 'Some Relic', kind: 'relic' } };
    const state = baseState({
      board: { r2c1: dealer, r2c2: relic },
      players: { A: player({ effigyDeck: [{ instanceId: 'ed1', effigyType: 'bleeding' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c2).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'r#0')).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1);
  });

  it('can also sacrifice a Relic-Armament (attached or freestanding) — the bug report\'s exact complaint', () => {
    const armament = equip({ id: 'ra', instanceId: 'ra#0', name: 'Rusted Rapier', kind: 'relic-armament' });
    const wielder = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wielder#0' }), currentLifespan: 5, engaged: false, armaments: [armament] };
    const state = baseState({
      board: { r2c1: dealer, r2c2: wielder },
      players: { A: player({ effigyDeck: [{ instanceId: 'ed1', effigyType: 'bleeding' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c2.armaments).toEqual([]);
    expect(next.board.r2c2.type).toBe('being'); // the wielder itself is untouched
    expect(next.players.A.purgatory.some(c => c.instanceId === 'ra#0')).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1);
  });

  it('can also sacrifice a Relic-Being', () => {
    const relicBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'rb#0', isRelicBeing: true }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r2c1: dealer, r2c2: relicBeing },
      players: { A: player({ effigyDeck: [{ instanceId: 'ed1', effigyType: 'bleeding' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c2).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'rb#0')).toBe(true);
  });

  it('never offers the opponent\'s own Relic as a candidate', () => {
    const ownRelic = { type: 'relic', ownerId: 'A', card: { id: 'r1', instanceId: 'own#0', name: 'Mine', kind: 'relic' } };
    const oppRelic = { type: 'relic', ownerId: 'B', card: { id: 'r2', instanceId: 'opp#0', name: 'Theirs', kind: 'relic' } };
    const state = baseState({
      board: { r2c1: dealer, r2c2: ownRelic, r4c1: oppRelic },
      players: { A: player({ effigyDeck: [{ instanceId: 'ed1', effigyType: 'bleeding' }, { instanceId: 'ed2', effigyType: 'bleeding' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c2).toBeUndefined(); // the only legal (own) candidate — auto-resolved
    expect(next.board.r4c1).toEqual(oppRelic); // untouched
  });

  it('offers a real choice among multiple own Relic shapes', () => {
    const relicA = { type: 'relic', ownerId: 'A', card: { id: 'ra', instanceId: 'ra#0', name: 'A', kind: 'relic' } };
    const relicB = { type: 'relic', ownerId: 'A', card: { id: 'rb', instanceId: 'rb#0', name: 'B', kind: 'relic' } };
    const state = baseState({
      board: { r2c1: dealer, r2c2: relicA, r2c3: relicB },
      players: { A: player({ effigyDeck: [{ instanceId: 'ed1', effigyType: 'bleeding' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('sacrifice-relic-cost-target');
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE_RELIC_COST_TARGET', cellId: 'r2c2', armamentInstanceId: null });
    expect(resolved.board.r2c2).toBeUndefined();
    expect(resolved.board.r2c3).toEqual(relicB); // untouched
  });

  it('logs an honest "no Relic to sacrifice" instead of crashing with none available', () => {
    const state = baseState({ board: { r2c1: dealer }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('no Relic'))).toBe(true);
  });
});

describe('MOVE_OR_ATTACK', () => {
  it('deals direct Lifespan damage when the mirrored lane is empty', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 4 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(46);
    expect(next.board.r4c1).toBeUndefined(); // attack doesn't relocate the attacker
    expect(next.board.r2c1.engaged).toBe(true);
  });

  it('a Relic in the lane does not block — damage still goes straight to the opponent, Relic untouched', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 4 }), currentLifespan: 5, engaged: false };
    const relic = { type: 'relic', ownerId: 'B', card: { id: 'r', instanceId: 'r#0', name: 'Dial of Metatoris', kind: 'relic' } };
    const state = baseState({ board: { r2c1: attacker, r4c1: relic }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(46);
    expect(next.board.r4c1).toEqual(relic); // untouched
    expect(next.board.r2c1.engaged).toBe(true);
  });

  it('a freestanding Armament pile in the lane does not block either — same treatment as a Relic', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 4 }), currentLifespan: 5, engaged: false };
    const pile = { type: 'armament-stack', ownerId: 'B', armaments: [equip({ id: 'a', instanceId: 'a#0', name: 'Rusted Rapier', kind: 'relic-armament' })] };
    const state = baseState({ board: { r2c1: attacker, r4c1: pile }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(46);
    expect(next.board.r4c1).toEqual(pile); // untouched
    expect(next.board.r2c1.engaged).toBe(true);
  });

  it('mutual combat damages both sides by the other\'s Strength', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 2, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 3, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.currentLifespan).toBe(10 - 3);
    expect(next.board.r4c1.currentLifespan).toBe(10 - 2);
  });

  it('a dying Being goes to Purgatory and deals its base Lifespan to its own controller', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 1, lifespan: 6 }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r2c1: attacker, r4c1: defender },
      players: { A: player(), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.B.purgatory).toHaveLength(1);
    expect(next.players.B.lifespan).toBe(50 - 6); // base Lifespan, not remaining (3)
    expect(next.board.r2c1.currentLifespan).toBe(9); // attacker took defender's Strength (1)
  });

  it('a dying token Being ceases to exist instead of entering Purgatory', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'def', strength: 1, lifespan: 6, isToken: true }),
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({
      board: { r2c1: attacker, r4c1: defender },
      players: { A: player(), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.B.purgatory).toEqual([]);
    expect(next.players.B.lifespan).toBe(50 - 6); // still takes its base Lifespan as damage
  });

  it('a dying defender with the Depart keyword logs its trigger and really summons the token (Cobra)', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'def', strength: 1, lifespan: 6, keywords: { depart: 'Summon a Snake Skin token on this tile.' } }),
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.log.some(entry => entry.message.includes('Depart triggers'))).toBe(true);
    expect(next.log.some(entry => entry.message.includes('Snake Skin'))).toBe(true);
    // The token really lands on the tile the dying Being just vacated —
    // not refused because that tile still looked occupied at Depart time.
    expect(next.board.r4c1.type).toBe('armament-stack');
    expect(next.board.r4c1.armaments[0].card.name).toBe('Snake Skin');
    expect(next.board.r4c1.armaments[0].card.isToken).toBe(true);
  });

  it('a dying attacker with the Depart keyword logs its trigger too, and really grants the Lifespan', () => {
    const attacker = {
      type: 'being', ownerId: 'A',
      card: beingCard({ strength: 1, lifespan: 6, keywords: { depart: 'Gain 1 Lifespan.' } }),
      currentLifespan: 2, engaged: false,
    };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 5, lifespan: 8 }), currentLifespan: 8, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.log.some(entry => entry.message.includes('Depart triggers'))).toBe(true);
    // Died to the defender's Strength (5), then its own base Lifespan (6)
    // hits A too — but Depart's "Gain 1 Lifespan" still nets 1 back.
    expect(next.players.A.lifespan).toBe(50 - 6 + 1);
  });

  it('a dying Being without the Depart keyword logs no Depart trigger', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 1, lifespan: 6 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.log.some(entry => entry.message.includes('Depart triggers'))).toBe(false);
  });

  it('an attack never relocates the attacker, win or lose', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.board.r2c1.engaged).toBe(true);
  });

  it('a dying attacker is removed from the board, not left behind with stale stats', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 1, lifespan: 6 }), currentLifespan: 2, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 5, lifespan: 8 }), currentLifespan: 8, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.lifespan).toBe(50 - 6); // base Lifespan
    expect(next.board.r4c1.currentLifespan).toBe(7); // defender took the dead attacker's Strength (1)
  });

  it('refuses to move an engaged Being', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: true };
    const state = baseState({ board: { r2c1: attacker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next).toBe(state);
  });

  it('refuses a reposition using a direction the card doesn\'t actually have printed', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 1 });
    expect(next).toBe(state);
  });

  it('attacking is always available from the front row regardless of the card\'s arrows', () => {
    // Card has only a sideways arrow (no forward arrow at all) — attack still works,
    // since arrows only govern repositioning, never attacking.
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 4, arrows: [3] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(46);
  });

  it('refuses an attack from the home row — must reach the front row first', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r1c2: attacker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r1c2', toCellId: 'r2c2', isAttack: true });
    expect(next).toBe(state);
  });

  it('a diagonal or sideways direction never crosses the Ethereal Realm as a reposition', () => {
    // AmaTangi-style card: no straight forward/backward arrow, only diagonals + sideways.
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [2, 3, 7, 8] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker } });
    // direction 2 (forward-right) from r2c1 would naively land on r3c2 (Ethereal Realm) — illegal.
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 2 });
    expect(next).toBe(state);
  });

  it('a sideways direction is a plain, harmless reposition', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: attacker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next.board.r2c3).toEqual({ ...attacker, engaged: true });
    expect(next.board.r2c2).toBeUndefined();
  });

  it('a Favor Counter fully prevents that side\'s combat damage and is consumed', () => {
    const attacker = {
      type: 'being', ownerId: 'A', card: beingCard({ strength: 2, lifespan: 10 }),
      currentLifespan: 10, engaged: false, favorCounter: true,
    };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 3, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.currentLifespan).toBe(10); // fully prevented, not reduced
    expect(next.board.r2c1.favorCounter).toBe(false); // consumed
    expect(next.board.r4c1.currentLifespan).toBe(8); // defender still takes the attacker's Strength
    expect(next.log.some(e => e.message.includes('Favor Counter prevents'))).toBe(true);
  });
});

describe('"Gain (N) Lifespan" / "lose (N) Lifespan" as a resolvable effect', () => {
  it('gains the effect\'s controller Lifespan directly', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ keywords: { engage: 'Gain (3) Lifespan.' } }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.lifespan).toBe(53);
  });

  it('"lose (N) Lifespan" costs the effect\'s controller Lifespan directly, and can end the game', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ keywords: { engage: 'you lose (4) Lifespan.' } }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ lifespan: 4 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.lifespan).toBe(0);
    expect(next.phase).toBe('gameover');
    expect(next.winner).toBe('B');
  });

  it('"take (N) Lifespan Damage" is the same loss, just worded differently (Horological Horror)', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ keywords: { engage: 'you take (5) Lifespan Damage' } }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.lifespan).toBe(45);
  });
});

describe('Thespian: "When this Being dies you lose (4) Lifespan" — aliased to Depart internally', () => {
  it('really costs its own controller the Lifespan when it dies in combat, on top of the normal death-damage', () => {
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const thespian = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Thespian', strength: 1, lifespan: 3, keywords: { depart: 'you lose (4) Lifespan.' } }),
      currentLifespan: 2, engaged: false,
    };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: attacker, r2c1: thespian }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.log.some(e => e.message.includes('Depart triggers'))).toBe(true);
    // Base Lifespan (3) lost to the normal death-damage, plus Depart's own
    // extra (4) — both are real, independent Lifespan losses.
    expect(next.players.A.lifespan).toBe(50 - 3 - 4);
  });
});

describe('PLACE_RELIC', () => {
  const relicCard = (overrides = {}) => ({
    id: 'relic-1', instanceId: 'relic-1#0', name: 'Test Relic', kind: 'relic',
    castingCost: { faithless: 0, colored: {} }, ...overrides,
  });

  it('places a Relic on an empty Mortal Realm cell the player controls', () => {
    const state = baseState({ players: { A: player({ hand: [relicCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic-1#0', cellId: 'r2c1' });
    expect(next.board.r2c1).toEqual({ type: 'relic', ownerId: 'A', card: relicCard() });
    expect(next.players.A.hand).toHaveLength(0);
  });

  it('refuses a cell in the Ethereal Realm', () => {
    const state = baseState({ players: { A: player({ hand: [relicCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic-1#0', cellId: 'r3c1' });
    expect(next).toBe(state);
  });

  it('refuses the reserved Effigy Deck/Zone corner cells', () => {
    const state = baseState({ players: { A: player({ hand: [relicCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic-1#0', cellId: 'r1c1' });
    expect(next).toBe(state);
  });

  it('refuses an already-occupied cell', () => {
    const occupant = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: occupant }, players: { A: player({ hand: [relicCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic-1#0', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  describe('"Beings may move across this" (Shifting Sands) — coexists with a Being or an Armament pile, blocked only by a different ground/plain Relic', () => {
    const movesAcrossCard = (overrides = {}) => ({
      id: 'ss', instanceId: 'ss#0', name: 'Shifting Sands', kind: 'relic',
      castingCost: { faithless: 0, colored: {} }, keywords: { beingsMayMoveAcross: true }, ...overrides,
    });

    it('can be placed on a tile a Being already occupies — both coexist', () => {
      const occupant = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
      const state = baseState({ board: { r2c1: occupant }, players: { A: player({ hand: [movesAcrossCard()] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'PLACE_RELIC' && a.cellId === 'r2c1')).toBe(true);
      const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'ss#0', cellId: 'r2c1' });
      expect(next.board.r2c1).toEqual(occupant); // the Being is untouched
      expect(next.groundRelics.r2c1.card.name).toBe('Shifting Sands');
    });

    it('can be placed on a tile with only an Armament pile (relic-armament) on it', () => {
      const armamentPile = { type: 'armament-stack', ownerId: 'A', armaments: [{ card: { id: 'ds', instanceId: 'ds#0', name: 'Dancing Swords', kind: 'relic-armament', keywords: {} }, engaged: false }] };
      const state = baseState({ board: { r2c1: armamentPile }, players: { A: player({ hand: [movesAcrossCard()] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'PLACE_RELIC' && a.cellId === 'r2c1')).toBe(true);
      const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'ss#0', cellId: 'r2c1' });
      expect(next.board.r2c1).toEqual(armamentPile);
      expect(next.groundRelics.r2c1.card.name).toBe('Shifting Sands');
    });

    it('is still blocked by a DIFFERENT plain (non-Armament) Relic already on the tile', () => {
      const plainRelic = { type: 'relic', ownerId: 'A', card: { id: 'pr', instanceId: 'pr#0', name: 'Plain Relic', kind: 'relic', keywords: {} } };
      const state = baseState({ board: { r2c1: plainRelic }, players: { A: player({ hand: [movesAcrossCard()] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'PLACE_RELIC' && a.cellId === 'r2c1')).toBe(false);
      const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'ss#0', cellId: 'r2c1' });
      expect(next).toBe(state);
    });

    it('is still blocked by a different ground Relic already on the tile', () => {
      const groundRelic = { type: 'relic', ownerId: 'A', card: { id: 'ss2', instanceId: 'ss2#0', name: 'Other Ground Relic', kind: 'relic', keywords: { beingsMayMoveAcross: true } } };
      const state = baseState({ groundRelics: { r2c1: groundRelic }, players: { A: player({ hand: [movesAcrossCard()] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'PLACE_RELIC' && a.cellId === 'r2c1')).toBe(false);
      const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'ss#0', cellId: 'r2c1' });
      expect(next).toBe(state);
    });

    it('a Being can move onto a tile a groundRelic already occupies via a normal arrow move — no Engage/Crossing Counter needed', () => {
      const mover = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
      const groundRelic = { type: 'relic', ownerId: 'A', card: movesAcrossCard(), counters: { crossing: 2 } };
      const state = baseState({ board: { r2c1: mover }, groundRelics: { r2c2: groundRelic }, players: { A: player(), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r2c1' && a.toCellId === 'r2c2')).toBe(true);
      const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 3, isAttack: false });
      expect(next.board.r2c2.type).toBe('being');
      expect(next.board.r2c1).toBeUndefined();
      // The relic stays put, untouched, and still has its Crossing Counters —
      // the move used no Engage ability and spent no counter.
      expect(next.groundRelics.r2c2).toEqual(groundRelic);
    });
  });
});

describe('PLACE_ALTAR', () => {
  const altarCard = (overrides = {}) => ({
    id: 'altar-1', instanceId: 'altar-1#0', name: 'Test Altar', kind: 'altar',
    castingCost: { faithless: 0, colored: {} }, keywords: { craftBonus: 1 }, ...overrides,
  });

  it('adds an Altar to the player\'s own altars pile — not tied to a board cell', () => {
    const state = baseState({ players: { A: player({ hand: [altarCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.altars.A).toEqual([{ card: altarCard() }]);
    expect(next.board).toEqual({}); // no board cell involved at all
    expect(next.players.A.hand).toHaveLength(0);
  });

  it('adds to B\'s own altars pile for player B', () => {
    const state = baseState({ turnPlayer: 'B', players: { A: player(), B: player({ hand: [altarCard()] }) } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.altars.B).toEqual([{ card: altarCard() }]);
  });

  it('a player may control more than one Altar at once — each placement just appends', () => {
    const second = altarCard({ instanceId: 'altar-2#0', name: 'Second Altar' });
    const state = baseState({
      altars: { A: [{ card: altarCard() }], B: [] },
      players: { A: player({ hand: [second] }), B: player() },
    });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-2#0' });
    expect(next.altars.A).toEqual([{ card: altarCard() }, { card: second }]);
  });

  it('getLegalActions offers PLACE_ALTAR with no cellId at all', () => {
    const state = baseState({ players: { A: player({ hand: [altarCard()], effigyPool: [] }), B: player() } });
    const placeActions = getLegalActions(state, 'A').filter(a => a.type === 'PLACE_ALTAR');
    expect(placeActions).toEqual([{ type: 'PLACE_ALTAR', instanceId: 'altar-1#0' }]);
  });

  it('getLegalActions still offers it even when the player already controls other Altars', () => {
    const state = baseState({
      altars: { A: [{ card: altarCard({ instanceId: 'existing#0' }) }], B: [] },
      players: { A: player({ hand: [altarCard()] }), B: player() },
    });
    const placeActions = getLegalActions(state, 'A').filter(a => a.type === 'PLACE_ALTAR');
    expect(placeActions).toHaveLength(1);
  });

  it('grants "When conjured gain (N) <Name> Counters" immediately (e.g. Eònion Altar\'s Time Counters)', () => {
    const eonionAltar = altarCard({
      instanceId: 'eonion#0', name: 'Eònion Altar',
      keywords: { craftBonus: 1, craftBonusCondition: 'zero-time-counters', armamentCounterGrant: { type: 'time', amount: 3 } },
    });
    const state = baseState({ players: { A: player({ hand: [eonionAltar] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'eonion#0' });
    expect(next.altars.A).toEqual([{ card: eonionAltar, counters: { time: 3 } }]);
  });
});

describe('PLACE_ALTAR: "additional cost to Conjure"', () => {
  const altarCard = (overrides = {}) => ({
    id: 'altar-1', instanceId: 'altar-1#0', name: 'Test Altar', kind: 'altar',
    castingCost: { faithless: 0, colored: {} }, keywords: { craftBonus: 1 }, ...overrides,
  });

  it('mills the named count off the deck into Purgatory (e.g. "Kalduran Altar")', () => {
    const deck = [{ instanceId: 'd1' }, { instanceId: 'd2' }, { instanceId: 'd3' }, { instanceId: 'd4' }];
    const card = altarCard({ keywords: { craftBonus: 1, conjureCost: 'send the top (3) cards of your deck to your Purgatory.' } });
    const state = baseState({ players: { A: player({ hand: [card], mainDeck: deck }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.players.A.mainDeck).toEqual([{ instanceId: 'd4' }]);
    expect(next.players.A.purgatory).toEqual([{ instanceId: 'd1' }, { instanceId: 'd2' }, { instanceId: 'd3' }]);
    expect(next.log.some(e => e.message.includes('sends 3 card(s)'))).toBe(true);
  });

  it('mills only what remains when the deck has fewer cards than the count', () => {
    const deck = [{ instanceId: 'd1' }];
    const card = altarCard({ keywords: { craftBonus: 1, conjureCost: 'send the top (3) cards of your deck to your Purgatory.' } });
    const state = baseState({ players: { A: player({ hand: [card], mainDeck: deck }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.players.A.mainDeck).toEqual([]);
    expect(next.players.A.purgatory).toEqual([{ instanceId: 'd1' }]);
  });

  it('discards a random hand card to Purgatory (e.g. "NamKaranian Altar")', () => {
    const filler = { instanceId: 'filler#0', name: 'Filler' };
    const card = altarCard({ keywords: { craftBonus: 1, conjureCost: 'discard a card at random' } });
    const state = baseState({ players: { A: player({ hand: [card, filler] }), B: player() } });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    randomSpy.mockRestore();
    expect(next.players.A.hand).toEqual([]);
    expect(next.players.A.purgatory).toEqual([filler]);
    expect(next.log.some(e => e.message.includes('discards Filler'))).toBe(true);
  });

  it('no-ops the random discard when the hand is otherwise empty', () => {
    const card = altarCard({ keywords: { craftBonus: 1, conjureCost: 'discard a card at random' } });
    const state = baseState({ players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.players.A.hand).toEqual([]);
    expect(next.players.A.purgatory).toEqual([]);
  });

  it('refuses PLACE_ALTAR outright when its damage-to-target cost has no legal target', () => {
    // Unlike mill/discard (which degrade gracefully), a genuine "additional
    // cost" makes the Altar unplaceable without a target — see
    // altarConjureCostPayable, re-checked here directly in the reducer, not
    // just in getLegalActions (the "refuses to offer..." test below).
    const card = altarCard({ keywords: { craftBonus: 1, conjureCost: 'Deal (3) Damage to a Turanga you control.' } });
    const state = baseState({ players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next).toBe(state);
  });
});

describe('"Deal (N) Damage to a <Typing> you control" resolver fallback (shared with Depart/Martyr/Engage)', () => {
  it('logs a "no target" fallback instead of executing when no matching Being is controlled', () => {
    // Exercised via ACTIVATE_ENGAGE rather than PLACE_ALTAR, since Altars
    // gate this cost's legality up front (see above) — Engage has no such
    // pre-check, so this is the resolver's genuine fallback path.
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Deal (3) Damage to a Turanga you control.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('has no Turanga') && e.message.includes('to target'))).toBe(true);
  });
});

describe('PLACE_ALTAR: "Deal (N) Damage to a <Typing> you control" (e.g. "Rhak-tùrin Altar")', () => {
  const altarCard = (overrides = {}) => ({
    id: 'altar-1', instanceId: 'altar-1#0', name: 'Rhak-tùrin Altar', kind: 'altar',
    castingCost: { faithless: 0, colored: {} }, keywords: { craftBonus: 1, conjureCost: 'Deal (3) Damage to a Turanga you control.' }, ...overrides,
  });
  const turanga = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: `turanga-${Math.random()}`, typing: 'Turanga, Being', lifespan: 5 }),
    currentLifespan: 5, engaged: false, ...overrides,
  });

  it('deals damage directly when exactly one Turanga is controlled', () => {
    const being = turanga();
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [altarCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.board.r2c1.currentLifespan).toBe(2); // 5 - 3
    expect(next.log.some(e => e.message.includes('deals 3 damage to Test Being'))).toBe(true);
  });

  it('kills the Turanga and deals its owner death-damage when the damage is lethal', () => {
    const being = turanga({ currentLifespan: 2 });
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [altarCard()], lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory).toHaveLength(1);
    expect(next.players.A.lifespan).toBe(45); // 50 - base Lifespan (5)
  });

  it('parks a pendingChoice when more than one Turanga is controlled', () => {
    const first = turanga({ card: beingCard({ instanceId: 'turanga-1', name: 'First', typing: 'Turanga, Being' }) });
    const second = turanga({ card: beingCard({ instanceId: 'turanga-2', name: 'Second', typing: 'Turanga, Being' }) });
    const state = baseState({ board: { r2c1: first, r2c2: second }, players: { A: player({ hand: [altarCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_ALTAR', instanceId: 'altar-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'damage-target', playerId: 'A', cardName: 'Rhak-tùrin Altar', damage: 3, typing: 'Turanga' });
    expect(next.board.r2c1.currentLifespan).toBe(5); // untouched until resolved
  });

  it('getLegalActions offers RESOLVE_DAMAGE_TARGET only for the player\'s own matching Beings', () => {
    const mine = turanga({ card: beingCard({ instanceId: 'turanga-1', typing: 'Turanga, Being' }) });
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'turanga-2', name: 'Their Turanga', typing: 'Turanga, Being' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      pendingChoice: { kind: 'damage-target', playerId: 'A', cardName: 'Rhak-tùrin Altar', damage: 3, typing: 'Turanga' },
    });
    const resolveActions = getLegalActions(state, 'A').filter(a => a.type === 'RESOLVE_DAMAGE_TARGET');
    expect(resolveActions).toEqual([{ type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r2c1' }]);
  });

  it('RESOLVE_DAMAGE_TARGET applies the damage and clears the pendingChoice', () => {
    const being = turanga({ currentLifespan: 5 });
    const state = baseState({
      board: { r2c1: being },
      pendingChoice: { kind: 'damage-target', playerId: 'A', cardName: 'Rhak-tùrin Altar', damage: 3, typing: 'Turanga' },
    });
    const next = gameReducer(state, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r2c1' });
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r2c1.currentLifespan).toBe(2);
  });

  it('refuses to offer PLACE_ALTAR at all when the player controls no Turanga', () => {
    const state = baseState({ players: { A: player({ hand: [altarCard()] }), B: player() } });
    const placeActions = getLegalActions(state, 'A').filter(a => a.type === 'PLACE_ALTAR');
    expect(placeActions).toEqual([]);
  });
});

describe('ATTACH_ARMAMENT', () => {
  const armamentCard = (overrides = {}) => ({
    id: 'arm-1', instanceId: 'arm-1#0', name: 'Test Armament', kind: 'relic-armament',
    castingCost: { faithless: 0, colored: {} }, ...overrides,
  });

  it('attaches to a Being the player controls, stacking onto its cell', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [armamentCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r2c1' });
    expect(next.board.r2c1.type).toBe('being');
    expect(next.board.r2c1.armaments).toEqual([equip(armamentCard())]);
    expect(next.players.A.hand).toHaveLength(0);
  });

  it('stacks a second Armament on top of the first rather than replacing it', () => {
    const first = armamentCard();
    const being = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false, armaments: [equip(first)] };
    const second = armamentCard({ instanceId: 'arm-2#0', name: 'Second Armament' });
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [second] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-2#0', cellId: 'r2c1' });
    expect(next.board.r2c1.armaments).toEqual([equip(first), equip(second)]);
  });

  it('refuses to attach to an opponent\'s Being', () => {
    const being = { type: 'being', ownerId: 'B', card: beingCard(), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r4c1: being }, players: { A: player({ hand: [armamentCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r4c1' });
    expect(next).toBe(state);
  });

  it('plays onto an empty cell the player controls, creating a freestanding stack', () => {
    const state = baseState({ players: { A: player({ hand: [armamentCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r2c1' });
    expect(next.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [equip(armamentCard())] });
    expect(next.players.A.hand).toHaveLength(0);
  });

  it('stacks onto an existing freestanding Armament pile the player owns', () => {
    const first = armamentCard();
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(first)] };
    const second = armamentCard({ instanceId: 'arm-2#0', name: 'Second Armament' });
    const state = baseState({ board: { r2c1: pile }, players: { A: player({ hand: [second] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-2#0', cellId: 'r2c1' });
    expect(next.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [equip(first), equip(second)] });
  });

  it('refuses to play onto a cell outside the Mortal Realm the player controls', () => {
    const state = baseState({ players: { A: player({ hand: [armamentCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r3c1' });
    expect(next).toBe(state);
  });

  it('refuses to play onto an opponent\'s freestanding Armament pile', () => {
    const pile = { type: 'armament-stack', ownerId: 'B', armaments: [equip(armamentCard({ instanceId: 'other#0' }))] };
    const state = baseState({ board: { r4c1: pile }, players: { A: player({ hand: [armamentCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r4c1' });
    expect(next).toBe(state);
  });
});

describe('Armament stat bonuses ("Being gains +N/+N")', () => {
  const boostCard = (strength, lifespan, overrides = {}) => ({
    id: 'arm-1', instanceId: 'arm-1#0', name: 'Rusted Rapier', kind: 'relic-armament',
    castingCost: { faithless: 0, colored: {} }, keywords: { statBonus: { strength, lifespan } }, ...overrides,
  });

  it('heals currentLifespan immediately when attaching to an existing Being (e.g. "Snake Skin": +0/+2)', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ lifespan: 5 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [boostCard(0, 2)] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r2c1' });
    expect(next.board.r2c1.currentLifespan).toBe(5); // 3 + 2
    expect(next.board.r2c1.armaments).toEqual([equip(boostCard(0, 2))]);
  });

  it('does not touch currentLifespan when attaching to an empty cell (no Being yet to boost)', () => {
    const state = baseState({ players: { A: player({ hand: [boostCard(0, 2)] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r2c1' });
    expect(next.board.r2c1.type).toBe('armament-stack');
  });

  it('kills the Being immediately if a negative Lifespan bonus is lethal (e.g. "Gargantuan hammer": +6/-3)', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ lifespan: 5 }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ hand: [boostCard(6, -3)], lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'arm-1#0', cellId: 'r2c1' });
    // Dies from its own lethal Lifespan penalty — the Armament that killed
    // it still stays behind as a freestanding pile, same as any other death.
    expect(next.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [equip(boostCard(6, -3))] });
    expect(next.players.A.purgatory).toHaveLength(1);
    expect(next.players.A.lifespan).toBe(45); // 50 - base Lifespan (5), same death pipeline as combat
  });

  it('applies a picked-up pile\'s Lifespan bonus when a Being is summoned onto it', () => {
    const summonCard = beingCard({ lifespan: 3, castingCost: { faithless: 0, colored: {} } });
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(boostCard(1, 2))] };
    const state = baseState({ board: { r1c2: pile }, players: { A: player({ hand: [summonCard] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: summonCard.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.currentLifespan).toBe(5); // 3 + 2
  });

  it('applies a picked-up pile\'s Lifespan bonus when a Being moves onto it, on top of what it already carries', () => {
    const existingArmament = boostCard(0, 1, { instanceId: 'existing#0' });
    const being = {
      type: 'being', ownerId: 'A', card: beingCard({ lifespan: 4, arrows: [3] }),
      currentLifespan: 5, engaged: false, armaments: [equip(existingArmament)],
    };
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(boostCard(0, 2))] };
    const state = baseState({ board: { r2c1: being, r2c2: pile }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r2c2', direction: 3, isAttack: false });
    expect(next.board.r2c2.currentLifespan).toBe(7); // 5 (already boosted) + 2 (newly picked up), not re-derived from base
    expect(next.board.r2c2.armaments).toEqual([equip(existingArmament), equip(boostCard(0, 2))]);
  });
});

describe('Armaments picked up by a Being (summon or move) and left behind on death', () => {
  const armamentCard = (overrides = {}) => ({
    id: 'arm-1', instanceId: 'arm-1#0', name: 'Test Armament', kind: 'relic-armament',
    castingCost: { faithless: 0, colored: {} }, ...overrides,
  });
  const pile = (owner = 'A') => ({ type: 'armament-stack', ownerId: owner, armaments: [equip(armamentCard())] });

  it('SUMMON_BEING onto a freestanding pile of the player\'s own picks it up', () => {
    const summonCard = beingCard({ castingCost: { faithless: 0, colored: {} } });
    const state = baseState({ board: { r1c2: pile() }, players: { A: player({ hand: [summonCard] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: summonCard.instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.type).toBe('being');
    expect(next.board.r1c2.armaments).toEqual([equip(armamentCard())]);
  });

  it('SUMMON_BEING refuses a cell already holding another Being', () => {
    const occupied = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
    const summonCard = beingCard({ castingCost: { faithless: 0, colored: {} } });
    const state = baseState({ board: { r1c2: occupied }, players: { A: player({ hand: [summonCard] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: summonCard.instanceId, cellId: 'r1c2' });
    expect(next).toBe(state);
  });

  it('a normal move carries the Being\'s own Armaments along with it', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false, armaments: [equip(armamentCard())] };
    const state = baseState({ board: { r2c2: being } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next.board.r2c3.armaments).toEqual([equip(armamentCard())]);
    expect(next.board.r2c2).toBeUndefined();
  });

  it('moving onto a freestanding pile picks it up, merging with any Armaments already carried', () => {
    const carried = armamentCard({ instanceId: 'carried#0', name: 'Carried' });
    const being = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false, armaments: [equip(carried)] };
    const state = baseState({ board: { r2c2: being, r2c3: pile() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next.board.r2c3.armaments).toEqual([equip(carried), equip(armamentCard())]);
  });

  it('refuses to move onto a cell occupied by anything other than the player\'s own Armament pile', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const blocker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'blocker#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: being, r2c3: blocker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next).toBe(state);
  });

  it('a Being that dies in combat leaves its Armaments behind as a freestanding pile', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 1, lifespan: 6 }), currentLifespan: 2, engaged: false, armaments: [equip(armamentCard())] };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 5, lifespan: 8 }), currentLifespan: 8, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [equip(armamentCard())] });
  });

  it('a Being sacrificed for Martyr leaves its Armaments behind too', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { martyr: 'Deal 2 damage to target Being.' } }),
      currentLifespan: 5, engaged: false, armaments: [equip(armamentCard())],
    };
    const state = baseState({ board: { r2c1: being }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [equip(armamentCard())] });
  });

  it('a Being that dies with no Armaments still just clears the cell', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 1, lifespan: 6 }), currentLifespan: 2, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 5, lifespan: 8 }), currentLifespan: 8, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1).toBeUndefined();
  });
});

describe('Dryad — "This Being may move onto another Being with the TreeFolk, Vine, or Seed typing. This has that Being\'s Strength and Lifespan while attached."', () => {
  const dryadBeing = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: 'dryad#0', name: 'Dryad', typing: 'TreeFolk, Being', strength: 1, lifespan: 3, arrows: [3], keywords: { dryad: true } }),
    currentLifespan: 3, engaged: false, ...overrides,
  });
  const seedBeing = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: 'seed#0', name: 'Seed of Divinity', typing: 'Seed, Being', strength: 0, lifespan: 1 }),
    currentLifespan: 1, engaged: false, ...overrides,
  });

  it('attaches onto its own Seed, gaining its Strength live and its current Lifespan as an immediate heal', () => {
    const state = baseState({ board: { r2c1: dryadBeing(), r2c2: seedBeing() }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 3, isAttack: false });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.board.r2c2.type).toBe('being');
    expect(next.board.r2c2.card.name).toBe('Dryad');
    expect(next.board.r2c2.dryadAttached.card.name).toBe('Seed of Divinity');
    expect(next.board.r2c2.currentLifespan).toBe(4); // 3 + 1 (mount's current Lifespan, healed once on attach)
  });

  it('reads the attached mount\'s Strength live in combat, on top of its own', () => {
    const state = baseState({
      board: {
        r2c1: { ...dryadBeing(), dryadAttached: { card: seedBeing().card, currentLifespan: 1, engaged: false } },
        r4c1: { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 0, lifespan: 10 }), currentLifespan: 10, engaged: false },
      },
      players: { A: player(), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    // Dryad's own 1 Strength (from dryadBeing()'s card) + Seed's 0 Strength = 1 damage to the defender.
    expect(next.board.r4c1.currentLifespan).toBe(9);
  });

  it('does not offer attaching onto a non-TreeFolk/Vine/Seed Being', () => {
    const nonSeed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ns#0', typing: 'Demon, Being' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: dryadBeing(), r2c2: nonSeed }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 3, isAttack: false });
    expect(next).toBe(state);
  });

  it('does not offer attaching onto an opponent\'s own matching Being', () => {
    const state = baseState({ board: { r2c1: dryadBeing(), r2c2: { ...seedBeing(), ownerId: 'B' } }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 3, isAttack: false });
    expect(next).toBe(state);
  });

  it('getLegalActions actually offers the attach move — the reducer already allowed it, but the UI never surfaced an occupied-but-eligible tile as a legal destination', () => {
    const state = baseState({ board: { r2c1: dryadBeing(), r2c2: seedBeing() }, players: { A: player(), B: player() } });
    const legal = getLegalActions(state, 'A');
    expect(legal).toContainEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r2c2', direction: 3, isAttack: false });
  });

  it('getLegalActions does not offer a SECOND attach once the Dryad is already carrying a mount', () => {
    const carrying = { ...dryadBeing(), card: { ...dryadBeing().card, arrows: [3] }, dryadAttached: { card: seedBeing().card, currentLifespan: 1, engaged: false } };
    const anotherSeed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'seed2#0', typing: 'Seed, Being' }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: carrying, r2c2: anotherSeed }, players: { A: player(), B: player() } });
    const legal = getLegalActions(state, 'A');
    expect(legal).not.toContainEqual(expect.objectContaining({ fromCellId: 'r2c1', toCellId: 'r2c2' }));
  });

  it('leaves the attached mount behind on the origin tile when it moves away again (a mount is a shared tile position, not worn equipment)', () => {
    const carrying = { ...dryadBeing(), card: { ...dryadBeing().card, arrows: [3] }, dryadAttached: { card: seedBeing().card, currentLifespan: 1, engaged: false } };
    const state = baseState({ board: { r2c1: carrying }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 3, isAttack: false });
    expect(next.board.r2c1.type).toBe('being');
    expect(next.board.r2c1.card.name).toBe('Seed of Divinity');
    expect(next.board.r2c1.dryadAttached).toBeUndefined();
    // The left-behind mount is not itself moving — only the Dryad-attached
    // Being riding it is — so it stays exactly as Engaged/Disengaged as it
    // was stashed at attach time (`dryadAttached.engaged`, captured here
    // as `false`), same as an Animated Armament pile dying leaves the next
    // entry down in whatever state it was already in, rather than
    // suddenly becoming Engaged just because the thing on top of it moved.
    expect(next.board.r2c1.engaged).toBe(false);
    expect(next.board.r2c2.card.name).toBe('Dryad');
    expect(next.board.r2c2.dryadAttached).toBeUndefined();
  });

  it('drops the mount back onto the tile, unharmed, when the Dryad dies in combat', () => {
    const carrying = {
      type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dryad#0', name: 'Dryad', strength: 0, lifespan: 1 }),
      currentLifespan: 1, engaged: false, dryadAttached: { card: seedBeing().card, currentLifespan: 1, engaged: true },
    };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: carrying, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.type).toBe('being');
    expect(next.board.r2c1.card.name).toBe('Seed of Divinity');
    expect(next.board.r2c1.dryadAttached).toBeUndefined();
    expect(next.board.r2c1.currentLifespan).toBe(1);
  });

  it('drops the mount back when the Dryad is Martyred', () => {
    const carrying = {
      type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dryad#0', name: 'Dryad', keywords: { martyr: 'Draw (1) card.' } }),
      currentLifespan: 3, engaged: false, dryadAttached: { card: seedBeing().card, currentLifespan: 1, engaged: false },
    };
    const state = baseState({ board: { r2c1: carrying }, players: { A: player({ mainDeck: [beingCard({ instanceId: 'draw#0' })] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.board.r2c1.card.name).toBe('Seed of Divinity');
  });

  it('Sporangium\'s "When a Being with Dryad moves onto this" reaction summons a Vine on a tile it points to', () => {
    const sporangium = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'spor#0', name: 'Sporangium', typing: 'Seed, Being', strength: 0, lifespan: 1, arrows: [3], keywords: { onDryadAttachedOnto: 'summon a 0/2 Vine token on a tile this points to.' } }),
      currentLifespan: 1, engaged: false,
    };
    const state = baseState({ board: { r2c1: dryadBeing(), r2c2: sporangium }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', direction: 3, isAttack: false });
    const vineCells = Object.entries(next.board).filter(([, o]) => o?.card?.name === 'Vine');
    expect(vineCells).toHaveLength(1);
  });

  it('a freshly-summoned Being\'s own When Summoned still schedules (not silently dropped) even when landing directly onto Sporangium leaves ITS OWN pendingChoice open', () => {
    // Two arrows -> two empty candidate tiles, so Sporangium's own
    // "summon a Vine on a tile this points to" opens a real pendingChoice
    // instead of auto-resolving the way the single-arrow test above does
    // — this is the shape that actually exposes the bug (Jirahperā's own
    // trigger being dropped only ever happens once Sporangium's reaction
    // leaves a real pendingChoice in place).
    const sporangium = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'spor#0', name: 'Sporangium', typing: 'Seed, Being', strength: 0, lifespan: 1, arrows: [3, 4], keywords: { onDryadAttachedOnto: 'summon a 0/2 Vine token on a tile this points to.' } }),
      currentLifespan: 1, engaged: false,
    };
    const jirahpera = beingCard({
      instanceId: 'jp#0', name: 'Jirahperā', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: {} },
      keywords: { dryad: true, whenSummoned: 'you may summon (2) 0/2 Vine tokens on tiles Jirahperā points to.' },
    });
    const state = baseState({ board: { r2c2: sporangium }, players: { A: player({ hand: [jirahpera], effigyPool: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'jp#0', cellId: 'r2c2' });
    expect(next.board.r2c2.card.name).toBe('Jirahperā');
    expect(next.board.r2c2.dryadAttached.card.name).toBe('Sporangium');
    // Sporangium's own reaction still opens its own choice...
    expect(next.pendingChoice?.kind).toBe('summon-token-pointed');
    // ...and Jirahperā's own When Summoned is NOT silently dropped just
    // because that choice is still open — it schedules alongside it.
    expect(next.pendingResolution).toMatchObject({ kind: 'summon-being', cardName: 'Jirahperā' });
  });
});

describe('Shift — "Engage: Move this onto a tile in the Ethereal Realm, it becomes a Prophecy..." (RULES.md > Keywords > Shift)', () => {
  const shade = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'shade#0', name: 'Shifting Shade', typing: 'Spirit, Being', keywords: { shift: { amount: 1, effect: null } } }), currentLifespan: 5, engaged: false };

  it('is offered for a disengaged Being with Shift, not for an engaged one', () => {
    const state = baseState({ board: { r2c1: shade }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SHIFT' && a.cellId === 'r2c1')).toBe(true);
    const engagedState = baseState({ board: { r2c1: { ...shade, engaged: true } }, players: { A: player(), B: player() } });
    expect(getLegalActions(engagedState, 'A').some(a => a.type === 'ACTIVATE_SHIFT')).toBe(false);
  });

  it('is not offered with the Ethereal Realm completely full — self-play found this staying "legal" forever otherwise, an AI infinite loop', () => {
    const fullEthereal = ['r3c1', 'r3c2', 'r3c3', 'r3c4', 'r3c5'].reduce((board, cell, i) => {
      board[cell] = { type: 'prophecy', ownerId: 'A', card: { name: `Filler ${i}` }, timer: 1, faceDown: true };
      return board;
    }, { r2c1: shade });
    const state = baseState({ board: fullEthereal, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SHIFT')).toBe(false);
    // Even a direct dispatch stays a graceful no-op, matching the offer.
    const next = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r2c1' });
    expect(next.board.r2c1).toEqual(shade); // untouched — still a Being, never shifted
    expect(next.log.some(e => e.message.includes('has no empty tile in the Ethereal Realm'))).toBe(true);
  });

  it('offers a choice among the 5 empty Ethereal Realm tiles, and becomes a stripped-down face-up Prophecy on the chosen one', () => {
    const state = baseState({ board: { r2c1: shade }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r2c1' });
    expect(opened.pendingChoice.kind).toBe('shift-destination');
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_SHIFT_DESTINATION');
    expect(options.map(o => o.cellId).sort()).toEqual(['r3c1', 'r3c2', 'r3c3', 'r3c4', 'r3c5']);
    const resolved = gameReducer(opened, options.find(o => o.cellId === 'r3c3'));
    expect(resolved.board.r2c1).toBeUndefined();
    const shifted = resolved.board.r3c3;
    expect(shifted).toMatchObject({ type: 'prophecy', ownerId: 'A', timer: 1, faceDown: false });
    expect(shifted.card.name).toBe('Shifting Shade'); // keeps its name
    expect(shifted.card.keywords.shift).toBe(null); // loses all other text (bare Shift, no quote — nothing left active)
    expect(shifted.shiftedFromCard.card?.strength ?? shifted.shiftedFromCard.strength).toBe(shade.card.strength); // original stashed for return
  });

  it('leaves equipped Armaments behind on the origin tile when it Shifts, same as any other way a Being leaves the board', () => {
    const armamentCard = { id: 'arm', instanceId: 'arm#0', name: 'Test Armament', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, keywords: {} };
    const carrying = { ...shade, armaments: [{ card: armamentCard, engaged: false }] };
    const state = baseState({ board: { r2c1: carrying }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r2c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_SHIFT_DESTINATION', cellId: 'r3c1' });
    expect(resolved.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [{ card: armamentCard, engaged: false }] });
  });

  it('auto-places (single empty tile) directly within the same beginTurn call, landing Disengaged by the time it returns — the one real path where the normal turn.js > disengage() step still catches it naturally, same final result as every other path', () => {
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id, strength: 0, lifespan: 1 }), currentLifespan: 1, engaged: false });
    const shifted = { type: 'prophecy', ownerId: 'A', card: { ...shade.card, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: shade.card };
    const state = baseState({
      board: {
        r3c1: shifted,
        r1c2: filler('f1#0'), r1c3: filler('f2#0'), r1c4: filler('f3#0'),
        r2c1: filler('f4#0'), r2c2: filler('f5#0'), r2c3: filler('f6#0'), r2c4: filler('f7#0'),
      },
      turnPlayer: 'A', players: { A: player(), B: player() },
    });
    const next = beginTurn(state); // ticks to 0, auto-places on the sole empty tile (r2c5), all within this one call
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r2c5).toMatchObject({ type: 'being', ownerId: 'A', engaged: false, currentLifespan: shade.card.lifespan });
  });

  it('returns to an empty Mortal Realm tile at full printed Lifespan once its Time Counters hit 0 — offering a choice among multiple candidates, then immediately Disengaging since that turn\'s own Disengage step already passed by the time the choice is resolved', () => {
    const shifted = { type: 'prophecy', ownerId: 'A', card: { ...shade.card, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: shade.card };
    const state = baseState({ board: { r3c1: shifted }, turnPlayer: 'A', players: { A: player(), B: player() } });
    const next = beginTurn(state); // the automatic per-turn tick: 1 -> 0
    // Still sitting at timer 0 as a Prophecy until the player actually
    // picks a landing tile — the pendingChoice below is what's waiting.
    expect(next.board.r3c1).toMatchObject({ type: 'prophecy', timer: 0 });
    expect(next.pendingChoice.kind).toBe('shift-return');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SHIFT_RETURN');
    expect(options.length).toBeGreaterThan(1);
    const resolved = gameReducer(next, options[0]);
    expect(resolved.board.r3c1).toBeUndefined();
    const landed = resolved.board[options[0].cellId];
    expect(landed).toMatchObject({ type: 'being', ownerId: 'A', engaged: false, currentLifespan: shade.card.lifespan });
    expect(landed.card.keywords.shift).toBeTruthy(); // gets its real card back, not the stripped Prophecy-form one
    expect(resolved.players.A.purgatory).toHaveLength(0);
  });

  it('enforces the legend rule when a returning Shifted Deity would duplicate a same-named Deity already on the board', () => {
    const deityCard = { ...shade.card, isDeity: true, name: 'Test Deity' };
    const shifted = { type: 'prophecy', ownerId: 'A', card: { ...deityCard, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: deityCard };
    const existingCopy = { type: 'being', ownerId: 'A', card: deityCard, currentLifespan: 3, engaged: false };
    // Fill every other Mortal Realm tile of A's so the return auto-places
    // immediately (single empty tile) instead of opening a shift-return
    // tile choice first — isolates the legend-rule check itself.
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id, strength: 0, lifespan: 1 }), currentLifespan: 1, engaged: false });
    const state = baseState({
      board: {
        r3c1: shifted, r2c1: existingCopy,
        r1c2: filler('f1#0'), r1c3: filler('f2#0'), r1c4: filler('f3#0'),
        r2c2: filler('f4#0'), r2c3: filler('f5#0'), r2c4: filler('f6#0'),
      },
      turnPlayer: 'A', players: { A: player(), B: player() },
    });
    const next = beginTurn(state); // ticks to 0, auto-places on the one remaining empty tile (r2c5)
    expect(next.board.r2c5).toMatchObject({ type: 'being', card: { name: 'Test Deity' } });
    expect(next.pendingChoice?.kind).toBe('legend-rule-keep');
    expect(next.pendingChoice.deityName).toBe('Test Deity');
  });
});

describe('Shift — Scā-vuhk Hunger\'s own quoted "At the end of your turn remove (1) Time Counter from this" and "When this moves into the Mortal Realm" reaction', () => {
  const originalCard = beingCard({
    instanceId: 'sv#0', name: 'Scā-vuhk Hunger', typing: 'Hunger, Being',
    keywords: {
      shift: { amount: 1, effect: 'At the end of your turn remove (1) Time Counter from this' },
      onMovedIntoMortalRealm: 'Draw (1) card.',
    },
  });
  const shiftedCard = { ...originalCard, textBox: 'At the end of your turn remove (1) Time Counter from this', typing: '', keywords: { endOfTurnRemoveOwnTimeCounters: 1 } };

  it('parses its quoted Shift text into the shifted form\'s own self-decay ability on activation', () => {
    const being = { type: 'being', ownerId: 'A', card: originalCard, currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r2c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_SHIFT_DESTINATION', cellId: 'r3c1' });
    expect(resolved.board.r3c1.card.keywords.endOfTurnRemoveOwnTimeCounters).toBe(1);
  });

  it('removes a Time Counter at the end of its controller\'s turn, and once it hits 0, returns and fires its own "moves into the Mortal Realm" reaction', () => {
    // Fill every Mortal Realm tile of A's except one so the return auto-places.
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id, strength: 0, lifespan: 1 }), currentLifespan: 1, engaged: false });
    const state = baseState({
      turnPlayer: 'A',
      board: {
        r3c1: { type: 'prophecy', ownerId: 'A', card: shiftedCard, timer: 1, faceDown: false, shiftedFromCard: originalCard },
        r1c2: filler('f1#0'), r1c3: filler('f2#0'), r1c4: filler('f3#0'),
        r2c1: filler('f4#0'), r2c2: filler('f5#0'), r2c3: filler('f6#0'), r2c4: filler('f7#0'),
      },
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'draw#0' })] }), B: player() },
    });
    const next = endTurn(state);
    expect(next.log.some(e => e.message.includes('loses 1 Time Counter'))).toBe(true);
    expect(next.board.r3c1).toBeUndefined();
    const returned = next.board.r2c5;
    // Lands Engaged per its own printed text, but this is an End Phase
    // decay tick — that turn's own Disengage step already ran at its
    // start, so it's immediately Disengaged again rather than sitting
    // Engaged for a whole extra turn (see placeReturnedFromShift).
    expect(returned).toMatchObject({ type: 'being', ownerId: 'A', engaged: false });
    // onMovedIntoMortalRealm: "Draw (1) card." really drew.
    expect(next.players.A.hand).toHaveLength(1);
  });

  it('its own REAL printed reaction — "sacrifice this and create (2) Scā-vuhk Hunger tokens" — tolerates "create" (not just "summon") and the "and" connector left after SACRIFICE_THIS_THEN_RE\'s own capture, and lets the player choose where each token lands', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'sv#0', name: 'Scā-vuhk Hunger' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: being }, players: { A: player(), B: player() } });
    const opened = resolveOrLogEffect(
      state, 'A', 'Scā-vuhk Hunger',
      'sacrifice this and create (2) Scā-vuhk Hunger tokens.',
      'Reaction', { selfCellId: 'r2c1' }
    );
    expect(opened.board.r2c1).toBeUndefined(); // the original sacrificed itself
    // Nothing is auto-placed — the player picks each of the 2 tiles.
    expect(opened.pendingChoice).toMatchObject({ kind: 'token-location', tokenName: 'scā-vuhk hunger', remaining: 2 });
    expect(getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_TOKEN_LOCATION').length).toBeGreaterThan(1);

    const afterFirst = gameReducer(opened, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c2' });
    expect(afterFirst.board.r1c2.card.name).toBe('Scā-vuhk Hunger');
    // The choice reopens for the second token instead of clearing.
    expect(afterFirst.pendingChoice).toMatchObject({ kind: 'token-location', tokenName: 'scā-vuhk hunger', remaining: 1 });

    const afterSecond = gameReducer(afterFirst, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c3' });
    expect(afterSecond.board.r1c3.card.name).toBe('Scā-vuhk Hunger');
    expect(afterSecond.pendingChoice).toBeNull();

    const tokenCells = Object.entries(afterSecond.board).filter(([, o]) => o?.card?.name === 'Scā-vuhk Hunger');
    expect(tokenCells).toHaveLength(2);
    tokenCells.forEach(([, o]) => expect(o.card.isToken).toBe(true));
  });
});

describe('Shift — "Whenever a Being you control Shifts, X" (Sanative Siphon\'s first clause, Thōgrakin Hunger)', () => {
  const siphon = { type: 'relic', ownerId: 'A', card: { id: 'sanative', instanceId: 'sanative#0', name: 'Sanative Siphon', kind: 'relic', keywords: { onOwnBeingShift: { effect: 'Gain (1) Crossing Counter', exceptEndStep: false } } } };
  const shade = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'shade#0', name: 'Shifting Shade', keywords: { shift: { amount: 1, effect: null } } }), currentLifespan: 5, engaged: false };

  it('gains a Crossing Counter the instant any of its controller\'s Beings Shifts', () => {
    const state = baseState({ board: { r2c1: shade, r2c2: siphon }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r2c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_SHIFT_DESTINATION', cellId: 'r3c1' });
    expect(resolved.board.r2c2.counters).toEqual({ crossing: 1 });
  });

  it('does not trigger for the opponent\'s own Being Shifting', () => {
    const oppShade = { ...shade, ownerId: 'B', card: { ...shade.card, instanceId: 'shade2#0' } };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: oppShade, r2c2: siphon }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r4c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_SHIFT_DESTINATION', cellId: 'r3c1' });
    expect(resolved.board.r2c2.counters).toBeUndefined();
  });

  it('Thōgrakin Hunger\'s own "except during the end step" reaction still fires for a normal, player-activated Shift', () => {
    const thograkin = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'thog#0', name: 'Thōgrakin Hunger', keywords: { onOwnBeingShift: { effect: 'add (1) Formless Essence', exceptEndStep: true } } }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: shade, r2c3: thograkin }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_SHIFT', cellId: 'r2c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_SHIFT_DESTINATION', cellId: 'r3c1' });
    expect(resolved.players.A.effigyPool.filter(e => e.effigyType === 'formless')).toHaveLength(1);
  });
});

describe('Shift — Ounati Hunger\'s own bare "Shift (1)." and "When this moves into the Mortal Realm give a different Hunger you control +1/+1"', () => {
  const ounati = (id = 'ounati#0') => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: id, name: 'Ounati Hunger', typing: 'Hunger, Being', keywords: { shift: { amount: 1, effect: null }, onMovedIntoMortalRealm: 'give a different Hunger you control +1/+1.' } }),
    currentLifespan: 2, engaged: false,
  });

  it('buffs a different Hunger it controls +1/+1 when it returns to the Mortal Realm', () => {
    const otherHunger = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'oh#0', name: 'Other Hunger', typing: 'Hunger, Being', strength: 1, lifespan: 2 }), currentLifespan: 2, engaged: false };
    const shifted = { type: 'prophecy', ownerId: 'A', card: { ...ounati().card, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: ounati().card };
    const state = baseState({ turnPlayer: 'A', board: { r3c1: shifted, r2c1: otherHunger }, players: { A: player(), B: player() } });
    const next = beginTurn(state); // automatic tick 1 -> 0, only 1 empty Ethereal-adjacent... wait Mortal Realm has many empty cells
    // Multiple empty Mortal Realm cells exist, so this opens a choice — resolve it.
    expect(next.pendingChoice.kind).toBe('shift-return');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SHIFT_RETURN');
    const resolved = gameReducer(next, options[0]);
    expect(resolved.board.r2c1.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
  });

  it('does not buff itself (it is not "a different Hunger")', () => {
    const shifted = { type: 'prophecy', ownerId: 'A', card: { ...ounati().card, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: ounati().card };
    const state = baseState({ turnPlayer: 'A', board: { r3c1: shifted }, players: { A: player(), B: player() } });
    const next = beginTurn(state);
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SHIFT_RETURN');
    const resolved = gameReducer(next, options[0]);
    const returned = resolved.board[options[0].cellId];
    expect(returned.permanentBonus).toBeUndefined();
  });

  it('two Ounati Hunger returning in the same tick both actually land — the second isn\'t left stuck behind the first\'s own multi-tile choice', () => {
    // Exactly 2 empty Mortal Realm tiles for A (r2c4, r2c5) — enough for
    // the first return to need a real choice, and for the retry to then
    // auto-place the second on whatever's left.
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id, strength: 0, lifespan: 1 }), currentLifespan: 1, engaged: false });
    const shiftedOunati = (id) => ({ type: 'prophecy', ownerId: 'A', card: { ...ounati(id).card, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: ounati(id).card });
    const state = baseState({
      turnPlayer: 'A',
      board: {
        r3c1: shiftedOunati('ou1#0'), r3c2: shiftedOunati('ou2#0'),
        r1c2: filler('f1#0'), r1c3: filler('f2#0'), r1c4: filler('f3#0'),
        r2c1: filler('f4#0'), r2c2: filler('f5#0'), r2c3: filler('f6#0'),
      },
      players: { A: player(), B: player() },
    });
    const afterTick = beginTurn(state); // both tick 1 -> 0 in the same modulate() pass
    expect(afterTick.pendingChoice?.kind).toBe('shift-return'); // the first one's choice
    const firstOptions = getLegalActions(afterTick, 'A').filter(a => a.type === 'RESOLVE_SHIFT_RETURN');
    expect(firstOptions.length).toBeGreaterThan(1);
    const afterFirst = gameReducer(afterTick, firstOptions[0]);
    // The retry inside placeReturnedFromShift should have immediately
    // auto-placed the second one on the one remaining empty tile — not
    // left it stuck as a Prophecy waiting for next turn.
    expect(afterFirst.pendingChoice).toBeNull();
    expect(afterFirst.board.r3c1).toBeUndefined();
    expect(afterFirst.board.r3c2).toBeUndefined();
    const landedOunati = Object.values(afterFirst.board).filter(o => o?.card?.name === 'Ounati Hunger');
    expect(landedOunati).toHaveLength(2);
    // Both resolve through RESOLVE_SHIFT_RETURN/its own retry (not the
    // direct modulate()-tick auto-place path), so both land Disengaged —
    // that turn's own Disengage step already ran by the time either
    // choice is actually resolved (see placeReturnedFromShift).
    landedOunati.forEach(o => expect(o).toMatchObject({ type: 'being', ownerId: 'A', engaged: false }));
  });
});

describe('Shift — Chains of the Unbound: "Martyr: Target Being an opponent controls Shifts (1)."', () => {
  const chains = { type: 'relic', ownerId: 'A', card: { id: 'chains', instanceId: 'chains#0', name: 'Chains of the Unbound', kind: 'relic', keywords: { martyr: 'Target Being an opponent controls Shifts (1).' } } };
  const oppBeing = (id = 'opp#0') => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id, name: 'No Shift Being' }), currentLifespan: 3, engaged: false });

  it('forces an opponent\'s Being to Shift (1), even though it has no Shift ability printed on it — the affected player picks the Ethereal destination, same as any other forced-choice-on-your-own-permanent precedent', () => {
    const state = baseState({ board: { r2c1: chains, r4c1: oppBeing() }, players: { A: player(), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(afterMartyr.pendingChoice).toMatchObject({ kind: 'shift-destination', playerId: 'B' });
    const options = getLegalActions(afterMartyr, 'B').filter(a => a.type === 'RESOLVE_SHIFT_DESTINATION');
    const resolved = gameReducer(afterMartyr, options[0]);
    expect(resolved.board.r4c1).toBeUndefined();
    const shifted = resolved.board[options[0].cellId];
    expect(shifted).toMatchObject({ type: 'prophecy', ownerId: 'B', timer: 1 });
    expect(shifted.shiftedFromCard.name).toBe('No Shift Being');
  });

  it('offers a choice among more than one opponent Being', () => {
    const state = baseState({ board: { r2c1: chains, r4c1: oppBeing('opp1#0'), r4c2: oppBeing('opp2#0') }, players: { A: player(), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(afterMartyr.pendingChoice.kind).toBe('force-shift-target');
    const options = getLegalActions(afterMartyr, 'A').filter(a => a.type === 'RESOLVE_FORCE_SHIFT_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r4c1', 'r4c2']);
  });

  it('logs an honest message when the opponent controls no Being', () => {
    const state = baseState({ board: { r2c1: chains }, players: { A: player(), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(afterMartyr.log.some(e => e.message.includes('no opponent Being to force Shift'))).toBe(true);
  });
});

describe('Shift — Údarik Hunger: "Engage: Target Being you control Shifts (1), then loses (1) Time Counter; if it moves into the Mortal Realm this turn Disengage it."', () => {
  const udarik = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'udarik#0', name: 'Udarik Hunger', keywords: { engage: 'Target Being you control Shifts (1), then loses (1) Time Counter; if it moves into the Mortal Realm this turn Disengage it.' } }), currentLifespan: 2, engaged: false };
  const target = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tgt#0', name: 'Target Being', lifespan: 3 }), currentLifespan: 3, engaged: false };

  // Walks through however many of Shift's own choices actually opened
  // (Ethereal destination, then Mortal Realm destination) — same
  // multi-step resolution shape as the other Shift describe blocks above.
  const walkShiftChoices = (state) => {
    let next = state;
    while (next.pendingChoice?.kind === 'shift-destination' || next.pendingChoice?.kind === 'shift-return') {
      const owner = next.pendingChoice.playerId;
      const type = next.pendingChoice.kind === 'shift-destination' ? 'RESOLVE_SHIFT_DESTINATION' : 'RESOLVE_SHIFT_RETURN';
      const options = getLegalActions(next, owner).filter(a => a.type === type);
      next = gameReducer(next, options[0]);
    }
    return next;
  };

  it('Shifts the target, immediately loses (1) Time Counter, returns Engaged, then Disengages it', () => {
    const state = baseState({ board: { r2c1: udarik, r2c2: target }, players: { A: player(), B: player() } });
    const afterEngage = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(afterEngage.board.r2c1.engaged).toBe(true); // Údarik itself paid its Engage cost
    const resolved = walkShiftChoices(afterEngage);
    const landed = Object.values(resolved.board).find(o => o?.card?.instanceId === 'tgt#0');
    expect(landed.type).toBe('being');
    expect(landed.engaged).toBe(false); // Engaged on return, then Disengaged by Údarik's own follow-up
    expect(landed.currentLifespan).toBe(3); // full printed Lifespan, fresh
  });

  it('cannot target another Being named Udarik Hunger', () => {
    const otherUdarik = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'udarik2#0', name: 'Udarik Hunger' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: udarik, r2c2: otherUdarik }, players: { A: player(), B: player() } });
    const afterEngage = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(afterEngage.log.some(e => e.message.includes('no legal Being'))).toBe(true);
    expect(afterEngage.board.r2c2.type).toBe('being'); // untouched
  });

  it('offers a choice among multiple legal targets', () => {
    const target2 = { ...target, card: { ...target.card, instanceId: 'tgt2#0' } };
    const state = baseState({ board: { r2c1: udarik, r2c2: target, r2c3: target2 }, players: { A: player(), B: player() } });
    const afterEngage = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(afterEngage.pendingChoice.kind).toBe('udarik-shift-target');
    const options = getLegalActions(afterEngage, 'A').filter(a => a.type === 'RESOLVE_UDARIK_SHIFT_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c2', 'r2c3']);
  });
});

describe('Shift — Echoes of the Boundless: "Whenever another Being dies it\'s controller may pay its Summoning cost to Shift (1) instead of sending it to Purgatory."', () => {
  const echoes = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'echoes#0', name: 'Echoes of the Boundless', keywords: { onAnyBeingDiedMayShiftInstead: 1 } }), currentLifespan: 4, engaged: false };
  const dyingBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dying#0', name: 'Dying Being', castingCost: { faithless: 1, colored: {} }, lifespan: 3, keywords: { martyr: '' } }), currentLifespan: 3, engaged: false };

  it('offers to pay the dying Being\'s own Summoning cost and Shift it instead of Purgatory, once accepted', () => {
    const state = baseState({ board: { r2c1: echoes, r2c2: dyingBeing }, players: { A: player({ effigyPool: [effigy('faithless')] }), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    expect(afterMartyr.pendingChoice.kind).toBe('echoes-boundless-shift-instead');
    expect(afterMartyr.players.A.purgatory.map(c => c.instanceId)).toContain('dying#0'); // damage/Purgatory already happened normally
    const afterPay = gameReducer(afterMartyr, { type: 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD' });
    expect(afterPay.players.A.effigyPool).toHaveLength(0); // paid its cost
    expect(afterPay.players.A.purgatory.map(c => c.instanceId)).not.toContain('dying#0'); // pulled back out
    expect(afterPay.pendingChoice.kind).toBe('shift-from-purgatory-destination'); // 5 empty Ethereal tiles -> a real choice
    const options = getLegalActions(afterPay, 'A').filter(a => a.type === 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION');
    const resolved = gameReducer(afterPay, options[0]);
    const shifted = Object.values(resolved.board).find(o => o?.shiftedFromCard?.instanceId === 'dying#0');
    expect(shifted).toMatchObject({ type: 'prophecy', ownerId: 'A', timer: 1 });
  });

  it('can be declined, leaving the card in Purgatory as normal', () => {
    const state = baseState({ board: { r2c1: echoes, r2c2: dyingBeing }, players: { A: player({ effigyPool: [effigy('faithless')] }), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    const declined = gameReducer(afterMartyr, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBe(null);
    expect(declined.players.A.purgatory.map(c => c.instanceId)).toContain('dying#0');
    expect(declined.players.A.effigyPool).toHaveLength(1); // untouched
  });

  it('is not offered when the controller can\'t afford the dying Being\'s own Summoning cost', () => {
    const state = baseState({ board: { r2c1: echoes, r2c2: dyingBeing }, players: { A: player({ effigyPool: [] }), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    expect(afterMartyr.pendingChoice).toBe(null);
  });

  it('does not trigger for Echoes of the Boundless\' own death', () => {
    const dyingEchoes = { ...echoes, card: { ...echoes.card, keywords: { onAnyBeingDiedMayShiftInstead: 1, martyr: '' } } };
    const state = baseState({ board: { r2c1: dyingEchoes }, players: { A: player({ effigyPool: [effigy('faithless')] }), B: player() } });
    const afterMartyr = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(afterMartyr.pendingChoice).toBe(null);
  });

  it('stops offering RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD (leaving only RESOLVE_DECLINE) once the cost is no longer affordable, even with the pendingChoice already open', () => {
    // Regression: triggerEchoesOfBoundlessOffer only checks canPayCost once,
    // at the moment the choice first opens — the offer here used to push
    // RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD unconditionally afterward,
    // never re-checking it, even though the reducer's own `if
    // (!canPayCost(...)) return state;` guard makes it a silent no-op once
    // unaffordable. Self-play found this a real, reachable stall: the AI
    // kept re-selecting the same permanently-unaffordable action forever
    // instead of ever reaching RESOLVE_DECLINE.
    const state = baseState({
      pendingChoice: {
        kind: 'echoes-boundless-shift-instead', playerId: 'A',
        dyingCard: { instanceId: 'dying#0', name: 'Dying Being', castingCost: { faithless: 1, colored: {} } },
        amount: 1, optional: true,
      },
      players: { A: player({ effigyPool: [] }), B: player() }, // can't afford it
    });
    const legal = getLegalActions(state, 'A');
    expect(legal).not.toContainEqual({ type: 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD' });
    expect(legal).toContainEqual({ type: 'RESOLVE_DECLINE' });
    const next = gameReducer(state, { type: 'RESOLVE_ECHOES_BOUNDLESS_SHIFT_INSTEAD' });
    expect(next).toBe(state); // the reducer's own guard still refuses it — confirms it really would have been a no-op
  });
});

describe('Shift — Formless Fangs: "Any Being dealt damage by this Shifts (2)."', () => {
  const fangs = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'fangs#0', name: 'Formless Fangs', strength: 2, lifespan: 2, keywords: { onDealsCombatDamageForceShift: 2 } }), currentLifespan: 2, engaged: false };
  // With an otherwise-empty board all 5 Ethereal tiles are open, so the
  // forced Shift opens its own 'shift-destination' choice — resolve it.
  const resolveShiftChoice = (state) => {
    if (state.pendingChoice?.kind !== 'shift-destination') return state;
    const owner = state.pendingChoice.playerId;
    const options = getLegalActions(state, owner).filter(a => a.type === 'RESOLVE_SHIFT_DESTINATION');
    return gameReducer(state, options[0]);
  };

  it('Shifts the defender it hit, if the defender survives the combat', () => {
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 1, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: fangs, r4c1: defender }, players: { A: player(), B: player() } });
    const next = resolveShiftChoice(gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true }));
    const shifted = Object.values(next.board).find(o => o?.shiftedFromCard?.instanceId === 'def#0');
    expect(shifted.type).toBe('prophecy');
    expect(shifted.timer).toBe(2);
  });

  it('does not Shift the defender if it died from the combat', () => {
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: fangs, r4c1: defender }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.pendingChoice).toBeFalsy();
  });

  it('still Shifts the defender even if Formless Fangs itself dies in the same mutual combat', () => {
    const strong = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'str#0', strength: 5, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: fangs, r4c1: strong }, players: { A: player(), B: player() } });
    const next = resolveShiftChoice(gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true }));
    expect(next.board.r2c1).toBeUndefined(); // Formless Fangs died (2 Strength vs its own 2 Lifespan)
    const shifted = Object.values(next.board).find(o => o?.shiftedFromCard?.instanceId === 'str#0');
    expect(shifted.type).toBe('prophecy'); // but the defender it hit still Shifted
  });

  it('when it is the DEFENDER, still Shifts the attacker that hit it, if the attacker survives', () => {
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r4c1: fangs, r2c1: attacker }, turnPlayer: 'B', players: { A: player(), B: player() } });
    const next = resolveShiftChoice(gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true }));
    const shifted = Object.values(next.board).find(o => o?.shiftedFromCard?.instanceId === 'atk#0');
    expect(shifted.type).toBe('prophecy');
  });

  it('does not apply to open-lane damage (only ever hits a Being)', () => {
    const state = baseState({ board: { r2c1: fangs }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(48);
    expect(next.board.r2c1.type).toBe('being'); // itself untouched by its own keyword
  });
});

describe('Shift — Tiarlish Hunger: "When this moves into the Mortal Realm copy the effect(s) of target Being an opponent controls until the end of your next turn."', () => {
  const tiarlishCard = beingCard({
    instanceId: 'tiar#0', name: 'Tiarlish Hunger', typing: 'Hunger, Being',
    keywords: { shift: { amount: 1, effect: null }, onMovedIntoMortalRealm: 'copy the effect(s) of target Being an opponent controls until the end of your next turn.' },
  });
  const shiftedTiarlish = { type: 'prophecy', ownerId: 'A', card: { ...tiarlishCard, textBox: '', typing: '', keywords: {} }, timer: 1, faceDown: false, shiftedFromCard: tiarlishCard };
  const oppBeing = (id = 'opp#0') => ({
    type: 'being', ownerId: 'B',
    card: beingCard({ instanceId: id, name: 'Copy Source', textBox: 'Martyr: Draw (1) card.', keywords: { martyr: 'Draw (1) card.' } }),
    currentLifespan: 2, engaged: false,
  });

  // The automatic tick (beginTurn) opens its OWN "which Mortal Realm tile"
  // choice first whenever more than one is empty (returnFromShift,
  // actions.js) — resolving that is what actually runs
  // placeReturnedFromShift (and so the copy trigger), same as any other
  // multi-step sequence in this file.
  const resolveTheReturn = (state) => {
    const afterTick = beginTurn(state);
    if (afterTick.pendingChoice?.kind !== 'shift-return') return afterTick;
    const options = getLegalActions(afterTick, 'A').filter(a => a.type === 'RESOLVE_SHIFT_RETURN');
    return gameReducer(afterTick, options[0]);
  };

  it('copies the whole textBox of the only opponent Being onto itself when it returns', () => {
    const state = baseState({ turnPlayer: 'A', board: { r3c1: shiftedTiarlish, r4c1: oppBeing() }, players: { A: player(), B: player() } });
    const next = resolveTheReturn(state);
    const returned = Object.values(next.board).find(o => o?.card?.name === 'Tiarlish Hunger');
    expect(returned.card.keywords.martyr).toBe('Draw (1) card.');
    expect(returned.copiedEffectOriginalCard.name).toBe('Tiarlish Hunger');
    expect(returned.copiedEffectSkipNextClear).toBe(true);
  });

  it('offers a choice among multiple opponent Beings', () => {
    const state = baseState({
      turnPlayer: 'A',
      board: { r3c1: shiftedTiarlish, r4c1: oppBeing('opp1#0'), r4c2: oppBeing('opp2#0') },
      players: { A: player(), B: player() },
    });
    const next = resolveTheReturn(state);
    expect(next.pendingChoice.kind).toBe('copy-opponent-effect');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_COPY_OPPONENT_EFFECT');
    expect(options.map(o => o.cellId).sort()).toEqual(['r4c1', 'r4c2']);
  });

  it('survives the rest of this turn and the opponent\'s whole turn, clearing only at the end of the copier\'s own NEXT turn (self-consuming flag)', () => {
    const state = baseState({ turnPlayer: 'A', board: { r3c1: shiftedTiarlish, r4c1: oppBeing() }, players: { A: player(), B: player() } });
    const afterReturn = resolveTheReturn(state);
    const cellAfterReturn = Object.entries(afterReturn.board).find(([, o]) => o?.card?.name === 'Tiarlish Hunger')[0];

    // A's own end of turn (the SAME turn it was granted) — consumes the
    // skip flag, but the copy survives.
    const afterAEnds = endTurn(afterReturn);
    expect(afterAEnds.board[cellAfterReturn].card.keywords.martyr).toBe('Draw (1) card.');
    expect(afterAEnds.board[cellAfterReturn].copiedEffectSkipNextClear).toBe(false);

    // B's whole turn passes (B's own endTurn never touches A's occupant).
    const afterBEnds = endTurn(afterAEnds);
    expect(afterBEnds.board[cellAfterReturn].card.keywords.martyr).toBe('Draw (1) card.');

    // A's own NEXT end of turn — now it actually clears.
    const afterASecondTurnEnds = endTurn(afterBEnds);
    expect(afterASecondTurnEnds.board[cellAfterReturn].card.name).toBe('Tiarlish Hunger');
    expect(afterASecondTurnEnds.board[cellAfterReturn].card.keywords.martyr).toBeUndefined();
    expect(afterASecondTurnEnds.board[cellAfterReturn].copiedEffectOriginalCard).toBeUndefined();
  });
});

describe('Unruly — "Whenever this Being attacks, lose Lifespan equal to its current Strength." (Unruly Fiend)', () => {
  const fiend = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'fiend#0', name: 'Unruly Fiend', strength: 4, keywords: { unruly: true, depart: 'Discard a card at random.' } }), currentLifespan: 1, engaged: false };

  it('loses Lifespan equal to its current (live) Strength the instant it attacks, into an open lane', () => {
    const state = baseState({ board: { r2c1: fiend }, players: { A: player({ lifespan: 20 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.lifespan).toBe(16); // 20 - 4 (its own Strength)
    expect(next.players.B.lifespan).toBe(46); // still takes the normal 4 combat damage too
  });

  it('reads its LIVE effective Strength (bonuses included), not just its printed base', () => {
    const buffed = { ...fiend, permanentBonus: { strength: 2, lifespan: 0 } };
    const state = baseState({ board: { r2c1: buffed }, players: { A: player({ lifespan: 20 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.lifespan).toBe(14); // 20 - 6 (4 base + 2 bonus)
  });

  it('still applies even though the attack kills it in mutual combat', () => {
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: fiend, r4c1: defender }, players: { A: player({ lifespan: 20 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    // 20 - 4 (Unruly's own loss) - 5 (its own printed Lifespan, paid to its
    // controller when it dies to the counter-attack) = 11.
    expect(next.players.A.lifespan).toBe(11);
    expect(next.board.r2c1).toBeUndefined(); // and it still died from the counter-attack
  });

  it('does not apply to a Being without the keyword', () => {
    const plain = { ...fiend, card: { ...fiend.card, keywords: {} } };
    const state = baseState({ board: { r2c1: plain }, players: { A: player({ lifespan: 20 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.lifespan).toBe(20);
  });
});

describe('"When this Being deals damage to an opponent, prevent that damage and craft (X) Effigies..." (Degrisch Vassal)', () => {
  const vassal = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dv#0', name: 'Degrisch Vassal', strength: 3, keywords: { preventOpenLaneDamageCraftEffigy: true } }), currentLifespan: 2, engaged: false };

  it('crafts Effigies instead of dealing Lifespan damage on an open-lane attack', () => {
    const state = baseState({
      board: { r2c1: vassal },
      players: { A: player({ effigyDeck: [effigy('living'), effigy('bleeding'), effigy('formless')] }), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(50); // no damage dealt
    expect(next.players.A.effigyPool).toHaveLength(3); // 3 Strength -> 3 Effigies
    expect(next.players.A.effigyDeck).toHaveLength(0);
  });

  it('also prevents damage and crafts Effigies attacking past a non-blocking Relic', () => {
    const relic = { type: 'relic', ownerId: 'B', card: { id: 'r', instanceId: 'r#0', name: 'Test Relic', kind: 'relic', keywords: {} } };
    const state = baseState({
      board: { r2c1: vassal, r4c1: relic },
      players: { A: player({ effigyDeck: [effigy('living'), effigy('bleeding'), effigy('formless')] }), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(50);
    expect(next.players.A.effigyPool).toHaveLength(3);
  });

  it('caps crafted Effigies at however many are left in the deck', () => {
    const state = baseState({
      board: { r2c1: vassal },
      players: { A: player({ effigyDeck: [effigy('living')] }), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.effigyPool).toHaveLength(1);
  });

  it('does not apply to a Being without the keyword — normal open-lane damage still lands', () => {
    const plain = { ...vassal, card: { ...vassal.card, keywords: {} } };
    const state = baseState({ board: { r2c1: plain }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(47);
  });

  it('does not apply to damage dealt against a blocking Being (mutual combat, not "an opponent")', () => {
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 1, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: vassal, r4c1: defender },
      players: { A: player({ effigyDeck: [effigy('living')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1.currentLifespan).toBe(2); // took 3 damage normally
    expect(next.players.A.effigyPool).toHaveLength(0); // no Effigy crafted
  });
});

describe('"Once per turn when a Being you control dies you may have this Relic gain its effect(s) until end of turn." (Wretched Remnants)', () => {
  const remnants = { type: 'relic', ownerId: 'A', card: { id: 'wr', instanceId: 'wr#0', name: 'Wretched Remnants', kind: 'relic', keywords: { onOwnBeingDiedGainTextBox: true } } };
  const dyingBeing = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: 'db#0', name: 'Wounded Turanga', textBox: 'Depart: Draw (1) card.', keywords: { depart: 'Draw (1) card.', martyr: '' } }),
    currentLifespan: 1, engaged: false, ...overrides,
  });

  it('offers the choice when a Being it controls dies, and copies the whole textBox (not stats/typing/name) onto itself until end of turn', () => {
    const state = baseState({
      board: { r2c1: remnants, r2c2: dyingBeing() },
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'draw#0' })] }), B: player() },
    });
    const afterDeath = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    expect(afterDeath.pendingChoice).toEqual({ kind: 'copy-textbox-until-end-of-turn', playerId: 'A', dyingCard: dyingBeing().card, allowedCells: ['r2c1'], optional: true });
    const resolved = gameReducer(afterDeath, { type: 'RESOLVE_COPY_TEXTBOX_UNTIL_END_OF_TURN', cellId: 'r2c1' });
    expect(resolved.board.r2c1.card.name).toBe('Wretched Remnants'); // name unchanged
    expect(resolved.board.r2c1.card.keywords.depart).toBe('Draw (1) card.'); // textBox's ability copied
    expect(resolved.board.r2c1.wretchedRemnantsUsedThisTurn).toBe(true);
  });

  it('can be declined', () => {
    const state = baseState({ board: { r2c1: remnants, r2c2: dyingBeing() }, players: { A: player(), B: player() } });
    const afterDeath = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    const declined = gameReducer(afterDeath, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBe(null);
    expect(declined.board.r2c1.card.name).toBe('Wretched Remnants');
    expect(declined.board.r2c1.card.keywords.depart).toBeUndefined();
  });

  it('is not offered a second time the same turn', () => {
    const usedRemnants = { ...remnants, wretchedRemnantsUsedThisTurn: true };
    const state = baseState({ board: { r2c1: usedRemnants, r2c2: dyingBeing() }, players: { A: player(), B: player() } });
    const afterDeath = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    expect(afterDeath.pendingChoice).toBe(null);
  });

  it('restores its own original card at end of turn', () => {
    const state = baseState({ board: { r2c1: remnants, r2c2: dyingBeing() }, turnPlayer: 'A', players: { A: player(), B: player() } });
    const afterDeath = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    const resolved = gameReducer(afterDeath, { type: 'RESOLVE_COPY_TEXTBOX_UNTIL_END_OF_TURN', cellId: 'r2c1' });
    const ended = endTurn(resolved);
    expect(ended.board.r2c1.card.keywords.depart).toBeUndefined();
    expect(ended.board.r2c1.card.name).toBe('Wretched Remnants');
  });

  it('resets the once-per-turn flag at the start of its controller\'s next turn', () => {
    const usedRemnants = { ...remnants, wretchedRemnantsUsedThisTurn: true };
    const state = baseState({ turnPlayer: 'A', board: { r2c1: usedRemnants }, players: { A: player(), B: player() } });
    const next = beginTurn(state);
    expect(next.board.r2c1.wretchedRemnantsUsedThisTurn).toBe(false);
  });
});

describe('Animated Armaments (RULES.md > Keywords > Animated)', () => {
  const animatedCard = (overrides = {}) => ({
    id: 'ds', instanceId: 'ds#0', name: 'Dancing Swords', kind: 'relic-armament',
    castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 1, arrows: [1, 2, 8],
    keywords: { animated: true }, ...overrides,
  });
  const plainArmamentCard = (overrides = {}) => ({
    id: 'rr', instanceId: 'rr#0', name: 'Rusted Rapier', kind: 'relic-armament',
    castingCost: { faithless: 0, colored: {} }, ...overrides,
  });
  const animatedEntry = (overrides = {}) => ({ card: animatedCard(), engaged: false, currentLifespan: 1, ...overrides });
  const animatedPile = (owner = 'A', entryOverrides = {}) => ({ type: 'armament-stack', ownerId: owner, armaments: [animatedEntry(entryOverrides)] });

  it('ATTACH_ARMAMENT onto an empty cell initializes currentLifespan on the new entry', () => {
    const state = baseState({ players: { A: player({ hand: [animatedCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'ds#0', cellId: 'r2c1' });
    expect(next.board.r2c1).toEqual(animatedPile());
  });

  it('playing an Animated Armament onto an EMPTY tile counts as "a Being is summoned" — Happy Hammer moves onto it (RULES.md: "treated as a Being")', () => {
    const happyHammer = equip({
      id: 'hh', instanceId: 'hh#0', name: 'Happy Hammer', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} },
      keywords: { movesToNewlySummonedBeing: true, statBonus: { strength: 3, lifespan: 0 } },
    });
    const wielder = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wielder#0', strength: 1 }), currentLifespan: 5, engaged: false, armaments: [happyHammer] };
    const state = baseState({ board: { r4c1: wielder }, players: { A: player({ hand: [animatedCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'ds#0', cellId: 'r2c1' });
    expect(next.board.r4c1.armaments).toEqual([]); // Happy Hammer left its old wielder
    const names = next.board.r2c1.armaments.map(a => a.card.name);
    expect(names).toEqual(expect.arrayContaining(['Dancing Swords', 'Happy Hammer']));
  });

  it('does NOT count as "a Being is summoned" when attaching onto an EXISTING Being (a Being was already there)', () => {
    const happyHammer = equip({
      id: 'hh', instanceId: 'hh#0', name: 'Happy Hammer', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} },
      keywords: { movesToNewlySummonedBeing: true },
    });
    const wielder = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wielder#0' }), currentLifespan: 5, engaged: false, armaments: [happyHammer] };
    const target = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 't#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r4c1: wielder, r2c1: target }, players: { A: player({ hand: [animatedCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'ds#0', cellId: 'r2c1' });
    expect(next.board.r4c1.armaments).toHaveLength(1); // Happy Hammer stays put — the target Being already existed
  });

  it('getLegalActions offers an attack from the front row', () => {
    const state = baseState({ board: { r2c2: animatedPile() } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'MOVE_OR_ATTACK' && a.isAttack && a.fromCellId === 'r2c2')).toBe(true);
    // None of a real Being's other abilities (Martyr, a generic Engage)
    // are offered just from being Animated.
    expect(legal.some(a => a.type === 'ACTIVATE_MARTYR' || a.type === 'ACTIVATE_ENGAGE')).toBe(false);
  });

  it('getLegalActions offers a reposition under its own arrows from the home row', () => {
    // Dancing Swords' own arrows (1, 2, 8) are all forward — from the home
    // row (r1c2) they land safely on the front row; from the front row
    // they'd cross into the Ethereal Realm and be illegal instead.
    const state = baseState({ board: { r1c2: animatedPile() } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'MOVE_OR_ATTACK' && !a.isAttack && a.fromCellId === 'r1c2')).toBe(true);
  });

  it('does not offer MOVE_OR_ATTACK when the topmost entry is already engaged', () => {
    const state = baseState({ board: { r2c2: animatedPile('A', { engaged: true }) } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'MOVE_OR_ATTACK')).toBe(false);
  });

  it('does not act as a Being when it\'s attached under a real Being, even as the topmost entry', () => {
    const beingWithAnimated = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false, armaments: [animatedEntry()] };
    const beingAlone = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const actionsWith = getLegalActions(baseState({ board: { r2c2: beingWithAnimated } }), 'A').filter(a => a.fromCellId === 'r2c2');
    const actionsWithout = getLegalActions(baseState({ board: { r2c2: beingAlone } }), 'A').filter(a => a.fromCellId === 'r2c2');
    // Identical either way — the attached Animated Armament grants no
    // extra, independent move/attack of its own while under a Being.
    expect(actionsWith).toEqual(actionsWithout);
  });

  it('is immediately usable, unengaged, the same turn its wielder dies attacking (its own engaged flag is tracked independently of the Being\'s)', () => {
    // Persistent Recruit attacks and dies in the exchange; Dancing Swords
    // (attached, never separately engaged this turn) drops to a freestanding
    // pile via dropArmaments, which copies its `{ card, engaged }` entry
    // over unchanged — the Being's own attack (writeActorState) only ever
    // sets `engaged` on the Being itself, never cascading onto its
    // Armaments. The now-freestanding Animated top should still be legal to
    // act with this same turn — no separate "summoning sickness" applies to
    // an Armament just because the occupant *shape* changed mid-turn.
    const recruit = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'recruit#0', name: 'Persistent Recruit', strength: 2, lifespan: 1 }),
      currentLifespan: 1, engaged: false,
      armaments: [animatedEntry()],
    };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: recruit, r4c1: defender }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.purgatory).toEqual([expect.objectContaining({ name: 'Persistent Recruit' })]);
    expect(next.board.r2c1).toEqual(animatedPile());
    expect(next.board.r2c1.armaments[0].engaged).toBe(false);
    expect(getLegalActions(next, 'A').some(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r2c1')).toBe(true);
  });

  it('an Animated entry buried mid-stack (not already topmost) is moved to the top once its wielder dies', () => {
    // Simulates how a mover's own armaments (with an Animated one already
    // on top) can end up with that entry buried after MOVE_OR_ATTACK's own
    // reposition branch concatenates a picked-up waiting pile's armaments
    // after them, with no reordering — dropArmaments (called here via
    // dealDamageToBeing's own death branch) is the one choke point that
    // restores the invariant.
    const below = equip(plainArmamentCard({ instanceId: 'below#0' }));
    const above = equip(plainArmamentCard({ instanceId: 'above#0' }));
    const buried = {
      type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', lifespan: 1 }), currentLifespan: 1, engaged: false,
      armaments: [below, animatedEntry(), above], // Animated sits in the middle, not last
    };
    const state = baseState({ board: { r2c1: buried }, players: { A: player({ lifespan: 30 }), B: player() } });
    const next = dealDamageToBeing(state, 'r2c1', 1);
    expect(next.board.r2c1.type).toBe('armament-stack');
    const names = next.board.r2c1.armaments.map(a => a.card.instanceId);
    expect(names).toEqual(['below#0', 'above#0', 'ds#0']); // Animated ('ds#0') moved to the top
    expect(next.board.r2c1.armaments[names.length - 1].card.keywords?.animated).toBe(true);
  });

  it('moves under its own arrows, engaging just the topmost entry', () => {
    const state = baseState({ board: { r1c2: animatedPile() } }); // direction 1: forward, into the front row
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r1c2', direction: 1 });
    expect(next.board.r1c2).toBeUndefined();
    expect(next.board.r2c2).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [animatedEntry({ engaged: true })] });
  });

  it('attacks into an empty lane, dealing its own Strength directly to the opponent', () => {
    const state = baseState({ board: { r2c1: animatedPile() }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(49); // Dancing Swords' own Strength (1)
    expect(next.board.r2c1.armaments[0].engaged).toBe(true);
  });

  it('a plain (non-Animated) Armament pile still does not act as a Being — no MOVE_OR_ATTACK offered', () => {
    const state = baseState({ board: { r2c2: { type: 'armament-stack', ownerId: 'A', armaments: [equip(plainArmamentCard())] } } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'MOVE_OR_ATTACK')).toBe(false);
  });

  it('blocks an attack (unlike a Relic or a plain Armament pile) — real mutual combat', () => {
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk', strength: 1, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: attacker, r2c1: animatedPile() }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    // Dancing Swords (1/1) trades with the attacker (1/1) — both take 1.
    expect(next.board.r4c1.currentLifespan).toBe(4);
    expect(next.board.r2c1).toBeUndefined(); // Dancing Swords died (1 - 1 = 0)
  });

  it('dies from combat damage: controller takes its own base Lifespan, it goes to Purgatory, remaining Armaments stay behind', () => {
    const under = plainArmamentCard({ instanceId: 'under#0', name: 'Under' });
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(under), animatedEntry({ currentLifespan: 1 })] };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: attacker, r2c1: pile }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(next.players.A.lifespan).toBe(49); // Dancing Swords' own base Lifespan (1)
    expect(next.players.A.purgatory).toEqual([animatedCard()]);
    // "Under" survives, left behind as an ordinary pile.
    expect(next.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [equip(under)] });
  });

  it('a Being moving onto the pile picks it up — the Animated entry stops acting independently', () => {
    const mover = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: mover, r2c3: animatedPile() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next.board.r2c3.type).toBe('being');
    expect(next.board.r2c3.armaments).toEqual([animatedEntry()]);
    // Once disengaged again (next turn), only the Being's own actions are
    // legal from that tile — no extra, independent one for the Armament.
    const disengaged = { ...next, board: { ...next.board, r2c3: { ...next.board.r2c3, engaged: false } } };
    const plainBeing = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const withArmament = getLegalActions(disengaged, 'A').filter(a => a.fromCellId === 'r2c3');
    const withoutArmament = getLegalActions(baseState({ board: { r2c3: plainBeing } }), 'A').filter(a => a.fromCellId === 'r2c3');
    expect(withArmament).toEqual(withoutArmament);
  });

  it('Strength bonuses from Armaments stacked underneath still apply to the Animated actor on top', () => {
    const boost = { id: 'boost', instanceId: 'boost#0', name: 'Boost', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, keywords: { statBonus: { strength: 2, lifespan: 0 } } };
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(boost), animatedEntry()] };
    const state = baseState({ board: { r2c1: pile }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.B.lifespan).toBe(47); // 1 (own Strength) + 2 (Boost) = 3 damage
  });

  describe('a non-Animated Armament attaching onto an Animated top slots in below it, not on top', () => {
    const plainArmament = () => ({ id: 'hh', instanceId: 'hh#0', name: 'Happy Hammer', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, keywords: {} });

    it('inserts the new entry just below the existing Animated top, which stays acting', () => {
      const state = baseState({ board: { r2c1: animatedPile() }, players: { A: player({ hand: [plainArmament()] }), B: player() } });
      const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'hh#0', cellId: 'r2c1' });
      expect(next.board.r2c1.armaments).toEqual([equip(plainArmament()), animatedEntry()]);
      // Dancing Swords (the Animated one) is still the topmost/acting entry.
      expect(getLegalActions(next, 'A').some(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r2c1')).toBe(true);
    });

    it('still applies a new entry\'s own Lifespan stat bonus to the Animated top, even though it isn\'t attaching directly to a Being', () => {
      const boosting = { id: 'hh', instanceId: 'hh#0', name: 'Happy Hammer', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, keywords: { statBonus: { strength: 0, lifespan: 3 } } };
      const state = baseState({ board: { r2c1: animatedPile() }, players: { A: player({ hand: [boosting] }), B: player() } });
      const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'hh#0', cellId: 'r2c1' });
      expect(next.board.r2c1.armaments).toEqual([equip(boosting), animatedEntry({ currentLifespan: 4 })]); // 1 (own) + 3 (Happy Hammer)
    });

    it('an Animated Armament attaching still goes on top as normal (it becomes the new acting entry)', () => {
      const secondAnimated = { id: 'ss', instanceId: 'ss#0', name: 'Soulless Scissors', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 2, keywords: { animated: true } };
      const state = baseState({ board: { r2c1: animatedPile() }, players: { A: player({ hand: [secondAnimated] }), B: player() } });
      const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'ss#0', cellId: 'r2c1' });
      expect(next.board.r2c1.armaments).toEqual([animatedEntry(), { ...equip(secondAnimated), currentLifespan: 2 }]);
    });

    it('a newly-attached Animated entry inherits the Lifespan bonus already sitting on the pile beneath it', () => {
      const boostingUnder = { id: 'hh', instanceId: 'hh#0', name: 'Happy Hammer', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, keywords: { statBonus: { strength: 0, lifespan: 3 } } };
      const secondAnimated = { id: 'ss', instanceId: 'ss#0', name: 'Soulless Scissors', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 2, keywords: { animated: true } };
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(boostingUnder)] };
      const state = baseState({ board: { r2c1: pile }, players: { A: player({ hand: [secondAnimated] }), B: player() } });
      const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'ss#0', cellId: 'r2c1' });
      // 2 (own base Lifespan) + 3 (Happy Hammer, already in the pile) = 5,
      // not just its own printed 2 — the bonus doesn't wait for the next
      // Armament to attach before it starts counting.
      expect(next.board.r2c1.armaments).toEqual([equip(boostingUnder), { ...equip(secondAnimated), currentLifespan: 5 }]);
    });
  });
});

describe('CAST_CONJURING', () => {
  const conjuringCard = (overrides = {}) => ({
    id: 'conj-1', instanceId: 'conj-1#0', name: 'Test Conjuring', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Gain 3 Lifespan.', ...overrides,
  });

  it('moves the card from hand to Purgatory and logs that it resolved, really granting the Lifespan', () => {
    const state = baseState({ players: { A: player({ hand: [conjuringCard()], lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.purgatory).toEqual([conjuringCard()]);
    expect(next.log.some(e => e.message.includes('casts Test Conjuring'))).toBe(true);
    expect(next.players.A.lifespan).toBe(53);
  });

  it('refuses when the cost can\'t be paid', () => {
    const card = conjuringCard({ castingCost: { faithless: 3, colored: {} } });
    const state = baseState({ players: { A: player({ hand: [card] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next).toBe(state);
  });

  it('an Ethereal Conjuring is castable at main-phase speed too, same as any other Conjuring (it\'s also castable reactively now — see the "Eighteenth wave" describe block below)', () => {
    const card = conjuringCard({ kind: 'ethereal-conjuring' });
    const state = baseState({ players: { A: player({ hand: [card], lifespan: 50 }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING' && a.instanceId === 'conj-1#0')).toBe(true);
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.players.A.purgatory).toEqual([card]);
    expect(next.players.A.lifespan).toBe(53);
  });

  it('"Deal (N) damage to any target" targets any Being on the board, either owner (Sharpshoot)', () => {
    const card = conjuringCard({ name: 'Sharpshoot', kind: 'ethereal-conjuring', textBox: 'Deal (1) damage to any target.' });
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: enemy, r4c2: ally },
      players: { A: player({ hand: [card] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'damage-target', playerId: 'A', cardName: 'Sharpshoot', damage: 1, typing: null, includesPlayers: true });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
    const resolved = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
    expect(resolved.board.r4c1.currentLifespan).toBe(4);
  });

  it('never auto-resolves — "any target" always includes both players\' own Lifespan, so a choice always exists', () => {
    const card = conjuringCard({ name: 'Sharpshoot', kind: 'ethereal-conjuring', textBox: 'Deal (1) damage to any target.' });
    const lone = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'lone' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: lone },
      players: { A: player({ hand: [card] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.pendingChoice.kind).toBe('damage-target');
    expect(next.board.r4c1.currentLifespan).toBe(5); // untouched — nothing auto-resolved
    const options = getLegalActions(next, 'A');
    expect(options).toContainEqual({ type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
    expect(options).toContainEqual({ type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'A' });
    expect(options).toContainEqual({ type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
  });

  it('can target either player\'s own Lifespan directly, including the caster\'s own', () => {
    const card = conjuringCard({ name: 'Sharpshoot', kind: 'ethereal-conjuring', textBox: 'Deal (1) damage to any target.' });
    const state = baseState({ players: { A: player({ hand: [card], lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    const hitOpponent = gameReducer(opened, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
    expect(hitOpponent.players.B.lifespan).toBe(49);
    expect(hitOpponent.pendingChoice).toBeNull();

    const hitSelf = gameReducer(opened, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'A' });
    expect(hitSelf.players.A.lifespan).toBe(49); // "any target" includes the caster's own side too
  });

  it('a "target Being"-only effect (not "any target") never offers a player as a target', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'kend#0', name: 'Kendasha', keywords: { depart: 'Deal (1) damage to target Being.' } }), currentLifespan: 3, engaged: false };
    const lone = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'lone#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender, r4c2: lone }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.pendingChoice).toEqual({ kind: 'damage-target', playerId: 'B', cardName: 'Kendasha', damage: 1, typing: null, includesPlayers: false });
    const options = getLegalActions(next, 'B');
    expect(options.some(a => a.type === 'RESOLVE_DAMAGE_TARGET_PLAYER')).toBe(false);
  });

  // A freestanding Animated Armament (its topmost entry — RULES.md >
  // Keywords > Animated) acts as a Being of its own and is already a legal
  // attack target in combat; "any target" damage effects should see it the
  // same way, not just real `type: 'being'` occupants.
  describe('"any target" also reaches a freestanding Animated Armament acting as a Being', () => {
    const swordsCard = { id: 'ds', instanceId: 'ds#0', name: 'Dancing Swords', kind: 'relic-armament', lifespan: 1, keywords: { animated: true } };
    const swordsPile = (entryOverrides = {}) => ({
      type: 'armament-stack', ownerId: 'B',
      armaments: [{ card: swordsCard, engaged: false, currentLifespan: 2, ...entryOverrides }],
    });

    it('offers it as a choice alongside a real Being', () => {
      const card = conjuringCard({ name: 'Sharpshoot', kind: 'ethereal-conjuring', textBox: 'Deal (1) damage to any target.' });
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false };
      const state = baseState({
        board: { r4c1: swordsPile(), r2c1: ally },
        players: { A: player({ hand: [card] }), B: player() },
      });
      const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
      expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
      const resolved = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
      expect(resolved.board.r4c1.armaments[0].currentLifespan).toBe(1);
    });

    it('reaches it as one candidate among the two players\' own Lifespan (no auto-resolve — "any target" always offers a real choice)', () => {
      const card = conjuringCard({ name: 'Sharpshoot', kind: 'ethereal-conjuring', textBox: 'Deal (1) damage to any target.' });
      const state = baseState({ board: { r4c1: swordsPile() }, players: { A: player({ hand: [card] }), B: player() } });
      const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
      expect(opened.pendingChoice.kind).toBe('damage-target');
      const next = gameReducer(opened, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
      expect(next.board.r4c1.armaments[0].currentLifespan).toBe(1);
    });

    it('kills it outright: goes to Purgatory, its controller takes its own base Lifespan, Armaments beneath it stay behind', () => {
      const under = { id: 'rr', instanceId: 'rr#0', name: 'Rusted Rapier', kind: 'relic-armament' };
      const card = conjuringCard({ name: 'Sharpshoot', kind: 'ethereal-conjuring', textBox: 'Deal (1) damage to any target.' });
      const pile = { type: 'armament-stack', ownerId: 'B', armaments: [{ card: under, engaged: false }, { card: swordsCard, engaged: false, currentLifespan: 1 }] };
      const state = baseState({ board: { r4c1: pile }, players: { A: player({ hand: [card] }), B: player({ lifespan: 50 }) } });
      const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
      const next = gameReducer(opened, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
      expect(next.players.B.lifespan).toBe(49); // Dancing Swords' own printed Lifespan (1)
      expect(next.players.B.purgatory).toEqual([swordsCard]);
      expect(next.board.r4c1).toEqual({ type: 'armament-stack', ownerId: 'B', armaments: [{ card: under, engaged: false }] });
    });
  });
});

describe('Deja Vu — "Return target Being that you control with cost (X) to your hand, then Summon it without paying its summoning cost. Pay (2) additional Timeless Essence to target a Deity."', () => {
  const dejaVu = (overrides = {}) => ({
    id: 'dv-1', instanceId: 'dv-1#0', name: 'Deja Vu', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: { timeless: 2 }, xCostColor: '' },
    keywords: { dejaVu: true, dejaVuDeitySurcharge: { amount: 2, color: 'timeless' } },
    textBox: 'Return target Being that you control with cost (X) to your hand, then Summon it without paying its summoning cost\nPay (2) additional Timeless Essence to target a Deity.',
    ...overrides,
  });

  // A cheap own Being: totalCastingCost 1 (1 Bleeding), so Deja Vu's own
  // combined cost targeting it is 2 Timeless (base) + 1 Faithless (the X,
  // read off the target — xCostColor '' means the faithless slot).
  const cheapBeing = (overrides = {}) => beingCard({
    instanceId: 'cheap#0', name: 'Cheap Ally', castingCost: { faithless: 1, colored: {} }, ...overrides,
  });

  it('is not offered at all with no affordable target (no own Beings on board)', () => {
    const state = baseState({ players: { A: player({ hand: [dejaVu()], effigyPool: [effigy('timeless'), effigy('timeless')] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING')).toBe(false);
  });

  it('is not offered when the only own Being on board costs more than the player can pay', () => {
    const expensive = cheapBeing({ instanceId: 'exp#0', castingCost: { faithless: 5, colored: {} } });
    const state = baseState({
      board: { r1c1: { type: 'being', ownerId: 'A', card: expensive, currentLifespan: 5, engaged: false } },
      players: { A: player({ hand: [dejaVu()], effigyPool: [effigy('timeless'), effigy('timeless')] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING')).toBe(false);
  });

  it('casting opens a deja-vu-target pendingChoice restricted to affordable own Beings, without paying anything yet', () => {
    const being = cheapBeing();
    const state = baseState({
      board: { r1c1: { type: 'being', ownerId: 'A', card: being, currentLifespan: 5, engaged: false } },
      players: { A: player({ hand: [dejaVu()], effigyPool: [effigy('timeless'), effigy('timeless'), effigy('bleeding')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dv-1#0' });
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.purgatory).toEqual([dejaVu()]);
    expect(next.players.A.effigyPool).toHaveLength(3); // nothing spent yet
    expect(next.pendingChoice.kind).toBe('deja-vu-target');
    expect(next.pendingChoice.allowedCells).toEqual(['r1c1']);
    expect(getLegalActions(next, 'A')).toEqual([{ type: 'RESOLVE_DEJA_VU_TARGET', cellId: 'r1c1' }]);
  });

  it('resolving the target pays the combined cost (base + target\'s own totalCastingCost as Faithless) and returns-then-resummons on the same tile, retriggering When Summoned', () => {
    const being = cheapBeing({ keywords: { whenSummoned: 'Gain 2 Lifespan.' } });
    const state = baseState({
      board: { r1c1: { type: 'being', ownerId: 'A', card: being, currentLifespan: 5, engaged: false } },
      players: { A: player({ lifespan: 50, hand: [dejaVu()], effigyPool: [effigy('timeless', 1), effigy('timeless', 2), effigy('bleeding', 1)] }), B: player() },
    });
    const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dv-1#0' });
    const next = gameReducer(opened, { type: 'RESOLVE_DEJA_VU_TARGET', cellId: 'r1c1' });
    expect(next.pendingChoice).toBe(null);
    // 2 Timeless + 1 Faithless (paid by the one non-Timeless Effigy) spent.
    expect(next.players.A.effigyPool).toHaveLength(0);
    // A fresh summon: full printed Lifespan, engaged, When Summoned refired.
    expect(next.board.r1c1.type).toBe('being');
    expect(next.board.r1c1.card).toBe(being);
    expect(next.board.r1c1.currentLifespan).toBe(5);
    expect(next.board.r1c1.engaged).toBe(true);
    expect(next.players.A.lifespan).toBe(52);
    expect(next.log.some(e => e.message.includes('When Summoned triggers'))).toBe(true);
  });

  it('targeting a Deity adds the (2) additional Timeless surcharge and this is what makes it a legal target at all', () => {
    const deity = beingCard({
      instanceId: 'deity#0', name: 'Test Deity', kind: 'deity', isDeity: true, castingCost: { faithless: 0, colored: {} },
    });
    const state = baseState({
      board: { r1c1: { type: 'being', ownerId: 'A', card: deity, currentLifespan: 5, engaged: false } },
      // Only 2 Timeless available — not enough to also cover the Deity's (2) additional Timeless surcharge.
      players: { A: player({ hand: [dejaVu()], effigyPool: [effigy('timeless', 1), effigy('timeless', 2)] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING')).toBe(false);

    const funded = baseState({
      board: { r1c1: { type: 'being', ownerId: 'A', card: deity, currentLifespan: 5, engaged: false } },
      players: { A: player({ hand: [dejaVu()], effigyPool: [effigy('timeless', 1), effigy('timeless', 2), effigy('timeless', 3), effigy('timeless', 4)] }), B: player() },
    });
    const opened = gameReducer(funded, { type: 'CAST_CONJURING', instanceId: 'dv-1#0' });
    expect(opened.pendingChoice.allowedCells).toEqual(['r1c1']);
    const next = gameReducer(opened, { type: 'RESOLVE_DEJA_VU_TARGET', cellId: 'r1c1' });
    expect(next.players.A.effigyPool).toHaveLength(0); // all 4 Timeless spent (2 base + 2 surcharge)
    expect(next.board.r1c1.card).toBe(deity);
    expect(next.board.r1c1.engaged).toBe(false); // Deities enter disengaged, same as any other summon
  });
});

describe('Immen Gorta — "As an additional cost to summon, Sacrifice (2) Beings."', () => {
  const immenGorta = (overrides = {}) => beingCard({
    id: 'ig-1', instanceId: 'ig-1#0', name: 'Immen Gorta, the Boundless Hunger', kind: 'deity', isDeity: true,
    castingCost: { faithless: 0, colored: { formless: 5 } },
    keywords: { additionalSummonCostSacrificeBeings: 2 },
    ...overrides,
  });
  const fodder = (instanceId, name = 'Fodder') => beingCard({ instanceId, name });

  it('is not offered at all with fewer than 2 own Beings on board', () => {
    const state = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card: fodder('f1#0'), currentLifespan: 3, engaged: false } },
      players: { A: player({ hand: [immenGorta()], effigyPool: Array.from({ length: 5 }, (_, i) => effigy('formless', i)) }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'SUMMON_BEING' && a.instanceId === 'ig-1#0')).toBe(false);
  });

  it('summoning it pays the printed cost, then opens a summon-sacrifice-cost pendingChoice highlighting every own Being, without placing it yet', () => {
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: fodder('f1#0', 'Fodder One'), currentLifespan: 3, engaged: false },
        r2c2: { type: 'being', ownerId: 'A', card: fodder('f2#0', 'Fodder Two'), currentLifespan: 3, engaged: false },
      },
      players: { A: player({ hand: [immenGorta()], effigyPool: Array.from({ length: 5 }, (_, i) => effigy('formless', i)) }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'ig-1#0', cellId: 'r1c2' });
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.effigyPool).toHaveLength(0); // the 5 Formless summoning cost is already paid
    expect(next.board.r1c2).toBeUndefined(); // not placed yet — the additional cost isn't paid
    expect(next.pendingChoice.kind).toBe('summon-sacrifice-cost');
    expect(next.pendingChoice.amount).toBe(2);
    const legal = getLegalActions(next, 'A');
    expect(legal).toHaveLength(2);
    expect(legal.map(a => a.cellId).sort()).toEqual(['r2c1', 'r2c2']);
  });

  it('picking one Being just records the selection; picking the second sacrifices both and places Immen Gorta, retriggering When Summoned', () => {
    const withWhenSummoned = immenGorta({ keywords: { additionalSummonCostSacrificeBeings: 2, whenSummoned: 'Gain 2 Lifespan.' } });
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: fodder('f1#0', 'Fodder One'), currentLifespan: 3, engaged: false },
        r2c2: { type: 'being', ownerId: 'A', card: fodder('f2#0', 'Fodder Two'), currentLifespan: 3, engaged: false },
      },
      players: { A: player({ lifespan: 50, hand: [withWhenSummoned], effigyPool: Array.from({ length: 5 }, (_, i) => effigy('formless', i)) }), B: player() },
    });
    const opened = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'ig-1#0', cellId: 'r1c2' });
    const afterFirst = gameReducer(opened, { type: 'RESOLVE_SUMMON_SACRIFICE_COST', cellId: 'r2c1' });
    expect(afterFirst.pendingChoice.selected).toEqual(['r2c1']);
    expect(afterFirst.board.r2c1).toBeDefined(); // not sacrificed yet — only one of two picked
    expect(getLegalActions(afterFirst, 'A').map(a => a.cellId)).toEqual(['r2c2']); // already-picked cell no longer offered

    const next = gameReducer(afterFirst, { type: 'RESOLVE_SUMMON_SACRIFICE_COST', cellId: 'r2c2' });
    expect(next.pendingChoice).toBe(null);
    expect(next.board.r2c1).toBeUndefined();
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r1c2.type).toBe('being');
    expect(next.board.r1c2.card).toBe(withWhenSummoned);
    expect(next.board.r1c2.engaged).toBe(false); // Deities enter disengaged
    expect(next.players.A.lifespan).toBe(52); // its own When Summoned refired
    expect(next.log.some(e => e.message.includes('sacrifices Fodder One, Fodder Two'))).toBe(true);
  });

  it('refuses to double-count the same Being or an opponent\'s Being', () => {
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: fodder('f1#0', 'Fodder One'), currentLifespan: 3, engaged: false },
        r2c2: { type: 'being', ownerId: 'A', card: fodder('f2#0', 'Fodder Two'), currentLifespan: 3, engaged: false },
        r3c1: { type: 'being', ownerId: 'B', card: fodder('f3#0', 'Enemy'), currentLifespan: 3, engaged: false },
      },
      players: { A: player({ hand: [immenGorta()], effigyPool: Array.from({ length: 5 }, (_, i) => effigy('formless', i)) }), B: player() },
    });
    const opened = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'ig-1#0', cellId: 'r1c2' });
    const rejectedEnemy = gameReducer(opened, { type: 'RESOLVE_SUMMON_SACRIFICE_COST', cellId: 'r3c1' });
    expect(rejectedEnemy).toBe(opened);
    const afterFirst = gameReducer(opened, { type: 'RESOLVE_SUMMON_SACRIFICE_COST', cellId: 'r2c1' });
    const rejectedDupe = gameReducer(afterFirst, { type: 'RESOLVE_SUMMON_SACRIFICE_COST', cellId: 'r2c1' });
    expect(rejectedDupe).toBe(afterFirst);
  });
});

describe('"Target Being\'s Strength becomes (N) until end of turn" (Regress)', () => {
  const regress = (overrides = {}) => ({
    id: 'regress-1', instanceId: 'regress-1#0', name: 'Regress', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: "Target Being's Strength becomes (0) until end of turn.", ...overrides,
  });

  it('sets Strength to 0 for the rest of the turn, auto-resolving the only legal target', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target', strength: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: target },
      players: { A: player({ hand: [regress()] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'regress-1#0' });
    expect(effectiveStrength(next.board.r4c1)).toBe(0);
  });

  it('clears at end of turn, restoring the card\'s printed Strength', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target', strength: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: target },
      players: { A: player({ hand: [regress()] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'regress-1#0' });
    const afterEndTurn = gameReducer(afterCast, { type: 'PASS_TURN' });
    expect(effectiveStrength(afterEndTurn.board.r4c1)).toBe(5);
  });

  it('offers a choice among multiple Beings, either owner', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine', strength: 3 }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs', strength: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      players: { A: player({ hand: [regress()] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'regress-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'strength-set-eot', playerId: 'A', cardName: 'Regress', amount: 0 });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_STRENGTH_SET_EOT', cellId: 'r2c1' });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_STRENGTH_SET_EOT', cellId: 'r4c1' });
    const resolved = gameReducer(next, { type: 'RESOLVE_STRENGTH_SET_EOT', cellId: 'r4c1' });
    expect(effectiveStrength(resolved.board.r4c1)).toBe(0);
    expect(effectiveStrength(resolved.board.r2c1)).toBe(3);
    expect(resolved.pendingChoice).toBe(null);
  });
});

describe('"Return target Non-Deity Being you control to your hand" (Revoke)', () => {
  const revoke = (overrides = {}) => ({
    id: 'revoke-1', instanceId: 'revoke-1#0', name: 'Revoke', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: "Return target Non-Deity Being you control to your hand. Revoke can not target a Faithless Being.",
    ...overrides,
  });
  const coloredBeing = (overrides = {}) => beingCard({ castingCost: { faithless: 0, colored: { bleeding: 1 } }, ...overrides });

  it('returns the only legal Being (non-Deity, non-Faithless) to hand, auto-resolving', () => {
    const mine = { type: 'being', ownerId: 'A', card: coloredBeing({ instanceId: 'mine', name: 'Mine' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine },
      players: { A: player({ hand: [revoke()] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'revoke-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.hand.some(c => c.name === 'Mine')).toBe(true);
  });

  it('never offers a Faithless Being (no colored cost) or a Deity as a candidate', () => {
    const faithlessBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'faithless', castingCost: { faithless: 2, colored: {} } }), currentLifespan: 5, engaged: false };
    const deity = { type: 'being', ownerId: 'A', card: coloredBeing({ instanceId: 'deity', isDeity: true }), currentLifespan: 5, engaged: false };
    const legalOne = { type: 'being', ownerId: 'A', card: coloredBeing({ instanceId: 'legal', name: 'Legal' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: faithlessBeing, r2c2: deity, r2c3: legalOne },
      players: { A: player({ hand: [revoke()] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'revoke-1#0' });
    // Only one legal candidate (Legal) — auto-resolves rather than opening a choice.
    expect(next.pendingChoice).toBe(null);
    expect(next.players.A.hand.some(c => c.name === 'Legal')).toBe(true);
    expect(next.board.r2c1).toBeDefined();
    expect(next.board.r2c2).toBeDefined();
  });

  it('offers a choice among multiple legal Beings, dropping Armaments behind when returned', () => {
    const armament = { card: { id: 'arm', instanceId: 'arm#0', name: 'Test Arm', kind: 'relic-armament' }, engaged: false };
    const a = { type: 'being', ownerId: 'A', card: coloredBeing({ instanceId: 'a', name: 'A-being' }), currentLifespan: 5, engaged: false, armaments: [armament] };
    const b = { type: 'being', ownerId: 'A', card: coloredBeing({ instanceId: 'b', name: 'B-being' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: a, r2c2: b },
      players: { A: player({ hand: [revoke()] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'revoke-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'return-to-hand', playerId: 'A', cardName: 'Revoke' });
    const resolved = gameReducer(next, { type: 'RESOLVE_RETURN_TO_HAND', cellId: 'r2c1' });
    expect(resolved.players.A.hand.some(c => c.name === 'A-being')).toBe(true);
    expect(resolved.board.r2c1).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [armament] });
    expect(resolved.pendingChoice).toBe(null);
  });
});

describe('"Add (N) Essence of any type" (Conversion)', () => {
  const conversion = {
    id: 'conv-1', instanceId: 'conv-1#0', name: 'Conversion', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Add (1) Essence of any type.',
  };

  it('opens a color choice, and resolving grants that color to the pool', () => {
    const state = baseState({ players: { A: player({ hand: [conversion] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conv-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'choose-essence-color', playerId: 'A', cardName: 'Conversion', count: 1 });
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOOSE_ESSENCE_COLOR', color: 'living' });
    expect(resolved.players.A.effigyPool).toHaveLength(1);
    expect(resolved.players.A.effigyPool[0].effigyType).toBe('living');
    expect(resolved.pendingChoice).toBe(null);
  });
});

describe('"Sacrifice a Being you control: X" cost:effect (My Body as a Shield)', () => {
  const myBodyAsAShield = {
    id: 'mbaas-1', instanceId: 'mbaas-1#0', name: 'My Body as a Shield', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Sacrifice a Being you control: Target being becomes Favored until end of turn.',
  };

  it('sacrifices the only legal Being, then grants Favored to the only remaining target', () => {
    const toSac = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'toSac' }), currentLifespan: 5, engaged: false };
    const other = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'other' }), currentLifespan: 5, engaged: false, favorCounter: false };
    const state = baseState({
      board: { r2c1: toSac, r4c1: other },
      players: { A: player({ hand: [myBodyAsAShield] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'mbaas-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'toSac')).toBe(true);
    expect(next.board.r4c1.favorCounter).toBe(true);
  });

  it('opens a sacrifice choice among multiple Beings, then an independent Favored-target choice', () => {
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: a, r2c2: b },
      players: { A: player({ hand: [myBodyAsAShield] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'mbaas-1#0' });
    expect(next.pendingChoice.kind).toBe('sacrifice-being-cost');
    const afterSac = gameReducer(next, { type: 'RESOLVE_SACRIFICE_BEING_COST', cellId: 'r2c1' });
    expect(afterSac.board.r2c1).toBeUndefined();
    // Only "b" remains on the board — auto-resolves the Favored grant too.
    expect(afterSac.board.r2c2.favorCounter).toBe(true);
    expect(afterSac.pendingChoice).toBe(null);
  });
});

describe('"Sacrifice target <Typing>: X" — a typed sacrifice cost (Cannibalize)', () => {
  const cannibalize = {
    id: 'cann-1', instanceId: 'cann-1#0', name: 'Cannibalize', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Sacrifice target Hunger: Hungers you control disengage.',
  };
  const hungerBeing = (overrides = {}) => beingCard({ typing: 'Hunger, Being', ...overrides });

  it('sacrifices the only legal Hunger, then disengages every remaining Hunger the player controls', () => {
    const toSac = { type: 'being', ownerId: 'A', card: hungerBeing({ instanceId: 'toSac' }), currentLifespan: 5, engaged: true };
    const nonHunger = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'plain', typing: 'Turanga, Being' }), currentLifespan: 5, engaged: true };
    const state = baseState({
      board: { r2c1: toSac, r2c3: nonHunger },
      players: { A: player({ hand: [cannibalize] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'cann-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.board.r2c3.engaged).toBe(true); // not a Hunger — untouched
  });

  it('offers a choice among multiple Hungers to sacrifice, then disengages every remaining Hunger', () => {
    const a = { type: 'being', ownerId: 'A', card: hungerBeing({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'A', card: hungerBeing({ instanceId: 'b' }), currentLifespan: 5, engaged: true };
    const state = baseState({
      board: { r2c1: a, r2c2: b },
      players: { A: player({ hand: [cannibalize] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'cann-1#0' });
    expect(next.pendingChoice).toEqual({
      kind: 'sacrifice-typed-cost', playerId: 'A', cardName: 'Cannibalize', typing: 'Hunger',
      effectText: 'Hungers you control disengage.', label: 'effect', context: {},
    });
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE_TYPED_COST', cellId: 'r2c1' });
    expect(resolved.board.r2c1).toBeUndefined();
    expect(resolved.board.r2c2.engaged).toBe(false);
  });
});

describe('"All Beings are sent to Purgatory. Each player Crafts (1) Effigy card for each Being they controlled. Your turn ends." (Dust to Dust)', () => {
  const dustToDust = {
    id: 'dtd-1', instanceId: 'dtd-1#0', name: 'Dust to Dust', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'All Beings are sent to Purgatory. Each player Crafts (1) Effigy card for each Being they controlled.\nYour turn ends.',
  };

  it('wipes every Being, crafts each player Effigies scaled by how many they controlled, and ends the turn', () => {
    const aBeing1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a1' }), currentLifespan: 5, engaged: false };
    const aBeing2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a2' }), currentLifespan: 5, engaged: false };
    const bBeing1 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'b1' }), currentLifespan: 5, engaged: false };
    const relic = { type: 'relic', ownerId: 'B', card: { id: 'r', instanceId: 'r#0', name: 'Untouched Relic', kind: 'relic' } };
    const deckCard = (n) => ({ instanceId: `e${n}`, effigyType: 'bleeding' });
    const state = baseState({
      turnPlayer: 'A',
      board: { r2c1: aBeing1, r2c2: aBeing2, r4c1: bBeing1, r4c2: relic },
      players: {
        A: player({ hand: [dustToDust], effigyDeck: [deckCard(1), deckCard(2)] }),
        B: player({ effigyDeck: [deckCard(3)] }),
      },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dtd-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r4c1).toBeUndefined();
    expect(next.board.r4c2).toEqual(relic); // Relic untouched — only Beings wiped
    expect(next.players.A.purgatory.filter(c => ['a1', 'a2'].includes(c.instanceId))).toHaveLength(2);
    expect(next.players.B.purgatory.some(c => c.instanceId === 'b1')).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(2); // 2 Beings controlled
    expect(next.players.B.effigyPool).toHaveLength(1); // 1 Being controlled
    expect(next.turnPlayer).toBe('B'); // forced end of turn
  });
});

// Drives a "select a Being to move, then pick a direction" flow to
// completion regardless of exactly how many steps it takes (full
// auto-resolve, a single free-move choice, or select-move-source then
// free-move) — the board geometry from a given cell varies with its
// position, so these tests assert the *outcome* (the mover ends up
// somewhere new) rather than hardcoding which cell it lands on.
const driveToCompletion = (state, playerId) => {
  let cur = state;
  while (cur.pendingChoice) {
    const legal = getLegalActions(cur, playerId);
    expect(legal.length).toBeGreaterThan(0);
    cur = gameReducer(cur, legal[0]);
  }
  return cur;
};

describe('"Move target Being (1) tile in any direction" (Divine Winds)', () => {
  const divineWinds = {
    id: 'dw-1', instanceId: 'dw-1#0', name: 'Divine Winds', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Move target Being (1) tile in any direction.',
  };

  it('moves the targeted Being (either owner) somewhere new, resolving fully through however many steps it takes', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      players: { A: player({ hand: [divineWinds] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dw-1#0' });
    const resolved = driveToCompletion(next, 'A');
    expect(resolved.pendingChoice).toBe(null);
    const occupantNames = Object.values(resolved.board).filter(Boolean).map(o => o.card?.name);
    expect(occupantNames).toContain('Test Being'); // both started as "Test Being" — one of them moved, neither vanished
    const stillAtOrigin = (resolved.board.r2c1?.card?.instanceId === 'mine') + (resolved.board.r4c1?.card?.instanceId === 'theirs');
    expect(stillAtOrigin).toBe(1); // exactly one of the two stayed put — the other moved
  });

  it('logs a graceful no-op when no Being on the board has anywhere to move', () => {
    const state = baseState({
      board: {},
      players: { A: player({ hand: [divineWinds] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dw-1#0' });
    expect(next.log.some(e => e.message.includes('no legal Being to move'))).toBe(true);
    expect(next.pendingChoice).toBe(null);
  });
});

describe('"Target Being you control moves to a tile with an Armament on it" (Prepare for Battle)', () => {
  const prepareForBattle = {
    id: 'pfb-1', instanceId: 'pfb-1#0', name: 'Prepare for Battle', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Target Being you control moves to a tile with an Armament on it.',
  };

  it('only ever lands the Being on a tile that actually has a freestanding Armament', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [{ card: { id: 'a', instanceId: 'a#0', name: 'Test Arm', kind: 'relic-armament' }, engaged: false }] };
    const state = baseState({
      board: { r2c1: mine, r2c2: pile },
      players: { A: player({ hand: [prepareForBattle] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'pfb-1#0' });
    const resolved = driveToCompletion(next, 'A');
    expect(resolved.pendingChoice).toBe(null);
    expect(resolved.board.r2c1).toBeUndefined();
    expect(resolved.board.r2c2.card.instanceId).toBe('mine');
    expect(resolved.board.r2c2.armaments).toEqual(pile.armaments); // Armament picked up, not lost
  });

  it('never offers an opponent-controlled Being as a candidate', () => {
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    const pile = { type: 'armament-stack', ownerId: 'B', armaments: [{ card: { id: 'a', instanceId: 'a#0', name: 'Test Arm', kind: 'relic-armament' }, engaged: false }] };
    const state = baseState({
      board: { r4c1: theirs, r4c2: pile },
      players: { A: player({ hand: [prepareForBattle] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'pfb-1#0' });
    expect(next.log.some(e => e.message.includes('no legal Being'))).toBe(true);
    expect(next.board.r4c1).toEqual(theirs); // untouched
  });
});

describe('"Move target Being you control in any direction, then move target Being an opponent controls in any direction." (Echo chamber)', () => {
  const echoChamber = {
    id: 'echo-1', instanceId: 'echo-1#0', name: 'Echo chamber', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Move target Being you control in any direction, then move target Being an opponent controls in any direction.',
  };

  it('moves one Being of each player\'s, never the caster\'s own for the opponent half or vice versa', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      players: { A: player({ hand: [echoChamber] }), B: player() },
    });
    const afterFirst = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'echo-1#0' });
    const afterFirstResolved = driveToCompletion(afterFirst, 'A');
    // "then" has not yet been processed if a pendingChoice from the second clause is still open —
    // driveToCompletion above already resolves through everything, both clauses, in order.
    expect(afterFirstResolved.pendingChoice).toBe(null);
    const stillAtOriginMine = afterFirstResolved.board.r2c1?.card?.instanceId === 'mine';
    const stillAtOriginTheirs = afterFirstResolved.board.r4c1?.card?.instanceId === 'theirs';
    expect(stillAtOriginMine).toBe(false); // moved
    expect(stillAtOriginTheirs).toBe(false); // moved
  });
});

describe('"Shuffle your hand into your deck, then draw half that many cards rounded up." (Infinite Divisibility)', () => {
  const infiniteDivisibility = {
    id: 'id-1', instanceId: 'id-1#0', name: 'Infinite Divisibility', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Shuffle your hand into your deck, then draw half that many cards rounded up.',
  };

  it('shuffles the hand into the deck and draws ceil(handSize / 2)', () => {
    const hand = [1, 2, 3, 4, 5].map(n => ({ instanceId: `h${n}`, name: `Hand ${n}` }));
    const state = baseState({
      players: { A: player({ hand: [infiniteDivisibility, ...hand], mainDeck: [] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'id-1#0' });
    // 5 hand cards shuffled in; ceil(5/2) = 3 drawn back.
    expect(next.players.A.hand).toHaveLength(3);
    expect(next.players.A.mainDeck).toHaveLength(2);
    const allInstanceIds = [...next.players.A.hand, ...next.players.A.mainDeck].map(c => c.instanceId).sort();
    expect(allInstanceIds).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });
});

describe('"Engage target being, it has +2/+0 until end of turn." (Boknean Wine)', () => {
  const boknean = {
    id: 'bw-1', instanceId: 'bw-1#0', name: 'Boknean Wine', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Engage target being, it has +2/+0 until end of turn.',
  };

  it('engages the only legal disengaged Being and buffs its Strength until end of turn', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine', strength: 3 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine },
      players: { A: player({ hand: [boknean] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'bw-1#0' });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(effectiveStrength(next.board.r2c1)).toBe(5);
    const afterEndTurn = gameReducer(next, { type: 'PASS_TURN' });
    expect(effectiveStrength(afterEndTurn.board.r2c1)).toBe(3);
  });

  it('never offers an already-engaged Being as a candidate', () => {
    const already = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'already' }), currentLifespan: 5, engaged: true };
    const state = baseState({
      board: { r2c1: already },
      players: { A: player({ hand: [boknean] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'bw-1#0' });
    expect(next.log.some(e => e.message.includes('no disengaged Being'))).toBe(true);
  });

  // Regression: the printed text is "Engage target being..." — no "you
  // control" — unlike Acrobatic Escape's own explicit "target Being you
  // control" or Transplant's engage-as-a-self-cost shape. The old code
  // restricted candidates to the caster's own Beings, so this could never
  // actually target an opponent's — found while designing the
  // pre-resolution priority window (the user's own worked example:
  // engaging an opponent's Arbosalis Zealot before its own Engage ability
  // resolves needs this to be reachable at all).
  it('can target an opponent\'s own Being, not just the caster\'s', () => {
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs', strength: 1 }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r4c1: theirs },
      players: { A: player({ hand: [boknean] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'bw-1#0' });
    expect(next.board.r4c1.engaged).toBe(true);
    expect(effectiveStrength(next.board.r4c1)).toBe(3); // 1 + 2
  });

  it('offers a real choice across both players\' own disengaged Beings', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      players: { A: player({ hand: [boknean] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'bw-1#0' });
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'engage-buff-eot' }));
    const resolved = gameReducer(next, { type: 'RESOLVE_ENGAGE_BUFF_EOT', cellId: 'r4c1' });
    expect(resolved.board.r4c1.engaged).toBe(true);
    expect(resolved.board.r2c1.engaged).toBe(false); // untouched
  });
});

describe('"Engage target Treefolk, move it (1) tile in any direction." (Transplant)', () => {
  const transplant = {
    id: 'tp-1', instanceId: 'tp-1#0', name: 'Transplant', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Engage target Treefolk, move it (1) tile in any direction.',
  };

  it('engages and moves the only legal Treefolk somewhere new', () => {
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf', typing: 'Treefolk, Being' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: treefolk },
      players: { A: player({ hand: [transplant] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'tp-1#0' });
    const resolved = driveToCompletion(next, 'A');
    expect(resolved.pendingChoice).toBe(null);
    expect(resolved.board.r2c1).toBeUndefined();
    const moved = Object.values(resolved.board).find(o => o?.card?.instanceId === 'tf');
    expect(moved).toBeTruthy();
    expect(moved.engaged).toBe(true);
  });

  it('ignores a non-Treefolk Being entirely', () => {
    const plain = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'plain', typing: 'Turanga, Being' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: plain },
      players: { A: player({ hand: [transplant] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'tp-1#0' });
    expect(next.log.some(e => e.message.includes('no legal Treefolk'))).toBe(true);
    expect(next.board.r2c1).toEqual(plain);
  });
});

describe('Vine token summons (Ravenous Growth, Spreading Roots, Crawling Growth)', () => {
  it('Ravenous Growth: summons a Vine on the only legal empty tile the caster controls', () => {
    const ravenousGrowth = {
      id: 'rg-1', instanceId: 'rg-1#0', name: 'Ravenous Growth', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Summon a 0/2 Vine token on target empty tile you control.',
    };
    const state = baseState({ players: { A: player({ hand: [ravenousGrowth] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'rg-1#0' });
    const resolved = driveToCompletion(next, 'A');
    const vineCell = Object.entries(resolved.board).find(([, o]) => o?.card?.name === 'Vine');
    expect(vineCell).toBeTruthy();
  });

  it('Spreading Roots: auto-places 2 Vine tokens with no choice offered', () => {
    const spreadingRoots = {
      id: 'sr-1', instanceId: 'sr-1#0', name: 'Spreading Roots', kind: 'conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Summon (2) 0/2 vine being tokens on tiles you control.',
    };
    const state = baseState({ players: { A: player({ hand: [spreadingRoots] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'sr-1#0' });
    expect(next.pendingChoice).toBe(null);
    const vineCells = Object.values(next.board).filter(o => o?.card?.name === 'Vine');
    expect(vineCells).toHaveLength(2);
  });

  it('Crawling Growth: only offers empty tiles adjacent to an existing Vine the caster controls', () => {
    const crawlingGrowth = {
      id: 'cg-1', instanceId: 'cg-1#0', name: 'Crawling Growth', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Summon a 0/2 Vine token on an empty tile adjacent to another Vine you control.',
    };
    const existingVine = {
      type: 'being', ownerId: 'A',
      card: { id: 'vine', instanceId: 'vine#existing', name: 'Vine', kind: 'being', typing: 'Being, Token', isToken: true, castingCost: { faithless: 0, colored: {} }, strength: 0, lifespan: 2, timerMax: 0, arrows: [] },
      currentLifespan: 2, engaged: false,
    };
    const state = baseState({
      board: { r2c3: existingVine },
      players: { A: player({ hand: [crawlingGrowth] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'cg-1#0' });
    const resolved = driveToCompletion(next, 'A');
    expect(resolved.pendingChoice).toBe(null);
    const newVineCell = Object.entries(resolved.board).find(([cell, o]) => cell !== 'r2c3' && o?.card?.name === 'Vine');
    expect(newVineCell).toBeTruthy();
    const { row, col } = { row: parseInt(newVineCell[0][1], 10), col: parseInt(newVineCell[0][3], 10) };
    expect(Math.abs(row - 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(col - 3)).toBeLessThanOrEqual(1);
  });

  it('Crawling Growth: does nothing with no Vine already on the board', () => {
    const crawlingGrowth = {
      id: 'cg-1', instanceId: 'cg-1#0', name: 'Crawling Growth', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Summon a 0/2 Vine token on an empty tile adjacent to another Vine you control.',
    };
    const state = baseState({ players: { A: player({ hand: [crawlingGrowth] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'cg-1#0' });
    expect(next.log.some(e => e.message.includes('no empty tile adjacent'))).toBe(true);
  });
});

describe('"Sacrifice an Armament, then deal damage equal to it\'s total cost to any target." (Scrap Shot)', () => {
  const scrapShot = {
    id: 'ss-1', instanceId: 'ss-1#0', name: 'Scrap Shot', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: "Sacrifice an Armament, then deal damage equal to it's total cost to any target.",
  };
  const armamentEntry = (cost) => ({
    card: { id: 'arm', instanceId: 'arm#0', name: 'Test Arm', kind: 'relic-armament', castingCost: { faithless: cost, colored: {} } }, engaged: false,
  });

  it('sacrifices the only Armament and deals damage equal to its total cost, driving through the resulting "any target" choice', () => {
    const holder = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'holder' }), currentLifespan: 20, engaged: false, armaments: [armamentEntry(3)] };
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target' }), currentLifespan: 20, engaged: false };
    const state = baseState({
      board: { r2c1: holder, r4c1: target },
      players: { A: player({ hand: [scrapShot] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ss-1#0' });
    const resolved = driveToCompletion(next, 'A');
    expect(resolved.pendingChoice).toBe(null);
    expect(resolved.board.r2c1.armaments).toEqual([]);
    const totalDamageTaken = (20 - resolved.board.r2c1.currentLifespan) + (20 - resolved.board.r4c1.currentLifespan);
    expect(totalDamageTaken).toBe(3); // the sacrificed Armament's own cost
  });

  it('offers a choice among multiple Armaments, each dealing its own cost as damage', () => {
    const armA = { card: { ...armamentEntry(2).card, instanceId: 'arm-a#0' }, engaged: false };
    const armB = { card: { ...armamentEntry(4).card, instanceId: 'arm-b#0' }, engaged: false };
    const holder = {
      type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'holder' }), currentLifespan: 20, engaged: false,
      armaments: [armA, armB],
    };
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target' }), currentLifespan: 20, engaged: false };
    const state = baseState({
      board: { r2c1: holder, r4c1: target },
      players: { A: player({ hand: [scrapShot] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ss-1#0' });
    expect(next.pendingChoice.kind).toBe('sacrifice-armament-damage');
    const afterSac = gameReducer(next, { type: 'RESOLVE_SACRIFICE_ARMAMENT_DAMAGE', cellId: 'r2c1', armamentInstanceId: 'arm-b#0' });
    expect(afterSac.board.r2c1.armaments).toHaveLength(1);
    expect(afterSac.board.r2c1.armaments[0].card.instanceId).toBe('arm-a#0');
    const resolved = driveToCompletion(afterSac, 'A');
    const totalDamageTaken = (20 - resolved.board.r2c1.currentLifespan) + (20 - resolved.board.r4c1.currentLifespan);
    expect(totalDamageTaken).toBe(4); // arm-b's own cost
  });

  it('logs a graceful no-op with no Armament to sacrifice', () => {
    const state = baseState({ players: { A: player({ hand: [scrapShot] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ss-1#0' });
    expect(next.log.some(e => e.message.includes('no Armament to sacrifice'))).toBe(true);
  });
});

describe('"Discard your hand and Craft (3) Effigies. At the start of your next turn draw (1) additional card. Your Turn Ends." (All or nothing)', () => {
  const allOrNothing = {
    id: 'aon-1', instanceId: 'aon-1#0', name: 'All or nothing', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Discard your hand and Craft (3) Effigies.\nAt the start of your next turn draw (1) additional card.\nYour Turn Ends.',
  };
  const deckCard = (n) => ({ instanceId: `e${n}`, effigyType: 'bleeding' });

  it('discards the whole hand, crafts 3 Effigies, and ends the turn immediately', () => {
    const hand = [1, 2].map(n => ({ instanceId: `h${n}`, name: `Hand ${n}` }));
    const state = baseState({
      turnPlayer: 'A',
      players: {
        A: player({ hand: [allOrNothing, ...hand], effigyDeck: [deckCard(1), deckCard(2), deckCard(3)] }),
        B: player(),
      },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'aon-1#0' });
    expect(next.players.A.hand).toEqual([]);
    expect(next.players.A.purgatory.filter(c => ['h1', 'h2'].includes(c.instanceId))).toHaveLength(2);
    // A's own effigyDeck is now empty, so B's beginTurn (endTurn calls it
    // internally) can't also passively craft 1 more for A on top of these 3.
    expect(next.players.A.effigyPool).toHaveLength(3);
    expect(next.turnPlayer).toBe('B'); // forced end of turn
  });

  it('really draws an extra card at the start of the caster\'s next turn, one-shot', () => {
    const deck = [1, 2, 3].map(n => ({ instanceId: `d${n}`, name: `Deck ${n}` }));
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ hand: [allOrNothing], mainDeck: deck }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'aon-1#0' });
    expect(afterCast.players.A.extraDrawNextTurn).toBe(1);
    // B's turn happens in between (beginTurn for B doesn't touch A's flag).
    const bTurn = beginTurn(afterCast);
    expect(bTurn.players.A.extraDrawNextTurn).toBe(1);
    const aTurnAgain = beginTurn({ ...bTurn, turnPlayer: 'A', turnNumber: bTurn.turnNumber + 1 });
    expect(aTurnAgain.players.A.hand).toHaveLength(2); // 1 normal + 1 bonus
    expect(aTurnAgain.players.A.extraDrawNextTurn).toBe(0); // consumed
  });
});

describe('"Discard a card the next card you play this turn costs (-1) Faithless." (Lighten the Load)', () => {
  const lightenTheLoad = {
    id: 'ltl-1', instanceId: 'ltl-1#0', name: 'Lighten the Load', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Discard a card the next card you play this turn costs (-1) Faithless.',
  };

  it('discards the only other hand card and grants 1 temporary Faithless Essence', () => {
    const other = { instanceId: 'other#0', name: 'Other Card' };
    const state = baseState({ players: { A: player({ hand: [lightenTheLoad, other] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ltl-1#0' });
    expect(next.players.A.hand).toEqual([]);
    expect(next.players.A.purgatory.some(c => c.instanceId === 'other#0')).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.players.A.effigyPool[0].effigyType).toBe('faithless');
    expect(next.players.A.effigyPool[0].temporary).toBe(true);
  });

  it('offers a choice among multiple hand cards to discard', () => {
    const a = { instanceId: 'a#0', name: 'A' };
    const b = { instanceId: 'b#0', name: 'B' };
    const state = baseState({ players: { A: player({ hand: [lightenTheLoad, a, b] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ltl-1#0' });
    expect(next.pendingChoice.kind).toBe('discard-chosen-cost-reduction');
    const resolved = gameReducer(next, { type: 'RESOLVE_DISCARD_CHOSEN_COST_REDUCTION', instanceId: 'a#0' });
    expect(resolved.players.A.hand).toEqual([b]);
    expect(resolved.players.A.effigyPool).toHaveLength(1);
  });
});

describe('"Target Being gains (1) Time Counter and \'Can not move while this being has at least (1) Time Counter\'." (Moment of Doubt)', () => {
  const momentOfDoubt = {
    id: 'mod-1', instanceId: 'mod-1#0', name: 'Moment of Doubt', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Target Being gains (1) Time Counter and "Can not move while this being has at least (1) Time Counter".',
  };

  it('gives the only Being a Time Counter and blocks its own movement (but not attacking)', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target', arrows: [1, 2, 3] }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: target },
      players: { A: player({ hand: [momentOfDoubt] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'mod-1#0' });
    expect(afterCast.board.r4c1.counters).toEqual({ time: 1 });
    expect(afterCast.board.r4c1.blockedWhileHasTimeCounters).toBe(true);
    // Switch to B's own turn to check what's actually offered to them.
    const next = { ...afterCast, turnPlayer: 'B' };
    // No MOVE_OR_ATTACK (isAttack: false) offered for B any more.
    expect(getLegalActions(next, 'B').some(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r4c1' && !a.isAttack)).toBe(false);
    // Attacking (isAttack: true) is unaffected.
    expect(getLegalActions(next, 'B').some(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r4c1' && a.isAttack)).toBe(true);
    const attempt = gameReducer(next, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r4c2', direction: 3, isAttack: false });
    expect(attempt).toBe(next); // refused, no-op
  });
});

describe('"Flip a coin, If heads deal (1) damage to an enemy, if tails target opponent deals (1) damage where ever they want" (Ambiguity)', () => {
  const ambiguity = {
    id: 'amb-1', instanceId: 'amb-1#0', name: 'Ambiguity', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Flip a coin, If heads deal (1) damage to an enemy, if tails target opponent deals (1) damage where ever they want',
  };

  it('always damages exactly one Being for exactly 1, regardless of the flip', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    for (let i = 0; i < 20; i++) {
      const state = baseState({
        board: { r2c1: { ...mine }, r4c1: { ...theirs } },
        players: { A: player({ hand: [ambiguity] }), B: player() },
      });
      const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'amb-1#0' });
      const resolved = driveToCompletion(next, next.pendingChoice ? next.pendingChoice.playerId : 'A');
      const totalDamage = (5 - resolved.board.r2c1.currentLifespan) + (5 - resolved.board.r4c1.currentLifespan);
      expect(totalDamage).toBe(1);
    }
  });

  it('heads only ever targets an enemy Being, never the caster\'s own', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      players: { A: player({ hand: [ambiguity] }), B: player() },
    });
    // Force heads by stubbing Math.random low.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'amb-1#0' });
    spy.mockRestore();
    expect(next.board.r2c1.currentLifespan).toBe(5); // untouched
    expect(next.board.r4c1.currentLifespan).toBe(4); // hit
  });

  it('tails hands the choice to the opponent, over any Being (including the caster\'s own)', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mine' }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'theirs' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: mine, r4c1: theirs },
      players: { A: player({ hand: [ambiguity] }), B: player() },
    });
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9); // tails
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'amb-1#0' });
    spy.mockRestore();
    expect(next.pendingChoice).toEqual({ kind: 'damage-target', playerId: 'B', cardName: 'Ambiguity', damage: 1, typing: null });
  });
});

describe('"Reveal the top (3) cards of your deck, you may add any Seed Beings revealed in this way to hand, then shuffle your deck." (Aerate)', () => {
  const aerate = {
    id: 'aer-1', instanceId: 'aer-1#0', name: 'Aerate', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Reveal the top (3) cards of your deck, you may add any Seed Beings revealed in this way to hand, then shuffle your deck.',
  };

  it('adds every revealed Seed Being to hand and shuffles the rest back', () => {
    const seed = { instanceId: 's1', name: 'Seed Sprout', kind: 'being', typing: 'Seed, Being' };
    const other1 = { instanceId: 'o1', name: 'Other 1' };
    const other2 = { instanceId: 'o2', name: 'Other 2' };
    const rest = { instanceId: 'r1', name: 'Rest 1' };
    const state = baseState({
      players: { A: player({ hand: [aerate], mainDeck: [seed, other1, other2, rest] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'aer-1#0' });
    expect(next.players.A.hand).toEqual([seed]);
    expect(next.players.A.mainDeck).toHaveLength(3);
    const remainingIds = next.players.A.mainDeck.map(c => c.instanceId).sort();
    expect(remainingIds).toEqual(['o1', 'o2', 'r1']);
  });

  it('shuffles all 3 back with no Seed Beings revealed', () => {
    const cards = [1, 2, 3].map(n => ({ instanceId: `c${n}`, name: `Card ${n}` }));
    const state = baseState({ players: { A: player({ hand: [aerate], mainDeck: cards }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'aer-1#0' });
    expect(next.players.A.hand).toEqual([]);
    expect(next.players.A.mainDeck).toHaveLength(3);
  });

  it('also matches the real CSV\'s own misspelling ("revelaed" instead of "revealed")', () => {
    const misspelledAerate = { ...aerate, textBox: 'Reveal the top (3) cards of your deck, you may add any Seed Beings revelaed in this way to hand, then shuffle your deck.' };
    const seed = { instanceId: 's1', name: 'Seed Sprout', kind: 'being', typing: 'Seed, Being' };
    const state = baseState({ players: { A: player({ hand: [misspelledAerate], mainDeck: [seed] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'aer-1#0' });
    expect(next.players.A.hand).toEqual([seed]);
  });
});

describe('"Sacrifice (X) Beings: Add (X) Shifting Essence where (X) is the number of Beings sacrificed." (Death\'s Howl)', () => {
  const deathsHowl = {
    id: 'dh-1', instanceId: 'dh-1#0', name: "Death's Howl", kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Sacrifice (X) Beings: Add (X) Shifting Essence where (X) is the number of Beings sacrificed.',
  };

  it('opens a toggle choice; confirming with 2 selected sacrifices 2 and grants 2 Shifting Essence', () => {
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: a, r2c2: b },
      players: { A: player({ hand: [deathsHowl] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dh-1#0' });
    expect(next.pendingChoice.kind).toBe('sacrifice-any-beings-toggle');
    const t1 = gameReducer(next, { type: 'RESOLVE_SACRIFICE_ANY_BEINGS_TOGGLE', cellId: 'r2c1' });
    const t2 = gameReducer(t1, { type: 'RESOLVE_SACRIFICE_ANY_BEINGS_TOGGLE', cellId: 'r2c2' });
    const resolved = gameReducer(t2, { type: 'RESOLVE_SACRIFICE_ANY_BEINGS_CONFIRM' });
    expect(resolved.board.r2c1).toBeUndefined();
    expect(resolved.board.r2c2).toBeUndefined();
    expect(resolved.players.A.effigyPool).toHaveLength(2);
    expect(resolved.players.A.effigyPool.every(e => e.effigyType === 'shifting')).toBe(true);
  });

  it('confirming with 0 selected is legal and grants nothing', () => {
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: a },
      players: { A: player({ hand: [deathsHowl] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dh-1#0' });
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE_ANY_BEINGS_CONFIRM' });
    expect(resolved.board.r2c1).toEqual(a);
    expect(resolved.players.A.effigyPool).toEqual([]);
  });
});

describe('"Discard (X) Bag o\' Bones: Draw (X) Cards." (Deossification)', () => {
  const deossification = {
    id: 'deo-1', instanceId: 'deo-1#0', name: 'Deossification', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: "Discard (X) Bag o' Bones: Draw (X) Cards.",
  };

  it('discards the chosen Bag o\' Bones copies and draws that many', () => {
    const bones1 = { instanceId: 'bones1', name: "Bag o' Bones" };
    const bones2 = { instanceId: 'bones2', name: "Bag o' Bones" };
    const other = { instanceId: 'other', name: 'Other Card' };
    const deck = [1, 2].map(n => ({ instanceId: `d${n}`, name: `Deck ${n}` }));
    const state = baseState({
      players: { A: player({ hand: [deossification, bones1, bones2, other], mainDeck: deck }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'deo-1#0' });
    expect(next.pendingChoice.kind).toBe('discard-x-named-toggle');
    const t1 = gameReducer(next, { type: 'RESOLVE_DISCARD_X_NAMED_TOGGLE', instanceId: 'bones1' });
    const t2 = gameReducer(t1, { type: 'RESOLVE_DISCARD_X_NAMED_TOGGLE', instanceId: 'bones2' });
    const resolved = gameReducer(t2, { type: 'RESOLVE_DISCARD_X_NAMED_CONFIRM' });
    expect(resolved.players.A.hand.some(c => c.name === "Bag o' Bones")).toBe(false);
    expect(resolved.players.A.hand.some(c => c.instanceId === 'other')).toBe(true);
    expect(resolved.players.A.purgatory.filter(c => c.name === "Bag o' Bones")).toHaveLength(2);
    expect(resolved.players.A.mainDeck).toHaveLength(0);
  });

  it('logs a graceful no-op with no Bag o\' Bones in hand', () => {
    const state = baseState({ players: { A: player({ hand: [deossification] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'deo-1#0' });
    expect(next.log.some(e => e.message.includes("no Bag o' Bones"))).toBe(true);
  });
});

describe('"During the next Modulate Step, Time Counters are not removed." (Pause)', () => {
  const pause = {
    id: 'pause-1', instanceId: 'pause-1#0', name: 'Pause', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'During the next Modulate Step, Time Counters are not removed.',
  };

  it('skips the very next Modulate Step\'s Time Counter removal, for either player, then clears', () => {
    const prophecy = { type: 'prophecy', ownerId: 'B', card: { name: 'P' }, timer: 3, faceDown: true };
    const state = baseState({
      turnPlayer: 'A',
      board: { r3c1: prophecy },
      players: { A: player({ hand: [pause] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'pause-1#0' });
    expect(afterCast.skipNextModulate).toBe(true);
    const bTurn = beginTurn({ ...afterCast, turnPlayer: 'B' });
    expect(bTurn.board.r3c1.timer).toBe(3); // unchanged — skipped
    expect(bTurn.skipNextModulate).toBe(false); // consumed
    const bTurn2 = beginTurn({ ...bTurn, turnPlayer: 'B', turnNumber: bTurn.turnNumber + 1 });
    expect(bTurn2.board.r3c1.timer).toBe(2); // ticks normally now
  });
});

describe('"Target Engaged Being gains: (2) Time Counters and \'While this has at least (1) Time Counter, it does not Disengage during Disengage step\'" (Freeze Frame)', () => {
  const freezeFrame = {
    id: 'ff-1', instanceId: 'ff-1#0', name: 'Freeze Frame', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Target Engaged Being gains: (2) Time Counters and "While this has at least (1) Time Counter, it does not Disengage during Disengage step"',
  };

  it('gives the only Engaged Being 2 Time Counters and keeps it engaged through Disengage Step', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target' }), currentLifespan: 5, engaged: true };
    const state = baseState({
      board: { r4c1: target },
      players: { A: player({ hand: [freezeFrame] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ff-1#0' });
    expect(afterCast.board.r4c1.counters).toEqual({ time: 2 });
    expect(afterCast.board.r4c1.doesNotDisengageWhileHasTimeCounters).toBe(true);
    const bTurn = beginTurn({ ...afterCast, turnPlayer: 'B' });
    expect(bTurn.board.r4c1.engaged).toBe(true); // still engaged — the Time Counters kept it tapped
  });

  it('never offers a disengaged Being as a candidate', () => {
    const disengaged = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'idle' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: disengaged },
      players: { A: player({ hand: [freezeFrame] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ff-1#0' });
    expect(next.log.some(e => e.message.includes('no Engaged Being'))).toBe(true);
  });

  it('can target an Engaged Animated Armament acting as a Being (topmost of its own pile), writing visible Time Counters onto that entry', () => {
    const animatedTop = {
      card: { id: 'aa', instanceId: 'aa#0', name: 'Animated Armament', kind: 'relic-armament', keywords: { animated: true } },
      engaged: true, currentLifespan: 2,
    };
    const stack = { type: 'armament-stack', ownerId: 'B', armaments: [animatedTop] };
    const state = baseState({
      board: { r4c1: stack },
      players: { A: player({ hand: [freezeFrame] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ff-1#0' });
    expect(afterCast.board.r4c1.type).toBe('armament-stack');
    // Counters and the disengage-prevention flag land on the topmost
    // ARMAMENT ENTRY (where Board.jsx's CounterBadges actually reads them
    // from for this occupant shape), not the stack occupant itself.
    expect(afterCast.board.r4c1.armaments[0].counters).toEqual({ time: 2 });
    expect(afterCast.board.r4c1.armaments[0].doesNotDisengageWhileHasTimeCounters).toBe(true);
    const bTurn = beginTurn({ ...afterCast, turnPlayer: 'B' });
    expect(bTurn.board.r4c1.armaments[0].engaged).toBe(true); // still engaged — the Time Counters kept it tapped
  });
});

describe('"Restore (N) Lifespan" (Priestly Practitioner\'s own Engage) — targets any Being or player, not self-only', () => {
  const priestlyPractitioner = () => ({
    type: 'being', ownerId: 'A', card: beingCard({ name: 'Priestly Practitioner', keywords: { engage: 'Restore (2) Lifespan.' } }), engaged: false, currentLifespan: 5,
  });

  it('opens restore-lifespan-target instead of resolving as a bare self-gain', () => {
    const state = baseState({ board: { r2c1: priestlyPractitioner() }, players: { A: player({ lifespan: 40 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'restore-lifespan-target', playerId: 'A', cardName: 'Priestly Practitioner', label: 'Engage ability', amount: 2 });
    expect(next.players.A.lifespan).toBe(40); // unchanged — nothing resolves until a target is chosen
  });

  it('can target an opponent\'s own Being, not just the controller\'s side', () => {
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy#0' }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: priestlyPractitioner(), r4c1: enemy }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(getLegalActions(opened, 'A')).toContainEqual({ type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: 'r4c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: 'r4c1' });
    expect(resolved.board.r4c1.currentLifespan).toBe(3);
  });

  it('can target either player\'s own Lifespan directly, uncapped', () => {
    const state = baseState({ board: { r2c1: priestlyPractitioner() }, players: { A: player({ lifespan: 40 }), B: player({ lifespan: 50 }) } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER', targetPlayerId: 'B' });
    expect(resolved.players.B.lifespan).toBe(52);
  });
});

describe('"Shuffle a <query> into deck from your Purgatory" (Melting Clock)', () => {
  const meltingClock = {
    id: 'mc-1', instanceId: 'mc-1#0', name: 'Melting Clock', kind: 'relic',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Engage: Shuffle a Prophecy card into deck from your Purgatory.',
    keywords: { engage: 'Shuffle a Prophecy card into deck from your Purgatory.' },
  };

  it('shuffles the only matching Purgatory card back into the deck', () => {
    const prophecyCard = { instanceId: 'p1', name: 'Old Prophecy', kind: 'prophecy', typing: 'Prophecy' };
    const other = { instanceId: 'o1', name: 'Other', kind: 'being', typing: 'Turanga, Being' };
    const state = baseState({
      board: { r2c1: { type: 'relic', ownerId: 'A', card: meltingClock, engaged: false } },
      players: { A: player({ purgatory: [prophecyCard, other] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toEqual([other]);
    expect(next.players.A.mainDeck.some(c => c.instanceId === 'p1')).toBe(true);
  });
});

describe('"Shuffle a Faithless Being into deck from your Purgatory, then if you control only Faithless Cards draw (1) Card." (Temple of Dubiety)', () => {
  const templeOfDubiety = {
    id: 'tod-1', instanceId: 'tod-1#0', name: 'Temple of Dubiety', kind: 'relic',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Engage: Shuffle a Faithless Being into deck from your Purgatory, then if you control only Faithless Cards draw (1) Card.',
    keywords: { engage: 'Shuffle a Faithless Being into deck from your Purgatory, then if you control only Faithless Cards draw (1) Card.' },
  };
  const faithlessBeing = { instanceId: 'fb1', name: 'Faithless Guy', kind: 'being', typing: 'Turanga, Being', castingCost: { faithless: 2, colored: {} } };
  const coloredBeing = { instanceId: 'cb1', name: 'Colored Guy', kind: 'being', typing: 'Turanga, Being', castingCost: { faithless: 0, colored: { bleeding: 1 } } };

  it('shuffles the Faithless Being in and draws when only Faithless permanents are controlled', () => {
    const faithlessOnBoard = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'onboard', castingCost: { faithless: 1, colored: {} } }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: {
        r2c1: { type: 'relic', ownerId: 'A', card: templeOfDubiety, engaged: false },
        r2c2: faithlessOnBoard,
      },
      players: { A: player({ purgatory: [faithlessBeing], mainDeck: [{ instanceId: 'd1', name: 'Deck 1' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toEqual([]);
    // The shuffled-in card could itself be the one drawn back (real
    // shuffle randomness) — just confirm a real draw happened.
    expect(next.players.A.hand).toHaveLength(1);
    expect(next.log.some(e => e.message.includes('only Faithless permanents controlled'))).toBe(true);
  });

  it('shuffles in but does not draw when a non-Faithless permanent is also controlled', () => {
    const coloredOnBoard = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'onboard2', castingCost: { faithless: 0, colored: { bleeding: 1 } } }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: {
        r2c1: { type: 'relic', ownerId: 'A', card: templeOfDubiety, engaged: false },
        r2c2: coloredOnBoard,
      },
      players: { A: player({ purgatory: [faithlessBeing], mainDeck: [{ instanceId: 'd1', name: 'Deck 1' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toEqual([]);
    expect(next.players.A.hand.some(c => c.instanceId === 'd1')).toBe(false);
  });

  it('never picks a non-Faithless Being from Purgatory as a candidate', () => {
    const state = baseState({
      board: { r2c1: { type: 'relic', ownerId: 'A', card: templeOfDubiety, engaged: false } },
      players: { A: player({ purgatory: [coloredBeing] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toEqual([coloredBeing]); // untouched
    expect(next.log.some(e => e.message.includes('no Faithless Being'))).toBe(true);
  });

  it('offers a real choice — not an auto-pick — when 2+ Faithless Beings sit in Purgatory', () => {
    const otherFaithless = { instanceId: 'fb2', name: 'Other Faithless Guy', kind: 'being', typing: 'Turanga, Being', castingCost: { faithless: 1, colored: {} } };
    const state = baseState({
      board: { r2c1: { type: 'relic', ownerId: 'A', card: templeOfDubiety, engaged: false } },
      players: { A: player({ purgatory: [faithlessBeing, otherFaithless] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toEqual([faithlessBeing, otherFaithless]); // nothing auto-picked yet
    expect(next.pendingChoice).toEqual({
      kind: 'shuffle-purgatory-into-deck', playerId: 'A', cardName: 'Temple of Dubiety',
      label: 'Engage ability', source: 'purgatory-faithless-being', then: { drawCount: 1 },
    });
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: 'fb1' });
    expect(legal).toContainEqual({ type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: 'fb2' });
    const resolved = gameReducer(next, { type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: 'fb2' });
    expect(resolved.players.A.purgatory).toEqual([faithlessBeing]); // only the chosen one shuffled back
    expect(resolved.pendingChoice).toBeNull();
  });
});

describe('"Sacrifice a non Armament Relic: Add (1) Forge Counter to target Relic" (Smelt)', () => {
  const smelt = {
    id: 'smelt-1', instanceId: 'smelt-1#0', name: 'Smelt', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Sacrifice a non Armament Relic: Add (1) Forge Counter to target Relic',
  };

  it('sacrifices the only Relic and adds a Forge Counter to the only remaining Relic', () => {
    const toSac = { type: 'relic', ownerId: 'A', card: { id: 'r1', instanceId: 'r1#0', name: 'To Sac', kind: 'relic' }, engaged: false };
    const other = { type: 'relic', ownerId: 'B', card: { id: 'r2', instanceId: 'r2#0', name: 'Other Relic', kind: 'relic' }, engaged: false };
    const state = baseState({
      board: { r2c1: toSac, r4c1: other },
      players: { A: player({ hand: [smelt] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'smelt-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'r1#0')).toBe(true);
    expect(next.board.r4c1.counters).toEqual({ forge: 1 });
  });

  it('logs a graceful no-op with no Relic of the caster\'s own to sacrifice', () => {
    const state = baseState({ players: { A: player({ hand: [smelt] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'smelt-1#0' });
    expect(next.log.some(e => e.message.includes('no non-Armament Relic'))).toBe(true);
  });
});

describe('"Give target Being you control (+1/+1), reconjure this for each adjacent Being you control." (Vyu-bhata)', () => {
  const vyuBhata = {
    id: 'vb-1', instanceId: 'vb-1#0', name: 'Vyu-bhata', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Give target Being you control (+1/+1), reconjure this for each adjacent Being you control.',
  };

  it('applies +1/+1 alone with no adjacent Beings', () => {
    const lone = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'lone', strength: 2, lifespan: 3 }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r2c1: lone },
      players: { A: player({ hand: [vyuBhata] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'vb-1#0' });
    expect(effectiveStrength(next.board.r2c1)).toBe(3);
  });

  it('compounds an extra +1/+1 per adjacent Being the caster controls', () => {
    const target = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'target', strength: 2, lifespan: 3 }), currentLifespan: 3, engaged: false };
    const neighbor1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'n1' }), currentLifespan: 3, engaged: false };
    const neighbor2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'n2' }), currentLifespan: 3, engaged: false };
    const enemyNeighbor = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 3, engaged: false };
    // r2c2 is adjacent to r2c1 (same row, next column) and r1c2 (diagonal).
    const state = baseState({
      board: { r2c2: target, r2c1: neighbor1, r1c2: neighbor2, r4c2: enemyNeighbor },
      players: { A: player({ hand: [vyuBhata] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'vb-1#0' });
    // 3 own Beings on board (target, n1, n2) means a real choice of which to target.
    expect(afterCast.pendingChoice.kind).toBe('vyu-bhata-target');
    const next = gameReducer(afterCast, { type: 'RESOLVE_VYU_BHATA_TARGET', cellId: 'r2c2' });
    // 1 (base) + 2 (own adjacent Beings) = +3/+3. The non-adjacent enemy doesn't count either way.
    expect(effectiveStrength(next.board.r2c2)).toBe(5);
    expect(next.board.r2c2.currentLifespan).toBe(6); // Lifespan bonus heals immediately, same precedent as Lamtukka Gentleman
  });
});

// Phase 3(b) of the priority-window rework (see the approved plan): Strike
// Down was always meant to be cast reactively, mid-combat, before damage
// lands — a gap RULES.md's own Conjurings note used to document as "no
// instant-speed window yet." Now that a real attack-declaration window
// exists (declareAttackFrom/state.pendingResolution), both printed clauses
// are real: it destroys EXACTLY the Being currently blocking a real
// declared attack (never a broad "any front-row Being" search), and the
// attacker deals no damage at all once it resolves. Confirmed with the
// user: EITHER player may cast it, not just the attacker or just the
// defender.
describe('"Destroy target blocking Being, its controller is not dealt damage when it dies; the attacking Being deals no damage." (Strike Down)', () => {
  const strikeDown = (overrides = {}) => ({
    id: 'sd-1', instanceId: 'sd-1#0', name: 'Strike Down', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Destroy target blocking Being, its controller is not dealt damage when it dies; the attacking Being deals no damage.',
    ...overrides,
  });
  const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'attacker', strength: 4 }), currentLifespan: 5, engaged: false };
  const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'defender', lifespan: 6 }), currentLifespan: 6, engaged: false };

  it('is not offered (and does not resolve) with no attack currently declared', () => {
    const state = baseState({
      board: { r2c1: attacker, r4c1: defender },
      players: { A: player({ hand: [strikeDown()] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING')).toBe(false);
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'sd-1#0' });
    expect(next.board.r4c1).toEqual(defender); // untouched — the dispatch was rejected
  });

  it('is not offered when the declared attack has no real Being to destroy (an open lane)', () => {
    const state = baseState({
      turnPlayer: 'A', board: { r2c1: attacker },
      players: { A: player(), B: player({ hand: [strikeDown()], lifespan: 50 }) },
    });
    const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(declared.reactiveWindow).toBeNull(); // auto-closed — B has nothing real to cast
  });

  it('destroys exactly the blocking Being, with no death-Lifespan-damage to its controller, once cast reactively by the DEFENDER during the attack window', () => {
    const state = baseState({
      turnPlayer: 'A', board: { r2c1: attacker, r4c1: defender },
      players: { A: player(), B: player({ hand: [strikeDown()], lifespan: 50 }) },
    });
    const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(declared.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    // A has nothing more to add, so the window auto-closes and the
    // attack itself finally resolves within this SAME dispatch — the
    // attacker's own damage is fully negated (Strike Down's own
    // `noDamage: true` flag, stashed on the shared pendingResolution).
    const resolved = gameReducer(declared, { type: 'CAST_CONJURING', instanceId: 'sd-1#0' });
    expect(resolved.pendingResolution).toBeNull();
    expect(resolved.board.r4c1).toBeUndefined();
    expect(resolved.players.B.purgatory.some(c => c.instanceId === 'defender')).toBe(true);
    expect(resolved.players.B.lifespan).toBe(50); // no death-Lifespan-damage, no open-lane damage either
    expect(resolved.board.r2c1.currentLifespan).toBe(5); // attacker untouched, never took a hit back
  });

  it('the same negation works when cast reactively by the ATTACKER instead (either side may cast it)', () => {
    // The window opens for B first; B declines (has nothing), flipping
    // it back to A, who then casts Strike Down against B's own blocker.
    const conjuringForA = strikeDown({ instanceId: 'sd-a#0' });
    const state = baseState({
      turnPlayer: 'A', board: { r2c1: attacker, r4c1: defender },
      players: { A: player({ hand: [conjuringForA] }), B: player({ lifespan: 50 }) },
    });
    const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(declared.reactiveWindow).toBeNull(); // B has nothing — auto-closed already
    // Since B never got a real chance to hold priority open, simulate A
    // still holding it via a fresh reactiveWindow for this half of the
    // test (a separate real path: A could also cast it on their own
    // still-open declare-time window whenever B's own pass flips it back
    // in a real multi-response chain — covered structurally by the
    // "resolves atomically as a response" Engage/Conjuring tests above).
    const reopened = { ...state, reactiveWindow: { openFor: 'A' }, pendingResolution: { kind: 'attack', declaringPlayer: 'A', fromCellId: 'r2c1', cardName: 'Attacker' } };
    const resolved = gameReducer(reopened, { type: 'CAST_CONJURING', instanceId: 'sd-a#0' });
    expect(resolved.board.r4c1).toBeUndefined();
    expect(resolved.players.B.lifespan).toBe(50); // no death damage, no attack damage either
  });

  it('never targets a Being off the current attack\'s own lane, even if it belongs to the same defender', () => {
    const otherDefenderBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'other#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      turnPlayer: 'A', board: { r2c1: attacker, r4c1: defender, r4c2: otherDefenderBeing },
      players: { A: player(), B: player({ hand: [strikeDown()], lifespan: 50 }) },
    });
    const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    const resolved = gameReducer(declared, { type: 'CAST_CONJURING', instanceId: 'sd-1#0' });
    expect(resolved.board.r4c1).toBeUndefined(); // the actual blocker
    expect(resolved.board.r4c2).toEqual(otherDefenderBeing); // untouched — not part of this attack's own lane
  });
});

describe('"As an additonal cost to conjure: Pay Lifespan equal to the Lifespan of target engaged Being you control. That Being fights without engaging. Sacrifice it at the end of the turn." (Desperate Finale)', () => {
  const desperateFinale = {
    id: 'df-1', instanceId: 'df-1#0', name: 'Desperate Finale', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'As an additonal cost to conjure: Pay Lifespan equal to the Lifespan of target engaged Being you control.\nThat Being fights without engaging. \nSacrifice it at the end of the turn.',
    keywords: { conjureCost: 'Pay Lifespan equal to the Lifespan of target engaged Being you control.' },
  };

  it('is not offered without any engaged Being of the caster\'s own', () => {
    const state = baseState({ players: { A: player({ hand: [desperateFinale] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING')).toBe(false);
  });

  it('is not offered when the only engaged Being\'s own Lifespan would drop the caster to 0 or below', () => {
    const engagedBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'eng#0', strength: 3, lifespan: 5 }), currentLifespan: 5, engaged: true };
    const state = baseState({ board: { r2c1: engagedBeing }, players: { A: player({ hand: [desperateFinale], lifespan: 5 }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING')).toBe(false);
  });

  it('pays Lifespan equal to the target\'s own printed Lifespan, then it fights without engaging into an open lane', () => {
    const engagedBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'eng#0', strength: 3, lifespan: 5 }), currentLifespan: 5, engaged: true };
    const state = baseState({
      board: { r2c1: engagedBeing },
      players: { A: player({ hand: [desperateFinale], lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'df-1#0' });
    expect(next.players.A.lifespan).toBe(45); // 50 - 5 (the target's own printed Lifespan)
    expect(next.players.B.lifespan).toBe(47); // attacks into an open lane for its 3 Strength
    expect(next.board.r2c1.engaged).toBe(true); // still engaged — resolveAttackFrom re-taps it, same as any attack
    expect(next.board.r2c1.sacrificeAtEndOfTurn).toBe(true);
  });

  it('a target that dies fighting its own forced attack is not flagged for end-of-turn sacrifice — it\'s already gone', () => {
    const weakEngaged = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'weak#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: true };
    const strongDefender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'strong#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      board: { r2c1: weakEngaged, r4c1: strongDefender },
      players: { A: player({ hand: [desperateFinale], lifespan: 50 }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'df-1#0' });
    expect(next.board.r2c1).toBeUndefined(); // died in its own forced attack
    expect(next.players.A.purgatory.some(c => c.instanceId === 'weak#0')).toBe(true);
  });

  it('offers a choice among more than one legal engaged Being', () => {
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0', lifespan: 3 }), currentLifespan: 3, engaged: true };
    const b = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b#0', lifespan: 4 }), currentLifespan: 4, engaged: true };
    const state = baseState({
      board: { r2c1: a, r2c2: b },
      players: { A: player({ hand: [desperateFinale], lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'df-1#0' });
    expect(opened.pendingChoice).toEqual({ kind: 'desperate-finale-target', playerId: 'A', cardName: 'Desperate Finale' });
    const options = getLegalActions(opened, 'A').filter(o => o.type === 'RESOLVE_DESPERATE_FINALE_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c1', 'r2c2']);
    const next = gameReducer(opened, options.find(o => o.cellId === 'r2c2'));
    expect(next.players.A.lifespan).toBe(46); // paid b's own Lifespan (4)
    expect(next.board.r2c2.sacrificeAtEndOfTurn).toBe(true);
  });

  it('the flagged Being is sacrificed at end of turn via a real sacrifice, not a death (no owner Lifespan loss)', () => {
    const flagged = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'f#0', lifespan: 7 }), currentLifespan: 4, engaged: true, sacrificeAtEndOfTurn: true };
    const state = baseState({ turnPlayer: 'A', board: { r2c1: flagged }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = endTurn(state);
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'f#0')).toBe(true);
    expect(next.players.A.lifespan).toBe(49); // only the normal -1 Down Tick cost, no death-Lifespan-loss
  });

  it('does not sacrifice a Being without the flag at end of turn', () => {
    const plain = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'p#0' }), currentLifespan: 4, engaged: false };
    const state = baseState({ turnPlayer: 'A', board: { r2c1: plain }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = endTurn(state);
    expect(next.board.r2c1).toBeDefined();
  });
});

describe('"Sacrifice target Being add (2) Shifting Essence." (Martyrdom)', () => {
  const martyrdom = {
    id: 'mart-1', instanceId: 'mart-1#0', name: 'Martyrdom', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Sacrifice target Being add (2) Shifting Essence.',
  };

  it('sacrifices the only legal Being and grants 2 temporary Shifting Essence', () => {
    const toSac = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'toSac' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: toSac },
      players: { A: player({ hand: [martyrdom] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'mart-1#0' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'toSac')).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(2);
    expect(next.players.A.effigyPool.every(e => e.effigyType === 'shifting')).toBe(true);
  });

  it('offers a choice among multiple Beings to sacrifice', () => {
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r2c1: a, r2c2: b },
      players: { A: player({ hand: [martyrdom] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'mart-1#0' });
    expect(next.pendingChoice.kind).toBe('sacrifice-being-cost');
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE_BEING_COST', cellId: 'r2c1' });
    expect(resolved.board.r2c1).toBeUndefined();
    expect(resolved.players.A.effigyPool).toHaveLength(2);
  });
});

describe('"Whenever you conjure a Prophecy craft (1) Effigy." (Timeline Tinker)', () => {
  const tinker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tinker', keywords: { whenConjureProphecy: 'craft (1) Effigy' } }), currentLifespan: 2, engaged: false };
  const prophecyCard = { id: 'proph', instanceId: 'proph#0', name: 'A Prophecy', kind: 'prophecy', castingCost: { faithless: 0, colored: {} }, timerMax: 1, textBox: 'Gain (1) Time Counters.' };

  it('crafts 1 Effigy when its controller plays a Prophecy', () => {
    const state = baseState({
      board: { r2c1: tinker },
      players: { A: player({ hand: [prophecyCard], effigyPool: [], effigyDeck: [{ instanceId: 'e1', effigyType: 'timeless' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.log.some(e => e.message.includes('Whenever you conjure a Prophecy'))).toBe(true);
  });

  it('does not trigger off the opponent playing a Prophecy', () => {
    const opponentsTinker = { ...tinker, ownerId: 'B' };
    const state = baseState({
      board: { r2c1: opponentsTinker },
      players: { A: player({ hand: [prophecyCard], effigyDeck: [{ instanceId: 'e1', effigyType: 'timeless' }] }), B: player({ effigyPool: [] }) },
    });
    const next = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    expect(next.players.B.effigyPool).toHaveLength(0);
  });

  it('triggers once per copy when the controller has more than one', () => {
    const tinker2 = { ...tinker, card: beingCard({ instanceId: 'tinker2', keywords: { whenConjureProphecy: 'craft (1) Effigy' } }) };
    const state = baseState({
      board: { r2c1: tinker, r2c2: tinker2 },
      players: { A: player({ hand: [prophecyCard], effigyPool: [], effigyDeck: [{ instanceId: 'e1', effigyType: 'timeless' }, { instanceId: 'e2', effigyType: 'timeless' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    expect(next.players.A.effigyPool).toHaveLength(2);
  });
});

describe('"Target Non Deity Being loses all abilities until end of turn." (Drown out the Screams)', () => {
  const drown = {
    id: 'dr-1', instanceId: 'dr-1#0', name: 'Drown out the Screams', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Target Non Deity Being loses all abilities until end of turn.',
  };

  it('strips the only legal target\'s abilities but keeps its Strength/Lifespan', () => {
    const target = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'target', strength: 4, lifespan: 5, keywords: { engage: 'Deal (1) damage to target Being.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r4c1: target }, players: { A: player({ hand: [drown] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dr-1#0' });
    expect(next.board.r4c1.card.keywords).toEqual({});
    expect(next.board.r4c1.suppressedKeywords).toEqual({ engage: 'Deal (1) damage to target Being.' });
    expect(effectiveStrength(next.board.r4c1)).toBe(4); // Strength retained
    expect(next.board.r4c1.currentLifespan).toBe(5); // Lifespan retained
  });

  it('no longer offers the suppressed Being\'s Engage ability', () => {
    const target = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'target', keywords: { engage: 'Deal (1) damage to target Being.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: target }, players: { A: player({ hand: [drown] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dr-1#0' });
    const legal = getLegalActions(next);
    expect(legal.some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(false);
  });

  it('restores the original abilities at end of turn', () => {
    const target = {
      type: 'being', ownerId: 'A',
      card: { ...beingCard({ instanceId: 'target' }), keywords: {} },
      suppressedKeywords: { engage: 'Deal (1) damage to target Being.' },
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: target } });
    const next = endTurn(state);
    expect(next.board.r2c1.card.keywords).toEqual({ engage: 'Deal (1) damage to target Being.' });
    expect(next.board.r2c1.suppressedKeywords).toBeUndefined();
  });

  it('never targets a Deity, and offers a choice among multiple legal targets', () => {
    const deity = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'deity', isDeity: true }), currentLifespan: 5, engaged: false };
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'b' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r5c1: deity, r2c1: a, r4c1: b }, players: { A: player({ hand: [drown] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dr-1#0' });
    expect(next.pendingChoice.kind).toBe('drown-screams-target');
    const legal = getLegalActions(next);
    expect(legal.some(a2 => a2.type === 'RESOLVE_DROWN_SCREAMS_TARGET' && a2.cellId === 'r5c1')).toBe(false);
    const resolved = gameReducer(next, { type: 'RESOLVE_DROWN_SCREAMS_TARGET', cellId: 'r2c1' });
    expect(resolved.board.r2c1.card.keywords).toEqual({});
  });
});

describe('"Target Being loses all abilities and becomes a 0/5 TreeFolk Being until end of turn." (Dendrify)', () => {
  const dendrify = {
    id: 'dn-1', instanceId: 'dn-1#0', name: 'Dendrify', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Target Being loses all abilities and becomes a 0/5 TreeFolk Being until end of turn.',
  };

  it('overrides the only legal target\'s Strength/Lifespan and strips its abilities', () => {
    const target = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'target', strength: 6, lifespan: 3, keywords: { engage: 'Deal (1) damage to target Being.' } }),
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ board: { r4c1: target }, players: { A: player({ hand: [dendrify] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dn-1#0' });
    expect(next.board.r4c1.card.keywords).toEqual({});
    expect(effectiveStrength(next.board.r4c1)).toBe(0);
    expect(deathDamageFor(next.board.r4c1)).toBe(5);
  });

  it('keeps existing damage (does not heal back up to the new Lifespan ceiling)', () => {
    const target = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'target', strength: 6, lifespan: 8 }),
      currentLifespan: 2, engaged: false, // already damaged down to 2 out of a printed 8
    };
    const state = baseState({ board: { r4c1: target }, players: { A: player({ hand: [dendrify] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dn-1#0' });
    expect(next.board.r4c1.currentLifespan).toBe(2); // not healed to 5
  });

  it('turns Horological Horror into a real 0/5 instead of killing it — Dendrify suppresses xEqualsTimeCountersControlled in the same step, which must not also re-derive its live X as 0 and deal lethal damage', () => {
    const horror = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'horror', name: 'Horological Horror', strength: 0, lifespan: 0, keywords: { xEqualsTimeCountersControlled: true } }),
      currentLifespan: 6, strengthOverride: 6, engaged: false, // a live X of 6 from some Time Counters in play
    };
    const state = baseState({ board: { r4c1: horror }, players: { A: player({ hand: [dendrify] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dn-1#0' });
    expect(next.board.r4c1).toBeDefined(); // still alive, not routed through death
    expect(next.board.r4c1.card.name).toBe('Horological Horror');
    expect(effectiveStrength(next.board.r4c1)).toBe(0);
    expect(next.board.r4c1.currentLifespan).toBe(5);
    expect(next.players.B.purgatory).toHaveLength(0); // never died
  });

  it('restores original Strength/Lifespan/abilities at end of turn', () => {
    const target = {
      type: 'being', ownerId: 'A',
      card: { ...beingCard({ instanceId: 'target', strength: 6, lifespan: 8 }), keywords: {} },
      suppressedKeywords: {},
      strengthSetUntilEndOfTurn: 0, lifespanSetUntilEndOfTurn: 5,
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: target } });
    const next = endTurn(state);
    expect(next.board.r2c1.strengthSetUntilEndOfTurn).toBeUndefined();
    expect(next.board.r2c1.lifespanSetUntilEndOfTurn).toBeUndefined();
    expect(effectiveStrength(next.board.r2c1)).toBe(6);
    expect(deathDamageFor(next.board.r2c1)).toBe(8);
  });

  it('offers a choice among multiple legal targets (either owner)', () => {
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a' }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'b' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: a, r4c1: b }, players: { A: player({ hand: [dendrify] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dn-1#0' });
    expect(next.pendingChoice.kind).toBe('dendrify-target');
    const resolved = gameReducer(next, { type: 'RESOLVE_DENDRIFY_TARGET', cellId: 'r4c1' });
    expect(effectiveStrength(resolved.board.r4c1)).toBe(0);
    expect(resolved.board.r2c1).toEqual(a); // untouched
  });
});

describe('Being Engage with a counter cost (Void Channeler) — not offered/dispatchable without enough Counters', () => {
  const voidChanneler = () => ({
    id: 'vc-1', instanceId: 'vc-1#0', name: 'Void Channeler', kind: 'being',
    castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 3, timerMax: 0, arrows: [1],
    textBox: 'Gain (1) Crossing Counter each time you Conjure.\nRemove (3) Crossing Counters, Engage: Add a Formless Being to hand from deck.',
    keywords: { engageCounterCost: { type: 'crossing', amount: 3 }, engage: 'Add a Formless Being to hand from deck.' },
  });

  it('is not offered by getLegalActions with fewer than the required Counters — self-play found this staying "legal" forever otherwise, an AI infinite loop', () => {
    const occupant = { type: 'being', ownerId: 'A', card: voidChanneler(), currentLifespan: 3, engaged: false, counters: { crossing: 2 } };
    const state = baseState({ board: { r2c1: occupant }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(false);
    // Even a direct dispatch stays a no-op — matches the reducer's own
    // pre-existing counter-cost gate, which this offer-side fix now agrees with.
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('is offered once enough Counters are banked, and really engages', () => {
    const occupant = { type: 'being', ownerId: 'A', card: voidChanneler(), currentLifespan: 3, engaged: false, counters: { crossing: 3 } };
    const state = baseState({ board: { r2c1: occupant }, players: { A: player({ mainDeck: [beingCard({ instanceId: 'formless#0', typing: 'Formless, Being' })] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.board.r2c1.counters.crossing).toBe(0);
  });
});

describe('Relic Engage fixes: Ferryman\'s Boat, Claws of Onoushara, Pruning Sheers', () => {
  it('Ferryman\'s Boat: "Sacrifice a Being on a tile this points to" sacrifices only a pointed-to Being', () => {
    // Arrow direction 3 (right) from r2c1, for player A, resolves to r2c2 —
    // a legal Mortal Realm cell (dir 1/forward would cross the blocked
    // Ethereal Realm from this row).
    const ferrymansBoat = {
      id: 'fb-1', instanceId: 'fb-1#0', name: "Ferryman's Boat", kind: 'relic',
      castingCost: { faithless: 0, colored: {} }, arrows: [3],
      textBox: "When summoned gain (2) Crossing Counters.\nRemove (1) Crossing Counter, Engage: Sacrifice a Being on a tile this points to.",
      keywords: { engageCounterCost: { type: 'crossing', amount: 1 }, engage: 'Sacrifice a Being on a tile this points to.' },
    };
    const pointedBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'pointed' }), currentLifespan: 5, engaged: false };
    const notPointedBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'notpointed' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: {
        r2c1: { type: 'relic', ownerId: 'A', card: ferrymansBoat, engaged: false, counters: { crossing: 1 } },
        r2c2: pointedBeing,
        r4c1: notPointedBeing,
      },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r4c1).toEqual(notPointedBeing); // untouched
  });

  it('Claws of Onoushara: "Sacrifice a Being on this tile, then draw cards equal to it\'s Lifespan" draws the sacrificed Being\'s printed Lifespan', () => {
    const claws = {
      id: 'co-1', instanceId: 'co-1#0', name: 'Claws of Onoushara', kind: 'relic',
      castingCost: { faithless: 0, colored: {} },
      textBox: "Engage: Sacrifice a Being on this tile, then draw cards equal to it's Lifespan.\nBeings may move across this.",
      keywords: { engage: "Sacrifice a Being on this tile, then draw cards equal to it's Lifespan.", beingsMayMoveAcross: true },
    };
    const coLocatedBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'colocated', lifespan: 3 }), currentLifespan: 3, engaged: false };
    const deck = [1, 2, 3].map(n => ({ instanceId: `d${n}`, name: `Deck ${n}` }));
    const state = baseState({
      board: { r2c1: coLocatedBeing },
      groundRelics: { r2c1: { type: 'relic', ownerId: 'A', card: claws, engaged: false } },
      players: { A: player({ mainDeck: deck }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.hand).toHaveLength(3); // 3 == the sacrificed Being's printed Lifespan
  });

  it('Pruning Sheers: sacrifices only a legal typed, cost-limited Being and gains 5 Lifespan', () => {
    const pruningSheers = {
      id: 'ps-1', instanceId: 'ps-1#0', name: 'Pruning Sheers', kind: 'relic',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Engage: Sacrifice a TreeFolk, Vine, or Seed you control that costs (2) or less, then gain (5) Lifespan.',
      keywords: { engage: 'Sacrifice a TreeFolk, Vine, or Seed you control that costs (2) or less, then gain (5) Lifespan.' },
    };
    const cheapVine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'vine', typing: 'Vine, Being', castingCost: { faithless: 1, colored: {} } }), currentLifespan: 2, engaged: false };
    const expensiveTreefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf', typing: 'TreeFolk, Being', castingCost: { faithless: 3, colored: {} } }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: {
        r2c1: { type: 'relic', ownerId: 'A', card: pruningSheers, engaged: false },
        r2c2: cheapVine,
        r2c3: expensiveTreefolk,
      },
      players: { A: player({ lifespan: 40 }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c2).toBeUndefined(); // the cheap Vine was sacrificed
    expect(next.board.r2c3).toEqual(expensiveTreefolk); // too expensive — untouched
    expect(next.players.A.lifespan).toBe(45);
  });
});

describe('"Discard a <Kind>: Draw (N) cards" — a colon cost:effect, not a "then" chain (Scrap Removal)', () => {
  const scrapRemoval = (overrides = {}) => ({
    id: 'scrap-1', instanceId: 'scrap-1#0', name: 'Scrap Removal', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Discard a Relic: Draw (2) cards.', ...overrides,
  });
  const relicCard = (overrides = {}) => ({ instanceId: 'relic-1#0', name: 'Test Relic', kind: 'relic', ...overrides });

  it('requires discarding a Relic from hand before drawing, when exactly one is available', () => {
    const relic = relicCard();
    const drawn = [{ instanceId: 'd1', name: 'Drawn 1' }, { instanceId: 'd2', name: 'Drawn 2' }];
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval(), relic], mainDeck: drawn }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.players.A.hand.some(c => c.name === 'Test Relic')).toBe(false);
    expect(next.players.A.purgatory.some(c => c.name === 'Test Relic')).toBe(true);
    expect(next.players.A.hand.filter(c => c.kind !== 'relic')).toHaveLength(2);
    expect(next.players.A.mainDeck).toHaveLength(0);
  });

  it('does not draw at all when no Relic is in hand to discard', () => {
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval()], mainDeck: [{ instanceId: 'd1', name: 'Drawn 1' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.mainDeck).toHaveLength(1);
    expect(next.log.some(e => e.message.includes('no Relic to discard'))).toBe(true);
  });

  it('opens a choice when multiple Relics are in hand, and only discards the chosen one', () => {
    const relicA = relicCard({ instanceId: 'relic-a', name: 'Relic A' });
    const relicB = relicCard({ instanceId: 'relic-b', name: 'Relic B' });
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval(), relicA, relicB], mainDeck: [] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.pendingChoice).toEqual({
      kind: 'discard-kind-draw', playerId: 'A', cardName: 'Scrap Removal', label: 'effect', discardKind: 'relic', drawCount: 2,
    });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DISCARD_KIND_DRAW', instanceId: 'relic-a' });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DISCARD_KIND_DRAW', instanceId: 'relic-b' });
    const resolved = gameReducer(next, { type: 'RESOLVE_DISCARD_KIND_DRAW', instanceId: 'relic-a' });
    expect(resolved.players.A.hand.some(c => c.instanceId === 'relic-a')).toBe(false);
    expect(resolved.players.A.hand.some(c => c.instanceId === 'relic-b')).toBe(true);
    expect(resolved.players.A.purgatory.some(c => c.instanceId === 'relic-a')).toBe(true);
    expect(resolved.pendingChoice).toBe(null);
  });

  it('also accepts a Relic-Armament in hand as "a Relic" to discard', () => {
    const relicArmament = { instanceId: 'ra-1#0', name: 'Test Armament', kind: 'relic-armament' };
    const drawn = [{ instanceId: 'd1', name: 'Drawn 1' }, { instanceId: 'd2', name: 'Drawn 2' }];
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval(), relicArmament], mainDeck: drawn }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.players.A.purgatory.some(c => c.instanceId === 'ra-1#0')).toBe(true);
    expect(next.players.A.hand.filter(c => c.kind !== 'relic-armament')).toHaveLength(2);
  });

  it('also accepts a Relic-Being in hand as "a Relic" to discard', () => {
    const relicBeing = { instanceId: 'rb-1#0', name: 'Test Relic-Being', kind: 'being', isRelicBeing: true };
    const drawn = [{ instanceId: 'd1', name: 'Drawn 1' }, { instanceId: 'd2', name: 'Drawn 2' }];
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval(), relicBeing], mainDeck: drawn }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.players.A.purgatory.some(c => c.instanceId === 'rb-1#0')).toBe(true);
    expect(next.players.A.hand.filter(c => c.instanceId !== 'rb-1#0')).toHaveLength(2);
  });

  it('never treats a plain Being (not a Relic-Being) as a Relic to discard', () => {
    const plainBeing = { instanceId: 'pb-1#0', name: 'Plain Being', kind: 'being', isRelicBeing: false };
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval(), plainBeing], mainDeck: [{ instanceId: 'd1', name: 'Drawn 1' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.log.some(e => e.message.includes('no Relic to discard'))).toBe(true);
    expect(next.players.A.hand.some(c => c.instanceId === 'pb-1#0')).toBe(true); // untouched
  });

  it('offers a real choice across a mix of plain Relic, Relic-Armament, and Relic-Being — no random pick', () => {
    const relic = relicCard({ instanceId: 'relic-a' });
    const relicArmament = { instanceId: 'ra-1#0', name: 'Test Armament', kind: 'relic-armament' };
    const relicBeing = { instanceId: 'rb-1#0', name: 'Test Relic-Being', kind: 'being', isRelicBeing: true };
    const state = baseState({
      players: { A: player({ hand: [scrapRemoval(), relic, relicArmament, relicBeing], mainDeck: [] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'scrap-1#0' });
    expect(next.pendingChoice.kind).toBe('discard-kind-draw');
    const legal = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_DISCARD_KIND_DRAW');
    expect(legal.map(a => a.instanceId).sort()).toEqual(['ra-1#0', 'rb-1#0', 'relic-a']);
  });
});

describe('"Add X to hand from Purgatory, if you control <Name> you may add Y instead" (Fetch)', () => {
  const fetch = (overrides = {}) => ({
    id: 'fetch-1', instanceId: 'fetch-1#0', name: 'Fetch', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: "Add a Bag o' Bones to hand from your Purgatory, if you control Cookie you may add an Undead instead.",
    ...overrides,
  });

  it('searches for the default target when the named card is not controlled', () => {
    const purgatory = [{ instanceId: 'bones#0', name: "Bag o' Bones", typing: 'Undead' }];
    const state = baseState({
      players: { A: player({ hand: [fetch()], purgatory }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'fetch-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: "Bag o' Bones", cardName: 'Fetch' });
  });

  it('upgrades to the named target when the required card is controlled (Cookie on board)', () => {
    const cookie = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Cookie', instanceId: 'cookie#0' }), currentLifespan: 5, engaged: false };
    const purgatory = [{ instanceId: 'zombie#0', name: 'Zombie', typing: 'Undead' }];
    const state = baseState({
      board: { r3c1: cookie },
      players: { A: player({ hand: [fetch()], purgatory }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'fetch-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: 'Undead', cardName: 'Fetch' });
  });
});

describe('"Add X to hand from deck" search effects', () => {
  const armamentInDeck = (n) => ({
    id: `arm-deck-${n}`, instanceId: `arm-deck-${n}#0`, name: `Deck Armament ${n}`,
    kind: 'relic-armament', typing: 'Relic - Armament',
  });
  const conjuringCard = (overrides = {}) => ({
    id: 'conj-1', instanceId: 'conj-1#0', name: 'Blacksmithing', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Add an Armament to hand from deck.', ...overrides,
  });

  it('CAST_CONJURING with a matching search parks the game on pendingChoice instead of logging "not automated"', () => {
    const state = baseState({
      players: { A: player({ hand: [conjuringCard()], mainDeck: [armamentInDeck(1), armamentInDeck(2)] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', cardName: 'Blacksmithing' });
    expect(next.log.some(e => e.message.includes('isn\'t automated yet'))).toBe(false);
    expect(next.log.some(e => e.message.includes('searches A\'s deck for "Armament"'))).toBe(true);
  });

  it('logs that nothing was found when the deck has no matching card, without setting pendingChoice', () => {
    const state = baseState({ players: { A: player({ hand: [conjuringCard()], mainDeck: [] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('finds no "Armament"'))).toBe(true);
  });

  it('flavor text (a fully quoted line, with or without attribution) is stripped from effect resolution', () => {
    const card = conjuringCard({ textBox: 'Gain 1 Lifespan.\n"Add an Armament to hand from deck." - Ancient Proverb' });
    const state = baseState({ players: { A: player({ hand: [card], mainDeck: [armamentInDeck(1)], lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    // The quoted flavor line never triggers the search-from-deck pattern it
    // superficially resembles — only the real first line (Gain 1 Lifespan)
    // resolves, for real.
    expect(next.pendingChoice).toBeNull();
    expect(next.players.A.lifespan).toBe(51);
  });

  it('also recognizes the reversed word order ("Add X from deck to hand")', () => {
    const card = conjuringCard({ textBox: 'Add an Armament from deck to hand.' });
    const state = baseState({ players: { A: player({ hand: [card], mainDeck: [armamentInDeck(1)] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'conj-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', cardName: 'Blacksmithing' });
  });

  it('also recognizes "from YOUR deck" (Seed of Divinity), and a leading Effigy-color word filters by color, not typing', () => {
    const card = { id: 'sod', instanceId: 'sod#0', name: 'Seed of Divinity', kind: 'being',
      castingCost: { faithless: 0, colored: {} }, keywords: { martyr: 'Add a Living Deity to hand from your deck' } };
    const livingDeity = { id: 'crathea', instanceId: 'crathea#0', name: 'Crathea', kind: 'deity', typing: 'Deity, Being', effigyType: 'living' };
    const shiftingDeity = { id: 'other', instanceId: 'other#0', name: 'Other Deity', kind: 'deity', typing: 'Deity, Being', effigyType: 'shifting' };
    const state = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card, currentLifespan: 3, engaged: false } },
      players: { A: player({ mainDeck: [livingDeity, shiftingDeity] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Deity', colorFilter: 'living', cardName: 'Seed of Divinity' });
    const legal = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_CHOICE');
    expect(legal).toEqual([{ type: 'RESOLVE_CHOICE', instanceId: 'crathea#0' }]); // only the Living one, not the Shifting one
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'crathea#0' });
    expect(resolved.players.A.hand.map(c => c.instanceId)).toEqual(['crathea#0']);
  });

  describe('RESOLVE_CHOICE', () => {
    it('moves the chosen card from the search source into hand and clears pendingChoice', () => {
      const state = baseState({
        pendingChoice: { kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', cardName: 'Blacksmithing' },
        players: { A: player({ mainDeck: [armamentInDeck(1), armamentInDeck(2)] }), B: player() },
      });
      const next = gameReducer(state, { type: 'RESOLVE_CHOICE', instanceId: 'arm-deck-2#0' });
      expect(next.pendingChoice).toBeNull();
      expect(next.players.A.hand).toEqual([armamentInDeck(2)]);
      expect(next.players.A.mainDeck).toEqual([armamentInDeck(1)]);
    });

    it('is the only legal action for the searching player while a choice is pending', () => {
      const state = baseState({
        pendingChoice: { kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', cardName: 'Blacksmithing' },
        players: { A: player({ mainDeck: [armamentInDeck(1)] }), B: player() },
      });
      const actionsForA = getLegalActions(state, 'A');
      expect(actionsForA).toEqual([{ type: 'RESOLVE_CHOICE', instanceId: 'arm-deck-1#0' }]);
      expect(getLegalActions(state, 'B')).toEqual([]);
    });

    it('blocks unrelated actions (e.g. PASS_TURN) while a choice is pending', () => {
      const state = baseState({
        pendingChoice: { kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', cardName: 'Blacksmithing' },
        players: { A: player({ mainDeck: [armamentInDeck(1)] }), B: player() },
      });
      const next = gameReducer(state, { type: 'PASS_TURN' });
      expect(next).toBe(state);
    });
  });
});

describe('ACTIVATE_MARTYR', () => {
  it('engages and sacrifices the Being, logging its captured effect text and really granting the Lifespan', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { martyr: 'Gain 1 Lifespan.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory).toHaveLength(1);
    expect(next.log.some(e => e.message.includes('sacrifices Test Being for Martyr'))).toBe(true);
    expect(next.log.some(e => e.message.includes('Martyr triggers'))).toBe(true);
    expect(next.players.A.lifespan).toBe(51); // Martyr's sacrifice itself deals no death-damage
  });

  it('refuses on a Being that is already engaged', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { martyr: 'Do something.' } }),
      currentLifespan: 5, engaged: true,
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('refuses on a Being without the Martyr keyword', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  describe('"Summon a/an <Typing> Being on this tile from your Purgatory" (Grave robber)', () => {
    const graveRobber = () => beingCard({
      name: 'Grave robber', keywords: { martyr: 'Summon an Undead Being on this tile from your Purgatory.' },
    });
    const undead = (id = 'u#0', overrides = {}) => beingCard({ instanceId: id, name: 'Ghoul', typing: 'Undead, Being', ...overrides });
    const human = (id = 'h#0') => beingCard({ instanceId: id, name: 'Some Human', typing: 'Human, Being' });

    it('logs "no Undead" and leaves the tile empty when Purgatory has none', () => {
      const being = { type: 'being', ownerId: 'A', card: graveRobber(), currentLifespan: 5, engaged: false };
      const state = baseState({ board: { r2c1: being }, players: { A: player({ purgatory: [human()] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
      expect(next.board.r2c1).toBeUndefined(); // Grave robber sacrificed, nothing reanimated
      expect(next.log.some(e => e.message.includes('finds no "Undead" Being'))).toBe(true);
      expect(next.players.A.purgatory).toHaveLength(2); // Grave robber + the Human, untouched
    });

    it('auto-resolves with a single Undead in Purgatory: reanimates it on the vacated tile, removed from Purgatory', () => {
      const being = { type: 'being', ownerId: 'A', card: graveRobber(), currentLifespan: 5, engaged: false };
      const state = baseState({ board: { r2c1: being }, players: { A: player({ purgatory: [undead()] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
      expect(next.board.r2c1.type).toBe('being');
      expect(next.board.r2c1.card.name).toBe('Ghoul');
      expect(next.board.r2c1.currentLifespan).toBe(undead().lifespan);
      expect(next.board.r2c1.engaged).toBe(true); // enters play the normal way — no Persist/Deity
      expect(next.players.A.purgatory).toHaveLength(1); // just Grave robber itself now
      expect(next.players.A.purgatory[0].name).toBe('Grave robber');
    });

    it('offers a choice among multiple Undead in Purgatory, and resolving it reanimates the chosen one', () => {
      const being = { type: 'being', ownerId: 'A', card: graveRobber(), currentLifespan: 5, engaged: false };
      const state = baseState({
        board: { r2c1: being },
        players: { A: player({ purgatory: [undead('u1#0', { name: 'Ghoul' }), undead('u2#0', { name: 'Restless Dead' })] }), B: player() },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
      expect(next.pendingChoice).toEqual({ kind: 'summon-from-purgatory', playerId: 'A', cardName: 'Grave robber', cellId: 'r2c1', query: 'Undead' });
      const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SUMMON_FROM_PURGATORY');
      expect(options).toHaveLength(2);
      const resolved = gameReducer(next, options[0]);
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.board.r2c1.type).toBe('being');
      // Grave robber itself (sacrificed into Purgatory by this same Martyr)
      // plus whichever of the two Undead wasn't chosen.
      expect(resolved.players.A.purgatory).toHaveLength(2);
    });

    it('a reanimated Being with its own When Summoned trigger fires it for real (reuses placeBeingOnBoard)', () => {
      const being = { type: 'being', ownerId: 'A', card: graveRobber(), currentLifespan: 5, engaged: false };
      const reanimated = undead('u#0', { name: 'Favorite Son', keywords: { whenSummoned: 'become Favored (Gains a Favor Counter)' } });
      const state = baseState({ board: { r2c1: being }, players: { A: player({ purgatory: [reanimated] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
      expect(next.board.r2c1.favorCounter).toBe(true);
    });
  });

  describe('a bare "Martyr" on a Relic (Bag o\' Bones) — engage and sacrifice, no effect', () => {
    const bagOBones = () => ({
      id: 'bag', instanceId: 'bag#0', name: "Bag o' Bones", kind: 'relic',
      castingCost: { faithless: 0, colored: {} }, keywords: { martyr: '' },
    });

    it('is offered by getLegalActions for a disengaged Relic with the keyword', () => {
      const state = baseState({ board: { r1c3: { type: 'relic', ownerId: 'A', card: bagOBones() } } });
      const legal = getLegalActions(state, 'A');
      expect(legal.some(a => a.type === 'ACTIVATE_MARTYR' && a.cellId === 'r1c3')).toBe(true);
    });

    it('sacrifices the Relic into Purgatory with no crash and no spurious "isn\'t automated yet" log', () => {
      const state = baseState({ board: { r1c3: { type: 'relic', ownerId: 'A', card: bagOBones() } } });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r1c3' });
      expect(next.board.r1c3).toBeUndefined();
      expect(next.players.A.purgatory).toEqual([bagOBones()]);
      expect(next.log.some(e => e.message.includes('sacrifices Bag o\' Bones for Martyr'))).toBe(true);
      expect(next.log.some(e => e.message.includes('Martyr triggers'))).toBe(true);
      expect(next.log.some(e => e.message.includes('isn\'t automated yet'))).toBe(false);
    });

    it('refuses a plain Relic with no Martyr keyword at all', () => {
      const plain = { id: 'r', instanceId: 'r#0', name: 'Some Relic', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: {} };
      const state = baseState({ board: { r1c3: { type: 'relic', ownerId: 'A', card: plain } } });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r1c3' });
      expect(next).toBe(state);
    });
  });
});

describe('ACTIVATE_ENGAGE', () => {
  it('engages the Being (without sacrificing it) and logs its captured effect text, really granting the Lifespan', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Gain 1 Lifespan.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being } }); // default players: A starts at 50 Lifespan
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.type).toBe('being'); // still on the board, not sacrificed
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.log.some(e => e.message.includes('engages Test Being\'s ability'))).toBe(true);
    expect(next.players.A.lifespan).toBe(51);
  });

  it('resolves a recognized "Add X to hand from deck" Engage effect for real', () => {
    const armament = { id: 'arm-deck', instanceId: 'arm-deck#0', name: 'Deck Armament', kind: 'relic-armament', typing: 'Relic - Armament' };
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Discard a Spirit, add an Armament to hand from deck.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ mainDeck: [armament] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', cardName: 'Test Being' });
  });

  it('refuses on an already-engaged Being', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Do something.' } }),
      currentLifespan: 5, engaged: true,
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('refuses on a Being without the Engage keyword', () => {
    const being = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('engages via an Armament-granted ability when the Being has no Engage of its own (e.g. "Darmah-Triya Bracers")', () => {
    const bracers = { name: 'Darmah-Triya Bracers', keywords: { grantedEngage: 'Deal (2) Damage to this, then add (1) Bleeding Essence.' } };
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard(), // no Engage of its own
      currentLifespan: 5, engaged: false, armaments: [equip(bracers)],
    };
    const state = baseState({ board: { r2c1: being } });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.log.some(e => e.message.includes('engages Test Being\'s ability'))).toBe(true);
    // The granted text's "add (1) Bleeding Essence" clause is itself a
    // recognized pattern (see ADD_ESSENCE_RE) — composes automatically.
    expect(next.players.A.effigyPool).toContainEqual(expect.objectContaining({ effigyType: 'bleeding' }));
  });

  it('prefers the Being\'s own Engage keyword over an Armament-granted one when both are present', () => {
    const bracers = { name: 'Darmah-Triya Bracers', keywords: { grantedEngage: 'Granted effect.' } };
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Own effect.' } }),
      currentLifespan: 5, engaged: false, armaments: [equip(bracers)],
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('Own effect'))).toBe(true);
    expect(next.log.some(e => e.message.includes('Granted effect'))).toBe(false);
  });

  it('engages a Relic (e.g. "Dial of Metatoris") the same way as a Being', () => {
    const relicCard = { id: 'dial', instanceId: 'dial#0', name: 'Dial of Metatoris', kind: 'relic', keywords: { engage: 'Modulate (±1) on a target you control' } };
    const relic = { type: 'relic', ownerId: 'A', card: relicCard };
    const state = baseState({ board: { r2c1: relic } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.type).toBe('relic'); // still on the board
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.log.some(e => e.message.includes('engages Dial of Metatoris\'s ability'))).toBe(true);
  });

  it('lets a freshly placed Relic Engage the same turn (no summoning sickness)', () => {
    const relicCard = { id: 'dial', instanceId: 'dial#0', name: 'Dial of Metatoris', kind: 'relic', keywords: { engage: 'Do something.' } };
    const relic = { type: 'relic', ownerId: 'A', card: relicCard };
    const state = baseState({ board: { r2c1: relic } });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });

  it('refuses on an already-engaged Relic', () => {
    const relicCard = { id: 'dial', instanceId: 'dial#0', name: 'Dial of Metatoris', kind: 'relic', keywords: { engage: 'Do something.' } };
    const relic = { type: 'relic', ownerId: 'A', card: relicCard, engaged: true };
    const state = baseState({ board: { r2c1: relic } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('refuses on a Relic without the Engage keyword', () => {
    const relicCard = { id: 'plain', instanceId: 'plain#0', name: 'Plain Relic', kind: 'relic' };
    const relic = { type: 'relic', ownerId: 'A', card: relicCard };
    const state = baseState({ board: { r2c1: relic } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });
});

describe('ACTIVATE_ARMAMENT_ENGAGE (an Armament\'s own Engage, e.g. "Feathers of the Fallen")', () => {
  const feathers = (overrides = {}) => ({
    id: 'feathers', instanceId: 'feathers#0', name: 'Feathers of the Fallen', kind: 'relic-armament',
    keywords: { engage: 'Remove (1) Crossing Counter, then move attached Being one tile in any direction.' },
    ...overrides,
  });

  it('engages the Armament (not the Being) and reports no Crossing Counters left when it has none', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [equip(feathers())],
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c1', armamentInstanceId: 'feathers#0' });
    expect(next.board.r2c1.engaged).toBe(false); // the Being itself is untouched
    expect(next.board.r2c1.armaments).toEqual([equip(feathers(), true)]);
    expect(next.log.some(e => e.message.includes('engages Feathers of the Fallen\'s ability'))).toBe(true);
    expect(next.log.some(e => e.message.includes('has no crossing Counters left to spend'))).toBe(true);
  });

  it('is independent of the attached Being\'s own engaged state — works even while the Being is engaged', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: true, armaments: [equip(feathers())],
    };
    const state = baseState({ board: { r2c1: being } });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c1', armamentInstanceId: 'feathers#0' });
  });

  it('works on a freestanding Armament pile with no Being attached', () => {
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(feathers())] };
    const state = baseState({ board: { r2c1: pile } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c1', armamentInstanceId: 'feathers#0' });
    expect(next.board.r2c1.armaments).toEqual([equip(feathers(), true)]);
  });

  it('refuses on an already-engaged Armament', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [equip(feathers(), true)],
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c1', armamentInstanceId: 'feathers#0' });
    expect(next).toBe(state);
  });

  it('refuses on an Armament without an Engage of its own (e.g. a plain stat-bonus Armament)', () => {
    const plain = { id: 'plain', instanceId: 'plain#0', name: 'Plain Armament' };
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [equip(plain)],
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c1', armamentInstanceId: 'plain#0' });
    expect(next).toBe(state);
  });

  it('does not offer an Armament granting only a *Being* Engage (grantedEngage, not its own)', () => {
    const bracers = { id: 'bracers', instanceId: 'bracers#0', name: 'Darmah-Triya Bracers', keywords: { grantedEngage: 'Some effect.' } };
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [equip(bracers)],
    };
    const state = baseState({ board: { r2c1: being } });
    const armamentEngageActions = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_ARMAMENT_ENGAGE');
    expect(armamentEngageActions).toEqual([]);
  });
});

describe('Feathers of the Fallen: "Remove (1) Crossing Counter, then move attached Being one tile in any direction"', () => {
  const feathersCard = (overrides = {}) => ({
    id: 'feathers', instanceId: 'feathers#0', name: 'Feathers of the Fallen', kind: 'relic-armament',
    castingCost: { faithless: 0, colored: {} },
    keywords: {
      engage: 'Remove (1) Crossing Counter, then move attached Being one tile in any direction.',
      armamentCounterGrant: { type: 'crossing', amount: 2 },
    },
    ...overrides,
  });
  // Unlike equip(), this sets the entry's actual `counters` state directly —
  // equip() alone can't express it since counters live outside `keywords`.
  const feathersEquipped = (crossing) => ({ card: feathersCard(), engaged: false, counters: { crossing } });

  it('ATTACH_ARMAMENT grants the printed Crossing Counters immediately (ETB)', () => {
    const state = baseState({ players: { A: player({ hand: [feathersCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ATTACH_ARMAMENT', instanceId: 'feathers#0', cellId: 'r2c1' });
    expect(next.board.r2c1.armaments[0].counters).toEqual({ crossing: 2 });
  });

  it('spends a Crossing Counter and moves the Being when there is exactly one legal destination', () => {
    // Boxed in on 3 sides so only one adjacent Mortal Realm cell is open.
    const blocker = (id) => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [feathersEquipped(1)],
    };
    const state = baseState({
      board: { r2c2: being, r1c2: blocker('b1'), r2c1: blocker('b2'), r2c3: blocker('b3') },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c2', armamentInstanceId: 'feathers#0' });
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r3c2).toBeUndefined(); // can't enter the Ethereal Realm
    // Only whichever single Mortal Realm neighbor was left open now holds it.
    const movedTo = Object.entries(next.board).find(([, o]) => o?.type === 'being' && o.ownerId === 'A');
    expect(movedTo).toBeTruthy();
    expect(movedTo[0]).not.toBe('r2c2');
    expect(movedTo[1].armaments[0].counters).toEqual({ crossing: 0 });
    expect(movedTo[1].engaged).toBe(false); // a granted move, not the Being's own action
  });

  it('parks a pendingChoice when more than one destination is open, and RESOLVE_FREE_MOVE applies the chosen one', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [feathersEquipped(1)],
    };
    const state = baseState({ board: { r2c2: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c2', armamentInstanceId: 'feathers#0' });
    expect(next.pendingChoice).toEqual({ kind: 'free-move', playerId: 'A', cardName: 'Feathers of the Fallen', fromCellId: 'r2c2' });
    expect(next.board.r2c2.armaments[0].counters).toEqual({ crossing: 0 }); // spent up front

    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_FREE_MOVE');
    expect(options.length).toBeGreaterThan(1);
    const resolved = gameReducer(next, options[0]);
    expect(resolved.pendingChoice).toBeNull();
    expect(resolved.board[options[0].toCellId].type).toBe('being');
    expect(resolved.board.r2c2).toBeUndefined();
  });

  it('logs "no Crossing Counters left" without moving when the Armament has none to spend', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [feathersEquipped(0)],
    };
    const state = baseState({ board: { r2c2: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c2', armamentInstanceId: 'feathers#0' });
    expect(next.board.r2c2.type).toBe('being'); // never moved
    expect(next.log.some(e => e.message.includes('has no crossing Counters left to spend'))).toBe(true);
  });

  describe('an Animated Armament acting as a Being (RULES.md > Keywords > Animated) is a valid mover too', () => {
    const animatedCard = () => ({
      id: 'ds', instanceId: 'ds#0', name: 'Dancing Swords', kind: 'relic-armament',
      castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 1, keywords: { animated: true },
    });
    const animatedEntry = () => ({ card: animatedCard(), engaged: false, currentLifespan: 1 });

    it('moves the whole pile — no longer "has no attached Being to move" just because it\'s a freestanding stack', () => {
      // Boxed in on 3 sides so only one adjacent Mortal Realm cell is open.
      const blocker = (id) => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [feathersEquipped(1), animatedEntry()] };
      const state = baseState({
        board: { r2c2: pile, r1c2: blocker('b1'), r2c1: blocker('b2'), r2c3: blocker('b3') },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c2', armamentInstanceId: 'feathers#0' });
      expect(next.board.r2c2).toBeUndefined();
      expect(next.log.some(e => e.message.includes('has no attached Being to move'))).toBe(false);
      const movedTo = Object.entries(next.board).find(([, o]) => o?.type === 'armament-stack' && o.ownerId === 'A');
      expect(movedTo).toBeTruthy();
      // Both entries — Feathers itself and the Animated top — travel together.
      expect(movedTo[1].armaments).toHaveLength(2);
      expect(movedTo[1].armaments[0].counters).toEqual({ crossing: 0 });
      // The Animated top is still the acting entry afterward, untapped by this move.
      expect(movedTo[1].armaments[1].engaged).toBe(false);
    });

    it('offers a pendingChoice among multiple destinations and RESOLVE_FREE_MOVE applies it, same as a real Being', () => {
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [feathersEquipped(1), animatedEntry()] };
      const state = baseState({ board: { r2c2: pile } });
      const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_ENGAGE', cellId: 'r2c2', armamentInstanceId: 'feathers#0' });
      expect(next.pendingChoice).toEqual({ kind: 'free-move', playerId: 'A', cardName: 'Feathers of the Fallen', fromCellId: 'r2c2' });
      const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_FREE_MOVE');
      expect(options.length).toBeGreaterThan(1);
      const resolved = gameReducer(next, options[0]);
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.board[options[0].toCellId].type).toBe('armament-stack');
      expect(resolved.board.r2c2).toBeUndefined();
    });
  });
});

describe('"Once per turn sacrifice (X) <Name>: Summon a Being from your Purgatory with cost (X)" (Cemetery Physician)', () => {
  const cemeteryPhysicianCard = (overrides = {}) => beingCard({
    name: 'Cemetery Physician',
    keywords: { sacrificeXSummon: { fodderName: "Bag o' Bones" } },
    ...overrides,
  });
  const cemeteryPhysician = (overrides = {}) => ({
    type: 'being', ownerId: 'A', card: cemeteryPhysicianCard(), currentLifespan: 5, engaged: false, ...overrides,
  });
  const bagOBones = (id) => ({ type: 'relic', ownerId: 'A', card: { id: 'bag', instanceId: id, name: "Bag o' Bones", kind: 'relic' } });
  const purgatoryBeing = (instanceId, cost) => ({ instanceId, name: `Being ${instanceId}`, kind: 'being', castingCost: { faithless: cost, colored: {} }, strength: 1, lifespan: 1, arrows: [1] });

  it('getLegalActions offers it when at least one fodder and one empty tile exist', () => {
    const state = baseState({ board: { r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0') } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON' && a.cellId === 'r2c1')).toBe(true);
  });

  it('is offered even while Cemetery Physician itself is engaged — not gated by Engage/tap at all', () => {
    const state = baseState({ board: { r2c1: cemeteryPhysician({ engaged: true }), r2c2: bagOBones('bag#0') } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON')).toBe(true);
  });

  it('is not offered with no fodder controlled', () => {
    const state = baseState({ board: { r2c1: cemeteryPhysician() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON')).toBe(false);
  });

  it('is not offered once already used this turn', () => {
    const state = baseState({ board: { r2c1: cemeteryPhysician({ usedSacrificeXThisTurn: true }), r2c2: bagOBones('bag#0') } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON')).toBe(false);
  });

  it('ACTIVATE_SACRIFICE_X_SUMMON opens an empty toggle-selection pendingChoice, and marks used-this-turn immediately (not only on a successful confirm)', () => {
    const state = baseState({ board: { r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0') } });
    const next = gameReducer(state, { type: 'ACTIVATE_SACRIFICE_X_SUMMON', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({
      kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1',
      fodderName: "Bag o' Bones", selected: [], optional: true,
    });
    expect(next.board.r2c1.usedSacrificeXThisTurn).toBe(true);
  });

  it('declining after activating (no X value has a real Purgatory match) still consumes the once-per-turn use — self-play found the AI looping forever re-activating otherwise', () => {
    const state = baseState({
      board: { r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0') },
      players: { A: player({ purgatory: [purgatoryBeing('pb#0', 9)] }), B: player() }, // no cost-1 match
    });
    const opened = gameReducer(state, { type: 'ACTIVATE_SACRIFICE_X_SUMMON', cellId: 'r2c1' });
    const toggled = gameReducer(opened, { type: 'RESOLVE_SACRIFICE_X_TOGGLE', cellId: 'r2c2' });
    expect(getLegalActions(toggled, 'A').some(a => a.type === 'RESOLVE_SACRIFICE_X_CONFIRM')).toBe(false);
    const declined = gameReducer(toggled, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBeNull();
    expect(getLegalActions(declined, 'A').some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON')).toBe(false);
  });

  it('RESOLVE_SACRIFICE_X_TOGGLE toggles a fodder cell in, then back out', () => {
    const state = baseState({
      board: { r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0'), r2c3: bagOBones('bag#1') },
      pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1', fodderName: "Bag o' Bones", selected: [], optional: true },
    });
    const toggledIn = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_TOGGLE', cellId: 'r2c2' });
    expect(toggledIn.pendingChoice.selected).toEqual(['r2c2']);
    const toggledOut = gameReducer(toggledIn, { type: 'RESOLVE_SACRIFICE_X_TOGGLE', cellId: 'r2c2' });
    expect(toggledOut.pendingChoice.selected).toEqual([]);
  });

  it('does not offer RESOLVE_SACRIFICE_X_CONFIRM when no Purgatory Being matches the selected count', () => {
    const state = baseState({
      board: { r2c2: bagOBones('bag#0') },
      pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1', fodderName: "Bag o' Bones", selected: ['r2c2'], optional: true },
      players: { A: player({ purgatory: [purgatoryBeing('pb#0', 3)] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SACRIFICE_X_CONFIRM')).toBe(false);
    // Decline is still available — it's an optional pendingChoice.
    expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_DECLINE')).toBe(true);
  });

  it('confirms: sacrifices exactly the selected fodder, marks used-this-turn, and auto-summons a single match onto the one remaining open tile', () => {
    // Every one of A's 8 Mortal Realm cells filled except the sacrificed
    // bone's own — so after it's freed, exactly one tile is open and the
    // summon resolves directly, no location choice needed.
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
    const state = baseState({
      board: {
        r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0'),
        r1c2: filler('f1'), r1c3: filler('f2'), r1c4: filler('f3'),
        r2c3: filler('f4'), r2c4: filler('f5'), r2c5: filler('f6'),
      },
      pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1', fodderName: "Bag o' Bones", selected: ['r2c2'], optional: true },
      players: { A: player({ purgatory: [purgatoryBeing('pb#0', 1)] }), B: player() },
    });
    const next = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
    expect(next.board.r2c1.usedSacrificeXThisTurn).toBe(true);
    expect(next.players.A.purgatory).toEqual([]);
    expect(next.board.r2c2.type).toBe('being'); // the sole freed tile — the new Being lands right back on it
    expect(next.board.r2c2.card.name).toBe('Being pb#0');
    expect(next.pendingChoice).toBeNull();
  });

  it('parks a pendingChoice when more than one Purgatory Being shares the sacrificed count', () => {
    // Every Mortal Realm cell filled except the sacrificed bone's own, so
    // choosing *which* Being is the only ambiguity left — location resolves
    // to the single open tile automatically right after.
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
    const state = baseState({
      board: {
        r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0'),
        r1c2: filler('f1'), r1c3: filler('f2'), r1c4: filler('f3'),
        r2c3: filler('f4'), r2c4: filler('f5'), r2c5: filler('f6'),
      },
      pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1', fodderName: "Bag o' Bones", selected: ['r2c2'], optional: true },
      players: { A: player({ purgatory: [purgatoryBeing('pb#0', 1), purgatoryBeing('pb#1', 1)] }), B: player() },
    });
    const next = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
    expect(next.pendingChoice).toEqual({ kind: 'summon-from-purgatory-cost', playerId: 'A', cardName: 'Cemetery Physician', cost: 1 });
    expect(next.players.A.purgatory).toHaveLength(2); // neither removed yet
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SUMMON_FROM_PURGATORY_COST');
    expect(options).toHaveLength(2);
    const resolved = gameReducer(next, options[0]);
    expect(resolved.pendingChoice).toBeNull(); // only one open tile — placed directly, no further choice
    expect(resolved.players.A.purgatory).toHaveLength(1);
    expect(resolved.board.r2c2.type).toBe('being');
  });

  it('parks a token-location-style pendingChoice when more than one empty tile is open, and RESOLVE_TOKEN_LOCATION places it', () => {
    const state = baseState({
      board: { r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0') },
      pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1', fodderName: "Bag o' Bones", selected: ['r2c2'], optional: true },
      players: { A: player({ purgatory: [purgatoryBeing('pb#0', 1)] }), B: player() },
    });
    const next = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
    expect(next.pendingChoice.kind).toBe('token-location');
    expect(next.pendingChoice.purgatoryInstanceId).toBe('pb#0');
    expect(next.players.A.purgatory).toHaveLength(1); // not removed until placed
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_TOKEN_LOCATION');
    expect(options.length).toBeGreaterThan(1);
    const resolved = gameReducer(next, options[0]);
    expect(resolved.pendingChoice).toBeNull();
    expect(resolved.board[options[0].cellId].card.name).toBe('Being pb#0');
    expect(resolved.players.A.purgatory).toEqual([]);
  });

  it('resets usedSacrificeXThisTurn at the start of its controller\'s next turn, not the opponent\'s', () => {
    const stateA = baseState({ turnNumber: 3, board: { r2c1: cemeteryPhysician({ usedSacrificeXThisTurn: true }) } });
    const stillUsedOnOpponentTurn = beginTurn({ ...stateA, turnPlayer: 'B' });
    expect(stillUsedOnOpponentTurn.board.r2c1.usedSacrificeXThisTurn).toBe(true);
    const resetOnOwnTurn = beginTurn({ ...stateA, turnPlayer: 'A' });
    expect(resetOnOwnTurn.board.r2c1.usedSacrificeXThisTurn).toBe(false);
  });

  it('a full second activation on a later turn works end-to-end via the real action dispatch path (ACTIVATE -> toggle -> confirm -> place), not just by hand-setting state, on an otherwise-open board with several empty tiles (the realistic early-game case, unlike the near-full boards the other tests above use to force auto-placement)', () => {
    let state = baseState({
      turnNumber: 3,
      board: { r2c1: cemeteryPhysician(), r2c2: bagOBones('bag#0'), r2c3: bagOBones('bag#1') },
      players: { A: player({ purgatory: [purgatoryBeing('pb#0', 1)] }), B: player() },
    });

    // First activation, turn 3. Many empty Mortal Realm tiles are open, so
    // this is the multi-candidate 'token-location' branch, not auto-place.
    state = gameReducer(state, { type: 'ACTIVATE_SACRIFICE_X_SUMMON', cellId: 'r2c1' });
    state = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_TOGGLE', cellId: 'r2c2' });
    state = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
    expect(state.board.r2c1.usedSacrificeXThisTurn).toBe(true);
    expect(state.board.r2c2).toBeUndefined(); // the sacrificed Bag o' Bones is gone
    expect(state.pendingChoice).toEqual(expect.objectContaining({ kind: 'token-location', purgatoryInstanceId: 'pb#0' }));
    const firstPlacement = getLegalActions(state, 'A').find(a => a.type === 'RESOLVE_TOKEN_LOCATION' && a.cellId === 'r2c2');
    expect(firstPlacement).toBeDefined();
    state = gameReducer(state, firstPlacement);
    expect(state.board.r2c2.card.name).toBe('Being pb#0');
    expect(state.players.A.purgatory).toEqual([]);

    // Not offered again this same turn.
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON')).toBe(false);

    // Opponent's turn, then back to A's — this is the real reset path
    // (beginTurn's own disengage step), not a hand-set flag.
    state = { ...state, turnPlayer: 'B' };
    state = beginTurn(state);
    state = { ...state, turnPlayer: 'A' };
    state = beginTurn(state);
    expect(state.board.r2c1.usedSacrificeXThisTurn).toBe(false);
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SACRIFICE_X_SUMMON' && a.cellId === 'r2c1')).toBe(true);

    // Second activation, using the OTHER Bag o' Bones — should work exactly
    // the same as the first, with no leftover state from the prior cycle.
    state = { ...state, players: { ...state.players, A: { ...state.players.A, purgatory: [purgatoryBeing('pb#1', 1)] } } };
    state = gameReducer(state, { type: 'ACTIVATE_SACRIFICE_X_SUMMON', cellId: 'r2c1' });
    expect(state.pendingChoice).toEqual({
      kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r2c1',
      fodderName: "Bag o' Bones", selected: [], optional: true,
    });
    state = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_TOGGLE', cellId: 'r2c3' });
    state = gameReducer(state, { type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
    expect(state.board.r2c1.usedSacrificeXThisTurn).toBe(true);
    expect(state.pendingChoice).toEqual(expect.objectContaining({ kind: 'token-location', purgatoryInstanceId: 'pb#1' }));
    const secondPlacement = getLegalActions(state, 'A').find(a => a.type === 'RESOLVE_TOKEN_LOCATION' && a.cellId === 'r2c3');
    expect(secondPlacement).toBeDefined();
    state = gameReducer(state, secondPlacement);
    expect(state.board.r2c3.card.name).toBe('Being pb#1');
    expect(state.players.A.purgatory).toEqual([]);
  });
});

describe('"Remove (N) <Type> Counter(s): Engage then <effect>" (Crucible)', () => {
  const crucibleCard = (overrides = {}) => ({
    id: 'crucible', instanceId: 'crucible#0', name: 'Crucible', kind: 'relic',
    castingCost: { faithless: 0, colored: {} },
    keywords: {
      armamentCounterGrant: { type: 'forge', amount: 2 },
      engage: 'add an Armament to hand from your Purgatory.',
      engageCounterCost: { type: 'forge', amount: 1 },
    },
    ...overrides,
  });
  const crucibleOnBoard = (counters = { forge: 2 }) => ({ type: 'relic', ownerId: 'A', card: crucibleCard(), engaged: false, counters });

  it('PLACE_RELIC grants the printed Forge Counters immediately (ETB), same field ATTACH_ARMAMENT uses', () => {
    const state = baseState({ players: { A: player({ hand: [crucibleCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'crucible#0', cellId: 'r2c1' });
    expect(next.board.r2c1.counters).toEqual({ forge: 2 });
  });

  it('is offered by getLegalActions when it can afford the Counter cost', () => {
    const state = baseState({ board: { r2c1: crucibleOnBoard() } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(true);
  });

  it('is not offered with no Forge Counters left', () => {
    const state = baseState({ board: { r2c1: crucibleOnBoard({ forge: 0 }) } });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'ACTIVATE_ENGAGE')).toBe(false);
  });

  it('spends 1 Forge Counter, taps it, and really searches Purgatory for an Armament', () => {
    const armament = { instanceId: 'arm#0', name: 'Cutlass', kind: 'relic-armament', typing: 'Relic, Armament' };
    const state = baseState({
      board: { r2c1: crucibleOnBoard() },
      players: { A: player({ purgatory: [armament] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.counters).toEqual({ forge: 1 });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: 'Armament', cardName: 'Crucible' });
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'arm#0' });
    expect(resolved.players.A.hand).toContainEqual(armament);
    expect(resolved.players.A.purgatory).toEqual([]);
  });

  it('refuses ACTIVATE_ENGAGE outright when dispatched with insufficient Forge Counters', () => {
    const state = baseState({ board: { r2c1: crucibleOnBoard({ forge: 0 }) } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });
});

describe('Self-damage: "Deal (N) Damage to this" (e.g. "Darmah-Triya Bracers")', () => {
  it('deals damage to the Being whose granted Engage ability it is, then still grants the chained Essence', () => {
    const bracers = {
      id: 'bracers', instanceId: 'bracers#0', name: 'Darmah-Triya Bracers',
      keywords: { grantedEngage: 'Deal (2) Damage to this, then add (1) Bleeding Essence.' },
    };
    const being = {
      type: 'being', ownerId: 'A', card: beingCard({ lifespan: 5 }),
      currentLifespan: 5, engaged: false, armaments: [equip(bracers)],
    };
    const state = baseState({ board: { r2c1: being }, players: { A: player({ effigyPool: [] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    // Both chained clauses resolve now (see resolveOrLogEffect's "then"
    // splitting) — self-damage isn't silently dropped just because Essence
    // is checked earlier in the single-clause pattern order.
    expect(next.board.r2c1.currentLifespan).toBe(3);
    expect(next.players.A.effigyPool).toContainEqual(expect.objectContaining({ effigyType: 'bleeding' }));
  });

  it('resolves the self-damage pattern on its own when no earlier clause matches first', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ lifespan: 5, keywords: { engage: 'Deal (2) Damage to this.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.currentLifespan).toBe(3);
    expect(next.log.some(e => e.message.includes('deals 2 damage to Test Being'))).toBe(true);
  });
});

describe('ACTIVATE_ARMAMENT_SACRIFICE ("Mahka-Rahva\'s Tiger Skin")', () => {
  const tigerSkin = (overrides = {}) => ({
    id: 'tiger-skin', instanceId: 'tiger-skin#0', name: "Mahka-Rahva's Tiger Skin", kind: 'relic-armament',
    keywords: { sacrificeForFavored: true }, ...overrides,
  });

  it('sacrifices the Armament and grants the attached Being a Favor Counter', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [equip(tigerSkin())],
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_SACRIFICE', cellId: 'r2c1', armamentInstanceId: 'tiger-skin#0' });
    expect(next.board.r2c1.armaments).toEqual([]);
    expect(next.board.r2c1.favorCounter).toBe(true);
    expect(next.log.some(e => e.message.includes('sacrifices Mahka-Rahva\'s Tiger Skin'))).toBe(true);
  });

  it('is available regardless of engaged state — not Engage-costed', () => {
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: true, armaments: [equip(tigerSkin())],
    };
    const state = baseState({ board: { r2c1: being } });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ARMAMENT_SACRIFICE', cellId: 'r2c1', armamentInstanceId: 'tiger-skin#0' });
  });

  it('refuses on an Armament without the sacrifice-for-Favored pattern', () => {
    const plain = { id: 'plain', instanceId: 'plain#0', name: 'Plain Armament' };
    const being = {
      type: 'being', ownerId: 'A', card: beingCard(),
      currentLifespan: 5, engaged: false, armaments: [equip(plain)],
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_SACRIFICE', cellId: 'r2c1', armamentInstanceId: 'plain#0' });
    expect(next).toBe(state);
  });
});

describe('Zealots: "Add (N) <Color> Essence" as an Engage effect', () => {
  it('grants a bonus effigy of the named color to the pool (e.g. "Arbosalis Zealot")', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Arbosalis Zealot', keywords: { engage: 'Engage: Add (1) Living Essence.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot }, players: { A: player({ effigyPool: [] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.players.A.effigyPool[0]).toMatchObject({ kind: 'effigy', effigyType: 'living', temporary: true });
    expect(next.log.some(e => e.message.includes('adds 1 living Essence'))).toBe(true);
  });

  it('grants a "Faithless" wildcard essence usable against a generic pip', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Zealot', keywords: { engage: 'Add (1) Faithless Essence.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot }, players: { A: player({ effigyPool: [] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.effigyPool[0]).toMatchObject({ kind: 'effigy', effigyType: 'faithless' });
    expect(canPayCost(next.players.A.effigyPool, { faithless: 1, colored: {} })).toBe(true);
    expect(canPayCost(next.players.A.effigyPool, { faithless: 0, colored: { living: 1 } })).toBe(false);
  });

  it('resolves both chained clauses — grants the essence and deals the self-damage (e.g. "Rhak-tùrin Zealot")', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Rhak-tùrin Zealot', lifespan: 5, keywords: { engage: 'Add (1) Bleeding Essence then deal (1) Damage to this.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot }, players: { A: player({ effigyPool: [] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.players.A.effigyPool[0]).toMatchObject({ effigyType: 'bleeding' });
    expect(next.board.r2c1.currentLifespan).toBe(4); // the "then deal (1) Damage to this" clause
  });

  it('adds the granted essence on top of an existing pool, keeping prior effigies', () => {
    const existing = effigy('formless');
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Arbosalis Zealot', keywords: { engage: 'Engage: Add (1) Living Essence.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot }, players: { A: player({ effigyPool: [existing] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.effigyPool).toHaveLength(2);
    expect(next.players.A.effigyPool).toContainEqual(existing);
  });
});

describe('Zealots with an extra Engage cost or condition', () => {
  it('pays the extra Lifespan cost when engaging (e.g. "NamKaranian Zealot")', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'NamKaranian Zealot', keywords: { engage: 'Add (1) Formless Essence.', engageLifespanCost: 2 } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot }, players: { A: player({ lifespan: 50, effigyPool: [] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.lifespan).toBe(48);
    expect(next.players.A.effigyPool).toContainEqual(expect.objectContaining({ effigyType: 'formless' }));
    expect(next.log.some(e => e.message.includes('pays 2 Lifespan to engage'))).toBe(true);
  });

  it('refuses to offer Engage when paying its Lifespan cost would drop to 0 or below', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'NamKaranian Zealot', keywords: { engage: 'Add (1) Formless Essence.', engageLifespanCost: 2 } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot }, players: { A: player({ lifespan: 2 }), B: player() } });
    expect(getLegalActions(state, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('offers Engage only while the Faithless-only condition holds (e.g. "Zealot")', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Zealot', keywords: { engage: 'Add (1) Faithless Essence.', engageCondition: 'faithless-only' } }),
      currentLifespan: 5, engaged: false,
    };
    const onlyZealot = baseState({ board: { r2c1: zealot } });
    expect(getLegalActions(onlyZealot, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });

    const coloredBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'colored#0', castingCost: { faithless: 0, colored: { living: 1 } } }), currentLifespan: 3, engaged: false };
    const withColoredPermanent = baseState({ board: { r2c1: zealot, r2c2: coloredBeing } });
    expect(getLegalActions(withColoredPermanent, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(withColoredPermanent, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(withColoredPermanent);
  });

  it('offers Engage only while controlling a Relic (e.g. "Kalduran Zealot")', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Kalduran Zealot', keywords: { engage: 'Add (1) Shifting Essence.', engageCondition: 'controls-relic' } }),
      currentLifespan: 5, engaged: false,
    };
    const noRelic = baseState({ board: { r2c1: zealot } });
    expect(getLegalActions(noRelic, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });

    const relic = { type: 'relic', ownerId: 'A', card: { id: 'r1', instanceId: 'r1#0', name: 'Test Relic' } };
    const withRelic = baseState({ board: { r2c1: zealot, r2c2: relic } });
    expect(getLegalActions(withRelic, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });

  it('also counts a "Beings may move across this" ground Relic (RULES.md > Being-Relic co-location) — not just a board Relic', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Kalduran Zealot', keywords: { engage: 'Add (1) Shifting Essence.', engageCondition: 'controls-relic' } }),
      currentLifespan: 5, engaged: false,
    };
    const groundRelic = { type: 'relic', ownerId: 'A', card: { id: 'ss', instanceId: 'ss#0', name: 'Shifting Sands', keywords: { beingsMayMoveAcross: true } }, counters: { crossing: 2 } };
    const state = baseState({ board: { r2c1: zealot }, groundRelics: { r2c2: groundRelic } });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });

  it('leaves Engage unconditional for an unrecognized condition phrase (honest simplification)', () => {
    const zealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Do something.', engageCondition: 'something-unrecognized' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: zealot } });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });

  it('also gates a Relic\'s own Engage on the Faithless-only condition (e.g. a borrowed "Wretched Remnants" textbox) — never offers a guaranteed no-op', () => {
    const relic = {
      type: 'relic', ownerId: 'A',
      card: { id: 'wr', instanceId: 'wr#0', name: 'Wretched Remnants', keywords: { engage: 'Add (1) Faithless Essence.', engageCondition: 'faithless-only' } },
      engaged: false,
    };
    const onlyRelic = baseState({ board: { r2c1: relic } });
    expect(getLegalActions(onlyRelic, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });

    const coloredBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'colored#0', castingCost: { faithless: 0, colored: { living: 1 } } }), currentLifespan: 3, engaged: false };
    const withColoredPermanent = baseState({ board: { r2c1: relic, r2c2: coloredBeing } });
    expect(getLegalActions(withColoredPermanent, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(withColoredPermanent, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(withColoredPermanent);
  });

  it('gates the same Relic Engage condition inside a reactive window (offerReactiveEngageActions)', () => {
    const relic = {
      type: 'relic', ownerId: 'B',
      card: { id: 'wr', instanceId: 'wr#0', name: 'Wretched Remnants', keywords: { engage: 'Add (1) Faithless Essence.', engageCondition: 'faithless-only' } },
      engaged: false,
    };
    const coloredBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'colored#0', castingCost: { faithless: 0, colored: { living: 1 } } }), currentLifespan: 3, engaged: false };
    const state = baseState({ reactiveWindow: { openFor: 'B' }, board: { r2c1: relic, r2c2: coloredBeing } });
    expect(getLegalActions(state, 'B')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });
});

describe('"Engage, X: Y" — a required second cost paid alongside Engage (e.g. "Osteomancer")', () => {
  it('pays the sacrifice cost, then resolves the real effect ("Sacrfiice a Bag o\' Bones: Add an Undead to hand from your Purgatory")', () => {
    const osteomancer = {
      type: 'being', ownerId: 'A',
      card: beingCard({
        name: 'Osteomancer',
        keywords: { engage: 'Add an Undead to hand from your Purgatory', engageExtraCost: "Sacrfiice a Bag o' Bones" },
      }),
      currentLifespan: 3, engaged: false,
    };
    const bagOBones = { type: 'relic', ownerId: 'A', card: { id: 'bag', instanceId: 'bag#0', name: "Bag o' Bones", typing: 'Relic, Token' } };
    const undead = { id: 'u1', instanceId: 'u1#0', name: 'Rotting Ghoul', typing: 'Undead, Being' };
    const state = baseState({
      board: { r2c1: osteomancer, r2c2: bagOBones },
      players: { A: player({ purgatory: [undead] }), B: player() },
    });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });

    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c2).toBeUndefined(); // the Bag o' Bones was sacrificed
    expect(next.log.some(e => e.message.includes("sacrifices Bag o' Bones to engage Osteomancer"))).toBe(true);
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: 'Undead', cardName: 'Osteomancer' });
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'u1#0' });
    expect(resolved.players.A.hand).toContainEqual(undead);
    expect(resolved.players.A.purgatory).toHaveLength(0);
  });

  it('does not offer Engage when there is nothing to sacrifice', () => {
    const osteomancer = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Osteomancer', keywords: { engage: 'Add an Undead to hand from your Purgatory', engageExtraCost: "Sacrfiice a Bag o' Bones" } }),
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ board: { r2c1: osteomancer } }); // no Bag o' Bones on the board
    expect(getLegalActions(state, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next).toBe(state);
  });

  it('sacrifices an Animated Armament (e.g. Bag o\' Bones animated via "Animate") as the extra cost without crashing', () => {
    // Regression: the sacrifice candidate search (engageExtraCostSacrificeCell)
    // already matches an Animated Armament acting as a Being the same way it
    // matches a real Being/Relic, but the caller here read `.card.name`
    // straight off the sacrificed occupant — an armament-stack occupant has
    // no top-level `.card` (only `.armaments[i].card`), so this crashed the
    // moment the sacrifice target was an Animated Armament rather than a
    // plain Relic. Self-play found this as a real, reachable crash.
    const osteomancer = {
      type: 'being', ownerId: 'A',
      card: beingCard({
        name: 'Osteomancer',
        keywords: { engage: 'Add an Undead to hand from your Purgatory', engageExtraCost: "Sacrfiice a Bag o' Bones" },
      }),
      currentLifespan: 3, engaged: false,
    };
    const animatedBagOBones = {
      type: 'armament-stack', ownerId: 'A',
      armaments: [{
        card: { id: 'bag', instanceId: 'bag#0', name: "Bag o' Bones", typing: 'Relic, Token, Armament', kind: 'relic-armament', keywords: { animated: true } },
        engaged: false, currentLifespan: 1,
      }],
    };
    const undead = { id: 'u1', instanceId: 'u1#0', name: 'Rotting Ghoul', typing: 'Undead, Being' };
    const state = baseState({
      board: { r2c1: osteomancer, r2c2: animatedBagOBones },
      players: { A: player({ purgatory: [undead] }), B: player() },
    });
    expect(getLegalActions(state, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    let next;
    expect(() => {
      next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    }).not.toThrow();
    expect(next.board.r2c2).toBeUndefined(); // the Animated Bag o' Bones was sacrificed
    expect(next.log.some(e => e.message.includes("sacrifices Bag o' Bones to engage Osteomancer"))).toBe(true);
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: 'Undead', cardName: 'Osteomancer' });
  });

  it('does not offer Engage for an unrecognized extra-cost shape (e.g. "Remove (X) Forge Counters" — Relic counters aren\'t modeled)', () => {
    const relicCard = {
      id: 'smithing', instanceId: 'smithing#0', name: 'Smithing Tools', kind: 'relic',
      keywords: { engage: 'Add an Armament from deck to hand with conjuring cost (X)', engageExtraCost: 'Remove (X) Forge Counters' },
    };
    const state = baseState({ board: { r2c1: { type: 'relic', ownerId: 'A', card: relicCard } } });
    expect(getLegalActions(state, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });

  it('does not offer Engage for a same-tile Relic+Being cost (e.g. "Sacrifice the Being on this tile" — Vadē Rah)', () => {
    const relicCard = {
      id: 'vade-rah', instanceId: 'vade-rah#0', name: 'Vadē Rah', kind: 'relic',
      keywords: { engage: 'add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being.', engageExtraCost: 'Sacrifice the Being on this tile' },
    };
    const state = baseState({ board: { r2c1: { type: 'relic', ownerId: 'A', card: relicCard } } });
    expect(getLegalActions(state, 'A')).not.toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
  });

  describe('both of Osteomancer\'s independent Engage abilities are present and each really works', () => {
    const bothAbilities = [
      { effect: 'Add an Undead to hand from your Purgatory', lifespanCost: null, condition: null, extraCost: "Sacrfiice a Bag o' Bones" },
      { effect: 'Summon a different Undead from your Purgatory.', lifespanCost: null, condition: null, extraCost: 'Sacrifice an Undead' },
    ];
    const osteomancer = () => ({
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Osteomancer', keywords: { engageAbilities: bothAbilities } }),
      currentLifespan: 3, engaged: false,
    });
    const bagOBones = (id = 'bag#0') => ({ type: 'relic', ownerId: 'A', card: { id: 'bag', instanceId: id, name: "Bag o' Bones", typing: 'Relic, Token' } });
    const undeadOnBoard = (id = 'u#0') => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id, name: 'Ghoul', typing: 'Undead, Being' }), currentLifespan: 3, engaged: false });

    it('offers both abilities, each with its own abilityIndex, when both costs are payable', () => {
      const state = baseState({
        board: { r2c1: osteomancer(), r2c2: bagOBones(), r2c3: undeadOnBoard() },
        players: { A: player({ purgatory: [{ id: 'u2', instanceId: 'u2#0', name: 'Ghoul', typing: 'Undead, Being' }] }), B: player() },
      });
      const legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1');
      expect(legal).toEqual(expect.arrayContaining([
        { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 0 },
        { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 1 },
      ]));
      expect(legal).toHaveLength(2);
    });

    it('the first ability (index 0) sacrifices a Bag o\' Bones and searches Purgatory for an Undead', () => {
      const undeadInPurgatory = { id: 'u2', instanceId: 'u2#0', name: 'Ghoul', typing: 'Undead, Being' };
      const state = baseState({
        board: { r2c1: osteomancer(), r2c2: bagOBones() },
        players: { A: player({ purgatory: [undeadInPurgatory] }), B: player() },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 0 });
      expect(next.board.r2c2).toBeUndefined(); // Bag o' Bones sacrificed
      expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: 'Undead', cardName: 'Osteomancer' });
    });

    it('the second ability (index 1) really pays its own cost — sacrifices an Undead — and "different" excludes that same-named card from what it can summon', () => {
      const state = baseState({
        board: { r2c1: osteomancer(), r2c3: undeadOnBoard() },
        players: { A: player(), B: player() },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 1 });
      expect(next.board.r2c3).toBeUndefined(); // the board Undead was really sacrificed to pay the cost
      expect(next.players.A.purgatory.some(c => c.name === 'Ghoul' && c.instanceId === 'u#0')).toBe(true); // it joined Purgatory
      // "different" — the only Undead in Purgatory is the one just sacrificed, so there's nothing legal left to summon.
      expect(next.log.some(e => e.message.includes('finds no different "Undead"'))).toBe(true);
    });

    it('summons a differently-named Undead already sitting in Purgatory, leaving the just-sacrificed same-named one behind', () => {
      const wight = beingCard({ instanceId: 'w#0', name: 'Wight', typing: 'Undead, Being' });
      const state = baseState({
        board: { r2c1: osteomancer(), r2c3: undeadOnBoard() },
        players: { A: player({ purgatory: [wight] }), B: player() },
      });
      let next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 1 });
      // More than one empty Mortal Realm tile is available, so
      // summonFromPurgatoryToOpenCell (actions.js) opens its own
      // 'token-location' choice for where to land, same as any other
      // multi-candidate Purgatory summon.
      expect(next.pendingChoice.kind).toBe('token-location');
      next = gameReducer(next, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c2' });
      expect(next.board.r1c2.card.name).toBe('Wight');
      expect(next.players.A.purgatory.some(c => c.name === 'Wight')).toBe(false); // left Purgatory, onto the board
      expect(next.players.A.purgatory.some(c => c.name === 'Ghoul')).toBe(true); // the sacrificed one stays behind, excluded
    });

    it('opens a choice among more than one differently-named Undead in Purgatory', () => {
      const wight = beingCard({ instanceId: 'w#0', name: 'Wight', typing: 'Undead, Being' });
      const lich = beingCard({ instanceId: 'l#0', name: 'Lich', typing: 'Undead, Being' });
      const state = baseState({
        board: { r2c1: osteomancer(), r2c3: undeadOnBoard() },
        players: { A: player({ purgatory: [wight, lich] }), B: player() },
      });
      let next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 1 });
      expect(next.pendingChoice.kind).toBe('summon-different-typed-from-purgatory');
      const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SUMMON_DIFFERENT_TYPED_FROM_PURGATORY');
      expect(options.map(o => o.instanceId).sort()).toEqual(['l#0', 'w#0']);
      next = gameReducer(next, options.find(o => o.instanceId === 'l#0'));
      expect(next.pendingChoice.kind).toBe('token-location');
      next = gameReducer(next, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c2' });
      expect(next.board.r1c2.card.name).toBe('Lich');
    });

    it('does not offer the second ability when there is no Undead to sacrifice for it, but still offers the first', () => {
      const state = baseState({
        board: { r2c1: osteomancer(), r2c2: bagOBones() }, // no Undead anywhere
        players: { A: player(), B: player() },
      });
      const legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1');
      expect(legal).toEqual([{ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1', abilityIndex: 0 }]);
    });
  });
});

describe('Eònion Zealot: "Once per turn when a Time Counter is removed from a Prophecy you control, add Essence"', () => {
  const eonionZealot = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'Eònion Zealot', keywords: { onProphecyCounterRemoved: { type: 'timeless', amount: 1 } } }),
    currentLifespan: 5, engaged: false,
    ...overrides,
  });
  const prophecy = (owner, timer) => ({
    type: 'prophecy', ownerId: owner, timer, faceDown: true,
    card: { id: 'proph-1', instanceId: 'proph-1#0', name: 'Test Prophecy' },
  });

  it('grants Timeless Essence when the automatic per-turn tick removes a counter', () => {
    const state = baseState({
      turnNumber: 3, board: { r2c1: eonionZealot(), r3c1: prophecy('A', 3) },
      players: { A: player({ effigyPool: [] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toContainEqual(expect.objectContaining({ effigyType: 'timeless', temporary: true }));
    expect(next.board.r2c1.usedProphecyTrigger).toBe(true);
  });

  it('only fires once per turn even if multiple Prophecies tick down', () => {
    const state = baseState({
      turnNumber: 3, board: { r2c1: eonionZealot(), r3c1: prophecy('A', 3), r3c2: prophecy('A', 5) },
      players: { A: player({ effigyPool: [] }), B: player() },
    });
    const next = beginTurn(state);
    const timelessCount = next.players.A.effigyPool.filter(e => e.effigyType === 'timeless').length;
    expect(timelessCount).toBe(1);
  });

  it('resets the once-per-turn flag at the start of the controller\'s next turn', () => {
    const usedZealot = eonionZealot({ usedProphecyTrigger: true });
    const state = baseState({ turnNumber: 3, board: { r2c1: usedZealot } });
    const next = beginTurn(state);
    expect(next.board.r2c1.usedProphecyTrigger).toBe(false);
  });

  it('also fires from a Modulate-as-effect resolution that removes a counter (RESOLVE_MODULATE)', () => {
    const state = baseState({
      board: { r2c1: eonionZealot(), r3c1: prophecy('A', 2) },
      players: { A: player({ effigyPool: [] }), B: player() },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: -1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(next.players.A.effigyPool).toContainEqual(expect.objectContaining({ effigyType: 'timeless' }));
  });

  it('does not fire when a Modulate-as-effect resolution adds a counter instead', () => {
    const state = baseState({
      board: { r2c1: eonionZealot(), r3c1: prophecy('A', 2) },
      players: { A: player({ effigyPool: [] }), B: player() },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: 1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(next.players.A.effigyPool).toEqual([]);
  });
});

describe('Modulate (±X) as an activated effect', () => {
  const prophecy = (owner, timer, overrides = {}) => ({
    type: 'prophecy', ownerId: owner, timer, faceDown: true,
    card: { id: 'proph-1', instanceId: 'proph-1#0', name: 'Test Prophecy', kind: 'prophecy', ...overrides },
  });

  it('a fixed-sign Modulate (-X) with an explicit "you control" parks a pendingChoice targeting only the caster\'s own Prophecies', () => {
    // "on a target you control" (matching Dial of Metatoris's own printed
    // text) — own-only is the printed restriction here, not an assumed
    // default (see the any-owner default test below).
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Modulate (-1) on a target you control.' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being, r3c1: prophecy('A', 3) } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'modulate', playerId: 'A', cardName: 'Test Being', delta: -1 });
  });

  // Regression: with NO "you control" anywhere in the text at all (unlike
  // the test above), a bare Modulate now defaults to targeting EITHER
  // player's Time Counter — see the real CSV's own internal contrast
  // (Hurry Up and Wait spells out "This may only target Time Counters
  // that you control" as an explicit second clause exactly when that
  // restriction applies, and leaves it off otherwise: Charge Forward,
  // Roll Back, the Conjuring literally named "Modulate", and MetaToris
  // all print a bare, unrestricted Modulate).
  it('a fixed-sign Modulate (-X) with no "you control" anywhere defaults to targeting either player\'s Prophecies', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Modulate (-1).' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being, r3c1: prophecy('B', 3) }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'modulate', playerId: 'A', cardName: 'Test Being', delta: -1, anyOwner: true });
    const resolved = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(resolved.board.r3c1.timer).toBe(2); // opponent's own Prophecy — legal now
  });

  it('offers only the searching player\'s own Prophecies as RESOLVE_MODULATE targets', () => {
    const state = baseState({
      board: { r3c1: prophecy('A', 3), r3c2: prophecy('B', 2, { instanceId: 'proph-2#0' }) },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test Card', delta: -1 },
    });
    expect(getLegalActions(state, 'A')).toEqual([{ type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 }]);
    expect(getLegalActions(state, 'B')).toEqual([]);
  });

  it('"Modulate (±X)" offers both signs as separate candidates', () => {
    const state = baseState({
      board: { r3c1: prophecy('A', 3) },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test Card', delta: 'choose' },
    });
    const actions = getLegalActions(state, 'A');
    expect(actions).toEqual(expect.arrayContaining([
      { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 },
      { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 },
    ]));
    expect(actions).toHaveLength(2);
  });

  it('RESOLVE_MODULATE decrements the target\'s Time Counter and clears pendingChoice', () => {
    const state = baseState({
      board: { r3c1: prophecy('A', 3) },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test Card', delta: -1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r3c1.timer).toBe(2);
  });

  it('a Prophecy Modulated to 0 or below resolves and goes to Purgatory, same as the automatic step', () => {
    const state = baseState({
      board: { r3c1: prophecy('A', 1) },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test Card', delta: -1 },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(next.board.r3c1).toBeUndefined();
    expect(next.players.A.purgatory).toHaveLength(1);
    expect(next.log.some(e => e.message.includes('resolves and is sent to Purgatory'))).toBe(true);
  });

  it('a face-down Prophecy Modulated to 0 flips face up and resolves its own flip trigger instead of just vanishing (RULES.md > Prophecies)', () => {
    const state = baseState({
      board: { r3c1: prophecy('A', 1, { textBox: 'Gain (2) Time Counters.' }) },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test Card', delta: -1 },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(next.board.r3c1).toEqual({ ...prophecy('A', 2, { textBox: 'Gain (2) Time Counters.' }), faceDown: false });
    expect(next.players.A.purgatory).toHaveLength(0);
  });

  it('logs "no Time Counter to Modulate" and skips pendingChoice when the caster controls none', () => {
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Modulate (-1).' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('no Time Counter'))).toBe(true);
  });

  it('can target a non-Prophecy Time Counter holder (Hourglass), not just a Prophecy', () => {
    const hourglass = {
      type: 'relic', ownerId: 'A',
      card: { id: 'hg', instanceId: 'hg#0', name: 'Hourglass', kind: 'relic', keywords: { collectsRemovedProphecyTimeCounters: true } },
      engaged: false, counters: { time: 2 },
    };
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Modulate (-1).' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being, r2c2: hourglass } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('modulate');
    const resolved = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r2c2', delta: -1 });
    expect(resolved.board.r2c2.counters).toEqual({ time: 1 });
  });

  it('floors a non-Prophecy holder at 0 rather than going negative', () => {
    const hourglass = {
      type: 'relic', ownerId: 'A',
      card: { id: 'hg', instanceId: 'hg#0', name: 'Hourglass', kind: 'relic', keywords: { collectsRemovedProphecyTimeCounters: true } },
      engaged: false, counters: { time: 0 },
    };
    const being = {
      type: 'being', ownerId: 'A',
      card: beingCard({ keywords: { engage: 'Modulate (-1).' } }),
      currentLifespan: 5, engaged: false,
    };
    const state = baseState({ board: { r2c1: being, r2c2: hourglass } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const resolved = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r2c2', delta: -1 });
    expect(resolved.board.r2c2.counters).toEqual({ time: 0 });
  });
});

describe('PASS_TURN', () => {
  it('hands the turn to the other player via endTurn', () => {
    const state = baseState();
    const next = gameReducer(state, { type: 'PASS_TURN' });
    expect(next.turnPlayer).toBe('B');
  });
});

describe('CONCEDE', () => {
  it('ends the match with the other player as winner', () => {
    const state = baseState();
    const next = gameReducer(state, { type: 'CONCEDE', player: 'A' });
    expect(next.phase).toBe('gameover');
    expect(next.winner).toBe('B');
  });

  it('is a no-op once the game is already over', () => {
    const state = baseState({ phase: 'gameover', winner: 'A' });
    const next = gameReducer(state, { type: 'CONCEDE', player: 'B' });
    expect(next.winner).toBe('A');
  });
});

describe('getLegalActions', () => {
  it('always includes PASS_TURN on the turn player\'s main phase', () => {
    const state = baseState();
    expect(getLegalActions(state, 'A').some(a => a.type === 'PASS_TURN')).toBe(true);
  });

  it('returns nothing for the player who is not on turn', () => {
    const state = baseState();
    expect(getLegalActions(state, 'B')).toEqual([]);
  });

  it('excludes hand cards the player cannot afford', () => {
    const card = beingCard({ castingCost: { faithless: 3, colored: {} } });
    const state = baseState({ players: { A: player({ hand: [card] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'SUMMON_BEING')).toBe(false);
  });
});

describe('createInitialState', () => {
  it('deals a 5-card opening hand from the shuffled Main Deck', () => {
    const mainDeckA = Array.from({ length: 40 }, (_, i) => ({ instanceId: `a${i}` }));
    const mainDeckB = Array.from({ length: 40 }, (_, i) => ({ instanceId: `b${i}` }));
    const state = createInitialState({ mainDeckA, effigyDeckA: [], mainDeckB, effigyDeckB: [], startingPlayer: 'A' });
    expect(state.players.A.hand).toHaveLength(5);
    expect(state.players.A.mainDeck).toHaveLength(35);
    expect(state.phase).toBe('mulligan');
  });
});

describe('"When Summoned" mechanics on Beings', () => {
  // Free (0-cost) so SUMMON_BEING doesn't need an effigyPool set up, unless
  // a test specifically wants to exercise a cost.
  const whenSummonedCard = (overrides = {}) => beingCard({ castingCost: { faithless: 0, colored: {} }, ...overrides });
  const prophecy = (owner, timer = 3) => ({
    type: 'prophecy', ownerId: owner, timer, faceDown: true,
    card: { id: 'proph-1', instanceId: 'proph-1#0', name: 'Test Prophecy' },
  });
  const summon = (card, board = {}, players = {}) => {
    const state = baseState({
      board,
      players: { A: player({ hand: [card], ...players.A }), B: player({ ...players.B }) },
    });
    return gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
  };

  it('does nothing extra for a Being with no When Summoned text', () => {
    const card = whenSummonedCard();
    const next = summon(card);
    expect(next.log.some(e => e.message.includes('When Summoned'))).toBe(false);
  });

  it('reuses the existing search-from-deck path for "add X to hand from deck" (Author)', () => {
    const card = whenSummonedCard({ name: 'Author', keywords: { whenSummoned: 'add a Prophecy to hand from deck.' } });
    const deckProphecy = { instanceId: 'p1', name: 'Charge Forward', typing: 'Prophecy' };
    const next = summon(card, {}, { A: { mainDeck: [deckProphecy] } });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Prophecy', cardName: 'Author' });
  });

  it('substitutes the card\'s own printed name for "this" (Wounded Turanga)', () => {
    const card = whenSummonedCard({ name: 'Wounded Turanga', lifespan: 4, keywords: { whenSummoned: 'deal (2) Damage to Wounded Turanga.' } });
    const next = summon(card);
    expect(next.board.r1c2.currentLifespan).toBe(2);
  });

  it('accepts "to it" as a self-reference too (Impatient Imp)', () => {
    const card = whenSummonedCard({ name: 'Impatient Imp', lifespan: 1, keywords: { whenSummoned: 'deal (1) damage to it.' } });
    const next = summon(card);
    expect(next.board.r1c2).toBeUndefined(); // 1 Lifespan - 1 damage = dies
  });

  it('"deal (N) Damage to all other Beings" hits every other Being, sparing itself (Quake Goliath)', () => {
    const card = whenSummonedCard({ name: 'Quake Goliath', keywords: { whenSummoned: 'deal (1) Damage to all other Beings.' } });
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const next = summon(card, { r2c1: ally, r4c1: enemy });
    expect(next.board.r2c1.currentLifespan).toBe(4);
    expect(next.board.r4c1.currentLifespan).toBe(4);
    expect(next.board.r1c2.currentLifespan).toBe(5); // itself, untouched
  });

  it('"become Favored" is self-targeted and permanent (Favorite Son)', () => {
    const card = whenSummonedCard({ name: 'Favorite Son', keywords: { whenSummoned: 'become Favored (Gains a Favor Counter...)' } });
    const next = summon(card);
    expect(next.board.r1c2.favorCounter).toBe(true);
    expect(next.board.r1c2.favorCounterExpiresEndOfTurn).toBeUndefined();
  });

  it('"target Being you control becomes Favored until end of turn" auto-resolves with one candidate (IkVarem)', () => {
    const card = whenSummonedCard({ name: 'IkVarem', keywords: { whenSummoned: 'target Being you control becomes Favored until end of turn.' } });
    const next = summon(card);
    expect(next.board.r1c2.favorCounter).toBe(true);
    expect(next.board.r1c2.favorCounterExpiresEndOfTurn).toBe(true);
  });

  it('"target Being you control becomes Favored" offers a choice with more than one candidate (IkVarem)', () => {
    const card = whenSummonedCard({ name: 'IkVarem', keywords: { whenSummoned: 'target Being you control becomes Favored until end of turn.' } });
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false };
    const next = summon(card, { r2c1: ally });
    expect(next.pendingChoice).toEqual({ kind: 'grant-favor', playerId: 'A', cardName: 'IkVarem' });
    const resolved = gameReducer(next, { type: 'RESOLVE_GRANT_FAVOR', cellId: 'r2c1' });
    expect(resolved.board.r2c1.favorCounter).toBe(true);
    expect(resolved.pendingChoice).toBeNull();
  });

  it('"If you control a Prophecy, X" does not trigger without one (Clock Tower Custodian)', () => {
    const card = whenSummonedCard({ name: 'Clock Tower Custodian', keywords: { whenSummoned: 'if you control a Prophecy draw (1) card.' } });
    const next = summon(card, {}, { A: { mainDeck: [{ instanceId: 'd1', name: 'Draw Me' }] } });
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.log.some(e => e.message.includes('has no Prophecy'))).toBe(true);
  });

  it('"If you control a Prophecy, X" triggers for real with one (Clock Tower Custodian)', () => {
    const card = whenSummonedCard({ name: 'Clock Tower Custodian', keywords: { whenSummoned: 'if you control a Prophecy draw (1) card.' } });
    const next = summon(card, { r3c1: prophecy('A') }, { A: { mainDeck: [{ instanceId: 'd1', name: 'Draw Me' }] } });
    expect(next.players.A.hand).toHaveLength(1);
    expect(next.players.A.hand[0].name).toBe('Draw Me');
  });

  it('"if you control a Prophecy deal (N) damage to target Being" targets any Being on the board (Massive Mage)', () => {
    const card = whenSummonedCard({ name: 'Massive Mage', keywords: { whenSummoned: 'if you control a Prophecy deal (4) damage to target Being.' } });
    // Only the newly-summoned Mage itself is a legal target — auto-resolves.
    const next = summon(card, { r3c1: prophecy('A') });
    expect(next.board.r1c2.currentLifespan).toBe(1); // 5 Lifespan - 4 damage
  });

  it('offers a choice among multiple Beings, either owner, for "target Being" (Massive Mage)', () => {
    const card = whenSummonedCard({ name: 'Massive Mage', keywords: { whenSummoned: 'if you control a Prophecy deal (4) damage to target Being.' } });
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const next = summon(card, { r3c1: prophecy('A'), r4c1: enemy });
    expect(next.pendingChoice).toEqual({ kind: 'damage-target', playerId: 'A', cardName: 'Massive Mage', damage: 4, typing: null, includesPlayers: false });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
    const resolved = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
    expect(resolved.board.r4c1.currentLifespan).toBe(1);
  });

  it('"reveal the top card of your deck" is log-only, no state change (Sneaky Peek)', () => {
    const card = whenSummonedCard({ name: 'Sneaky Peek', keywords: { whenSummoned: 'if you control a Prophecy, reveal the top card of your deck.' } });
    const deckCard = { instanceId: 'd1', name: 'Secret Card' };
    const next = summon(card, { r3c1: prophecy('A') }, { A: { mainDeck: [deckCard] } });
    expect(next.players.A.mainDeck).toEqual([deckCard]);
    expect(next.log.some(e => e.message.includes('Secret Card'))).toBe(true);
  });

  it('"draw (N) cards, then put (1) card from hand on the bottom of deck" chains correctly (Weaver)', () => {
    const card = whenSummonedCard({ name: 'Weaver', keywords: { whenSummoned: 'draw (2) cards, then put (1) card from hand on the bottom of deck.' } });
    const deck = [{ instanceId: 'd1', name: 'Card 1' }, { instanceId: 'd2', name: 'Card 2' }];
    const next = summon(card, {}, { A: { mainDeck: deck } });
    // Drew both, hand now has exactly 2 — a real choice of which to bottom.
    expect(next.pendingChoice).toEqual({ kind: 'bottom-of-deck', playerId: 'A', cardName: 'Weaver' });
    const resolved = gameReducer(next, { type: 'RESOLVE_BOTTOM_OF_DECK', instanceId: 'd1' });
    expect(resolved.players.A.hand).toHaveLength(1);
    expect(resolved.players.A.mainDeck.at(-1).instanceId).toBe('d1');
  });

  it('"draw (1) card, then discard (1) card at random" reuses the existing chained-then split (Imp-practical Joker)', () => {
    const card = whenSummonedCard({ name: 'Imp-practical Joker', keywords: { whenSummoned: 'draw (1) card, then discard (1) card at random.' } });
    const deckCard = { instanceId: 'd1', name: 'Drawn Card' };
    const next = summon(card, {}, { A: { mainDeck: [deckCard] } });
    expect(next.players.A.hand).toHaveLength(0); // drawn, then immediately discarded
    expect(next.players.A.purgatory).toHaveLength(1);
  });

  it('reveals the top card and adds it to hand only if it matches the named typing (Farm hand)', () => {
    const card = whenSummonedCard({ name: 'Farm hand', keywords: { whenSummoned: 'reveal the top of your deck, if it is a Seed Being add it to hand.' } });
    const seed = { instanceId: 'd1', name: 'Little Seed', typing: 'Seed, Being' };
    const matched = summon(card, {}, { A: { mainDeck: [seed] } });
    expect(matched.players.A.hand).toHaveLength(1);
    // revealPopup (bug report: "reveal the card large scale... Add a Put
    // Back on top button... and a Draw button") — a transient, purely
    // informational field the UI shows in a large popup; the real
    // outcome above is already fully decided by the time this is set.
    expect(matched.revealPopup).toEqual({ playerId: 'A', card: seed, outcome: 'drawn', cardName: 'Farm hand', label: 'When Summoned' });

    const nonSeed = { instanceId: 'd2', name: 'Not A Seed', typing: 'Human, Being' };
    const unmatched = summon(card, {}, { A: { mainDeck: [nonSeed] } });
    expect(unmatched.players.A.hand).toHaveLength(0);
    expect(unmatched.players.A.mainDeck).toEqual([nonSeed]);
    expect(unmatched.revealPopup).toEqual({ playerId: 'A', card: nonSeed, outcome: 'kept', cardName: 'Farm hand', label: 'When Summoned' });
  });

  it('DISMISS_REVEAL_POPUP clears the transient revealPopup field, and is a no-op with none pending', () => {
    const card = whenSummonedCard({ name: 'Farm hand', keywords: { whenSummoned: 'reveal the top of your deck, if it is a Seed Being add it to hand.' } });
    const seed = { instanceId: 'd1', name: 'Little Seed', typing: 'Seed, Being' };
    const state = summon(card, {}, { A: { mainDeck: [seed] } });
    expect(state.revealPopup).toBeDefined();
    const dismissed = gameReducer(state, { type: 'DISMISS_REVEAL_POPUP' });
    expect(dismissed.revealPopup).toBeUndefined();
    expect(gameReducer(dismissed, { type: 'DISMISS_REVEAL_POPUP' })).toBe(dismissed); // no-op, same reference
  });

  it('"look at the top (N) cards ... return them in the same order" leaves the deck unchanged (Seeress)', () => {
    const card = whenSummonedCard({ name: 'Seeress', keywords: { whenSummoned: 'look at the top (2) cards of your deck, return them in the same order.' } });
    const deck = [{ instanceId: 'd1', name: 'Top' }, { instanceId: 'd2', name: 'Second' }];
    const next = summon(card, {}, { A: { mainDeck: deck } });
    expect(next.players.A.mainDeck).toEqual(deck);
  });

  it('draws the lowest-cost revealed card for its controller (Humble Contrarian)', () => {
    const card = whenSummonedCard({ name: 'Humble Contrarian', keywords: { whenSummoned: 'reveal the top card of each deck, the player who has the lowest cost card draws it. If it is tied each player draws.' } });
    const cheap = { instanceId: 'a1', name: 'Cheap', castingCost: { faithless: 1, colored: {} } };
    const pricey = { instanceId: 'b1', name: 'Pricey', castingCost: { faithless: 5, colored: {} } };
    const next = summon(card, {}, { A: { mainDeck: [cheap] }, B: { mainDeck: [pricey] } });
    expect(next.players.A.hand.map(c => c.instanceId)).toContain('a1');
    expect(next.players.B.hand).toHaveLength(0);
  });

  it('draws the highest-cost revealed card for its controller (Pompous Contrarian)', () => {
    const card = whenSummonedCard({ name: 'Pompous Contrarian', keywords: { whenSummoned: 'reveal the top card of each deck.The player who has the highest cost card draws it. If it is tied each player draws' } });
    const cheap = { instanceId: 'a1', name: 'Cheap', castingCost: { faithless: 1, colored: {} } };
    const pricey = { instanceId: 'b1', name: 'Pricey', castingCost: { faithless: 5, colored: {} } };
    const next = summon(card, {}, { A: { mainDeck: [cheap] }, B: { mainDeck: [pricey] } });
    expect(next.players.B.hand.map(c => c.instanceId)).toContain('b1');
    expect(next.players.A.hand).toHaveLength(0);
  });

  it('a tied cost comparison draws for both players (Contrarian)', () => {
    const card = whenSummonedCard({ name: 'Humble Contrarian', keywords: { whenSummoned: 'reveal the top card of each deck, the player who has the lowest cost card draws it. If it is tied each player draws.' } });
    const a = { instanceId: 'a1', name: 'A', castingCost: { faithless: 2, colored: {} } };
    const b = { instanceId: 'b1', name: 'B', castingCost: { faithless: 2, colored: {} } };
    const next = summon(card, {}, { A: { mainDeck: [a] }, B: { mainDeck: [b] } });
    expect(next.players.A.hand).toHaveLength(1);
    expect(next.players.B.hand).toHaveLength(1);
  });

  it('"look at the top card ... then you may shuffle or put it back on top" offers a real choice (Inquisitive Prodigy)', () => {
    const card = whenSummonedCard({ name: 'Inquisitive Prodigy', keywords: { whenSummoned: 'look at the top card of your deck, then you may shuffle or put it back on top.' } });
    const deck = [{ instanceId: 'd1' }, { instanceId: 'd2' }];
    const next = summon(card, {}, { A: { mainDeck: deck } });
    expect(next.pendingChoice).toEqual({ kind: 'shuffle-or-keep', playerId: 'A', cardName: 'Inquisitive Prodigy', deckOwner: 'A' });

    const kept = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: false });
    expect(kept.players.A.mainDeck).toEqual(deck);
    expect(kept.pendingChoice).toBeNull();

    const shuffled = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: true });
    expect(shuffled.players.A.mainDeck).toHaveLength(2);
    expect(shuffled.pendingChoice).toBeNull();
  });

  it('"Look at the top card of an opponent\'s deck. You may have them shuffle." looks at and may shuffle the OPPONENT\'s deck, not the caster\'s (Foresight)', () => {
    const foresight = {
      id: 'foresight-1', instanceId: 'foresight-1#0', name: 'Foresight', kind: 'conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Look at the top card of an opponents deck. You may have them shuffle.',
    };
    const opponentDeck = [{ instanceId: 'b1' }, { instanceId: 'b2' }];
    const state = baseState({
      players: { A: player({ hand: [foresight] }), B: player({ mainDeck: opponentDeck }) },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'foresight-1#0' });
    expect(next.pendingChoice).toEqual({ kind: 'shuffle-or-keep', playerId: 'A', cardName: 'Foresight', deckOwner: 'B' });

    const kept = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: false });
    expect(kept.players.B.mainDeck).toEqual(opponentDeck);
    expect(kept.players.A.mainDeck).toEqual([]);

    const shuffled = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: true });
    expect(shuffled.players.B.mainDeck).toHaveLength(2);
  });

  it('"Look at the top (X) cards of your deck where (X) is the number of Undead in your Purgatory, then put them back in any order you like or shuffle." reuses shuffle-or-keep (Read the Bones)', () => {
    const readTheBones = {
      id: 'rtb', instanceId: 'rtb#0', name: 'Read the Bones', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Look at the top (X) cards of your deck where (X) is the number of Undead in your Purgatory, then put them back in any order you like or shuffle.',
    };
    const undead1 = { instanceId: 'u1', name: 'Zombie', typing: 'Undead, Being' };
    const undead2 = { instanceId: 'u2', name: 'Skeleton', typing: 'Undead, Being' };
    const deck = [{ instanceId: 'd1' }, { instanceId: 'd2' }];
    const state = baseState({
      players: { A: player({ hand: [readTheBones], purgatory: [undead1, undead2], mainDeck: deck }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'rtb#0' });
    expect(next.log.some(e => e.message.includes('top 2 card(s)'))).toBe(true); // 2 Undead in Purgatory
    expect(next.pendingChoice).toEqual({ kind: 'shuffle-or-keep', playerId: 'A', cardName: 'Read the Bones', deckOwner: 'A' });
    const kept = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: false });
    expect(kept.players.A.mainDeck).toEqual(deck);
    const shuffled = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: true });
    expect(shuffled.players.A.mainDeck).toHaveLength(2);
  });

  it('Read the Bones is a no-op with 0 Undead in Purgatory — no pendingChoice opened', () => {
    const readTheBones = {
      id: 'rtb', instanceId: 'rtb#0', name: 'Read the Bones', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Look at the top (X) cards of your deck where (X) is the number of Undead in your Purgatory, then put them back in any order you like or shuffle.',
    };
    const state = baseState({ players: { A: player({ hand: [readTheBones], purgatory: [], mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'rtb#0' });
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('top 0 card(s)'))).toBe(true);
  });

  it('"you may target a Prophecy and reveal it" is optional and log-only when accepted (Vaticinator)', () => {
    const card = whenSummonedCard({ name: 'Vaticinator', keywords: { whenSummoned: 'you may target a Prophecy and reveal it without triggering it. Return it Face down afterwards.' } });
    const next = summon(card, { r3c1: prophecy('A') });
    expect(next.pendingChoice).toEqual({ kind: 'reveal-prophecy', playerId: 'A', cardName: 'Vaticinator', optional: true });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DECLINE' });
    const resolved = gameReducer(next, { type: 'RESOLVE_REVEAL_PROPHECY', cellId: 'r3c1' });
    expect(resolved.pendingChoice).toBeNull();
    expect(resolved.board.r3c1).toBeDefined(); // still there, untouched
  });

  it('Decline clears an optional pending choice without doing anything (Vaticinator)', () => {
    const card = whenSummonedCard({ name: 'Vaticinator', keywords: { whenSummoned: 'you may target a Prophecy and reveal it without triggering it.' } });
    const next = summon(card, { r3c1: prophecy('A') });
    const declined = gameReducer(next, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBeNull();
  });

  it('RESOLVE_DECLINE is a no-op against a non-optional pending choice', () => {
    const card = whenSummonedCard({ name: 'IkVarem', keywords: { whenSummoned: 'target Being you control becomes Favored until end of turn.' } });
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false };
    const next = summon(card, { r2c1: ally });
    expect(next.pendingChoice).not.toBeNull();
    const declined = gameReducer(next, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toEqual(next.pendingChoice); // untouched — not optional
  });

  it('"you may sacrifice a Prophecy, then destroy target non Deity Being" never triggers without both (Cro-āsik Hunger)', () => {
    const card = whenSummonedCard({ name: 'Cro-āsik Hunger', keywords: { whenSummoned: 'you may sacrifice a Prophecy you control, then destroy target non Diety Being (Lifespan damage is not dealt)' } });
    const next = summon(card); // no Prophecy, no other Being
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('has no legal Prophecy'))).toBe(true);
  });

  it('sacrifices the chosen Prophecy and destroys the chosen Being without Lifespan damage (Cro-āsik Hunger)', () => {
    const card = whenSummonedCard({ name: 'Cro-āsik Hunger', keywords: { whenSummoned: 'you may sacrifice a Prophecy you control, then destroy target non Diety Being (Lifespan damage is not dealt)' } });
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy', lifespan: 9 }), currentLifespan: 9, engaged: false };
    const next = summon(card, { r3c1: prophecy('A'), r4c1: enemy });
    expect(next.pendingChoice).toEqual({ kind: 'sacrifice-destroy', playerId: 'A', cardName: 'Cro-āsik Hunger', optional: true });
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE_DESTROY', prophecyCellId: 'r3c1', targetCellId: 'r4c1' });
    expect(resolved.board.r3c1).toBeUndefined();
    expect(resolved.board.r4c1).toBeUndefined();
    expect(resolved.players.B.lifespan).toBe(50); // "Lifespan damage is not dealt"
    expect(resolved.players.A.purgatory).toContainEqual(prophecy('A').card);
  });

  it('"target opponent sacrifices a Being" is chosen by the opponent, without Lifespan damage (Venefica)', () => {
    const card = whenSummonedCard({ name: 'Venefica', keywords: { whenSummoned: 'target opponent sacrifices a Being but takes no Lifespan damage from it.' } });
    const enemy1 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e1', lifespan: 9 }), currentLifespan: 9, engaged: false };
    const enemy2 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e2', lifespan: 9 }), currentLifespan: 9, engaged: false };
    const next = summon(card, { r4c1: enemy1, r4c2: enemy2 });
    expect(next.pendingChoice).toEqual({ kind: 'sacrifice', playerId: 'B', cardName: 'Venefica' });
    expect(getLegalActions(next, 'A')).toEqual([]); // it's B's choice, not A's
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE', cellId: 'r4c1' });
    expect(resolved.board.r4c1).toBeUndefined();
    expect(resolved.players.B.lifespan).toBe(50);
  });

  it('auto-resolves the forced sacrifice when the opponent has exactly one Being (Venefica)', () => {
    const card = whenSummonedCard({ name: 'Venefica', keywords: { whenSummoned: 'target opponent sacrifices a Being but takes no Lifespan damage from it.' } });
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e1', lifespan: 9 }), currentLifespan: 9, engaged: false };
    const next = summon(card, { r4c1: enemy });
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r4c1).toBeUndefined();
  });

  it('does nothing when the opponent has no Being to sacrifice (Venefica)', () => {
    const card = whenSummonedCard({ name: 'Venefica', keywords: { whenSummoned: 'target opponent sacrifices a Being but takes no Lifespan damage from it.' } });
    const next = summon(card);
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('no Being to sacrifice'))).toBe(true);
  });

  it('"engage target non Deity Being ... does not disengage" taps it and flags it (Instigator)', () => {
    const card = whenSummonedCard({ name: 'Instigator', keywords: { whenSummoned: 'engage target non Deity Being, until the start of your next turn it gains "This does not disengage during Disengage Step".' } });
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const next = summon(card, { r4c1: enemy });
    expect(next.pendingChoice).toEqual({ kind: 'doesnt-disengage', playerId: 'A', cardName: 'Instigator' });
    const resolved = gameReducer(next, { type: 'RESOLVE_DOESNT_DISENGAGE', cellId: 'r4c1' });
    expect(resolved.board.r4c1.engaged).toBe(true);
    expect(resolved.board.r4c1.doesNotDisengage).toBe(true);
  });

  it('auto-resolves onto the only legal target — itself, if nothing else qualifies (Instigator)', () => {
    const card = whenSummonedCard({ name: 'Instigator', keywords: { whenSummoned: 'engage target non Deity Being, until the start of your next turn it gains "This does not disengage during Disengage Step".' } });
    const next = summon(card);
    expect(next.board.r1c2.engaged).toBe(true);
    expect(next.board.r1c2.doesNotDisengage).toBe(true);
  });

  it('Distant Debator\'s own "you may" phrasing reuses the same doesnt-disengage mechanism, but stays optional even with a single candidate', () => {
    const distantDebator = { instanceId: 'dd#0', name: 'Distant Debator', keywords: { onRevealedTopOfDeck: 'you may engage a non Deity Being in the Mortal Realm until your next turn.' } };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      turnNumber: 3, board: { r4c1: enemy },
      players: { A: player({ mainDeck: [distantDebator] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.players.A.hand).toContainEqual(distantDebator);
    expect(next.pendingChoice).toEqual({ kind: 'doesnt-disengage', playerId: 'A', cardName: 'Distant Debator', optional: true });
    expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_DECLINE' });
    const resolved = gameReducer(next, { type: 'RESOLVE_DOESNT_DISENGAGE', cellId: 'r4c1' });
    expect(resolved.board.r4c1.engaged).toBe(true);
    expect(resolved.board.r4c1.doesNotDisengage).toBe(true);
  });

  it('declining Distant Debator\'s trigger leaves the target untouched', () => {
    const distantDebator = { instanceId: 'dd#0', name: 'Distant Debator', keywords: { onRevealedTopOfDeck: 'you may engage a non Deity Being in the Mortal Realm until your next turn.' } };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      turnNumber: 3, board: { r4c1: enemy },
      players: { A: player({ mainDeck: [distantDebator] }), B: player() },
    });
    const next = beginTurn(state);
    const declined = gameReducer(next, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBeNull();
    expect(declined.board.r4c1.engaged).toBe(false);
  });

  it('fires from a card-effect-driven draw too, not just the normal Draw Step (drawCardsFor path)', () => {
    const drawTwo = {
      id: 'dt', instanceId: 'dt#0', name: 'Draw Two', kind: 'conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Draw (2) cards.',
    };
    const distantDebator = { instanceId: 'dd#0', name: 'Distant Debator', keywords: { onRevealedTopOfDeck: 'you may engage a non Deity Being in the Mortal Realm until your next turn.' } };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c1: enemy },
      players: { A: player({ hand: [drawTwo], mainDeck: [{ instanceId: 'filler#0' }, distantDebator] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dt#0' });
    expect(next.players.A.hand).toContainEqual(distantDebator);
    expect(next.pendingChoice).toEqual({ kind: 'doesnt-disengage', playerId: 'A', cardName: 'Distant Debator', optional: true });
  });

  it('"this Being\'s Strength and Lifespan becomes equal to target Being" copies stats (Thespian)', () => {
    const card = whenSummonedCard({ name: 'Thespian', strength: 0, lifespan: 1, keywords: { whenSummoned: 'this Being\'s Strength and Lifespan becomes equal to target Being you control.' } });
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally', strength: 7, lifespan: 9 }), currentLifespan: 6, engaged: false };
    const next = summon(card, { r2c1: ally });
    expect(next.pendingChoice.kind).toBe('copy-stats');
    const resolved = gameReducer(next, { type: 'RESOLVE_COPY_STATS', cellId: 'r2c1' });
    expect(resolved.board.r1c2.strengthOverride).toBe(7);
    expect(resolved.board.r1c2.currentLifespan).toBe(6);
    expect(effectiveStrength(resolved.board.r1c2)).toBe(7);
  });

  it('gates the optional Lifespan-cost buff on affordability and a legal target (Lamtukka Gentleman)', () => {
    const card = whenSummonedCard({
      name: 'Lamtukka Gentleman', typing: 'Demon, Being',
      keywords: { whenSummoned: 'you may pay (3) Lifespan to give a different demon or imp you control +1/+1' },
    });
    const next = summon(card); // no other Demon/Imp on board
    expect(next.pendingChoice).toBeNull();
  });

  it('pays the Lifespan cost and applies a permanent +S/+L to the chosen ally, excluding itself (Lamtukka Gentleman)', () => {
    const card = whenSummonedCard({
      name: 'Lamtukka Gentleman', typing: 'Demon, Being',
      keywords: { whenSummoned: 'you may pay (3) Lifespan to give a different demon or imp you control +1/+1' },
    });
    const imp = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'imp', typing: 'Imp, Being', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const next = summon(card, { r2c1: imp }, { A: { lifespan: 50 } });
    expect(next.pendingChoice).toEqual({
      kind: 'buff-ally', playerId: 'A', cardName: 'Lamtukka Gentleman', cost: 3, strengthBonus: 1, lifespanBonus: 1, optional: true,
    });
    const resolved = gameReducer(next, { type: 'RESOLVE_BUFF_ALLY', cellId: 'r2c1' });
    expect(resolved.players.A.lifespan).toBe(47);
    expect(resolved.board.r2c1.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
    expect(resolved.board.r2c1.currentLifespan).toBe(2);
    expect(effectiveStrength(resolved.board.r2c1)).toBe(2);
  });

  it('"Shuffle (N) cards into deck from your Purgatory ... or draw (M) Cards" offers a mandatory either/or (MetaToris)', () => {
    const card = whenSummonedCard({
      name: 'MetaToris',
      keywords: { whenSummoned: 'Shuffle (3) cards into deck from your Purgatory (can not target MetaToris) or draw (3) Cards.' },
    });
    const next = summon(card);
    expect(next.pendingChoice).toEqual({ kind: 'shuffle-or-draw', playerId: 'A', cardName: 'MetaToris', shuffleCount: 3, drawCount: 3 });
    expect(getLegalActions(next, 'A')).toEqual([
      { type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: true },
      { type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: false },
    ]);
  });

  it('shuffling moves cards from Purgatory into the deck (MetaToris)', () => {
    const card = whenSummonedCard({
      name: 'MetaToris',
      keywords: { whenSummoned: 'Shuffle (3) cards into deck from your Purgatory (can not target MetaToris) or draw (3) Cards.' },
    });
    const purgatory = [{ instanceId: 'p1' }, { instanceId: 'p2' }];
    const next = summon(card, {}, { A: { purgatory } });
    const resolved = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: true });
    expect(resolved.players.A.purgatory).toHaveLength(0);
    expect(resolved.players.A.mainDeck).toHaveLength(2);
  });

  it('drawing draws the printed count (MetaToris)', () => {
    const card = whenSummonedCard({
      name: 'MetaToris',
      keywords: { whenSummoned: 'Shuffle (3) cards into deck from your Purgatory (can not target MetaToris) or draw (3) Cards.' },
    });
    const deck = [{ instanceId: 'd1' }, { instanceId: 'd2' }, { instanceId: 'd3' }];
    const next = summon(card, {}, { A: { mainDeck: deck } });
    const resolved = gameReducer(next, { type: 'RESOLVE_SHUFFLE_OR_DRAW', shuffle: false });
    expect(resolved.players.A.hand).toHaveLength(3);
  });

  describe('"this Deity immediately moves without engaging" (Mahka-Rahva)', () => {
    const mahkaCard = (overrides = {}) => whenSummonedCard({
      name: 'Mahka-Rahva', isDeity: true,
      keywords: { whenSummoned: 'this Diety immediately moves without engaging.' }, // real CSV's own typo
      ...overrides,
    });

    it('relocates and moves the single open destination directly when only one is legal', () => {
      // Boxed in on every side but one (r2c1) — same "box in" technique as
      // Feathers of the Fallen's own free-move tests above. From r1c2,
      // A's other 3 legal directions land on r2c2, r2c3, and r1c3.
      const blocker = (id) => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
      const next = summon(mahkaCard(), { r2c2: blocker('b1'), r2c3: blocker('b2'), r1c3: blocker('b3') });
      expect(next.board.r1c2).toBeUndefined();
      expect(next.board.r2c1.type).toBe('being');
      expect(next.board.r2c1.card.name).toBe('Mahka-Rahva');
      // Already entered disengaged as a Deity (RULES.md > Keywords); the
      // free move doesn't change that — she's still ready for a real action.
      expect(next.board.r2c1.engaged).toBe(false);
    });

    it('offers a free-move choice among multiple legal destinations, resolving to whichever is chosen — still disengaged after', () => {
      const next = summon(mahkaCard());
      expect(next.pendingChoice).toEqual({ kind: 'free-move', playerId: 'A', cardName: 'Mahka-Rahva', fromCellId: 'r1c2' });
      const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_FREE_MOVE');
      expect(options.length).toBeGreaterThan(1);
      const resolved = gameReducer(next, options[0]);
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.board[options[0].toCellId].engaged).toBe(false);
    });

    it('can still take a real action the same turn after the forced move — a second action, on top of the free move', () => {
      const blocker = (id) => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
      const next = summon(mahkaCard(), { r2c2: blocker('b1'), r2c3: blocker('b2'), r1c3: blocker('b3') });
      // Landed at r2c1 (the one open cell) per the earlier test — still
      // disengaged, so a real MOVE_OR_ATTACK is legally available to her.
      const moveActions = getLegalActions(next, 'A').filter(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r2c1');
      expect(moveActions.length).toBeGreaterThan(0);
    });

    it('logs an honest "nowhere to move" instead of crashing when fully boxed in', () => {
      const blocker = (id) => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
      const next = summon(mahkaCard(), { r2c2: blocker('b1'), r2c3: blocker('b2'), r1c3: blocker('b3'), r2c1: blocker('b4') });
      expect(next.board.r1c2.card.name).toBe('Mahka-Rahva'); // never moved
      expect(next.log.some(e => e.message.includes('has nowhere to move'))).toBe(true);
    });
  });

  describe('"All Armaments you control move to the tile this is summoned on" (Mahka-Rahva)', () => {
    const gatherCard = (overrides = {}) => whenSummonedCard({
      name: 'Mahka-Rahva', isDeity: true,
      keywords: { gathersArmamentsOnSummon: true },
      ...overrides,
    });
    const rapier = (id = 'rapier#0') => ({
      id: 'rapier', instanceId: id, name: 'Rusted Rapier', kind: 'relic-armament',
      castingCost: { faithless: 0, colored: {} }, keywords: { statBonus: { strength: 1, lifespan: 0 } },
    });

    it('strips an Armament off another Being the player controls and reattaches it here', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [equip(rapier())] };
      const next = summon(gatherCard(), { r2c1: ally });
      expect(next.board.r2c1.armaments).toBeUndefined();
      expect(next.board.r1c2.armaments).toEqual([equip(rapier())]);
    });

    it('empties and removes a freestanding Armament-stack pile entirely once its Armaments are gathered', () => {
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(rapier())] };
      const next = summon(gatherCard(), { r2c1: pile });
      expect(next.board.r2c1).toBeUndefined();
      expect(next.board.r1c2.armaments).toEqual([equip(rapier())]);
    });

    it('leaves the opponent\'s Armaments untouched', () => {
      const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false, armaments: [equip(rapier())] };
      const next = summon(gatherCard(), { r4c1: enemy });
      expect(next.board.r4c1.armaments).toEqual([equip(rapier())]); // untouched
      expect(next.board.r1c2.armaments).toBeUndefined(); // nothing gathered
    });

    it('merges gathered Armaments with any already waiting on its own summon tile', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [equip(rapier('r1#0'))] };
      const waitingPile = { type: 'armament-stack', ownerId: 'A', armaments: [equip(rapier('r2#0'))] };
      const next = summon(gatherCard(), { r2c1: ally, r1c2: waitingPile });
      expect(next.board.r1c2.armaments).toEqual([equip(rapier('r2#0')), equip(rapier('r1#0'))]);
    });

    it('does not touch the previous host\'s currentLifespan even when the moved Armament had granted a Lifespan bonus (documented simplification)', () => {
      const boosted = rapier();
      boosted.keywords = { statBonus: { strength: 0, lifespan: 2 } };
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally', lifespan: 3 }), currentLifespan: 5, engaged: false, armaments: [equip(boosted)] };
      const mahka = gatherCard({ lifespan: 5 });
      const next = summon(mahka, { r2c1: ally });
      expect(next.board.r2c1.currentLifespan).toBe(5); // still reflects the bonus it already banked, untouched
      expect(next.board.r1c2.currentLifespan).toBe(5); // Mahka's own printed Lifespan, not re-boosted a second time
    });

    it('a moved Armament\'s Strength bonus follows live to its new host, no extra bookkeeping needed', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [equip(rapier())] };
      const next = summon(gatherCard(), { r2c1: ally });
      expect(effectiveStrength(next.board.r1c2)).toBe(next.board.r1c2.card.strength + 1);
    });

    it('gathers, then still carries the newly-gathered Armaments along when she moves without engaging (full Mahka-Rahva text)', () => {
      const realMahka = whenSummonedCard({
        name: 'Mahka-Rahva', isDeity: true,
        keywords: { gathersArmamentsOnSummon: true, whenSummoned: 'this Diety immediately moves without engaging.' },
      });
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [equip(rapier())] };
      // Box in every direction but one (r2c1 is the ally itself, so it's
      // already not a legal destination) — leaves r2c2 as the sole option.
      const blocker = (id) => ({ type: 'being', ownerId: 'B', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
      const next = summon(realMahka, { r2c1: ally, r2c3: blocker('b1'), r1c3: blocker('b2') });
      expect(next.board.r1c2).toBeUndefined(); // moved away from the summon tile
      expect(next.board.r2c2.card.name).toBe('Mahka-Rahva');
      expect(next.board.r2c2.armaments).toEqual([equip(rapier())]); // gathered, then carried along
      expect(next.board.r2c1.armaments).toBeUndefined(); // stripped from the ally
    });

    it('does not crash resolving "moves without engaging" text when selfCellId names an Animated Armament instead of a real Being', () => {
      // Regression: self-play found this exact crash 6 times across a
      // 5-hour, 2.5M-game run (occupant.card.name off undefined) — the
      // real trigger chain wasn't pinned down (astronomically rare: some
      // interaction of a granted/borrowed "moves without engaging" ability
      // landing on an Animated Armament rather than Mahka-Rahva herself),
      // but the underlying shape is the same "a real Being carries its own
      // top-level `card`; an Animated Armament acting as one doesn't" gap
      // fixed everywhere else in this file (moveBeingFreely and friends) —
      // proven directly here via resolveOrLogEffect rather than relying on
      // reproducing the exact natural trigger.
      const animatedPile = {
        type: 'armament-stack', ownerId: 'A',
        armaments: [{ card: { id: 'ds', instanceId: 'ds#0', name: 'Dancing Swords', kind: 'relic-armament', keywords: { animated: true } }, engaged: false, currentLifespan: 3 }],
      };
      const state = baseState({ board: { r2c1: animatedPile } });
      let next;
      expect(() => {
        next = resolveOrLogEffect(state, 'A', 'Mahka-Rahva', 'this Diety immediately moves without engaging.', 'When Summoned', { selfCellId: 'r2c1' });
      }).not.toThrow();
      // More than one legal destination from r2c1 on an otherwise-empty
      // board — opens the free-move choice (the branch that reads the
      // acting card's own name for its log line) rather than auto-resolving.
      expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'free-move', fromCellId: 'r2c1' }));
      expect(next.log.some(e => e.message.includes('Dancing Swords moves'))).toBe(true);
    });
  });

  describe('"sacrifice an Armament, then draw (1) card" (Tiny Forge Master)', () => {
    const tinyForgeMaster = () => whenSummonedCard({
      name: 'Tiny Forge Master', keywords: { whenSummoned: 'sacrifice an Armament, then draw (1) card.' },
    });
    const rusted = (id = 'rr#0') => equip({ id: 'rr', instanceId: id, name: 'Rusted Rapier', kind: 'relic-armament' });

    it('does nothing — no draw either — when the player controls no Armament at all', () => {
      const next = summon(tinyForgeMaster(), {}, { A: { mainDeck: [{ instanceId: 'd1' }] } });
      expect(next.players.A.hand).toHaveLength(0); // never drew — the cost was never paid
      expect(next.players.A.mainDeck).toHaveLength(1); // untouched
      expect(next.log.some(e => e.message.includes('has no Armament to sacrifice'))).toBe(true);
    });

    it('auto-resolves with the single Armament available: sacrifices it, then really draws', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [rusted()] };
      const next = summon(tinyForgeMaster(), { r2c1: ally }, { A: { mainDeck: [{ instanceId: 'd1' }] } });
      expect(next.board.r2c1.armaments).toEqual([]);
      expect(next.players.A.hand).toHaveLength(1);
      expect(next.players.A.hand[0].instanceId).toBe('d1');
      expect(next.players.A.mainDeck).toHaveLength(0);
    });

    it('offers a choice when more than one Armament is available, and resolving pays that one and draws', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false, armaments: [rusted('a#0')] };
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [rusted('b#0')] };
      const next = summon(tinyForgeMaster(), { r2c1: ally, r2c2: pile }, { A: { mainDeck: [{ instanceId: 'd1' }] } });
      expect(next.pendingChoice).toEqual({ kind: 'sacrifice-armament', playerId: 'A', cardName: 'Tiny Forge Master', drawCount: 1 });
      const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SACRIFICE_ARMAMENT');
      expect(options).toHaveLength(2);
      const resolved = gameReducer(next, options[0]);
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.players.A.hand).toHaveLength(1);
      // Whichever Armament was chosen is gone; the other is untouched.
      const remaining = options[0].cellId === 'r2c1' ? resolved.board.r2c2 : resolved.board.r2c1;
      expect(remaining.armaments).toHaveLength(1);
    });

    it('removes a now-empty freestanding Armament pile entirely after it\'s sacrificed', () => {
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [rusted()] };
      const next = summon(tinyForgeMaster(), { r2c1: pile }, { A: { mainDeck: [{ instanceId: 'd1' }] } });
      expect(next.board.r2c1).toBeUndefined();
      expect(next.players.A.hand).toHaveLength(1);
    });

    it('does not let the opponent\'s Armament pay the cost', () => {
      const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy' }), currentLifespan: 5, engaged: false, armaments: [rusted()] };
      const next = summon(tinyForgeMaster(), { r4c1: enemy }, { A: { mainDeck: [{ instanceId: 'd1' }] } });
      expect(next.board.r4c1.armaments).toEqual([rusted()]); // untouched
      expect(next.players.A.hand).toHaveLength(0); // never drew
      expect(next.log.some(e => e.message.includes('has no Armament to sacrifice'))).toBe(true);
    });
  });

  describe('"Sacrifice an Armament, then draw one card." (Forge Master) — word-form count, not a digit', () => {
    const forgeMaster = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Forge Master', keywords: { engage: 'Sacrifice an Armament, then draw one card.' } }), currentLifespan: 3, engaged: false };
    const rusted = () => equip({ id: 'rr', instanceId: 'rr#0', name: 'Rusted Rapier', kind: 'relic-armament' });

    it('really sacrifices the Armament before drawing — not a free draw', () => {
      const withArmament = { ...forgeMaster, armaments: [rusted()] };
      const state = baseState({ board: { r2c1: withArmament }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      expect(next.board.r2c1.armaments).toEqual([]);
      expect(next.players.A.hand).toHaveLength(1);
      expect(next.players.A.mainDeck).toHaveLength(0);
    });

    it('does not draw at all when there is no Armament to sacrifice (the cost, not the draw, gates this)', () => {
      const state = baseState({ board: { r2c1: forgeMaster }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      expect(next.players.A.hand).toHaveLength(0);
      expect(next.players.A.mainDeck).toHaveLength(1);
      expect(next.log.some(e => e.message.includes('has no Armament to sacrifice'))).toBe(true);
    });
  });

  describe('"Once per turn Sacrifice an Armament: Draw (1) card." (Seasoned Forge Master) — colon-costed, not "then" — regression for the free-draw bug', () => {
    const seasoned = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Seasoned Forge Master', keywords: { timesPerTurnAbility: { times: 1, effect: 'Sacrifice an Armament: Draw (1) card.' } } }), currentLifespan: 4, engaged: false };
    const rusted = () => equip({ id: 'rr', instanceId: 'rr#0', name: 'Rusted Rapier', kind: 'relic-armament' });

    it('really sacrifices the Armament before drawing — previously this drew for free, ignoring the cost entirely', () => {
      const withArmament = { ...seasoned, armaments: [rusted()] };
      const state = baseState({ board: { r2c1: withArmament }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
      expect(next.board.r2c1.armaments).toEqual([]);
      expect(next.players.A.hand).toHaveLength(1);
      expect(next.players.A.mainDeck).toHaveLength(0);
    });

    it('does not draw at all when there is no Armament to sacrifice', () => {
      const state = baseState({ board: { r2c1: seasoned }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
      expect(next.players.A.hand).toHaveLength(0);
      expect(next.players.A.mainDeck).toHaveLength(1);
      expect(next.log.some(e => e.message.includes('has no Armament to sacrifice'))).toBe(true);
    });
  });
});

describe('Token creation ("summon a token" effects)', () => {
  const whenSummonedCard = (overrides = {}) => beingCard({ castingCost: { faithless: 0, colored: {} }, ...overrides });
  const summon = (card, board = {}, players = {}) => {
    const state = baseState({
      board,
      players: { A: player({ hand: [card], ...players.A }), B: player({ ...players.B }) },
    });
    return gameReducer(state, { type: 'SUMMON_BEING', instanceId: card.instanceId, cellId: 'r1c2' });
  };

  it('auto-resolves onto the one remaining empty Mortal Realm cell when no location is named (Bone collector)', () => {
    const card = whenSummonedCard({ name: 'Bone collector', keywords: { whenSummoned: "summon a Bag o' Bones token (1 cost Relic - Martyr.)." } });
    const fillers = {};
    ['r1c3', 'r1c4', 'r2c1', 'r2c2', 'r2c3', 'r2c4'].forEach(cell => {
      fillers[cell] = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: cell }), currentLifespan: 5, engaged: false };
    });
    // Only r1c2 (about to hold Bone collector itself) and r2c5 are empty
    // among A's Mortal Realm cells — a single real candidate, so this
    // auto-resolves rather than opening a choice.
    const next = summon(card, fillers);
    expect(next.pendingChoice).toBeNull();
    expect(next.board.r2c5.type).toBe('relic');
    expect(next.board.r2c5.card.name).toBe("Bag o' Bones");
    expect(next.board.r2c5.card.isToken).toBe(true);
  });

  it('offers a choice of empty cells when more than one is legal', () => {
    const card = whenSummonedCard({ name: 'Bone collector', keywords: { whenSummoned: "summon a Bag o' Bones token (1 cost Relic - Martyr.)." } });
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally' }), currentLifespan: 5, engaged: false };
    // r1c2 is about to be occupied by Bone collector itself, r1c3 held by
    // an ally, leaving more than one real empty cell among A's Mortal
    // Realm tiles for a genuine choice.
    const next = summon(card, { r1c3: ally });
    expect(next.pendingChoice?.kind).toBe('token-location');
    expect(next.pendingChoice.tokenName).toBe("bag o' bones");
    const candidates = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_TOKEN_LOCATION');
    expect(candidates.length).toBeGreaterThan(1);
    const resolved = gameReducer(next, candidates[0]);
    expect(resolved.board[candidates[0].cellId].card.name).toBe("Bag o' Bones");
    expect(resolved.pendingChoice).toBeNull();
  });

  it('adds a named token straight to hand instead of the board (Grave robber)', () => {
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: beingCard({ keywords: { engage: "Add a Bag o' Bones token (1 cost Relic - Martyr.) to hand." } }), currentLifespan: 5, engaged: false },
      },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.hand).toHaveLength(1);
    expect(next.players.A.hand[0].name).toBe("Bag o' Bones");
    expect(next.players.A.hand[0].isToken).toBe(true);
  });

  it('falls through to the honest "isn\'t automated yet" log for a token not in the registry', () => {
    const card = whenSummonedCard({ name: 'Fabricator', keywords: { whenSummoned: 'summon a Golem token.' } });
    const next = summon(card);
    expect(next.log.some(e => e.message.includes("isn't automated yet"))).toBe(true);
    expect(next.pendingChoice).toBeNull();
  });

  it('does nothing when there is no empty Mortal Realm cell left to place a token on', () => {
    const card = whenSummonedCard({ name: 'Bone collector', keywords: { whenSummoned: "summon a Bag o' Bones token (1 cost Relic - Martyr.)." } });
    const fillers = {};
    // Fill every Mortal Realm cell for A except r1c2 (where Bone collector
    // itself is about to land).
    ['r1c1', 'r1c3', 'r1c4', 'r1c5', 'r2c1', 'r2c2', 'r2c3', 'r2c4', 'r2c5'].forEach(cell => {
      fillers[cell] = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: cell }), currentLifespan: 5, engaged: false };
    });
    const next = summon(card, fillers);
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('no empty tile'))).toBe(true);
  });

  describe('"you may summon (2) 0/2 Vine tokens on tiles this points to" (Jirahperā)', () => {
    // beingCard's default arrows is [1] (forward); Jirahperā lands at r1c2
    // (the `summon` helper's fixed cell), so direction 1 points to r2c2.
    const jirahpera = (overrides = {}) => whenSummonedCard({
      name: 'Jirahperā', arrows: [1],
      keywords: { whenSummoned: 'you may summon (2) 0/2 Vine tokens on tiles Jirahperā points to.' },
      ...overrides,
    });

    it('opens an optional choice rather than auto-resolving', () => {
      const next = summon(jirahpera());
      expect(next.pendingChoice).toEqual({
        kind: 'may-summon-vine-pointed', playerId: 'A', cardName: 'Jirahperā', label: 'When Summoned', count: 2,
        context: { selfCellId: 'r1c2' }, optional: true,
      });
      expect(next.board.r2c2).toBeUndefined(); // nothing placed yet
    });

    it('Decline leaves the board untouched', () => {
      const next = summon(jirahpera());
      const declined = gameReducer(next, { type: 'RESOLVE_DECLINE' });
      expect(declined.pendingChoice).toBeNull();
      expect(declined.board.r2c2).toBeUndefined();
    });

    it('accepting summons Vine tokens on its pointed tile(s), capped by how many are actually pointed to', () => {
      const next = summon(jirahpera()); // only 1 arrow, so only 1 pointed tile exists even though count is 2
      expect(getLegalActions(next, 'A').some(a => a.type === 'RESOLVE_MAY_SUMMON_VINE_POINTED')).toBe(true);
      const resolved = gameReducer(next, { type: 'RESOLVE_MAY_SUMMON_VINE_POINTED' });
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.board.r2c2.card.name).toBe('Vine');
      expect(resolved.board.r2c2.card.strength).toBe(0);
      expect(resolved.board.r2c2.card.lifespan).toBe(2);
    });

    it('places on more than one pointed tile when it has more than one arrow, up to the printed count', () => {
      const next = summon(jirahpera({ arrows: [1, 3] })); // forward (r2c2) and same-row right (r1c3)
      const resolved = gameReducer(next, { type: 'RESOLVE_MAY_SUMMON_VINE_POINTED' });
      expect(resolved.board.r2c2.card.name).toBe('Vine');
      expect(resolved.board.r1c3.card.name).toBe('Vine');
    });

    it('is not offered (but Decline still is) once every pointed tile is occupied', () => {
      const blocker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'blocker#0' }), currentLifespan: 5, engaged: false };
      const next = summon(jirahpera(), { r2c2: blocker });
      expect(getLegalActions(next, 'A').some(a => a.type === 'RESOLVE_MAY_SUMMON_VINE_POINTED')).toBe(false);
      expect(getLegalActions(next, 'A').some(a => a.type === 'RESOLVE_DECLINE')).toBe(true);
    });
  });
});

describe('"Choose target Being this points to, it is returned to it\'s owner\'s hand, It\'s owner Crafts Effigies equal to its cost." (Recollect)', () => {
  const recollectCard = (overrides = {}) => ({
    id: 'recol', instanceId: 'recol#0', name: 'Recollect', kind: 'prophecy',
    castingCost: { faithless: 0, colored: {} }, timerMax: 1, arrows: [1],
    textBox: 'Choose target Being this points to, it is returned to it’s owner’s hand, It’s owner Crafts Effigies equal to its cost.',
    keywords: { whenSummoned: null }, ...overrides,
  });
  const bigDeck = () => Array.from({ length: 5 }, (_, i) => ({ instanceId: `d${i}`, effigyType: 'faithless' }));

  it('returns the only Being on a pointed-to tile to its owner\'s hand, crafting Effigies equal to its cost', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target', castingCost: { faithless: 3, colored: {} } }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c3: target },
      players: { A: player({ hand: [recollectCard()] }), B: player({ effigyPool: [], effigyDeck: bigDeck() }) },
    });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'recol#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.board.r4c3).toBeUndefined();
    expect(resolved.players.B.hand.some(c => c.instanceId === 'target')).toBe(true);
    // 3 from Recollect + 1 from the normal per-turn craft every player gets.
    expect(resolved.players.B.effigyPool).toHaveLength(4);
  });

  it('returns the Being to its actual owner, not the Prophecy\'s caster, when the target belongs to the caster', () => {
    const target = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'target', castingCost: { faithless: 2, colored: {} } }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c3: target }, // occupies the opponent's front row, but owned by A
      players: { A: player({ hand: [recollectCard()], effigyPool: [], effigyDeck: bigDeck() }), B: player() },
    });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'recol#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.players.A.hand.some(c => c.instanceId === 'target')).toBe(true);
    // 2 from Recollect + 1 from the normal per-turn craft every player gets.
    expect(resolved.players.A.effigyPool).toHaveLength(3);
  });

  it('logs an honest "no Being on a tile it points to" instead of crashing with nothing to target', () => {
    const state = baseState({ players: { A: player({ hand: [recollectCard()] }), B: player() } });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'recol#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.log.some(e => e.message.includes('no Being on a tile it points to'))).toBe(true);
  });

  it('offers a choice among multiple pointed-to Beings, and resolving returns just the chosen one', () => {
    const proph = recollectCard({ instanceId: 'recol2#0', arrows: [1, 5] });
    const a = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'a', castingCost: { faithless: 1, colored: {} } }), currentLifespan: 5, engaged: false };
    const b = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b', castingCost: { faithless: 4, colored: {} } }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r4c3: a, r2c3: b },
      players: { A: player({ hand: [proph], effigyPool: [], effigyDeck: bigDeck() }), B: player({ effigyPool: [], effigyDeck: bigDeck() }) },
    });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'recol2#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.pendingChoice.kind).toBe('recollect-target');
    const next = gameReducer(resolved, { type: 'RESOLVE_RECOLLECT_TARGET', cellId: 'r4c3' });
    expect(next.board.r4c3).toBeUndefined();
    expect(next.players.B.hand.some(c => c.instanceId === 'a')).toBe(true);
    expect(next.board.r2c3).toEqual(b); // untouched
  });
});

describe('"Beings may move across this" ground Relics + Al khali the Empty\'s arrow-based token summon', () => {
  const prophecyCard = (overrides = {}) => ({
    id: 'proph', instanceId: 'proph#0', name: 'Al khali the Empty', kind: 'prophecy',
    castingCost: { faithless: 0, colored: {} }, timerMax: 1, arrows: [1, 5, 6],
    textBox: 'Summon a Shifting Sands token on all tiles this points to.',
    keywords: { whenSummoned: null }, ...overrides,
  });

  it('resolves onto exactly 3 tiles — 1 on the opponent\'s front row, 2 on the controller\'s — matching its own arrows', () => {
    const state = baseState({ players: { A: player({ hand: [prophecyCard()] }), B: player() } });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.log.some(e => e.message.includes('summons 3 Shifting Sands token(s)'))).toBe(true);
    // Direction 1 (12 o'clock/forward) → the opponent's front row (r4);
    // directions 5 and 6 (6 o'clock/backward, and backward-left) → the
    // controller's own front row (r2) — see RULES.md > Keywords.
    expect(resolved.groundRelics.r4c3?.card.name).toBe('Shifting Sands');
    expect(resolved.groundRelics.r2c3?.card.name).toBe('Shifting Sands');
    expect(resolved.groundRelics.r2c2?.card.name).toBe('Shifting Sands');
    expect(Object.keys(resolved.groundRelics)).toHaveLength(3);
    expect(resolved.board.r3c3).toBeUndefined(); // the Prophecy itself is gone
    expect(resolved.players.A.purgatory.some(c => c.name === 'Al khali the Empty')).toBe(true);
  });

  it('a Shifting Sands landing on the opponent\'s side is controlled by the opponent, not Al khali\'s own caster', () => {
    const state = baseState({ players: { A: player({ hand: [prophecyCard()] }), B: player() } });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.groundRelics.r4c3?.ownerId).toBe('B'); // opponent's front row — opponent controls it
    expect(resolved.groundRelics.r2c3?.ownerId).toBe('A'); // controller's own side — controller controls it
    expect(resolved.groundRelics.r2c2?.ownerId).toBe('A');
  });

  it('still summons a Shifting Sands onto a tile a Being already occupies — co-located, not skipped', () => {
    const occupied = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'occ#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r4c3: occupied }, players: { A: player({ hand: [prophecyCard()] }), B: player() } });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.log.some(e => e.message.includes('summons 3 Shifting Sands token(s)'))).toBe(true);
    expect(Object.keys(resolved.groundRelics)).toHaveLength(3);
    expect(resolved.groundRelics.r4c3?.card.name).toBe('Shifting Sands'); // co-located, not skipped
    expect(resolved.board.r4c3).toEqual(occupied); // the Being itself is untouched
  });

  it('each summoned Shifting Sands enters with 2 Crossing Counters', () => {
    const state = baseState({ players: { A: player({ hand: [prophecyCard()] }), B: player() } });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.groundRelics.r2c3.counters).toEqual({ crossing: 2 });
  });

  it('a Being can move onto a ground Relic\'s tile — the Relic stays exactly where it was', () => {
    const groundRelic = { type: 'relic', ownerId: 'A', card: { id: 'ss', instanceId: 'ss#0', name: 'Shifting Sands', kind: 'relic', keywords: { beingsMayMoveAcross: true } }, counters: { crossing: 2 } };
    const mover = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: mover }, groundRelics: { r2c3: groundRelic } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next.board.r2c3.card.name).toBe('Test Being'); // the Being landed there
    expect(next.groundRelics.r2c3).toEqual(groundRelic); // untouched
  });

  it('a plain Relic (no "Beings may move across this") still blocks movement as normal', () => {
    const blocker = { type: 'relic', ownerId: 'A', card: { id: 'r', instanceId: 'r#0', name: 'Plain Relic', kind: 'relic', keywords: {} } };
    const mover = { type: 'being', ownerId: 'A', card: beingCard({ arrows: [3] }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: mover, r2c3: blocker } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next).toBe(state); // refused, same as any other occupied cell
  });

  describe('Shifting Sands\' own Engage: "Remove (1) Crossing Counter, then move target Being you control to this tile"', () => {
    const shiftingSands = (counters = { crossing: 2 }) => ({
      type: 'relic', ownerId: 'A',
      card: { id: 'ss', instanceId: 'ss#0', name: 'Shifting Sands', kind: 'relic', keywords: { engage: 'Remove (1) Crossing Counter, then move target Being you control to this tile.', beingsMayMoveAcross: true } },
      counters,
    });

    it('is offered by getLegalActions when it can afford the Counter cost', () => {
      const state = baseState({ groundRelics: { r2c1: shiftingSands() } });
      const legal = getLegalActions(state, 'A');
      expect(legal.some(a => a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE' && a.cellId === 'r2c1')).toBe(true);
    });

    it('is not offered with no Crossing Counters left', () => {
      const state = baseState({ groundRelics: { r2c1: shiftingSands({ crossing: 0 }) } });
      const legal = getLegalActions(state, 'A');
      expect(legal.some(a => a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE')).toBe(false);
    });

    it('spends 1 Counter and auto-resolves with a single controlled Being', () => {
      const mover = { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false };
      const state = baseState({ board: { r2c5: mover }, groundRelics: { r2c1: shiftingSands() } });
      const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' });
      expect(next.groundRelics.r2c1.counters).toEqual({ crossing: 1 });
      expect(next.groundRelics.r2c1.engaged).toBe(true);
      expect(next.board.r2c1.card.name).toBe('Test Being');
      expect(next.board.r2c5).toBeUndefined();
    });

    it('offers a choice among multiple controlled Beings', () => {
      const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0' }), currentLifespan: 5, engaged: false };
      const b = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b#0' }), currentLifespan: 5, engaged: false };
      const state = baseState({ board: { r2c4: a, r2c5: b }, groundRelics: { r2c1: shiftingSands() } });
      const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' });
      expect(next.pendingChoice).toEqual({ kind: 'move-target-being', playerId: 'A', cardName: 'Shifting Sands', toCellId: 'r2c1' });
      const options = getLegalActions(next, 'A').filter(o => o.type === 'RESOLVE_MOVE_TARGET_BEING');
      expect(options).toHaveLength(2);
      const resolved = gameReducer(next, options[0]);
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.board.r2c1.type).toBe('being');
    });

    it('gracefully does nothing (but still spends the Counter) when the player controls no Being at all', () => {
      const state = baseState({ groundRelics: { r2c1: shiftingSands() } });
      const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' });
      expect(next.groundRelics.r2c1.counters).toEqual({ crossing: 1 });
      expect(next.log.some(e => e.message.includes('has no Being of A\'s to move here'))).toBe(true);
    });
  });

  describe('Tilled Fields\' own Engage: "Pay (1) Living Essence, Engage: Until end of turn Plants summoned on this tile come in Disengaged."', () => {
    const tilledFields = {
      type: 'relic', ownerId: 'A',
      card: {
        id: 'tf', instanceId: 'tf#0', name: 'Tilled Fields', kind: 'relic',
        keywords: { engage: 'Until end of turn Plants summoned on this tile come in Disengaged.', engageEffigyCost: { color: 'living', amount: 1 }, sacrificeIfEngagedAtEndOfTurn: true, beingsMayMoveAcross: true },
      },
    };
    const plantCard = { id: 'plant', instanceId: 'plant#0', name: 'Test Plant', kind: 'being', isDeity: false, isToken: false, typing: 'Plant, Being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 2, timerMax: 0, arrows: [1] };
    const humanCard = { id: 'human', instanceId: 'human#0', name: 'Test Human', kind: 'being', isDeity: false, isToken: false, typing: 'Human, Being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 2, timerMax: 0, arrows: [1] };

    it('is not offered without the Living Essence cost', () => {
      const state = baseState({ groundRelics: { r2c1: tilledFields }, players: { A: player({ effigyPool: [] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE')).toBe(false);
    });

    it('spends the Living Essence, taps the Relic, and flags its own tile', () => {
      const state = baseState({ groundRelics: { r2c1: tilledFields }, players: { A: player({ effigyPool: [effigy('living')] }), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' });
      expect(next.players.A.effigyPool).toEqual([]);
      expect(next.groundRelics.r2c1.engaged).toBe(true);
      expect(next.groundRelics.r2c1.plantsEnterDisengagedUntilEndOfTurn).toBe(true);
    });

    it('a Plant summoned onto the flagged tile enters Disengaged instead of the normal Engaged', () => {
      // Player A can only ever SUMMON_BEING onto SUMMON_CELLS.A (row 1,
      // cols 2-4) — r1c2 here, not an arbitrary empty Mortal Realm cell.
      const flagged = { ...tilledFields, engaged: true, plantsEnterDisengagedUntilEndOfTurn: true };
      const state = baseState({
        groundRelics: { r1c2: flagged },
        players: { A: player({ hand: [plantCard], effigyPool: [effigy('faithless')] }), B: player() },
      });
      const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'plant#0', cellId: 'r1c2' });
      expect(next.board.r1c2.engaged).toBe(false);
      expect(next.groundRelics.r1c2.card.name).toBe('Tilled Fields'); // co-located, untouched
    });

    it('a non-Plant summoned onto the same flagged tile still enters Engaged as normal', () => {
      const flagged = { ...tilledFields, engaged: true, plantsEnterDisengagedUntilEndOfTurn: true };
      const state = baseState({
        groundRelics: { r1c2: flagged },
        players: { A: player({ hand: [humanCard], effigyPool: [effigy('faithless')] }), B: player() },
      });
      const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'human#0', cellId: 'r1c2' });
      expect(next.board.r1c2.engaged).toBe(true);
    });

    it('sacrifices itself at end of turn if still Engaged, and clears the Plants flag either way', () => {
      const flagged = { ...tilledFields, engaged: true, plantsEnterDisengagedUntilEndOfTurn: true };
      const state = baseState({ turnPlayer: 'A', groundRelics: { r2c1: flagged }, players: { A: player(), B: player() } });
      const next = endTurn(state);
      expect(next.groundRelics.r2c1).toBeUndefined();
      expect(next.log.some(e => e.message.includes('Tilled Fields is sacrificed (still Engaged at end of turn)'))).toBe(true);
    });

    it('survives end of turn if it disengaged normally beforehand (not Engaged)', () => {
      const state = baseState({ turnPlayer: 'A', groundRelics: { r2c1: { ...tilledFields, engaged: false } }, players: { A: player(), B: player() } });
      const next = endTurn(state);
      expect(next.groundRelics.r2c1).toBeDefined();
    });
  });
});

describe('"Engage: Target Effigy that you control Engages, then add (1) Essence of its typing." (Effigial Conservator)', () => {
  const conservator = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Effigial Conservator', keywords: { engage: 'Target Effigy that you control Engages, then add (1) Essence of its typing.' } }), currentLifespan: 2, engaged: false };

  it('Engages the only Effigy in the pool and grants a temporary Essence of its own color', () => {
    const state = baseState({ board: { r2c1: conservator }, players: { A: player({ effigyPool: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(2);
    expect(next.players.A.effigyPool[0].engaged).toBe(true);
    expect(next.players.A.effigyPool[1]).toMatchObject({ effigyType: 'living', temporary: true });
  });

  it('offers a choice among multiple Effigies in the pool', () => {
    const state = baseState({ board: { r2c1: conservator }, players: { A: player({ effigyPool: [effigy('living'), effigy('bleeding')] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('engage-effigy-add-essence');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_ENGAGE_EFFIGY_ADD_ESSENCE');
    expect(options.map(o => o.instanceId).sort()).toEqual(['bleeding#1', 'living#1']);
    const resolved = gameReducer(next, options.find(o => o.instanceId === 'bleeding#1'));
    expect(resolved.players.A.effigyPool.find(e => e.instanceId === 'bleeding#1').engaged).toBe(true);
    expect(resolved.players.A.effigyPool.filter(e => e.effigyType === 'bleeding')).toHaveLength(2);
  });

  it('does not offer an already-Engaged Effigy as a target', () => {
    const state = baseState({ board: { r2c1: conservator }, players: { A: player({ effigyPool: [{ ...effigy('living'), engaged: true }] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('has no Effigy'))).toBe(true);
  });

  it('an Engaged Effigy is protected from being spent on a cost', () => {
    const summonCard = beingCard({ castingCost: { faithless: 0, colored: { living: 1 } } });
    const state = baseState({
      board: {},
      players: { A: player({ hand: [summonCard], effigyPool: [{ ...effigy('living'), engaged: true }] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'SUMMON_BEING')).toBe(false);
  });

  it('the Engaged Effigy untaps at the start of its controller\'s next turn, protection lifting', () => {
    const state = baseState({ turnPlayer: 'A', players: { A: player({ effigyPool: [{ ...effigy('living'), engaged: true }] }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool[0].engaged).toBe(false);
  });
});

describe('Sanative Siphon\'s own Engage: "Remove (X) Crossing Counters, Engage: Restore (X) Lifespan to target."', () => {
  const siphon = (counters = {}) => ({
    type: 'relic', ownerId: 'A',
    card: {
      id: 'siphon', instanceId: 'siphon#0', name: 'Sanative Siphon', kind: 'relic',
      keywords: { removeCountersEngageRestoreLifespan: { counterType: 'crossing' } },
    },
    counters,
  });

  it('offers ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE only for amounts up to the Crossing Counters held', () => {
    const state = baseState({ board: { r2c1: siphon({ crossing: 2 }) }, players: { A: player(), B: player() } });
    const legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE');
    expect(legal.map(a => a.amount)).toEqual([1, 2]);
  });

  it('is not offered with zero Crossing Counters', () => {
    const state = baseState({ board: { r2c1: siphon({ crossing: 0 }) }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE')).toBe(false);
  });

  it('is not offered while already Engaged', () => {
    const state = baseState({ board: { r2c1: { ...siphon({ crossing: 2 }), engaged: true } }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE')).toBe(false);
  });

  it('removes the counters, Engages the Relic, and opens restore-lifespan-target for the chosen amount', () => {
    const state = baseState({ board: { r2c1: siphon({ crossing: 2 }) }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE', cellId: 'r2c1', amount: 2 });
    expect(next.board.r2c1.counters.crossing).toBe(0);
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.pendingChoice).toEqual({ kind: 'restore-lifespan-target', playerId: 'A', cardName: 'Sanative Siphon', label: 'Engage ability', amount: 2 });
  });

  it('restores the chosen amount of Lifespan to a targeted player', () => {
    const state = baseState({ board: { r2c1: siphon({ crossing: 1 }) }, players: { A: player({ lifespan: 40 }), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_ENGAGE_RESTORE', cellId: 'r2c1', amount: 1 });
    const resolved = gameReducer(opened, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER', targetPlayerId: 'A' });
    expect(resolved.players.A.lifespan).toBe(41);
    expect(resolved.pendingChoice).toBe(null);
  });
});

describe('Orbital Acceleration: "All players draw a card. Craft (1) Effigy. You may Modulate (-1)."', () => {
  const prophecyCard = (overrides = {}) => ({
    id: 'proph', instanceId: 'proph#0', name: 'Orbital Acceleration', kind: 'prophecy',
    castingCost: { faithless: 0, colored: {} }, timerMax: 1,
    textBox: 'All players draw a card. \nCraft (1) Effigy.\nYou may Modulate (-1).',
    keywords: { whenSummoned: null }, ...overrides,
  });

  it('has both players draw, crafts 1 Effigy for its own controller, and — with no "Gain Time Counters" clause of its own — resolves straight to Purgatory in one step, same as Al khali the Empty', () => {
    const state = baseState({
      players: {
        A: player({ hand: [prophecyCard()], mainDeck: [{ instanceId: 'da#0' }], effigyDeck: [{ instanceId: 'ea#0', effigyType: 'timeless' }] }),
        B: player({ mainDeck: [{ instanceId: 'db#0' }] }),
      },
    });
    const played = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'proph#0', cellId: 'r3c3' });
    const resolved = beginTurn({ ...played, turnNumber: played.turnNumber + 1 });
    expect(resolved.board.r3c3).toBeUndefined(); // no lingering face-up phase
    expect(resolved.players.A.purgatory.some(c => c.name === 'Orbital Acceleration')).toBe(true);
    expect(resolved.players.A.hand.some(c => c.instanceId === 'da#0')).toBe(true);
    expect(resolved.players.B.hand.some(c => c.instanceId === 'db#0')).toBe(true);
    expect(resolved.players.A.effigyPool).toContainEqual(expect.objectContaining({ instanceId: 'ea#0' }));
  });
});

describe('"You may Modulate (-1)." (Orbital Acceleration\'s own third clause) — optional, and can target either player\'s Time Counter', () => {
  // Regression: this used to fall through to the generic (mandatory,
  // own-permanents-only) Modulate handling — MODULATE_RE matches "Modulate
  // (-1)" as a bare substring inside "You may Modulate (-1)." — silently
  // dropping both the "may" (no way to decline) and the card's own lack of
  // a "you control" restriction. Reported from real play as effectively
  // forcing an unwanted Modulate with no way out.
  const ownProphecy = { type: 'prophecy', ownerId: 'A', card: { name: 'Own Prophecy' }, timer: 2, faceDown: false };
  const opponentProphecy = { type: 'prophecy', ownerId: 'B', card: { name: 'Opponent Prophecy' }, timer: 2, faceDown: false };

  it('offers RESOLVE_DECLINE alongside the real Modulate options — never forced', () => {
    const state = baseState({ board: { r2c1: ownProphecy } });
    const next = resolveOrLogEffect(state, 'A', 'Orbital Acceleration', 'You may Modulate (-1).', 'Prophecy', {});
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'modulate', optional: true, anyOwner: true }));
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_DECLINE' });
    const declined = gameReducer(next, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBeNull();
    expect(declined.board.r2c1.timer).toBe(2); // untouched
  });

  it('can target the OPPONENT\'s Time Counter, not just the activating player\'s own', () => {
    const state = baseState({ board: { r4c1: opponentProphecy } });
    const next = resolveOrLogEffect(state, 'A', 'Orbital Acceleration', 'You may Modulate (-1).', 'Prophecy', {});
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_MODULATE', cellId: 'r4c1', delta: -1 });
    const resolved = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r4c1', delta: -1 });
    expect(resolved.board.r4c1.timer).toBe(1);
    expect(resolved.pendingChoice).toBeNull();
  });

  it('can also target the opponent\'s own Altar (exercises the cross-owner altar list lookup, not just the activator\'s own)', () => {
    const opponentAltar = { card: { name: 'Eònion Altar', instanceId: 'ealtar#0' }, counters: { time: 3 } };
    const state = baseState({ altars: { A: [], B: [opponentAltar] } });
    const next = resolveOrLogEffect(state, 'A', 'Orbital Acceleration', 'You may Modulate (-1).', 'Prophecy', {});
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_MODULATE', altarInstanceId: 'ealtar#0', delta: -1 });
    const resolved = gameReducer(next, { type: 'RESOLVE_MODULATE', altarInstanceId: 'ealtar#0', delta: -1 });
    expect(resolved.altars.B[0].counters.time).toBe(2); // written back to B's own list, not A's
    expect(resolved.altars.A).toEqual([]);
    expect(resolved.pendingChoice).toBeNull();
  });

  it('gracefully logs instead of opening a pendingChoice when neither player has a real target', () => {
    const state = baseState();
    const next = resolveOrLogEffect(state, 'A', 'Orbital Acceleration', 'You may Modulate (-1).', 'Prophecy', {});
    expect(next.pendingChoice).toBeNull();
    expect(next.log.some(e => e.message.includes('no Time Counter on the board to Modulate'))).toBe(true);
  });

  it('still lets the activating player Modulate their own Time Counter too (own permanents were never excluded, just no longer required)', () => {
    const state = baseState({ board: { r2c1: ownProphecy } });
    const next = resolveOrLogEffect(state, 'A', 'Orbital Acceleration', 'You may Modulate (-1).', 'Prophecy', {});
    const resolved = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r2c1', delta: -1 });
    expect(resolved.board.r2c1.timer).toBe(1);
  });
});

describe('MetaToris: "Twice per turn Modulate (±1)."', () => {
  const metaToris = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'MetaToris', keywords: { timesPerTurnAbility: { times: 2, effect: 'Modulate (±1).' } } }),
    currentLifespan: 4, engaged: false, ...overrides,
  });

  it('is offered up to twice per turn, not gated by engaged', () => {
    const state = baseState({ board: { r2c1: metaToris({ engaged: true }) } });
    const legal = getLegalActions(state, 'A');
    expect(legal.filter(a => a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY' && a.cellId === 'r2c1')).toHaveLength(1);
  });

  it('activating it really opens the Modulate choice, incrementing the use count', () => {
    const state = baseState({ board: { r2c1: metaToris(), r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true } } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c1.timesPerTurnUsed).toBe(1);
    // anyOwner: true — unlike Dial of Metatoris ("on a target you
    // control"), MetaToris's own printed text has no such restriction, so
    // per the user's ruling it can target either player's Time Counter.
    expect(next.pendingChoice).toEqual({ kind: 'modulate', playerId: 'A', cardName: 'MetaToris', delta: 'choose', anyOwner: true });
  });

  // Regression: the user's own ruling — unlike Dial of Metatoris (own-only,
  // per its printed "on a target you control"), MetaToris's own "Twice per
  // turn Modulate (±1)." has no ownership restriction in its printed text
  // at all, so it can target a Time Counter the OPPONENT controls,
  // including one on a shifted Being (represented as a face-up `type:
  // 'prophecy'` occupant with `shiftedFromCard` set — already a legal
  // Modulate target via isModulateTarget's plain `type === 'prophecy'`
  // check, same as any other Prophecy).
  it('can target an opponent-controlled Time Counter, including one on a shifted Being', () => {
    const opponentShifted = { type: 'prophecy', ownerId: 'B', card: { name: 'Something', instanceId: 'sb#0' }, timer: 3, faceDown: false, shiftedFromCard: { name: 'Something', instanceId: 'sb#0', lifespan: 3 } };
    const state = baseState({ board: { r2c1: metaToris(), r3c1: opponentShifted }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_MODULATE');
    expect(options).toContainEqual({ type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    const next = gameReducer(opened, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(next.board.r3c1.timer).toBe(4);
  });

  it('is usable a second time in the same turn after the first resolves', () => {
    let state = baseState({ board: { r2c1: metaToris(), r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true } } });
    state = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    state = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY' && a.cellId === 'r2c1')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c1.timesPerTurnUsed).toBe(2);
  });

  it('is not offered a third time in the same turn', () => {
    const state = baseState({ board: { r2c1: metaToris({ timesPerTurnUsed: 2 }) } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY')).toBe(false);
  });

  it('resets its use count at the start of its controller\'s next turn', () => {
    const state = baseState({ turnNumber: 3, board: { r2c1: metaToris({ timesPerTurnUsed: 2 }) } });
    const next = beginTurn(state);
    expect(next.board.r2c1.timesPerTurnUsed).toBe(0);
  });

  // Altars (Eònion Altar) carry their own Time Counters but live in
  // state.altars, not state.board, which historically left them
  // unreachable by any Modulate source (MetaToris's own ability, Dial of
  // Metatoris's Engage) even though nothing about Modulate's real text
  // restricts it to board occupants.
  it('can target an Altar\'s own Time Counters, addressed by the altar\'s instanceId', () => {
    const eonionAltar = { card: { instanceId: 'eonion#0', name: 'Eònion Altar' }, counters: { time: 3 } };
    let state = baseState({ board: { r2c1: metaToris() }, altars: { A: [eonionAltar], B: [] } });
    state = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(getLegalActions(state, 'A')).toEqual(expect.arrayContaining([
      { type: 'RESOLVE_MODULATE', altarInstanceId: 'eonion#0', delta: 1 },
      { type: 'RESOLVE_MODULATE', altarInstanceId: 'eonion#0', delta: -1 },
    ]));
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', altarInstanceId: 'eonion#0', delta: -1 });
    expect(next.altars.A).toEqual([{ card: eonionAltar.card, counters: { time: 2 } }]);
    expect(next.pendingChoice).toBeNull();
  });

  it('is still offered when the player controls only an Altar target, no board Time Counter', () => {
    const eonionAltar = { card: { instanceId: 'eonion#0', name: 'Eònion Altar' }, counters: { time: 1 } };
    const state = baseState({ board: { r2c1: metaToris() }, altars: { A: [eonionAltar], B: [] } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY')).toBe(true);
  });
});

describe('Dial of Metatoris: "Engage: Modulate (±1) on a target you control." can reach an Altar\'s Time Counters too', () => {
  const dialOfMetatoris = {
    type: 'relic', ownerId: 'A',
    card: { id: 'dial', instanceId: 'dial#0', name: 'Dial of Metatoris', kind: 'relic', keywords: { engage: 'Modulate (±1) on a target you control' } },
    engaged: false,
  };

  it('opens a Modulate choice that includes the Altar as a target', () => {
    const eonionAltar = { card: { instanceId: 'eonion#0', name: 'Eònion Altar' }, counters: { time: 2 } };
    let state = baseState({ board: { r2c1: dialOfMetatoris }, altars: { A: [eonionAltar], B: [] } });
    state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(state.pendingChoice).toEqual({ kind: 'modulate', playerId: 'A', cardName: 'Dial of Metatoris', delta: 'choose' });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', altarInstanceId: 'eonion#0', delta: 1 });
    expect(next.altars.A).toEqual([{ card: eonionAltar.card, counters: { time: 3 } }]);
  });

  it('can target its own controller\'s Shifted Being — "on a target you control" still includes a Shifted Being, which is just another owned Prophecy occupant', () => {
    const ownShifted = { type: 'prophecy', ownerId: 'A', card: { name: 'Something', instanceId: 'sb#0' }, timer: 3, faceDown: false, shiftedFromCard: { name: 'Something', instanceId: 'sb#0', lifespan: 3 } };
    const state = baseState({ board: { r2c1: dialOfMetatoris, r3c1: ownShifted } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_MODULATE');
    expect(options).toContainEqual({ type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    const next = gameReducer(opened, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(next.board.r3c1.timer).toBe(4);
  });

  it('cannot target an opponent\'s Shifted Being — "on a target you control" excludes it', () => {
    const opponentShifted = { type: 'prophecy', ownerId: 'B', card: { name: 'Something', instanceId: 'sb#0' }, timer: 3, faceDown: false, shiftedFromCard: { name: 'Something', instanceId: 'sb#0', lifespan: 3 } };
    const state = baseState({ board: { r2c1: dialOfMetatoris, r3c1: opponentShifted } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_MODULATE');
    expect(options).not.toContainEqual(expect.objectContaining({ cellId: 'r3c1' }));
  });
});

describe('"This gains +1/+1 whenever you Modulate (±1) except due to the Modulate Step." (Temporal Anomaly)', () => {
  const temporalAnomaly = {
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'Temporal Anomaly', strength: 1, lifespan: 1, keywords: { onModulateGrowth: { strength: 1, lifespan: 1 } } }),
    currentLifespan: 1, engaged: false,
  };
  const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true };

  it('grows +1/+1 permanently when its controller activates a real Modulate', () => {
    const state = baseState({
      board: { r2c1: temporalAnomaly, r3c1: prophecy },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: -1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(effectiveStrength(next.board.r2c1)).toBe(2);
    expect(next.board.r2c1.currentLifespan).toBe(2);
  });

  it('grows on a POSITIVE Modulate too — the reaction is not sign-gated', () => {
    const state = baseState({
      board: { r2c1: temporalAnomaly, r3c1: prophecy },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: 1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(effectiveStrength(next.board.r2c1)).toBe(2);
  });

  it('grows from an Altar Modulate too, not just a board target', () => {
    const eonionAltar = { card: { instanceId: 'eonion#0', name: 'Eònion Altar' }, counters: { time: 2 } };
    const state = baseState({
      board: { r2c1: temporalAnomaly },
      altars: { A: [eonionAltar], B: [] },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: -1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', altarInstanceId: 'eonion#0', delta: -1 });
    expect(effectiveStrength(next.board.r2c1)).toBe(2);
  });

  it('does NOT grow from the automatic per-turn Modulate Step tick (beginTurn)', () => {
    const state = baseState({
      turnNumber: 3,
      board: { r2c1: temporalAnomaly, r3c1: { ...prophecy, timer: 5 } },
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'filler#0' })] }), B: player() },
    });
    const next = beginTurn(state);
    expect(effectiveStrength(next.board.r2c1)).toBe(1); // unchanged — this was the Modulate Step, not a player activation
  });

  it('stacks once per copy when the controller has more than one', () => {
    const second = { ...temporalAnomaly, card: beingCard({ instanceId: 'ta2#0', name: 'Temporal Anomaly', strength: 1, lifespan: 1, keywords: { onModulateGrowth: { strength: 1, lifespan: 1 } } }) };
    const state = baseState({
      board: { r2c1: temporalAnomaly, r2c2: second, r3c1: prophecy },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: -1 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(effectiveStrength(next.board.r2c1)).toBe(2);
    expect(effectiveStrength(next.board.r2c2)).toBe(2);
  });
});

describe('Hourglass: "Whenever a Time Counter is removed from a Prophecy you control add it to this. Engage: Remove (5) Time Counters, then draw (2) cards."', () => {
  const hourglass = (counters = {}) => ({
    type: 'relic', ownerId: 'A',
    card: {
      id: 'hg', instanceId: 'hg#0', name: 'Hourglass', kind: 'relic',
      keywords: { collectsRemovedProphecyTimeCounters: true, engage: 'Remove (5) Time Counters, then draw (2) cards.' },
    },
    engaged: false, counters,
  });

  it('collects 1 Time Counter whenever the automatic per-turn tick removes one from a Prophecy its owner controls', () => {
    const state = baseState({
      board: { r2c1: hourglass(), r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true } },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.counters).toEqual({ time: 1 });
  });

  it('collects independently for every Hourglass the player controls', () => {
    const state = baseState({
      board: {
        r2c1: hourglass(), r2c2: hourglass({ time: 2 }),
        r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true },
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.counters).toEqual({ time: 1 });
    // Starts at 2, decays by 1 (the same automatic per-turn tick every Time
    // Counter you control gets) to 1, then collects +1 from the Prophecy's
    // own tick this same step, netting 2.
    expect(next.board.r2c2.counters).toEqual({ time: 2 });
  });

  it('does not collect from the opponent\'s Prophecy, and does not collect from an Altar\'s own tick (only "from a Prophecy")', () => {
    const state = baseState({
      turnPlayer: 'A',
      board: { r2c1: hourglass() },
      altars: { A: [{ card: { name: 'Eònion Altar' }, counters: { time: 3 } }], B: [] },
      players: {
        A: player(),
        B: { ...player(), }, // B owns nothing Prophecy-related this turn
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.counters).toEqual({});
  });

  it('is not offered by getLegalActions when it can\'t afford its own effect\'s Counter spend', () => {
    const state = baseState({ board: { r2c1: hourglass({ time: 4 }) } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(false);
  });

  it('spends 5 Time Counters and really draws 2 cards once it has enough', () => {
    const state = baseState({
      board: { r2c1: hourglass({ time: 5 }) },
      players: { A: player({ mainDeck: [{ instanceId: 'd1' }, { instanceId: 'd2' }] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r2c1')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.counters).toEqual({ time: 0 });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.players.A.hand).toHaveLength(2);
  });
});

describe('Horological Horror: "(X) is equal to the total number of Time Counters you control"', () => {
  const horrorCard = (overrides = {}) => beingCard({
    name: 'Horological Horror', strength: 0, lifespan: 0,
    keywords: { xEqualsTimeCountersControlled: true },
    ...overrides,
  });

  it('sums a face-down Prophecy, a face-up Prophecy, and an Altar\'s own Time Counters into its Strength and Lifespan at summon', () => {
    const state = baseState({
      board: {
        r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 2, faceDown: true },
        r3c2: { type: 'prophecy', ownerId: 'A', card: { name: 'P2' }, timer: 3, faceDown: false },
        r3c3: { type: 'prophecy', ownerId: 'B', card: { name: 'Not mine' }, timer: 9, faceDown: true }, // opponent's — excluded
      },
      altars: { A: [{ card: { name: 'Eònion Altar' }, counters: { time: 4 } }], B: [] },
      players: { A: player({ hand: [horrorCard()], effigyPool: [{ instanceId: 'e1', effigyType: 'timeless' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: horrorCard().instanceId, cellId: 'r1c2' });
    // 2 (face-down Prophecy) + 3 (face-up Prophecy) + 4 (Altar) = 9 — B's own Prophecy not counted.
    expect(next.board.r1c2.currentLifespan).toBe(9);
    expect(effectiveStrength(next.board.r1c2)).toBe(9);
  });

  it('is 0/0 with no Time Counters controlled at all', () => {
    const state = baseState({ players: { A: player({ hand: [horrorCard()], effigyPool: [{ instanceId: 'e1', effigyType: 'timeless' }] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: horrorCard().instanceId, cellId: 'r1c2' });
    expect(next.board.r1c2.currentLifespan).toBe(0);
    expect(effectiveStrength(next.board.r1c2)).toBe(0);
  });

  it('recomputes live every turn — a real aura, not fixed at summon (confirmed directly)', () => {
    const horror = { type: 'being', ownerId: 'A', card: horrorCard(), currentLifespan: 2, engaged: false, strengthOverride: 2 };
    const state = baseState({
      turnNumber: 3,
      board: { r2c1: horror, r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 5, faceDown: false } },
    });
    const next = beginTurn(state);
    // Confirms the recompute reads the *current* board state (after this
    // same turn's own Modulate -1 already ticked the Prophecy 5 -> 4), not
    // the stale value of 2 it had at summon.
    expect(next.board.r2c1.currentLifespan).toBe(4);
    expect(effectiveStrength(next.board.r2c1)).toBe(4);
  });

  it('dies (real death, not just a frozen 0) when its Time Counters shrink to nothing — its own "When this dies you take (5) Lifespan Damage" fires', () => {
    const horror = {
      type: 'being', ownerId: 'A',
      card: horrorCard({ keywords: { xEqualsTimeCountersControlled: true, depart: 'you take (5) Lifespan Damage' } }),
      currentLifespan: 1, engaged: false, strengthOverride: 1,
    };
    // A non-empty deck for A keeps beginTurn's own Draw Step from also
    // charging its unrelated empty-deck penalty (RULES.md: 10 Lifespan),
    // which would otherwise be conflated with the assertion below.
    const state = baseState({
      turnNumber: 3, board: { r2c1: horror }, // no Time Counters anywhere now
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'filler#0' })] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.name === 'Horological Horror')).toBe(true);
    // deathDamageFor's own standard loss reads the printed Lifespan (0, an
    // uncomputed "X") on top of the card's own explicit Depart text — 0 + 5.
    expect(next.players.A.lifespan).toBe(45);
  });

  it('recomputes each copy off its own owner\'s Time Counters, regardless of whose turn it is', () => {
    const horrorA = { type: 'being', ownerId: 'A', card: horrorCard(), currentLifespan: 0, engaged: false, strengthOverride: 0 };
    const horrorB = { type: 'being', ownerId: 'B', card: horrorCard(), currentLifespan: 0, engaged: false, strengthOverride: 0 };
    const state = baseState({
      turnNumber: 3,
      board: {
        r2c1: horrorA, r4c1: horrorB,
        r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 5, faceDown: false },
        r3c2: { type: 'prophecy', ownerId: 'B', card: { name: 'P2' }, timer: 1, faceDown: false },
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.currentLifespan).toBe(4); // A's own Prophecy ticked 5 -> 4 (A's turn)
    expect(next.board.r4c1.currentLifespan).toBe(1); // B's own copy also live-tracked off B's own total, even though it's A's turn
  });

  it('recomputes immediately after any mid-turn action that changes Time Counters, not just at the start of a turn', () => {
    const horror = { type: 'being', ownerId: 'A', card: horrorCard(), currentLifespan: 0, engaged: false, strengthOverride: 0 };
    const target = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Target Being', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: true };
    const state = baseState({
      board: { r2c1: horror, r2c2: target },
      pendingChoice: { kind: 'time-counter-block-move', playerId: 'A', cardName: 'Moment of Doubt', label: 'When Summoned', amount: 3 },
    });
    const next = gameReducer(state, { type: 'RESOLVE_TIME_COUNTER_BLOCK_MOVE', cellId: 'r2c2' });
    // The gained Time Counters land on r2c2, not on Horror's own cell — the
    // aura must still pick this up in the SAME reducer call, with no
    // separate beginTurn/endTurn pass in between.
    expect(next.board.r2c1.currentLifespan).toBe(3);
    expect(effectiveStrength(next.board.r2c1)).toBe(3);
  });

  // "Drown out the Screams" ("Target Non Deity Being loses all abilities
  // until end of turn.") strips card.keywords to {} — for a normal Being
  // that just removes its Engage/etc and leaves its printed Strength/
  // Lifespan alone (see that card's own describe block), but Horror has no
  // printed Strength/Lifespan of its own to fall back to (both columns are
  // literally "X" in the CSV) — losing the only ability that ever defined
  // them should kill it, same as its Time Counters dropping to 0 would.
  it('dies immediately if its ability is suppressed mid-turn ("Drown out the Screams")', () => {
    const drown = {
      id: 'dr-1', instanceId: 'dr-1#0', name: 'Drown out the Screams', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Target Non Deity Being loses all abilities until end of turn.',
    };
    const horror = {
      type: 'being', ownerId: 'A',
      card: horrorCard({ keywords: { xEqualsTimeCountersControlled: true, depart: 'you take (5) Lifespan Damage' } }),
      currentLifespan: 3, engaged: false, strengthOverride: 3,
    };
    const state = baseState({
      board: { r4c1: horror },
      altars: { A: [{ card: { name: 'Eònion Altar' }, counters: { time: 3 } }], B: [] },
      players: { A: player({ hand: [drown] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'dr-1#0' });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.name === 'Horological Horror')).toBe(true);
    // "Loses all abilities" suppresses the Depart text too (it's part of
    // the same keywords object) — deathDamageFor's own standard loss reads
    // the printed Lifespan (0, an uncomputed "X"), so no Lifespan is lost
    // at all here, unlike the Time-Counters-hit-0 case above where the
    // Depart ability is still live and fires normally.
    expect(next.players.A.lifespan).toBe(50);
  });
});

describe('"You may pay (N) Lifespan to Summon (2) Vassal tokens." (Vassal Matriach) — generic optional-Lifespan-cost wrapper', () => {
  const vassalMatriach = {
    id: 'vm', instanceId: 'vm#0', name: 'Vassal Matriach', kind: 'being',
    keywords: { depart: 'You may pay (5) Lifespan to Summon (2) Vassal tokens.' },
  };

  it('opens a real pay-or-decline choice on Depart, not an auto-resolve', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: { ...vassalMatriach, strength: 1, lifespan: 3 }, currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.pendingChoice).toEqual({
      kind: 'pay-lifespan-optional', playerId: 'B', cardName: 'Vassal Matriach', label: 'Depart',
      cost: 5, effectText: 'Summon (2) Vassal tokens.', optional: true,
    });
  });

  it('paying spends the Lifespan and lets the player choose where each of the 2 Vassal tokens (2/2, no ability) lands', () => {
    const state = baseState({
      pendingChoice: { kind: 'pay-lifespan-optional', playerId: 'A', cardName: 'Vassal Matriach', label: 'Depart', cost: 5, effectText: 'Summon (2) Vassal tokens.', optional: true },
      players: { A: player({ lifespan: 50 }), B: player() },
    });
    const opened = gameReducer(state, { type: 'RESOLVE_PAY_LIFESPAN_OPTIONAL' });
    expect(opened.players.A.lifespan).toBe(45);
    // Nothing auto-placed yet — the Lifespan cost is spent, but the board
    // is still empty until the player picks each tile.
    expect(Object.keys(opened.board)).toHaveLength(0);
    expect(opened.pendingChoice).toMatchObject({ kind: 'token-location', tokenName: 'vassal', remaining: 2 });

    const afterFirst = gameReducer(opened, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c2' });
    expect(afterFirst.pendingChoice).toMatchObject({ kind: 'token-location', tokenName: 'vassal', remaining: 1 });
    const afterSecond = gameReducer(afterFirst, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c3' });
    expect(afterSecond.pendingChoice).toBeNull();

    const placed = Object.values(afterSecond.board).filter(o => o?.card?.name === 'Vassal');
    expect(placed).toHaveLength(2);
    expect(placed[0].card.strength).toBe(2);
    expect(placed[0].card.lifespan).toBe(2);
  });

  it('Decline leaves the board and Lifespan untouched', () => {
    const state = baseState({
      pendingChoice: { kind: 'pay-lifespan-optional', playerId: 'A', cardName: 'Vassal Matriach', label: 'Depart', cost: 5, effectText: 'Summon (2) Vassal tokens.', optional: true },
      players: { A: player({ lifespan: 50 }), B: player() },
    });
    const next = gameReducer(state, { type: 'RESOLVE_DECLINE' });
    expect(next.pendingChoice).toBeNull();
    expect(next.players.A.lifespan).toBe(50);
    expect(Object.keys(next.board)).toHaveLength(0);
  });

  it('is not offered by getLegalActions when the player can\'t afford it', () => {
    const state = baseState({
      pendingChoice: { kind: 'pay-lifespan-optional', playerId: 'A', cardName: 'Vassal Matriach', label: 'Depart', cost: 5, effectText: 'Summon (2) Vassal tokens.', optional: true },
      players: { A: player({ lifespan: 5 }), B: player() },
    });
    const legal = getLegalActions(state, 'A');
    expect(legal.some(a => a.type === 'RESOLVE_PAY_LIFESPAN_OPTIONAL')).toBe(false);
    expect(legal.some(a => a.type === 'RESOLVE_DECLINE')).toBe(true);
  });

  it('a mutual kill where BOTH sides have a choice-opening Depart doesn\'t clobber the first one — the attacker\'s own Depart (resolved first) wins, the defender\'s is honestly skipped instead of silently overwriting it', () => {
    const attacker = { type: 'being', ownerId: 'A', card: { ...vassalMatriach, instanceId: 'atk#0', strength: 10, lifespan: 3 }, currentLifespan: 1, engaged: false };
    const secondMatriach = {
      id: 'vm2', instanceId: 'def#0', name: 'Second Matriach', kind: 'being',
      keywords: { depart: 'You may pay (2) Lifespan to Summon (2) Vassal tokens.' },
    };
    const defender = { type: 'being', ownerId: 'B', card: { ...secondMatriach, strength: 1, lifespan: 3 }, currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    // The attacker (Vassal Matriach) died first, so its own Depart choice
    // is the one left open — not the defender's (Second Matriach), which
    // would otherwise have silently clobbered it.
    expect(next.pendingChoice).toEqual({
      kind: 'pay-lifespan-optional', playerId: 'A', cardName: 'Vassal Matriach', label: 'Depart',
      cost: 5, effectText: 'Summon (2) Vassal tokens.', optional: true,
    });
    expect(next.log.some(e => e.message.includes("Second Matriach's Depart doesn't resolve"))).toBe(true);
  });
});

describe('"Sacrifice target Being you control." (Ritual Executioner)', () => {
  it('sacrifices itself when it is the only legal own Being on Engage (no "a different Being" exclusion printed)', () => {
    const executioner = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'exec#0', name: 'Ritual Executioner', keywords: { engage: 'Sacrifice target Being you control.' } }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: executioner }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'exec#0')).toBe(true);
  });

  it('with a second own Being present, offers a real choice (including itself) rather than auto-sacrificing the other one', () => {
    const executioner = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'exec#0', name: 'Ritual Executioner', keywords: { engage: 'Sacrifice target Being you control.' } }), currentLifespan: 3, engaged: false };
    const fodder = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'fodder#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: executioner, r2c2: fodder }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('sacrifice-being-cost');
    const resolved = gameReducer(next, { type: 'RESOLVE_SACRIFICE_BEING_COST', cellId: 'r2c2' });
    expect(resolved.board.r2c2).toBeUndefined();
    expect(resolved.players.A.purgatory.some(c => c.instanceId === 'fodder#0')).toBe(true);
    expect(resolved.board.r2c1.engaged).toBe(true);
  });

  it('offers a choice among multiple own Beings, excluding the opponent\'s', () => {
    const executioner = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Ritual Executioner', keywords: { engage: 'Sacrifice target Being you control.' } }), currentLifespan: 3, engaged: false };
    const a = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0' }), currentLifespan: 5, engaged: false };
    const opp = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'opp#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: executioner, r2c2: a, r4c1: opp }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('sacrifice-being-cost');
    expect(getLegalActions(next, 'A').some(a2 => a2.type === 'RESOLVE_SACRIFICE_BEING_COST' && a2.cellId === 'r4c1')).toBe(false);
  });
});

describe('"Target Being you control becomes Favored." (Careless IkVarem) — permanent, unlike temporary grant-favor', () => {
  it('makes the only legal own Being permanently Favored on Depart (no expiry flag)', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'ik#0', name: 'Careless IkVarem', strength: 1, lifespan: 2, keywords: { depart: 'Target Being you control becomes Favored.' } }),
      currentLifespan: 2, engaged: false,
    };
    const ally = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 4, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender, r4c2: ally }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c2.favorCounter).toBe(true);
    expect(next.board.r4c2.favorCounterExpiresEndOfTurn).toBeUndefined();
  });
});

describe('"Your next Being this turn costs (-1) Formless to Summon." (Simple Summoner)', () => {
  const summoner = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Simple Summoner', keywords: { engage: 'Your next Being this turn costs (-1) Formless to Summon.' } }), currentLifespan: 2, engaged: false };

  it('discounts the next Being summoned this turn by 1 Formless, then stops applying', () => {
    const cheapBeing = beingCard({ instanceId: 'cb#0', castingCost: { faithless: 0, colored: { formless: 1 } } });
    const secondBeing = beingCard({ instanceId: 'sb#0', castingCost: { faithless: 0, colored: { formless: 1 } } });
    const state = baseState({
      board: { r2c1: summoner },
      players: { A: player({ hand: [cheapBeing, secondBeing], effigyPool: [] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(engaged.nextBeingCostReduction).toEqual([{ color: 'formless', amount: 1 }]);
    // Reduced to 0 Formless — summonable with an empty pool.
    const summoned = gameReducer(engaged, { type: 'SUMMON_BEING', instanceId: 'cb#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2.type).toBe('being');
    expect(summoned.nextBeingCostReduction).toBeNull();
    // The discount is used up — the second Being needs its full cost again.
    const secondAttempt = gameReducer(summoned, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c3' });
    expect(secondAttempt.board.r1c3).toBeUndefined();
  });

  it('never drops a cost component below 0', () => {
    const freeBeing = beingCard({ instanceId: 'fb#0', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({
      board: { r2c1: summoner },
      players: { A: player({ hand: [freeBeing], effigyPool: [] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const summoned = gameReducer(engaged, { type: 'SUMMON_BEING', instanceId: 'fb#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2.type).toBe('being');
  });

  it('is cleared at end of turn if never used', () => {
    const state = baseState({ nextBeingCostReduction: [{ color: 'formless', amount: 1 }] });
    const next = endTurn(state);
    expect(next.nextBeingCostReduction).toBeNull();
  });

  it('stacks when two copies are engaged this turn — both discount the same next Being', () => {
    const summoner2 = { ...summoner, card: { ...summoner.card, instanceId: 'summoner2#0' } };
    const lamtukka = beingCard({ instanceId: 'lam#0', name: 'Ravenous Lamtukka', castingCost: { faithless: 1, colored: { formless: 3 } } });
    const state = baseState({
      board: { r2c1: summoner, r2c2: summoner2 },
      players: { A: player({ hand: [lamtukka], effigyPool: [effigy('formless'), effigy('formless')] }), B: player() },
    });
    const engagedOnce = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const engagedTwice = gameReducer(engagedOnce, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c2' });
    expect(engagedTwice.nextBeingCostReduction).toEqual([
      { color: 'formless', amount: 1 }, { color: 'formless', amount: 1 },
    ]);
    // Real cost 1 Faithless/3 Formless, minus 2 stacked Formless = 1
    // Faithless/1 Formless — payable with just 2 Formless in the pool.
    const summoned = gameReducer(engagedTwice, { type: 'SUMMON_BEING', instanceId: 'lam#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2?.card.name).toBe('Ravenous Lamtukka');
    expect(summoned.nextBeingCostReduction).toBeNull(); // both consumed by the one summon
  });

  it('user-reported repro: 3 Formless Effigy in pool is exactly enough to summon Ravenous Lamtukka (1 Faithless, 3 Formless) after the discount', () => {
    // Real printed cost (public/default-card-set.csv row 191): "1
    // Faithless, 3 Formless" — minus Simple Summoner's own (-1 Formless)
    // is 1 Faithless + 2 Formless. 3 Formless in the pool: 2 pay the
    // colored portion, the 1 left over legally covers the 1 Faithless
    // (canPayCost lets any leftover colored pip pay a generic slot).
    const lamtukka = beingCard({ instanceId: 'lam#0', name: 'Ravenous Lamtukka', castingCost: { faithless: 1, colored: { formless: 3 } } });
    const state = baseState({
      board: { r2c1: summoner },
      players: { A: player({ hand: [lamtukka], effigyPool: [effigy('formless'), effigy('formless'), effigy('formless')] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(getLegalActions(engaged, 'A')).toContainEqual({ type: 'SUMMON_BEING', instanceId: 'lam#0', cellId: 'r1c2' });
    const summoned = gameReducer(engaged, { type: 'SUMMON_BEING', instanceId: 'lam#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2?.card.name).toBe('Ravenous Lamtukka');
  });

  it('does not discount a Deity (a distinct kind from Being)', () => {
    const deity = beingCard({ instanceId: 'd#0', kind: 'deity', isDeity: true, castingCost: { faithless: 0, colored: { formless: 1 } } });
    const state = baseState({
      board: { r2c1: summoner },
      players: { A: player({ hand: [deity], effigyPool: [] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const summoned = gameReducer(engaged, { type: 'SUMMON_BEING', instanceId: 'd#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2).toBeUndefined(); // still costs the full 1 Formless, unaffordable
  });

  it('user-reported repro: two copies stack to reduce a real 4-cost Being (2 Faithless, 2 Formless) down to a 2-cost', () => {
    const summoner2 = { ...summoner, card: { ...summoner.card, instanceId: 'summoner2#0' } };
    const fourCostBeing = beingCard({ instanceId: 'fc#0', castingCost: { faithless: 2, colored: { formless: 2 } } });
    const state = baseState({
      board: { r2c1: summoner, r2c2: summoner2 },
      players: { A: player({ hand: [fourCostBeing], effigyPool: [effigy('faithless'), effigy('faithless')] }), B: player() },
    });
    const engagedOnce = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const engagedTwice = gameReducer(engagedOnce, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c2' });
    // 2 Faithless + 2 Formless, minus 2 stacked (-1 Formless) each = 2
    // Faithless + 0 Formless — a real 4-cost Being now costs exactly 2.
    expect(getLegalActions(engagedTwice, 'A')).toContainEqual({ type: 'SUMMON_BEING', instanceId: 'fc#0', cellId: 'r1c2' });
    const summoned = gameReducer(engagedTwice, { type: 'SUMMON_BEING', instanceId: 'fc#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2?.card.instanceId).toBe('fc#0');
  });

  it('an unrelated action (moving a different Being) between engaging and summoning does not clear the discount', () => {
    // All 8 arrows so any legal empty adjacent tile works — the point of
    // this test is the move actually happening, not which direction.
    const mover = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mv#0', arrows: [1, 2, 3, 4, 5, 6, 7, 8] }), currentLifespan: 5, engaged: false };
    const cheapBeing = beingCard({ instanceId: 'cb#0', castingCost: { faithless: 0, colored: { formless: 1 } } });
    const state = baseState({
      board: { r2c1: summoner, r2c3: mover },
      players: { A: player({ hand: [cheapBeing], effigyPool: [] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(engaged.nextBeingCostReduction).toEqual([{ color: 'formless', amount: 1 }]);
    // Move mover to whatever empty tile the engine actually offers — an
    // entirely unrelated action.
    const moveAction = getLegalActions(engaged, 'A').find(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r2c3' && !a.isAttack);
    expect(moveAction).toBeTruthy();
    const moved = gameReducer(engaged, moveAction);
    expect(moved.board.r2c3).toBeUndefined();
    expect(moved.board[moveAction.toCellId]).toBeDefined();
    expect(moved.nextBeingCostReduction).toEqual([{ color: 'formless', amount: 1 }]); // still there
    const summoned = gameReducer(moved, { type: 'SUMMON_BEING', instanceId: 'cb#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2?.type).toBe('being'); // discount still applied — free with an empty pool
  });

  it('an unrelated attack between engaging and summoning does not clear the discount', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1 }), currentLifespan: 5, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', strength: 0 }), currentLifespan: 5, engaged: false };
    const cheapBeing = beingCard({ instanceId: 'cb#0', castingCost: { faithless: 0, colored: { formless: 1 } } });
    const state = baseState({
      board: { r2c1: summoner, r2c3: attacker, r4c3: defender },
      players: { A: player({ hand: [cheapBeing], effigyPool: [] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const attacked = gameReducer(engaged, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c3', toCellId: 'r4c3', isAttack: true });
    // Combat resolves within the same dispatch (no reactive Conjuring in either hand).
    expect(attacked.board.r2c3.engaged).toBe(true);
    expect(attacked.nextBeingCostReduction).toEqual([{ color: 'formless', amount: 1 }]); // still there
    const summoned = gameReducer(attacked, { type: 'SUMMON_BEING', instanceId: 'cb#0', cellId: 'r1c2' });
    expect(summoned.board.r1c2?.type).toBe('being');
  });
});

describe('"Move target Being you control forward." (Spirit Guide)', () => {
  it('moves the only legal own Being one tile forward on Depart', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'sg#0', name: 'Spirit Guide', strength: 1, lifespan: 3, keywords: { depart: 'Move target Being you control forward.' } }),
      currentLifespan: 3, engaged: false,
    };
    const mover = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'mover#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender, r5c1: mover }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    // B's own "forward" is -row (board.js's own orientation convention) —
    // r5c1 moves to r4c1, which the dying defender just vacated.
    expect(next.board.r5c1).toBeUndefined();
    expect(next.board.r4c1.card.instanceId).toBe('mover#0');
  });

  it('logs an honest "nowhere to move" instead of crashing when forward is blocked (the Ethereal Realm)', () => {
    const mover = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mover#0' }), currentLifespan: 5, engaged: false };
    // Row 2 is A's own front row — forward (+row) from there is Row 3, the
    // Ethereal Realm, which computeMoveDestination always refuses (board.js
    // > "Beings can't enter the Ethereal Realm — not even to attack, via
    // arrows").
    const state = baseState({ board: { r2c1: mover } });
    const next = resolveOrLogEffect(state, 'A', 'Spirit Guide', 'Move target Being you control forward.', 'Depart', {});
    expect(next.log.some(e => e.message.includes('nowhere'))).toBe(true);
    expect(next.board.r2c1).toEqual(mover);
  });
});

describe('"Target Being has (-X/-0) strength until end of turn where (X) is Venomous Viper\'s Strength." (Venomous Viper)', () => {
  const viper = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Venomous Viper', strength: 3, keywords: { engage: "Target Being has (-X/-0) strength until end of turn where (X) is Venomous Viper's Strength." } }), currentLifespan: 2, engaged: false };

  it('debuffs the chosen target by the caster\'s own current Strength (the caster itself is also a legal target — "Target Being" is unqualified)', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target#0', strength: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: viper, r4c1: target }, players: { A: player(), B: player() } });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(engaged.pendingChoice.kind).toBe('strength-debuff-target');
    const next = gameReducer(engaged, { type: 'RESOLVE_STRENGTH_DEBUFF_TARGET', cellId: 'r4c1' });
    expect(effectiveStrength(next.board.r4c1)).toBe(2); // 5 - 3
    expect(next.board.r4c1.statBonusUntilEndOfTurn).toEqual({ strength: -3, lifespan: 0 });
  });

  it('reads a boosted Strength (Armament-equipped) live, not just the printed value', () => {
    const boosted = {
      ...viper,
      armaments: [equip({ id: 'a', instanceId: 'a#0', name: 'Boost', kind: 'relic-armament', keywords: { statBonus: { strength: 2, lifespan: 0 } } })],
    };
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target#0', strength: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: boosted, r4c1: target }, players: { A: player(), B: player() } });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(engaged, { type: 'RESOLVE_STRENGTH_DEBUFF_TARGET', cellId: 'r4c1' });
    expect(effectiveStrength(next.board.r4c1)).toBe(5); // 10 - (3 + 2)
  });

  it('offers a choice among multiple legal targets, either owner', () => {
    const own = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'own#0' }), currentLifespan: 5, engaged: false };
    const opp = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'opp#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: viper, r2c2: own, r4c1: opp }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'strength-debuff-target', playerId: 'A', cardName: 'Venomous Viper', label: 'Engage ability', amount: 3 });
  });
});

describe('"Deal (1) Lifespan Damage to a Being you control and (1) to a different Being." (Crumbling Sphinx)', () => {
  // "Target Being" here includes the caster itself (the printed text has no
  // "a different Being you control" exclusion for the first half) — every
  // fixture below gives it enough Lifespan to survive being its own target
  // so the resulting board state stays inspectable.
  const sphinx = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Crumbling Sphinx', keywords: { engage: 'Deal (1) Lifespan Damage to a Being you control and (1) to a different Being.' } }), currentLifespan: 5, engaged: false };

  it('damages the caster (its only own Being), then the only other Being, when both steps are unambiguous', () => {
    const other = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'other#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: sphinx, r4c1: other }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.currentLifespan).toBe(4); // the caster itself — its own only legal "Being you control"
    expect(next.board.r4c1.currentLifespan).toBe(4);
    expect(next.pendingChoice).toBeNull();
  });

  it('opens a choice for the first target among 3 own Beings (the caster included), then a further choice for the second', () => {
    const ownA = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0' }), currentLifespan: 5, engaged: false };
    const ownB = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: sphinx, r2c2: ownA, r2c3: ownB }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('lifespan-damage-first-target');
    const afterFirst = gameReducer(next, { type: 'RESOLVE_LIFESPAN_DAMAGE_FIRST_TARGET', cellId: 'r2c2' });
    expect(afterFirst.board.r2c2.currentLifespan).toBe(4);
    // Two Beings remain besides the one just hit (the caster itself and
    // ownB) — a real second choice, not an auto-resolve.
    expect(afterFirst.pendingChoice.kind).toBe('lifespan-damage-second-target');
    const legal = getLegalActions(afterFirst, 'A').filter(a => a.type === 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET');
    expect(legal.some(a => a.cellId === 'r2c2')).toBe(false); // excluded — same cell as the first target
    const resolved = gameReducer(afterFirst, { type: 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET', cellId: 'r2c3' });
    expect(resolved.board.r2c3.currentLifespan).toBe(4);
    expect(resolved.board.r2c1.currentLifespan).toBe(5); // the caster — untouched
  });

  it('opens a choice for the second target excluding whichever cell the first damage landed on', () => {
    const otherA = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'oa#0' }), currentLifespan: 5, engaged: false };
    const otherB = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ob#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: sphinx, r4c1: otherA, r4c2: otherB }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.currentLifespan).toBe(4); // the only own Being (the caster) — auto-resolved
    expect(next.pendingChoice.kind).toBe('lifespan-damage-second-target');
    const legal = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET');
    expect(legal.some(a => a.cellId === 'r2c1')).toBe(false); // excluded — same cell as the first target
    const resolved = gameReducer(next, { type: 'RESOLVE_LIFESPAN_DAMAGE_SECOND_TARGET', cellId: 'r4c1' });
    expect(resolved.board.r4c1.currentLifespan).toBe(4);
    expect(resolved.board.r4c2.currentLifespan).toBe(5); // untouched
  });

  it('logs an honest "no different Being" instead of crashing when the caster\'s own Being is the only Being on board', () => {
    const state = baseState({ board: { r2c1: sphinx }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.currentLifespan).toBe(4); // the caster damaged itself (its own only legal target)
    expect(next.log.some(e => e.message.includes('no different Being to target'))).toBe(true);
  });
});

describe('"Summon a Vassal token." (Vassal Vessel) — single-token Depart, plain SUMMON_TOKEN_RE path', () => {
  it('summons a Vassal token (2/2, no ability) once the tile choice resolves', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'vv#0', name: 'Vassal Vessel', strength: 1, lifespan: 3, keywords: { depart: 'Summon a Vassal token.' } }),
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const afterAttack = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(afterAttack.pendingChoice.kind).toBe('token-location');
    const options = getLegalActions(afterAttack, 'B').filter(a => a.type === 'RESOLVE_TOKEN_LOCATION');
    expect(options.length).toBeGreaterThan(0);
    const next = gameReducer(afterAttack, options[0]);
    const placed = Object.values(next.board).filter(o => o?.card?.name === 'Vassal');
    expect(placed).toHaveLength(1);
    expect(placed[0].card.strength).toBe(2);
    expect(placed[0].card.lifespan).toBe(2);
  });
});

describe('Growth Counters — "Pay (1) Living: Add (1) Growth Counter." / "Remove (1) Growth Counter: Sacrifice this, summon (1) Blooming Vine Token ... on any tile this points to." (Blooming Seed)', () => {
  const bloomingSeed = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({
      instanceId: 'seed#0', name: 'Blooming Seed', strength: 0, lifespan: 2, arrows: [1],
      keywords: {
        payEffigyCostAbility: { color: 'living', amount: 1, effect: 'Add (1) Growth Counter.' },
        counterCostSacrificeAbility: {
          type: 'growth', amount: 1,
          effect: 'summon (1) Blooming Vine Token (0/3 Being - vine token with "Engage: Add (1) Living") on any tile this points to.',
        },
      },
    }),
    currentLifespan: 2, engaged: false,
    ...overrides,
  });

  it('is not offered without (1) Living in the pool', () => {
    const state = baseState({ board: { r1c2: bloomingSeed() }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY')).toBe(false);
  });

  it('pays (1) Living and adds (1) Growth Counter to itself', () => {
    const state = baseState({
      board: { r1c2: bloomingSeed() },
      players: { A: player({ effigyPool: [effigy('living')] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY' && a.cellId === 'r1c2')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c2' });
    expect(next.players.A.effigyPool).toHaveLength(0);
    expect(next.board.r1c2.counters).toEqual({ growth: 1 });
  });

  it('is usable more than once per turn, so long as it stays affordable (no "once per turn" printed)', () => {
    const state = baseState({
      board: { r1c2: bloomingSeed() },
      players: { A: player({ effigyPool: [effigy('living', 1), effigy('living', 2)] }), B: player() },
    });
    const once = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c2' });
    const twice = gameReducer(once, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c2' });
    expect(twice.board.r1c2.counters).toEqual({ growth: 2 });
    expect(twice.players.A.effigyPool).toHaveLength(0);
  });

  it('tracks payEffigyAbilityUsesThisTurn on every activation regardless of any printed "once" cap — an AI-scoring hook, reset at the start of its controller\'s next turn', () => {
    const state = baseState({
      board: { r1c2: bloomingSeed() },
      players: { A: player({ effigyPool: [effigy('living', 1), effigy('living', 2)] }), B: player() },
    });
    const once = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c2' });
    expect(once.board.r1c2.payEffigyAbilityUsesThisTurn).toBe(1);
    const twice = gameReducer(once, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c2' });
    expect(twice.board.r1c2.payEffigyAbilityUsesThisTurn).toBe(2);
    const reset = endTurn(endTurn(twice)); // back around to A's own next turn
    expect(reset.board.r1c2.payEffigyAbilityUsesThisTurn).toBe(0);
  });

  it('is not offered without a Growth Counter on itself', () => {
    const state = baseState({ board: { r1c2: bloomingSeed() }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_COUNTER_COST_SACRIFICE')).toBe(false);
  });

  it('removes the Growth Counter, sacrifices itself, and summons Blooming Vine Token on the only empty pointed tile', () => {
    const state = baseState({
      board: { r1c2: bloomingSeed({ counters: { growth: 1 } }) },
      players: { A: player(), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_COUNTER_COST_SACRIFICE' && a.cellId === 'r1c2')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_COUNTER_COST_SACRIFICE', cellId: 'r1c2' });
    // The Seed itself is gone (sacrificed, not just moved) — direction 1 is
    // "forward" (+row for A), so r1c2 -> r2c2 is where the token lands.
    expect(next.players.A.purgatory.some(c => c.instanceId === 'seed#0')).toBe(true);
    expect(next.board.r1c2).toBeUndefined();
    expect(next.board.r2c2.card.name).toBe('Blooming Vine Token');
    expect(next.board.r2c2.card.strength).toBe(0);
    expect(next.board.r2c2.card.lifespan).toBe(3);
    expect(next.board.r2c2.card.keywords.engage).toBe('Add (1) Living Essence');
  });

  it('lets the player choose among more than one empty pointed tile', () => {
    // Direction 3 (same-row "right", -> r1c3) added alongside the default
    // forward arrow (-> r2c2), so two distinct empty tiles are pointed to.
    const seed = bloomingSeed({ counters: { growth: 1 } });
    const twoArrows = { ...seed, card: { ...seed.card, arrows: [1, 3] } };
    const state = baseState({ board: { r1c2: twoArrows }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_COUNTER_COST_SACRIFICE', cellId: 'r1c2' });
    expect(opened.pendingChoice.kind).toBe('summon-token-pointed');
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_SUMMON_TOKEN_POINTED');
    expect(options.map(o => o.cellId).sort()).toEqual(['r1c3', 'r2c2']);
    const next = gameReducer(opened, options.find(o => o.cellId === 'r1c3'));
    expect(next.board.r1c3.card.name).toBe('Blooming Vine Token');
    expect(next.board.r2c2).toBeUndefined();
  });

  it('logs an honest "no empty tile" instead of crashing when every pointed tile is occupied', () => {
    const blocker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'blocker#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({
      board: { r1c2: bloomingSeed({ counters: { growth: 1 } }), r2c2: blocker },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_COUNTER_COST_SACRIFICE', cellId: 'r1c2' });
    expect(next.players.A.purgatory.some(c => c.instanceId === 'seed#0')).toBe(true); // sacrifice still happens
    expect(next.log.some(e => e.message.includes('no empty tile'))).toBe(true);
    expect(next.board.r2c2).toEqual(blocker); // untouched
  });
});

describe('"Burn (2) Shifting: Trigger the Depart of a Being you control." (Skeleton Key)', () => {
  const skeletonKey = {
    type: 'relic', ownerId: 'A',
    card: { id: 'sk', instanceId: 'sk#0', name: 'Skeleton Key', kind: 'relic', keywords: { payEffigyCostAbility: { color: 'shifting', amount: 2, effect: 'Trigger the Depart of a Being you control.' } } },
    engaged: false,
  };
  const departingBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dep#0', name: 'Departer', keywords: { depart: 'Add (1) Bleeding Essence.' } }), currentLifespan: 3, engaged: false };

  it('is a Relic ability (not Being-only), spends the real Effigy, and triggers the only legal target\'s Depart without killing it', () => {
    const state = baseState({
      board: { r1c1: skeletonKey, r2c1: departingBeing },
      players: { A: player({ effigyPool: [effigy('shifting', 1), effigy('shifting', 2)] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY' && a.cellId === 'r1c1')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c1' });
    expect(next.log.some(e => e.message.includes("triggers Departer's Depart"))).toBe(true);
    // The target is still alive on the board — this only triggers the text.
    expect(next.board.r2c1.card.name).toBe('Departer');
    // The 2 Shifting cost is spent, then the Depart's own effect actually
    // resolves too (Add (1) Bleeding Essence, granted fresh into the pool).
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.players.A.effigyPool[0].effigyType).toBe('bleeding');
  });

  it('is not offered with fewer than 2 Shifting in the pool', () => {
    const state = baseState({ board: { r1c1: skeletonKey }, players: { A: player({ effigyPool: [effigy('shifting', 1)] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY')).toBe(false);
  });

  it('logs an honest message with no owned Being carrying a Depart', () => {
    const noDepart = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'nd#0', name: 'No Depart Being' }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r1c1: skeletonKey, r2c1: noDepart },
      players: { A: player({ effigyPool: [effigy('shifting', 1), effigy('shifting', 2)] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c1' });
    expect(next.log.some(e => e.message.includes('has no Being of A\'s with a Depart to trigger'))).toBe(true);
    expect(next.board.r2c1.card.name).toBe('No Depart Being'); // untouched, still alive
  });

  it('offers a choice among more than one Being with a Depart', () => {
    const second = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dep2#0', name: 'Departer 2', keywords: { depart: 'Add (1) Living Essence.' } }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r1c1: skeletonKey, r2c1: departingBeing, r2c2: second },
      players: { A: player({ effigyPool: [effigy('shifting', 1), effigy('shifting', 2)] }), B: player() },
    });
    const opened = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c1' });
    expect(opened.pendingChoice.kind).toBe('trigger-depart-target');
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_TRIGGER_DEPART_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c1', 'r2c2']);
    const next = gameReducer(opened, options.find(o => o.cellId === 'r2c2'));
    expect(next.log.some(e => e.message.includes("triggers Departer 2's Depart"))).toBe(true);
  });
});

describe('"Gain (1) Crossing Counter whenever a Being Dies." / "Remove (X) Crossing Counters: Sacrifice this Relic, then add a Formless Being with Conjuring cost (X) from your Purgatory to hand." (Death\'s Decanter)', () => {
  const decanter = (counters = {}) => ({
    type: 'relic', ownerId: 'A',
    card: {
      id: 'dd', instanceId: 'dd#0', name: "Death's Decanter", kind: 'relic',
      keywords: { gainCounterOnAnyBeingDeath: { type: 'crossing', amount: 1 }, removeCountersSacrificeSearchTypedCost: { counterType: 'crossing', typing: 'Formless' } },
    },
    engaged: false, counters,
  });

  it('gains a Crossing Counter when the CONTROLLER\'s own Being dies in combat', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r1c1: decanter(), r2c1: attacker, r4c1: defender }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r1c1.counters).toEqual({ crossing: 1 });
  });

  it('also gains a Crossing Counter when the OPPONENT\'s Being dies — no "you control" on the trigger', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r1c1: decanter(), r2c1: attacker, r4c1: defender }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r1c1.counters).toEqual({ crossing: 1 });
  });

  it('offers ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH only for amounts with a real matching Purgatory candidate', () => {
    const formless2 = { instanceId: 'f2#0', name: 'Formless Two', kind: 'being', typing: 'Formless, Being', castingCost: { faithless: 2, colored: {} } };
    const state = baseState({
      board: { r1c1: decanter({ crossing: 3 }) },
      players: { A: player({ purgatory: [formless2] }), B: player() },
    });
    const legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH');
    expect(legal.map(a => a.amount)).toEqual([2]); // only X=2 has a matching Formless Being in Purgatory
  });

  it('removing X=2 sacrifices the Relic and adds the only matching Formless Being to hand', () => {
    const formless2 = { instanceId: 'f2#0', name: 'Formless Two', kind: 'being', typing: 'Formless, Being', castingCost: { faithless: 2, colored: {} } };
    const state = baseState({
      board: { r1c1: decanter({ crossing: 3 }) },
      players: { A: player({ purgatory: [formless2] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH', cellId: 'r1c1', amount: 2 });
    expect(next.board.r1c1).toBeUndefined(); // the Relic is sacrificed, no death pipeline (it's not a Being)
    expect(next.players.A.hand).toContainEqual(formless2);
    expect(next.players.A.purgatory).toEqual([]);
  });

  it('offers a choice among more than one matching Formless Being at the same cost', () => {
    const formlessA = { instanceId: 'fa#0', name: 'Formless A', kind: 'being', typing: 'Formless, Being', castingCost: { faithless: 2, colored: {} } };
    const formlessB = { instanceId: 'fb#0', name: 'Formless B', kind: 'being', typing: 'Formless, Being', castingCost: { faithless: 2, colored: {} } };
    const state = baseState({
      board: { r1c1: decanter({ crossing: 2 }) },
      players: { A: player({ purgatory: [formlessA, formlessB] }), B: player() },
    });
    const opened = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH', cellId: 'r1c1', amount: 2 });
    expect(opened.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'purgatory', query: 'Formless', cardName: "Death's Decanter", costFilter: 2 });
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_CHOICE');
    expect(options.map(o => o.instanceId).sort()).toEqual(['fa#0', 'fb#0']);
    const next = gameReducer(opened, { type: 'RESOLVE_CHOICE', instanceId: 'fb#0' });
    expect(next.players.A.hand).toContainEqual(formlessB);
  });

  it('does NOT offer a same-cost non-Formless Being as a candidate', () => {
    const formless2 = { instanceId: 'f2#0', name: 'Formless Two', kind: 'being', typing: 'Formless, Being', castingCost: { faithless: 2, colored: {} } };
    const humanBeing = { instanceId: 'h2#0', name: 'Human Two', kind: 'being', typing: 'Human, Being', castingCost: { faithless: 2, colored: {} } };
    const state = baseState({
      board: { r1c1: decanter({ crossing: 2 }) },
      players: { A: player({ purgatory: [formless2, humanBeing] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH', cellId: 'r1c1', amount: 2 });
    expect(next.players.A.hand).toContainEqual(formless2);
    expect(next.players.A.purgatory).toContainEqual(humanBeing); // the non-Formless one is left behind
  });

  it('refuses an amount higher than the Counters actually held', () => {
    const state = baseState({ board: { r1c1: decanter({ crossing: 1 }) }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_SACRIFICE_SEARCH', cellId: 'r1c1', amount: 2 });
    expect(next).toBe(state);
  });
});

describe('"Once per turn, when a Turanga you control dies: Add a Spirit from deck to hand." / "...when a Spirit you control dies: Add a Turanga from deck to hand." (Lotus)', () => {
  const lotus = {
    type: 'relic', ownerId: 'A',
    card: {
      id: 'lt', instanceId: 'lt#0', name: 'Lotus', kind: 'relic',
      keywords: { deckSearchOnTypedDeath: [{ dyingTyping: 'Turanga', addTyping: 'Spirit' }, { dyingTyping: 'Spirit', addTyping: 'Turanga' }] },
    },
    engaged: false,
  };
  const turanga = (owner = 'A') => ({ type: 'being', ownerId: owner, card: beingCard({ instanceId: 'tg#0', name: 'Some Turanga', typing: 'Turanga, Being', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false });
  const spiritDeckCard = { instanceId: 'sp-deck#0', name: 'Deck Spirit', kind: 'being', typing: 'Spirit, Being' };
  const turangaDeckCard = { instanceId: 'tg-deck#0', name: 'Deck Turanga', kind: 'being', typing: 'Turanga, Being' };

  it('adds a Spirit from deck to hand when the controller\'s own Turanga dies via Martyr', () => {
    const martyrTuranga = { ...turanga(), card: { ...turanga().card, keywords: { martyr: '' } } };
    const state = baseState({
      board: { r1c1: lotus, r2c1: martyrTuranga },
      players: { A: player({ mainDeck: [spiritDeckCard] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.players.A.hand).toContainEqual(spiritDeckCard);
  });

  it('adds a Spirit from deck to hand when the controller\'s own Turanga dies in combat', () => {
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r1c1: lotus, r4c1: turanga(), r2c1: attacker },
      players: { A: player({ mainDeck: [spiritDeckCard] }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.hand).toContainEqual(spiritDeckCard);
    expect(next.players.A.mainDeck).toEqual([]);
    expect(next.board.r1c1.typedDeathSearchUsed).toEqual([true]); // only clause 0 (Turanga) has fired so far
  });

  it('does not trigger for an opponent\'s own Turanga dying — "you control" scopes both halves', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      board: { r1c1: lotus, r4c1: turanga('B'), r2c1: attacker },
      players: { A: player({ mainDeck: [spiritDeckCard] }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.hand).toEqual([]);
    expect(next.players.A.mainDeck).toEqual([spiritDeckCard]);
  });

  it('only fires once per turn per clause — a second Turanga death the same turn does not trigger again', () => {
    const buffed = { ...lotus, typedDeathSearchUsed: [true, undefined] };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r1c1: buffed, r4c1: turanga(), r2c1: attacker },
      players: { A: player({ mainDeck: [spiritDeckCard] }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.hand).toEqual([]); // already used this turn
    expect(next.players.A.mainDeck).toEqual([spiritDeckCard]);
  });

  it('the two clauses track independently — a used Turanga clause does not block the Spirit clause', () => {
    const buffed = { ...lotus, typedDeathSearchUsed: [true, undefined] };
    const spirit = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'sp#0', name: 'Some Spirit', typing: 'Spirit, Being', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r1c1: buffed, r4c1: spirit, r2c1: attacker },
      players: { A: player({ mainDeck: [turangaDeckCard] }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.hand).toContainEqual(turangaDeckCard);
    expect(next.board.r1c1.typedDeathSearchUsed).toEqual([true, true]);
  });

  it('resets both clauses at the start of the controller\'s next turn', () => {
    const buffed = { ...lotus, typedDeathSearchUsed: [true, true] };
    const state = baseState({
      turnPlayer: 'A', turnNumber: 3,
      board: { r1c1: buffed },
      players: { A: player({ mainDeck: [{ instanceId: 'filler#0' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r1c1.typedDeathSearchUsed).toBeUndefined();
  });

  it('offers a choice among more than one matching Spirit in deck', () => {
    const spirit2 = { instanceId: 'sp-deck2#0', name: 'Deck Spirit 2', kind: 'being', typing: 'Spirit, Being' };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r1c1: lotus, r4c1: turanga(), r2c1: attacker },
      players: { A: player({ mainDeck: [spiritDeckCard, spirit2] }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Spirit', cardName: 'Lotus' });
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'sp-deck2#0' });
    expect(resolved.players.A.hand).toContainEqual(spirit2);
  });
});

describe('"Enters with (2) Crossing Counters." / "Remove (1) Crossing Counter, then Engage: You may summon Undead from your Purgatory until the end of your turn." (Mausoleum Gates)', () => {
  const mausoleumGatesCard = {
    id: 'mg', instanceId: 'mg#0', name: 'Mausoleum Gates', kind: 'relic',
    castingCost: { faithless: 0, colored: {} },
    keywords: { armamentCounterGrant: { type: 'crossing', amount: 2 }, engageCounterCost: { type: 'crossing', amount: 1 }, engage: 'You may summon Undead from your Purgatory until the end of your turn.' },
  };
  const mausoleumGates = (counters = { crossing: 1 }) => ({ type: 'relic', ownerId: 'A', card: mausoleumGatesCard, engaged: false, counters });
  const undead = (n) => ({ instanceId: `u${n}#0`, name: `Undead ${n}`, kind: 'being', typing: 'Undead, Being', castingCost: { faithless: 0, colored: {} } });

  it('PLACE_RELIC grants the printed Crossing Counters immediately ("Enters with")', () => {
    const state = baseState({ players: { A: player({ hand: [mausoleumGatesCard] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'mg#0', cellId: 'r2c1' });
    expect(next.board.r2c1.counters).toEqual({ crossing: 2 });
  });

  it('Engaging spends the Crossing Counter, taps the Relic, and opens a standing Purgatory-summon window', () => {
    const state = baseState({ board: { r2c1: mausoleumGates() }, players: { A: player({ purgatory: [undead(1)] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.board.r2c1.counters).toEqual({ crossing: 0 });
    expect(next.players.A.summonTypedFromPurgatoryWindows).toEqual(['Undead']);
  });

  it('the window lets ANY number of matching Undead be summoned from Purgatory this turn, choosing a tile each time', () => {
    let state = baseState({
      board: { r1c1: mausoleumGates() },
      players: { A: player({ purgatory: [undead(1), undead(2)] }), B: player() },
    });
    state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c1' });
    let legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW');
    expect(legal.map(a => a.instanceId).sort()).toEqual(['u1#0', 'u2#0']);
    // Several empty Mortal Realm tiles exist on a real board, so this opens
    // the same 'token-location' picker Cemetery Physician's own variable
    // summon already uses, rather than placing immediately.
    state = gameReducer(state, { type: 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW', instanceId: 'u1#0' });
    expect(state.pendingChoice.kind).toBe('token-location');
    expect(state.pendingChoice.purgatoryInstanceId).toBe('u1#0');
    const tileOptions = getLegalActions(state, 'A').filter(a => a.type === 'RESOLVE_TOKEN_LOCATION');
    state = gameReducer(state, tileOptions[0]);
    expect(state.players.A.purgatory.map(c => c.instanceId)).toEqual(['u2#0']);
    expect(Object.values(state.board).some(o => o?.card?.instanceId === 'u1#0')).toBe(true);
    // Still open — a second Undead can be summoned the same turn too.
    legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW');
    expect(legal.map(a => a.instanceId)).toEqual(['u2#0']);
  });

  it('does not offer a non-Undead Being through the window', () => {
    const human = { instanceId: 'h1#0', name: 'Human One', kind: 'being', typing: 'Human, Being' };
    let state = baseState({ board: { r1c1: mausoleumGates() }, players: { A: player({ purgatory: [human] }), B: player() } });
    state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c1' });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW')).toBe(false);
  });

  it('the window closes at the end of the turn — no longer offered, and a stale dispatch is refused', () => {
    let state = baseState({
      turnPlayer: 'A',
      board: { r1c1: mausoleumGates() },
      players: { A: player({ purgatory: [undead(1)] }), B: player() },
    });
    state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c1' });
    const afterEndTurn = gameReducer(state, { type: 'PASS_TURN' });
    // endTurn hands off to B's own beginTurn — A's window is cleared regardless of whose turn it now is.
    expect(afterEndTurn.players.A.summonTypedFromPurgatoryWindows).toEqual([]);
    const stale = gameReducer(afterEndTurn, { type: 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW', instanceId: 'u1#0' });
    expect(stale).toBe(afterEndTurn);
  });
});

describe('"Target a Being you don\'t control, then copy it\'s Engage ability." (Marionette Doll)', () => {
  const doll = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Marionette Doll', keywords: { engage: "Target a Being you don't control, then copy it's Engage ability." } }), currentLifespan: 3, engaged: false };

  // Phase 2 of the priority-window rework (see the approved plan): a
  // fresh ACTIVATE_ENGAGE now declares first, deferring both the
  // engaged-flip and the effect behind a real reactiveWindow — and since
  // B's own Being(s) below carry a real "Engage: X" ability of their own,
  // B genuinely has something to respond with, so the window correctly
  // stays open rather than auto-closing within the same dispatch. An
  // explicit PASS_PRIORITY (B declines to respond) is needed before the
  // deferred effect actually resolves — same as any other declared,
  // not-yet-resolved action.
  it('copies and resolves the only legal opposing Being\'s own Engage ability', () => {
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy#0', name: 'Zealot', keywords: { engage: 'Add (1) Bleeding Essence.' } }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: doll, r4c1: enemy }, players: { A: player(), B: player() } });
    const declared = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(declared.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' })); // B could reactively Engage its own Zealot
    const next = gameReducer(declared, { type: 'PASS_PRIORITY' });
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.players.A.effigyPool[0].effigyType).toBe('bleeding');
    expect(next.log.some(e => e.message.includes("copies Zealot's Engage ability"))).toBe(true);
  });

  it('offers a choice among multiple opposing Beings, never the caster\'s own', () => {
    const enemy1 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e1#0', keywords: { engage: 'Add (1) Bleeding Essence.' } }), currentLifespan: 5, engaged: false };
    const enemy2 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e2#0', keywords: { engage: 'Add (1) Living Essence.' } }), currentLifespan: 5, engaged: false };
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0', keywords: { engage: 'Add (1) Formless Essence.' } }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: doll, r4c1: enemy1, r4c2: enemy2, r2c2: ally }, players: { A: player(), B: player() } });
    const declared = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const passed = gameReducer(declared, { type: 'PASS_PRIORITY' });
    expect(passed.pendingChoice.kind).toBe('copy-engage-target');
    const options = getLegalActions(passed, 'A').filter(a => a.type === 'RESOLVE_COPY_ENGAGE_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r4c1', 'r4c2']); // never r2c2 (the caster's own ally)
    const resolved = gameReducer(passed, options.find(o => o.cellId === 'r4c2'));
    expect(resolved.players.A.effigyPool[0].effigyType).toBe('living');
  });

  it('logs an honest no-Engage-to-copy instead of crashing when the target has none', () => {
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy#0', name: 'Plain Grunt' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: doll, r4c1: enemy }, players: { A: player(), B: player() } });
    // Plain Grunt has no Engage ability of its own, so B has nothing real
    // to respond with here — resolves within the same dispatch.
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('has no Engage ability of Plain Grunt\'s to copy'))).toBe(true);
    expect(next.board.r2c1.engaged).toBe(true); // Marionette Doll still used its own Engage
  });

  it('logs an honest "no Being" instead of crashing when the caster controls the whole board', () => {
    const state = baseState({ board: { r2c1: doll }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes("has no Being A doesn't control"))).toBe(true);
  });

  it('does not copy another copy-Engage card\'s ability (would recurse) — logs an honest no-op instead, with exactly one opposing Being', () => {
    // Self-play found this a guaranteed stack overflow: with only one
    // opposing Being and that Being's own Engage ALSO being "copy an
    // Engage ability", copying it re-enters this exact same resolution
    // with the same single candidate every time.
    const enemyDoll = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ed#0', name: 'Enemy Doll', keywords: { engage: "Target a Being you don't control, then copy it's Engage ability." } }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: doll, r4c1: enemyDoll }, players: { A: player(), B: player() } });
    // Enemy Doll also carries a real Engage ability, so B has something to
    // respond with — same reactiveWindow precedent as the tests above.
    const declared = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(declared, { type: 'PASS_PRIORITY' });
    expect(next.log.some(e => e.message.includes("can't copy Enemy Doll's Engage ability — it's a copy effect too"))).toBe(true);
    expect(next.board.r2c1.engaged).toBe(true); // still used its own Engage, just no infinite chain
  });

  it('does not chain into a fresh copy-engage-target choice when the picked target is itself a copy-Engage card, with multiple opposing Beings', () => {
    // The matching AI-loop half of the same bug: with 2+ candidates, this
    // used to open ANOTHER 'copy-engage-target' choice every time a
    // copy-Engage card was picked, chaining forever with no real effect
    // ever landing.
    const enemyDoll1 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ed1#0', name: 'Enemy Doll 1', keywords: { engage: "Target a Being you don't control, then copy it's Engage ability." } }), currentLifespan: 3, engaged: false };
    const enemyDoll2 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ed2#0', name: 'Enemy Doll 2', keywords: { engage: "Target a Being you don't control, then copy it's Engage ability." } }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: doll, r4c1: enemyDoll1, r4c2: enemyDoll2 }, players: { A: player(), B: player() } });
    const declared = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const opened = gameReducer(declared, { type: 'PASS_PRIORITY' });
    expect(opened.pendingChoice.kind).toBe('copy-engage-target');
    const resolved = gameReducer(opened, { type: 'RESOLVE_COPY_ENGAGE_TARGET', cellId: 'r4c1' });
    expect(resolved.pendingChoice).toBeNull(); // resolved to the graceful no-op, not another choice
    expect(resolved.log.some(e => e.message.includes("can't copy Enemy Doll 1's Engage ability — it's a copy effect too"))).toBe(true);
  });
});

describe('"Engage: Reveal the top card of your deck, then you may sacrifice this and draw a card." (Oracle of Eonia)', () => {
  const oracle = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Oracle of Eonia', keywords: { engage: 'Reveal the top card of your deck, then you may sacrifice this and draw a card.' } }), currentLifespan: 2, engaged: false };

  it('reveals the top card (log-only), then opens an optional sacrifice-and-draw choice', () => {
    const state = baseState({ board: { r2c1: oracle }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({
      kind: 'sacrifice-this-optional', playerId: 'A', cardName: 'Oracle of Eonia', label: 'Engage ability',
      effectText: 'draw a card.', context: { selfCellId: 'r2c1' }, optional: true,
    });
    expect(next.players.A.mainDeck).toHaveLength(1); // revealing doesn't move it
  });

  it('accepting sacrifices Oracle of Eonia and draws a card', () => {
    const state = baseState({ board: { r2c1: oracle }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(opened, { type: 'RESOLVE_SACRIFICE_THIS_OPTIONAL' });
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory).toEqual([oracle.card]);
    expect(next.players.A.hand).toHaveLength(1);
  });

  it('Decline leaves Oracle of Eonia on the board, untouched', () => {
    const state = baseState({ board: { r2c1: oracle }, players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const declined = gameReducer(opened, { type: 'RESOLVE_DECLINE' });
    expect(declined.pendingChoice).toBeNull();
    expect(declined.board.r2c1).toEqual({ ...oracle, engaged: true });
    expect(declined.players.A.hand).toHaveLength(0);
  });
});

describe('"Target Being gains a -1/-1 Counter." (Scarab) — -1/-1 Counters', () => {
  it('grants the counter, reducing effective Strength, and deals 1 Lifespan damage — the only legal target', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target#0', strength: 3, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r4c1: target }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Scarab', 'Target Being gains a -1/-1 Counter.', 'Depart', {});
    expect(next.board.r4c1.counters).toEqual({ '-1/-1': 1 });
    expect(next.board.r4c1.currentLifespan).toBe(4);
    expect(effectiveStrength(next.board.r4c1)).toBe(2); // 3 - 1
  });

  it('stacks across repeated applications', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target#0', strength: 3, lifespan: 5 }), currentLifespan: 5, engaged: false, counters: { '-1/-1': 2 } };
    const state = baseState({ board: { r4c1: target }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Scarab', 'Target Being gains a -1/-1 Counter.', 'Depart', {});
    expect(next.board.r4c1.counters).toEqual({ '-1/-1': 3 });
    expect(effectiveStrength(next.board.r4c1)).toBe(0); // floored at 0, not negative
  });

  it('can kill a Being outright — real death pipeline (Purgatory, owner takes its base Lifespan)', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'target#0', strength: 3, lifespan: 5 }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r4c1: target }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = resolveOrLogEffect(state, 'A', 'Scarab', 'Target Being gains a -1/-1 Counter.', 'Depart', {});
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.B.lifespan).toBe(45); // dies to death-damage = its own printed Lifespan (5), not just the 1 that killed it
    expect(next.players.B.purgatory).toEqual([target.card]);
  });

  it('offers a choice among multiple legal targets, either owner', () => {
    const t1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 't1#0' }), currentLifespan: 5, engaged: false };
    const t2 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't2#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: t1, r4c1: t2 }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Scarab', 'Target Being gains a -1/-1 Counter.', 'Depart', {});
    expect(next.pendingChoice).toEqual({ kind: 'minus-counter-target', playerId: 'A', cardName: 'Scarab', label: 'Depart', amount: 1 });
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_MINUS_COUNTER_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c1', 'r4c1']);
    const resolved = gameReducer(next, options.find(o => o.cellId === 'r2c1'));
    expect(resolved.board.r2c1.counters).toEqual({ '-1/-1': 1 });
  });

  it('fires for real on Depart, at the end of a real combat death', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const scarab = {
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'scarab#0', name: 'Scarab', strength: 2, lifespan: 1, keywords: { depart: 'Target Being gains a -1/-1 Counter.' } }),
      currentLifespan: 1, engaged: false,
    };
    const state = baseState({ board: { r2c1: attacker, r4c1: scarab }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    // Only the attacker is a legal "Target Being" once Scarab itself has died and vacated its tile.
    expect(next.board.r2c1.counters).toEqual({ '-1/-1': 1 });
  });
});

describe('"Each time this moves create a Rat token on the tile it moved from." (Hoarder)', () => {
  const hoarder = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Hoarder', arrows: [1], keywords: { onMove: 'create a Rat token on the tile it moved from.' } }), currentLifespan: 2, engaged: false };

  it('creates a Rat token on the tile it just vacated', () => {
    const state = baseState({ board: { r1c2: hoarder }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r1c2', direction: 1 });
    expect(next.board.r2c2.card.name).toBe('Hoarder'); // Hoarder itself landed here
    expect(next.board.r1c2.card.name).toBe('Rat'); // the token, on the tile it moved from
    expect(next.board.r1c2.card.strength).toBe(1);
    expect(next.board.r1c2.card.lifespan).toBe(1);
    // Its real printed row (public/default-card-set.csv row 463) prints
    // Arrows "1" — createTokenCard() used to drop arrows entirely for every
    // token it built, so a real Rat token could never move on its own.
    expect(next.board.r1c2.card.arrows).toEqual([1]);
    expect(next.log.some(e => e.message.includes("Hoarder's move triggers"))).toBe(true);
  });

  it('does not fire on an attack — attacking never repositions the attacker', () => {
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy#0', strength: 0, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: { ...hoarder, currentLifespan: 5 }, r4c1: enemy }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.card.name).toBe('Hoarder'); // stayed in its lane, no token created there
    expect(next.log.some(e => e.message.includes("Hoarder's move triggers"))).toBe(false);
  });

  it('moving repeatedly creates a Rat each time, stacking up behind it', () => {
    const state = baseState({ board: { r1c2: hoarder }, players: { A: player(), B: player() } });
    const afterFirst = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r1c2', direction: 1 }); // r1c2 -> r2c2, Rat at r1c2
    const disengaged = { ...afterFirst, board: { ...afterFirst.board, r2c2: { ...afterFirst.board.r2c2, engaged: false, card: { ...afterFirst.board.r2c2.card, arrows: [5] } } } };
    const afterSecond = gameReducer(disengaged, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 5 }); // back to r1c2 — blocked by the Rat already there
    // r1c2 already holds the first Rat, so moving back onto it isn't legal — Hoarder stays put.
    expect(afterSecond.board.r2c2.card.name).toBe('Hoarder');
    expect(afterSecond.board.r1c2.card.name).toBe('Rat');
  });
});

describe('"Summon (1) 0/2 Vine token on the tile it moved from." (Imneyat Dryad)', () => {
  const imneyatDryad = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Imneyat Dryad', arrows: [1], keywords: { onMove: 'Summon (1) 0/2 Vine token on the tile it moved from.' } }), currentLifespan: 3, engaged: false };

  it('summons a 0/2 Vine token on the tile it just vacated', () => {
    const state = baseState({ board: { r1c2: imneyatDryad }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r1c2', direction: 1 });
    expect(next.board.r2c2.card.name).toBe('Imneyat Dryad'); // itself landed here
    expect(next.board.r1c2.card.name).toBe('Vine'); // the token, on the tile it moved from
    expect(next.board.r1c2.card.strength).toBe(0);
    expect(next.board.r1c2.card.lifespan).toBe(2);
  });

  it('does not fire on an attack — attacking never repositions the mover', () => {
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'enemy#0', strength: 0, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: { ...imneyatDryad, currentLifespan: 5 }, r4c1: enemy }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.card.name).toBe('Imneyat Dryad'); // stayed in its lane, no token created there
  });
});

describe('Invoke keyword ("Add to hand, then summon/conjure")', () => {
  it('"Invoke (Add to hand, then summon/conjure) White Whisker." (Classic Familiar) invokes the named card onto an empty tile', () => {
    const familiar = {
      type: 'being', ownerId: 'A',
      card: beingCard({ name: 'Classic Familiar', keywords: { depart: 'Invoke (Add to hand, then summon/conjure) White Whisker.' } }),
      currentLifespan: 2, engaged: false,
    };
    const whiteWhisker = { id: 'ww', instanceId: 'ww#0', name: 'White Whisker', kind: 'relic', castingCost: { faithless: 0, colored: { living: 2 } }, keywords: {} };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B', board: { r4c1: attacker, r2c1: familiar },
      players: { A: player({ mainDeck: [whiteWhisker] }), B: player({ lifespan: 50 }) },
    });
    const afterCombat = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    // Many empty Mortal Realm cells remain for A besides the one Classic
    // Familiar just vacated, so Invoke's own default-destination choice
    // opens rather than auto-resolving — same as any other unnamed-location
    // token/Invoke placement with more than one legal empty cell.
    expect(afterCombat.pendingChoice.kind).toBe('invoke-destination');
    const options = getLegalActions(afterCombat, 'A').filter(a => a.type === 'RESOLVE_INVOKE_DESTINATION');
    expect(options.length).toBeGreaterThan(1);
    const next = gameReducer(afterCombat, options.find(o => o.cellId === 'r2c1'));
    expect(next.players.A.mainDeck).toHaveLength(0);
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.board.r2c1.type).toBe('relic');
    expect(next.board.r2c1.card.name).toBe('White Whisker');
  });

  // Regression: same root cause as the Locust Swarm fix above (toGameCard
  // trimming, cardData.js) — the real CSV row's own "Card Name" is "White
  // Whisker " with a trailing space (confirmed via
  // public/default-card-set.csv). Before the trim fix, invokeCandidates'
  // own exact-name match (searchZoneCandidates: `name === q`) compared the
  // untrimmed deck card's name ("white whisker ") against Classic
  // Familiar's own clean query text ("white whisker", captured then
  // trimmed) — never equal, so the search silently found nothing and
  // White Whisker could never actually be Invoked at all, despite sitting
  // right there in the deck. Parses both cards from real, untrimmed CSV
  // rows (unlike the clean fixture above) to actually exercise this path.
  it('still finds and Invokes White Whisker when both cards are parsed from real, untrimmed CSV rows', () => {
    const classicRow = {
      'Card Name': 'Classic Familiar ', 'Card Typing': 'Cat, Being, Familiar', 'Effigy Costs': '1 Faithless, 1 Living',
      'Casting Cost': '2', 'Text Box': 'Depart: Invoke (Add to hand, then summon/conjure) White Whisker.',
      'Strength': '2', 'Lifespan': '2', 'Arrows (Clockwise top center = 1)': '1, 5, 7',
    };
    const whiskerRow = {
      'Card Name': 'White Whisker ', 'Card Typing': 'Relic', 'Effigy Costs': '2 Living', 'Casting Cost': '2',
      'Text Box': 'Engage: Add a Familiar to hand from deck. \nSacrifice this when you summon a Familiar.',
    };
    const classic = toGameCard(classicRow, 0);
    const whisker = { ...toGameCard(whiskerRow, 1), instanceId: 'ww#0' };
    const familiar = { type: 'being', ownerId: 'A', card: { ...classic, instanceId: 'cf#0' }, currentLifespan: 2, engaged: false };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B', board: { r4c1: attacker, r2c1: familiar },
      players: { A: player({ mainDeck: [whisker] }), B: player({ lifespan: 50 }) },
    });
    const afterCombat = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(afterCombat.log.some(e => e.message.includes("isn't automated yet"))).toBe(false);
    expect(afterCombat.pendingChoice?.kind).toBe('invoke-destination'); // found in deck — a real destination choice opened, not a no-op
    const options = getLegalActions(afterCombat, 'A').filter(a => a.type === 'RESOLVE_INVOKE_DESTINATION');
    const next = gameReducer(afterCombat, options[0]);
    expect(next.players.A.mainDeck).toHaveLength(0); // pulled out of the deck once actually placed
    expect(next.board[options[0].cellId]?.card?.name).toBe('White Whisker');
  });

  it('"Invoke a Faithless Relic Card that costs (2) or less." (Faithless Invocation) filters by typing, cost, and Faithless-only', () => {
    const invocation = {
      id: 'fi', instanceId: 'fi#0', name: 'Faithless Invocation', kind: 'conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Invoke a Faithless Relic Card that costs (2) or less.',
    };
    const legal = { id: 'r1', instanceId: 'r1#0', name: 'Cheap Faithless Relic', kind: 'relic', typing: 'Relic', castingCost: { faithless: 2, colored: {} }, keywords: {} };
    const tooExpensive = { id: 'r2', instanceId: 'r2#0', name: 'Pricey Relic', kind: 'relic', typing: 'Relic', castingCost: { faithless: 3, colored: {} }, keywords: {} };
    const notFaithless = { id: 'r3', instanceId: 'r3#0', name: 'Colored Relic', kind: 'relic', typing: 'Relic', castingCost: { faithless: 0, colored: { living: 1 } }, keywords: {} };
    const wrongTyping = { id: 'b1', instanceId: 'b1#0', name: 'Cheap Being', kind: 'being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 1, keywords: {} };
    const state = baseState({
      players: { A: player({ hand: [invocation], mainDeck: [legal, tooExpensive, notFaithless, wrongTyping] }), B: player() },
    });
    const afterCast = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'fi#0' });
    // The card is only actually removed from the deck once a destination is
    // chosen (invokeCardOnto) — at this point it's just been *found*.
    expect(afterCast.pendingChoice).toMatchObject({ kind: 'invoke-destination', cardInstanceId: 'r1#0' });
    const options = getLegalActions(afterCast, 'A').filter(a => a.type === 'RESOLVE_INVOKE_DESTINATION');
    const next = gameReducer(afterCast, options[0]);
    expect(next.players.A.mainDeck.map(c => c.instanceId).sort()).toEqual(['b1#0', 'r2#0', 'r3#0']);
    const placed = Object.values(next.board).find(o => o?.type === 'relic');
    expect(placed.card.name).toBe('Cheap Faithless Relic');
  });

  it('"Invoke a Seed on target tile this points to." (Crathean Cultivator) lands on the pointed tile', () => {
    const cultivator = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Crathean Cultivator', arrows: [1], keywords: { engage: 'Invoke a Seed on target tile this points to.' } }), currentLifespan: 2, engaged: false };
    const seed = { id: 's', instanceId: 's#0', name: 'Some Seed', kind: 'being', typing: 'Seed, Being', castingCost: { faithless: 0, colored: {} }, strength: 0, lifespan: 2, keywords: {} };
    const state = baseState({ board: { r1c2: cultivator }, players: { A: player({ mainDeck: [seed] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.board.r2c2.card.name).toBe('Some Seed');
    expect(next.players.A.mainDeck).toHaveLength(0);
  });

  it('"Invoke a Seed..." finds no match and logs honestly instead of crashing', () => {
    const cultivator = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Crathean Cultivator', arrows: [1], keywords: { engage: 'Invoke a Seed on target tile this points to.' } }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r1c2: cultivator }, players: { A: player({ mainDeck: [{ instanceId: 'x', name: 'Unrelated' }] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.log.some(e => e.message.includes('finds no "Seed"'))).toBe(true);
    expect(next.board.r2c2).toBeUndefined();
  });

  it('"Invoke a TreeFolk with cost (4) or less on a tile this points to." (Samara Seed\'s own Martyr — "summon it" dropped) still invokes within the cost cap', () => {
    const samaraSeed = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'ss#0', name: 'Samara Seed', arrows: [1], keywords: { martyr: 'Invoke a TreeFolk with cost (4) or less on a tile this points to.' } }),
      currentLifespan: 1, engaged: false,
    };
    const cheapTreefolk = { id: 't1', instanceId: 't1#0', name: 'Sapling', kind: 'being', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: { living: 4 } }, strength: 1, lifespan: 2, keywords: {} };
    const pricyTreefolk = { id: 't2', instanceId: 't2#0', name: 'Ancient Treant', kind: 'being', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: { living: 5 } }, strength: 5, lifespan: 5, keywords: {} };
    const state = baseState({ board: { r1c2: samaraSeed }, players: { A: player({ mainDeck: [cheapTreefolk, pricyTreefolk] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r1c2' });
    expect(next.players.A.purgatory.some(c => c.instanceId === 'ss#0')).toBe(true); // Samara Seed sacrificed itself
    expect(next.board.r1c2).toBeUndefined();
    expect(next.board.r2c2.card.name).toBe('Sapling'); // only the affordable one qualifies
    expect(next.players.A.mainDeck.map(c => c.instanceId)).toEqual(['t2#0']);
  });

  // Regression: per the user's own ruling, Invoke's "on a tile this points
  // to" destination should ALSO accept a tile occupied by an eligible own
  // plant (TreeFolk/Vine/Seed) when the invoked card itself has Dryad —
  // same rule Boknean Druid's own "may be summoned directly onto..." text
  // already gets at plain SUMMON_BEING time (placeBeingOnBoard's own
  // dryadAttachTargetOk check). The gap was one level up in
  // placeInvokedCard's own candidate filter, which required the tile to
  // be empty outright and never even offered an occupied-but-attachable
  // one, so placeBeingOnBoard's already-correct attach logic never got a
  // chance to run.
  it('"Invoke a TreeFolk...on a tile this points to." (Samara Seed) attaches a Dryad-carrying invoked Being onto an own plant occupying that tile, instead of refusing the tile', () => {
    const samaraSeed = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'ss#0', name: 'Samara Seed', arrows: [1], keywords: { martyr: 'Invoke a TreeFolk with cost (4) or less on a tile this points to.' } }),
      currentLifespan: 1, engaged: false,
    };
    const elderflowerAncient = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ea#0', name: 'Elderflower Ancient', typing: 'TreeFolk, Being', strength: 2, lifespan: 4 }), currentLifespan: 4, engaged: false };
    const jirahpera = { id: 'jp', instanceId: 'jp#0', name: 'Jirahperā', kind: 'being', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: { living: 2 } }, strength: 1, lifespan: 1, keywords: { dryad: true } };
    const state = baseState({ board: { r1c2: samaraSeed, r2c2: elderflowerAncient }, players: { A: player({ mainDeck: [jirahpera] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r1c2' });
    expect(next.board.r2c2.card.name).toBe('Jirahperā'); // the invoked Dryad Being becomes the tile's own occupant
    expect(next.board.r2c2.dryadAttached?.card?.name).toBe('Elderflower Ancient'); // riding it, Dryad-style
    expect(next.players.A.mainDeck).toHaveLength(0); // found and invoked, not left behind
  });

  it('Samara Seed — with 2+ pointed candidates (a real invoke-destination pendingChoice), picking the occupied plant tile still attaches instead of silently clearing the choice', () => {
    const samaraSeed = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'ss#0', name: 'Samara Seed', arrows: [1, 2], keywords: { martyr: 'Invoke a TreeFolk with cost (4) or less on a tile this points to.' } }),
      currentLifespan: 1, engaged: false,
    };
    const elderflowerAncient = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ea#0', name: 'Elderflower Ancient', typing: 'TreeFolk, Being', strength: 2, lifespan: 4 }), currentLifespan: 4, engaged: false };
    const jirahpera = { id: 'jp', instanceId: 'jp#0', name: 'Jirahperā', kind: 'being', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: { living: 2 } }, strength: 1, lifespan: 1, keywords: { dryad: true } };
    // Direction 1 from r1c2 points to r2c2 (the plant, occupied but
    // Dryad-attach-eligible); direction 2 points to r2c3 (empty) — two
    // real candidates, so placeInvokedCard opens a genuine pendingChoice
    // instead of auto-resolving the way the single-candidate test above
    // does.
    const state = baseState({ board: { r1c2: samaraSeed, r2c2: elderflowerAncient }, players: { A: player({ mainDeck: [jirahpera] }), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r1c2' });
    expect(opened.pendingChoice).toMatchObject({ kind: 'invoke-destination' });
    expect(opened.pendingChoice.allowedCells).toEqual(expect.arrayContaining(['r2c2', 'r2c3']));
    const next = gameReducer(opened, { type: 'RESOLVE_INVOKE_DESTINATION', cellId: 'r2c2' });
    expect(next.board.r2c2.card.name).toBe('Jirahperā'); // attached, not silently dropped
    expect(next.board.r2c2.dryadAttached?.card?.name).toBe('Elderflower Ancient');
    expect(next.players.A.mainDeck).toHaveLength(0);
  });

  it('"Remove (1) Growth Counter: Sacrifice this, Invoke a Treefolk with cost (2) or less summon it on a tile this points to." (Kernel) sacrifices itself, then invokes within the cost cap', () => {
    const kernel = {
      type: 'being', ownerId: 'A',
      card: beingCard({
        instanceId: 'kernel#0', name: 'Kernel', arrows: [1],
        keywords: { counterCostSacrificeAbility: { type: 'growth', amount: 1, effect: 'Invoke a Treefolk with cost (2) or less summon it on a tile this points to.' } },
      }),
      currentLifespan: 1, engaged: false, counters: { growth: 1 },
    };
    const cheapTreefolk = { id: 't1', instanceId: 't1#0', name: 'Sapling', kind: 'being', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: { living: 2 } }, strength: 1, lifespan: 2, keywords: {} };
    const pricyTreefolk = { id: 't2', instanceId: 't2#0', name: 'Ancient Treant', kind: 'being', typing: 'TreeFolk, Being', castingCost: { faithless: 0, colored: { living: 5 } }, strength: 5, lifespan: 5, keywords: {} };
    const state = baseState({ board: { r1c2: kernel }, players: { A: player({ mainDeck: [cheapTreefolk, pricyTreefolk] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_COUNTER_COST_SACRIFICE', cellId: 'r1c2' });
    expect(next.players.A.purgatory.some(c => c.instanceId === 'kernel#0')).toBe(true); // Kernel sacrificed itself
    expect(next.board.r1c2).toBeUndefined();
    expect(next.board.r2c2.card.name).toBe('Sapling'); // only the affordable one qualifies
    expect(next.players.A.mainDeck.map(c => c.instanceId)).toEqual(['t2#0']);
  });

  it('opens invoke-card-choice when more than one real card matches the search', () => {
    const cultivator = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Crathean Cultivator', arrows: [1], keywords: { engage: 'Invoke a Seed on target tile this points to.' } }), currentLifespan: 2, engaged: false };
    const seedA = { id: 'sa', instanceId: 'sa#0', name: 'Seed A', kind: 'being', typing: 'Seed, Being', castingCost: { faithless: 0, colored: {} }, strength: 0, lifespan: 1, keywords: {} };
    const seedB = { id: 'sb', instanceId: 'sb#0', name: 'Seed B', kind: 'being', typing: 'Seed, Being', castingCost: { faithless: 0, colored: {} }, strength: 0, lifespan: 1, keywords: {} };
    const state = baseState({ board: { r1c2: cultivator }, players: { A: player({ mainDeck: [seedA, seedB] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.pendingChoice.kind).toBe('invoke-card-choice');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_INVOKE_CARD_CHOICE');
    expect(options.map(o => o.instanceId).sort()).toEqual(['sa#0', 'sb#0']);
    const resolved = gameReducer(next, options.find(o => o.instanceId === 'sb#0'));
    expect(resolved.board.r2c2.card.name).toBe('Seed B');
    expect(resolved.players.A.mainDeck.map(c => c.instanceId)).toEqual(['sa#0']);
  });
});

describe('"When a Familiar is summoned under your control draw (1) card." (Greenseer\'s assistant)', () => {
  const assistant = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'assistant#0', name: "Greenseer's assistant", typing: 'Human, Being', keywords: { onTypedSummonedUnderControl: { typing: 'Familiar', effect: 'draw (1) card.' } } }), currentLifespan: 2, engaged: false };

  it('draws a card when a Familiar (e.g. Hoarder) is summoned under the same control', () => {
    const hoarder = beingCard({ instanceId: 'hoarder#0', name: 'Hoarder', typing: 'Human, Being, Familiar', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({
      board: { r2c1: assistant },
      players: { A: player({ hand: [hoarder], mainDeck: [{ instanceId: 'd1', name: 'Deck 1' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'hoarder#0', cellId: 'r1c3' });
    expect(next.players.A.hand.some(c => c.instanceId === 'd1')).toBe(true);
    expect(next.log.some(e => e.message.includes("Greenseer's assistant's reaction triggers"))).toBe(true);
  });

  it('does not trigger for a Being that is not typed Familiar', () => {
    const plain = beingCard({ instanceId: 'plain#0', name: 'Plain Grunt', typing: 'Human, Being', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({
      board: { r2c1: assistant },
      players: { A: player({ hand: [plain], mainDeck: [{ instanceId: 'd1', name: 'Deck 1' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'plain#0', cellId: 'r1c3' });
    expect(next.players.A.hand.some(c => c.instanceId === 'd1')).toBe(false);
  });

  it('does not trigger for a Familiar summoned under the opponent\'s control', () => {
    const hoarder = beingCard({ instanceId: 'hoarder#0', name: 'Hoarder', typing: 'Human, Being, Familiar', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({
      board: { r2c1: assistant },
      players: { A: player(), B: player({ hand: [hoarder], mainDeck: [{ instanceId: 'd1', name: 'Deck 1' }] }) },
    });
    const next = gameReducer({ ...state, turnPlayer: 'B' }, { type: 'SUMMON_BEING', instanceId: 'hoarder#0', cellId: 'r5c2' });
    expect(next.players.B.hand.some(c => c.instanceId === 'd1')).toBe(false);
  });

  it('multiple copies each trigger their own draw', () => {
    const secondAssistant = { ...assistant, card: { ...assistant.card, instanceId: 'assistant2#0' } };
    const hoarder = beingCard({ instanceId: 'hoarder#0', name: 'Hoarder', typing: 'Human, Being, Familiar', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({
      board: { r2c1: assistant, r2c3: secondAssistant },
      players: { A: player({ hand: [hoarder], mainDeck: [{ instanceId: 'd1' }, { instanceId: 'd2' }] }), B: player() },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'hoarder#0', cellId: 'r1c3' });
    expect(next.players.A.hand).toHaveLength(2); // one draw per assistant
  });
});

describe('"Does not Disengage during start of turn. Once per turn Pay (1) Bleeding Essence: Disengage." (Anahk-sha)', () => {
  const anahkSha = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Anahk-sha', keywords: { neverAutoDisengages: true, timesPerTurnAbility: { times: 1, effect: 'Pay (1) Bleeding Essence: Disengage.' } } }), currentLifespan: 4, engaged: true };

  it('stays engaged through the Disengage step even though it was engaged all last turn', () => {
    const state = baseState({ turnPlayer: 'A', board: { r2c1: anahkSha }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'PASS_TURN' });
    // B's turn now starts (disengage() runs for the *new* turn player,
    // which is B) — advance once more back to A to actually run A's own
    // disengage step.
    const backToA = gameReducer(next, { type: 'PASS_TURN' });
    expect(backToA.board.r2c1.engaged).toBe(true); // never auto-disengaged
  });

  it('pays (1) Bleeding to disengage itself on demand', () => {
    const state = baseState({ board: { r2c1: anahkSha }, players: { A: player({ effigyPool: [effigy('bleeding')] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_TIMES_PER_TURN_ABILITY' && a.cellId === 'r2c1')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c1.engaged).toBe(false);
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('cannot pay without (1) Bleeding available, and does not disengage', () => {
    const state = baseState({ board: { r2c1: anahkSha }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.board.r2c1.engaged).toBe(true);
    expect(next.log.some(e => e.message.includes("can't afford to pay 1 Bleeding"))).toBe(true);
  });
});

describe('"Can not move. Whenever this moves craft an Effigy." (Reveler) — intentionally contradictory (confirmed with the user)', () => {
  const reveler = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Reveler', arrows: [1], keywords: { cannotMove: true, onMove: 'craft an Effigy.' } }), currentLifespan: 1, engaged: false };

  it('never offers itself a legal self-initiated move, despite having arrows', () => {
    const state = baseState({ board: { r1c2: reveler }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r1c2' && !a.isAttack)).toBe(false);
  });

  it('rejects a directly-dispatched self-move too (defense in depth)', () => {
    const state = baseState({ board: { r1c2: reveler }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r1c2', direction: 1 });
    expect(next.board.r1c2).toEqual(reveler); // untouched
  });

  it('crafts an Effigy when moved by an external effect (e.g. Shifting Sands\' own Engage)', () => {
    const state = baseState({
      board: { r1c2: reveler },
      players: { A: player({ effigyDeck: [{ instanceId: 'ed1', effigyType: 'bleeding' }] }), B: player() },
      pendingChoice: { kind: 'free-move', playerId: 'A', cardName: 'Shifting Sands', label: 'Engage', fromCellId: 'r1c2', destinationFilter: 'any' },
    });
    const next = gameReducer(state, { type: 'RESOLVE_FREE_MOVE', toCellId: 'r2c2' });
    expect(next.board.r2c2.card.name).toBe('Reveler');
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.log.some(e => e.message.includes("Reveler's move triggers"))).toBe(true);
  });
});

describe('"When summoned add (1) Growth Counter to a Seed this points to." (Green thumbed Gardener)', () => {
  const gardener = beingCard({
    instanceId: 'gardener#0', name: 'Green thumbed Gardener', arrows: [1], castingCost: { faithless: 0, colored: {} },
    keywords: { whenSummoned: 'add (1) Growth Counter to a Seed this points to.' },
  });

  it('adds the counter to the only Seed it points to', () => {
    const seed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'seed#0', typing: 'Seed, Being' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c2: seed }, players: { A: player({ hand: [gardener] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'gardener#0', cellId: 'r1c2' });
    expect(next.board.r2c2.counters).toEqual({ growth: 1 });
  });

  it('offers a choice among multiple Seeds it points to', () => {
    const twoArrows = { ...gardener, arrows: [1, 3] };
    const seedA = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'sa#0', typing: 'Seed, Being' }), currentLifespan: 2, engaged: false };
    const seedB = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'sb#0', typing: 'Seed, Being' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c2: seedA, r1c3: seedB }, players: { A: player({ hand: [twoArrows] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'gardener#0', cellId: 'r1c2' });
    expect(next.pendingChoice.kind).toBe('add-counter-typed-pointed-target');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_ADD_COUNTER_TYPED_POINTED_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r1c3', 'r2c2']);
    const resolved = gameReducer(next, options.find(o => o.cellId === 'r1c3'));
    expect(resolved.board.r1c3.counters).toEqual({ growth: 1 });
  });

  it('logs an honest "no Seed" instead of crashing when nothing it points to is a Seed', () => {
    const notSeed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ns#0', typing: 'Demon, Being' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c2: notSeed }, players: { A: player({ hand: [gardener] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'gardener#0', cellId: 'r1c2' });
    expect(next.log.some(e => e.message.includes('has no Seed it points to'))).toBe(true);
    expect(next.board.r2c2.counters).toBeUndefined();
  });
});

describe('"Engage: Move target Armament you control to a tile this points to." (Ay-gruhda)', () => {
  const aygruhda = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Ay-gruhda', arrows: [1], keywords: { engage: 'Move target Armament you control to a tile this points to.' } }), currentLifespan: 2, engaged: false };
  const rusted = (id = 'rr#0') => equip({ id: 'rr', instanceId: id, name: 'Rusted Rapier', kind: 'relic-armament', keywords: {} });

  it('moves the only Armament onto the only pointed empty tile, becoming a freestanding pile', () => {
    const withArmament = { ...aygruhda, armaments: [rusted()] };
    const state = baseState({ board: { r1c2: withArmament }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.board.r1c2.armaments).toEqual([]);
    expect(next.board.r2c2).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [rusted()] });
  });

  it('offers a choice among multiple own Armaments', () => {
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 5, engaged: false, armaments: [rusted('b#0')] };
    const withArmament = { ...aygruhda, armaments: [rusted('a#0')] };
    const state = baseState({ board: { r1c2: withArmament, r2c3: ally }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.pendingChoice.kind).toBe('move-armament-source');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_MOVE_ARMAMENT_SOURCE');
    expect(options.map(o => o.armamentInstanceId).sort()).toEqual(['a#0', 'b#0']);
    const resolved = gameReducer(next, options.find(o => o.armamentInstanceId === 'b#0'));
    // The chosen Armament (from the ally) moves onto Ay-gruhda's own
    // pointed tile; Ay-gruhda's own Armament stays put since it wasn't chosen.
    expect(resolved.board.r2c2.armaments).toEqual([rusted('b#0')]);
    expect(resolved.board.r2c3.armaments).toEqual([]);
    expect(resolved.board.r1c2.armaments).toEqual([rusted('a#0')]);
  });

  it('offers a choice among multiple pointed destinations, and attaches to an existing own Being there', () => {
    const twoArrows = { ...aygruhda, card: { ...aygruhda.card, arrows: [1, 3] }, armaments: [rusted()] };
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r1c2: twoArrows, r1c3: ally }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.pendingChoice.kind).toBe('move-armament-destination');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_MOVE_ARMAMENT_DESTINATION');
    expect(options.map(o => o.cellId).sort()).toEqual(['r1c3', 'r2c2']);
    const resolved = gameReducer(next, options.find(o => o.cellId === 'r1c3'));
    expect(resolved.board.r1c3.armaments).toEqual([rusted()]); // attached to the ally already there
  });

  it('logs an honest "no Armament" instead of crashing when the player controls none', () => {
    const state = baseState({ board: { r1c2: aygruhda }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c2' });
    expect(next.log.some(e => e.message.includes('has no Armament of A\'s to move'))).toBe(true);
  });
});

describe('"Once per turn, you may Pay (1) Bleeding Essence: The next Relic you summon this turn costs (-2) Faithless." (Metal Worker)', () => {
  const metalWorker = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Metal Worker', keywords: { timesPerTurnAbility: { times: 1, effect: 'Pay (1) Bleeding Essence: The next Relic you summon this turn costs (-2) Faithless.' } } }), currentLifespan: 3, engaged: false };
  const relicCard = (overrides = {}) => ({ id: 'r', instanceId: 'r#0', name: 'Some Relic', kind: 'relic', castingCost: { faithless: 2, colored: {} }, keywords: {}, ...overrides });

  it('pays 1 Bleeding, then discounts the next Relic placed this turn by 2 Faithless, then stops applying', () => {
    const cheapRelic = relicCard();
    const secondRelic = relicCard({ instanceId: 'r2#0' });
    const state = baseState({
      board: { r2c1: metalWorker },
      players: { A: player({ hand: [cheapRelic, secondRelic], effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const activated = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(activated.players.A.effigyPool).toHaveLength(0);
    expect(activated.nextRelicCostReduction).toEqual({ color: 'faithless', amount: 2 });
    // Reduced to 0 Faithless — placeable with an empty pool.
    const placed = gameReducer(activated, { type: 'PLACE_RELIC', instanceId: 'r#0', cellId: 'r1c2' });
    expect(placed.board.r1c2.type).toBe('relic');
    expect(placed.nextRelicCostReduction).toBeNull();
    // The discount is used up — the second Relic needs its full cost again.
    const secondAttempt = gameReducer(placed, { type: 'PLACE_RELIC', instanceId: 'r2#0', cellId: 'r1c3' });
    expect(secondAttempt.board.r1c3).toBeUndefined();
  });

  it('does not activate (and does not discount) without (1) Bleeding available', () => {
    const state = baseState({ board: { r2c1: metalWorker }, players: { A: player({ hand: [relicCard()] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.nextRelicCostReduction).toBeFalsy();
    expect(next.log.some(e => e.message.includes("can't afford to pay 1 Bleeding"))).toBe(true);
  });

  it('is cleared at end of turn if never used', () => {
    const state = baseState({
      turnPlayer: 'A', board: { r2c1: metalWorker },
      players: { A: player({ effigyPool: [effigy('bleeding')] }), B: player() },
      nextRelicCostReduction: { color: 'faithless', amount: 2 },
    });
    const next = gameReducer(state, { type: 'PASS_TURN' });
    expect(next.nextRelicCostReduction).toBeNull();
  });

  it('does not discount a Being (a distinct kind from Relic)', () => {
    const cheapBeing = beingCard({ instanceId: 'cb#0', castingCost: { faithless: 2, colored: {} } });
    const state = baseState({
      board: { r2c1: metalWorker }, players: { A: player({ hand: [cheapBeing], effigyPool: [] }), B: player() },
      nextRelicCostReduction: { color: 'faithless', amount: 2 },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'cb#0', cellId: 'r1c2' });
    expect(next.board.r1c2).toBeUndefined(); // still costs its full 2 Faithless, unaffordable
  });
});

describe('"Once Per turn shuffle an Armament into deck from your Purgatory, then add (1) Bleeding Essence." (Scrap Smith)', () => {
  const scrapSmith = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Scrap Smith', keywords: { timesPerTurnAbility: { times: 1, effect: 'shuffle an Armament into deck from your Purgatory, then add (1) Bleeding Essence.' } } }), currentLifespan: 2, engaged: false };
  const armament = { id: 'ra', instanceId: 'ra#0', name: 'Rusted Rapier', kind: 'relic-armament', typing: 'Relic, Armament' };

  it('shuffles the only Armament in Purgatory into the deck and adds 1 Bleeding Essence', () => {
    const state = baseState({ board: { r2c1: scrapSmith }, players: { A: player({ purgatory: [armament] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toHaveLength(0);
    expect(next.players.A.mainDeck).toEqual([armament]);
    expect(next.players.A.effigyPool).toHaveLength(1);
    expect(next.players.A.effigyPool[0]).toMatchObject({ effigyType: 'bleeding', temporary: true });
  });

  it('offers a choice among multiple Armaments in Purgatory', () => {
    const armamentB = { id: 'rb', instanceId: 'rb#0', name: 'Snake Skin', kind: 'relic-armament', typing: 'Relic, Armament' };
    const state = baseState({ board: { r2c1: scrapSmith }, players: { A: player({ purgatory: [armament, armamentB] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('shuffle-purgatory-into-deck');
    // The Essence half still resolves immediately (the generic "then"-split
    // doesn't wait on a pendingChoice opened by its first clause — same
    // established behavior every other "then"-split card already has).
    expect(next.players.A.effigyPool).toHaveLength(1);
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK');
    expect(options.map(o => o.instanceId).sort()).toEqual(['ra#0', 'rb#0']);
  });

  it('logs an honest "no Armament" instead of crashing when Purgatory has none', () => {
    const state = baseState({ board: { r2c1: scrapSmith }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_TIMES_PER_TURN_ABILITY', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('finds no "Armament" in A\'s Purgatory'))).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1); // the Essence half still resolves
  });
});

describe('"Engage: Shuffle up to (2) Armaments into your deck from Purgatory." (Scrap Collector)', () => {
  const scrapCollector = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Scrap Collector', keywords: { engage: 'Shuffle up to (2) Armaments into your deck from Purgatory.' } }), currentLifespan: 1, engaged: false };
  const armA = { id: 'ra', instanceId: 'ra#0', name: 'Rusted Rapier', kind: 'relic-armament', typing: 'Relic, Armament' };
  const armB = { id: 'rb', instanceId: 'rb#0', name: 'Snake Skin', kind: 'relic-armament', typing: 'Relic, Armament' };
  const armC = { id: 'rc', instanceId: 'rc#0', name: 'Cursed Cutlass', kind: 'relic-armament', typing: 'Relic, Armament' };

  it('opens a toggle choice capped at the printed count, not auto-resolving', () => {
    const state = baseState({ board: { r2c1: scrapCollector }, players: { A: player({ purgatory: [armA, armB, armC] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice).toEqual({ kind: 'shuffle-purgatory-toggle', playerId: 'A', cardName: 'Scrap Collector', label: 'Engage ability', query: 'Armament', maxCount: 2, selected: [] });
  });

  it('toggling a third candidate is illegal once 2 are already selected', () => {
    const opened = { kind: 'shuffle-purgatory-toggle', playerId: 'A', cardName: 'Scrap Collector', label: 'Engage', query: 'Armament', maxCount: 2, selected: ['ra#0', 'rb#0'] };
    const state = baseState({ pendingChoice: opened, players: { A: player({ purgatory: [armA, armB, armC] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SHUFFLE_PURGATORY_TOGGLE' && a.instanceId === 'rc#0')).toBe(false);
    // Untoggling one of the two already-selected is still legal.
    expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SHUFFLE_PURGATORY_TOGGLE' && a.instanceId === 'ra#0')).toBe(true);
  });

  it('confirming shuffles exactly the selected cards into the deck', () => {
    const opened = { kind: 'shuffle-purgatory-toggle', playerId: 'A', cardName: 'Scrap Collector', label: 'Engage', query: 'Armament', maxCount: 2, selected: ['ra#0'] };
    const state = baseState({ pendingChoice: opened, players: { A: player({ purgatory: [armA, armB] }), B: player() } });
    const next = gameReducer(state, { type: 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM' });
    expect(next.pendingChoice).toBeNull();
    expect(next.players.A.purgatory).toEqual([armB]);
    expect(next.players.A.mainDeck).toEqual([armA]);
  });

  it('confirming with nothing selected is legal ("up to" includes 0) and shuffles nothing', () => {
    const opened = { kind: 'shuffle-purgatory-toggle', playerId: 'A', cardName: 'Scrap Collector', label: 'Engage', query: 'Armament', maxCount: 2, selected: [] };
    const state = baseState({ pendingChoice: opened, players: { A: player({ purgatory: [armA, armB] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM')).toBe(true);
    const next = gameReducer(state, { type: 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM' });
    expect(next.pendingChoice).toBeNull();
    expect(next.players.A.purgatory).toEqual([armA, armB]);
    expect(next.players.A.mainDeck).toHaveLength(0);
  });

  it('logs an honest "no Armament" instead of crashing when Purgatory has none', () => {
    const state = baseState({ board: { r2c1: scrapCollector }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('finds no "Armament" in A\'s Purgatory'))).toBe(true);
    expect(next.pendingChoice).toBeNull();
  });
});

describe('"Depart: Restore (6) Lifespan or Summon (2) Blooming Vine tokens (...)." (Elderflower Ancient)', () => {
  const elderflower = {
    id: 'ea', instanceId: 'ea#0', name: 'Elderflower Ancient', kind: 'being',
    keywords: { depart: 'Restore (6) Lifespan or Summon (2) Blooming Vine tokens  (0/3 Being - Vine token with "Engage: Add (1) Living").' },
  };

  it('opens the either/or choice on Depart, not an auto-resolve', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: { ...elderflower, strength: 1, lifespan: 4 }, currentLifespan: 4, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.pendingChoice).toEqual({
      kind: 'restore-or-summon-vine', playerId: 'B', cardName: 'Elderflower Ancient', label: 'Depart', restoreAmount: 6, tokenCount: 2,
    });
  });

  describe('choosing "restore"', () => {
    const opened = { kind: 'restore-or-summon-vine', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', restoreAmount: 6, tokenCount: 2 };

    it('restores Lifespan to a targeted Being, capped at its own printed max — the excess fizzles', () => {
      // beingCard()'s printed Lifespan is 5; currentLifespan 3 + amount 6
      // would overshoot to 9, so only 2 of the 6 actually lands.
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 3, engaged: false };
      const state = baseState({ pendingChoice: opened, board: { r2c1: ally }, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'restore' });
      expect(next.pendingChoice).toEqual({ kind: 'restore-lifespan-target', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', amount: 6 });
      const resolved = gameReducer(next, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: 'r2c1' });
      expect(resolved.board.r2c1.currentLifespan).toBe(5);
      expect(resolved.pendingChoice).toBeNull();
    });

    it('restores the full amount when it fits under the Being\'s own max', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0', lifespan: 20 }), currentLifespan: 3, engaged: false };
      const state = baseState({ pendingChoice: opened, board: { r2c1: ally }, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'restore' });
      const resolved = gameReducer(next, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: 'r2c1' });
      expect(resolved.board.r2c1.currentLifespan).toBe(9);
    });

    it('is still a legal, choosable target when already at max — it just fizzles for 0', () => {
      const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 5, engaged: false };
      const state = baseState({ pendingChoice: opened, board: { r2c1: ally }, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'restore' });
      expect(getLegalActions(next, 'A')).toContainEqual({ type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: 'r2c1' });
      const resolved = gameReducer(next, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET', cellId: 'r2c1' });
      expect(resolved.board.r2c1.currentLifespan).toBe(5);
      expect(resolved.pendingChoice).toBeNull();
    });

    it('restores Lifespan to a player, and can push it above 50 — players have no cap', () => {
      const state = baseState({ pendingChoice: opened, players: { A: player({ lifespan: 48 }), B: player({ lifespan: 50 }) } });
      const afterChoice = gameReducer(state, { type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'restore' });
      expect(getLegalActions(afterChoice, 'A')).toContainEqual({ type: 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER', targetPlayerId: 'B' });
      const next = gameReducer(afterChoice, { type: 'RESOLVE_RESTORE_LIFESPAN_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(next.players.B.lifespan).toBe(56); // above the starting 50 — no cap
      expect(next.pendingChoice).toBeNull();
    });
  });

  describe('choosing "summon"', () => {
    const opened = { kind: 'restore-or-summon-vine', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', restoreAmount: 6, tokenCount: 2 };

    it('opens a board-native toggle capped at the printed count', () => {
      const state = baseState({ pendingChoice: opened, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'RESOLVE_RESTORE_OR_SUMMON_VINE', choice: 'summon' });
      expect(next.pendingChoice).toEqual({
        kind: 'summon-vine-tokens-toggle', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', maxCount: 2, selected: [],
      });
    });

    it('toggling a third tile is illegal once 2 are already selected', () => {
      const toggling = { kind: 'summon-vine-tokens-toggle', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', maxCount: 2, selected: ['r1c2', 'r1c3'] };
      const state = baseState({ pendingChoice: toggling, players: { A: player(), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE' && a.cellId === 'r1c4')).toBe(false);
      expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE' && a.cellId === 'r1c2')).toBe(true); // untoggle still legal
    });

    it('confirming places a Blooming Vine token on each selected tile', () => {
      const toggling = { kind: 'summon-vine-tokens-toggle', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', maxCount: 2, selected: ['r1c2', 'r1c3'] };
      const state = baseState({ pendingChoice: toggling, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM' });
      expect(next.pendingChoice).toBeNull();
      expect(next.board.r1c2.card.name).toBe('Blooming Vine Token');
      expect(next.board.r1c3.card.name).toBe('Blooming Vine Token');
    });

    it('confirming with nothing selected is legal and places nothing', () => {
      const toggling = { kind: 'summon-vine-tokens-toggle', playerId: 'A', cardName: 'Elderflower Ancient', label: 'Depart', maxCount: 2, selected: [] };
      const state = baseState({ pendingChoice: toggling, players: { A: player(), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM')).toBe(true);
      const next = gameReducer(state, { type: 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM' });
      expect(next.pendingChoice).toBeNull();
      expect(Object.keys(next.board)).toHaveLength(0);
    });
  });
});

describe('"Depart: Add a Passing Doubt to hand." (Skeptic) — generates a real token, not a deck search', () => {
  const skeptic = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Skeptic', keywords: { depart: 'Add a Passing Doubt to hand.' } }), currentLifespan: 2, engaged: false };

  it('adds a fresh Passing Doubt token to hand on Depart', () => {
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ turnPlayer: 'B', board: { r4c1: attacker, r2c1: skeptic }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(next.players.A.hand).toHaveLength(1);
    expect(next.players.A.hand[0].name).toBe('Passing Doubt');
    expect(next.players.A.hand[0].isToken).toBe(true);
    expect(next.players.A.hand[0].strength).toBe(2);
    expect(next.players.A.hand[0].lifespan).toBe(2);
    expect(next.players.A.mainDeck).toHaveLength(0); // never touched the deck
  });
});

describe('"Whenever you Martyr a Seed, Craft (1) Effigy." (Sapling)', () => {
  const sapling = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Sapling', keywords: { onOwnMartyrTyped: { typing: 'Seed', effect: 'Craft (1) Effigy.' } } }), currentLifespan: 2, engaged: false };
  const seed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'seed#0', typing: 'Seed, Being', keywords: { martyr: '' } }), currentLifespan: 1, engaged: false };

  it('crafts an Effigy when its controller Martyrs a Seed', () => {
    const state = baseState({ board: { r2c1: sapling, r2c2: seed }, players: { A: player({ effigyDeck: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    expect(next.log.some(e => e.message.includes("Sapling's reaction triggers"))).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1);
  });

  it('does not trigger when a non-Seed is Martyred', () => {
    const nonSeed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ns#0', typing: 'Demon, Being', keywords: { martyr: '' } }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: sapling, r2c2: nonSeed }, players: { A: player({ effigyDeck: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c2' });
    expect(next.log.some(e => e.message.includes("Sapling's reaction triggers"))).toBe(false);
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('does not trigger off the opponent Martyring their own Seed', () => {
    const state = baseState({
      turnPlayer: 'B',
      board: { r2c1: sapling, r4c1: { ...seed, ownerId: 'B' } },
      players: { A: player({ effigyDeck: [effigy('living')] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r4c1' });
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('also crafts an Effigy when a Seed sacrifices itself to its own effect (Blooming Seed/Kernel-style counterCostSacrificeAbility), not just a printed Martyr', () => {
    const bloomingSeed = {
      type: 'being', ownerId: 'A',
      card: beingCard({
        instanceId: 'bs#0', name: 'Blooming Seed', typing: 'Seed, Being',
        keywords: { counterCostSacrificeAbility: { type: 'growth', amount: 1, effect: 'summon a Treefolk token on this tile.' } },
      }),
      currentLifespan: 1, engaged: false, counters: { growth: 1 },
    };
    const state = baseState({ board: { r2c1: sapling, r2c2: bloomingSeed }, players: { A: player({ effigyDeck: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_COUNTER_COST_SACRIFICE', cellId: 'r2c2' });
    expect(next.log.some(e => e.message.includes("Sapling's reaction triggers"))).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1);
  });
});

describe('"If you conjure a non Armament Relic on a tile this points to, Craft an Effigy." (Monumental Mason)', () => {
  const mason = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Monumental Mason', arrows: [1] }), currentLifespan: 3, engaged: false };
  const withAbility = { ...mason, card: { ...mason.card, keywords: { craftEffigyOnPointedRelicConjure: { amount: 1 } } } };
  const relicCard = { id: 'relic', instanceId: 'relic#0', name: 'Test Relic', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: {} };

  it('crafts an Effigy when a non-Armament Relic is placed on a tile it points to', () => {
    const state = baseState({ board: { r1c2: withAbility }, players: { A: player({ hand: [relicCard], effigyDeck: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic#0', cellId: 'r2c2' });
    expect(next.log.some(e => e.message.includes("Monumental Mason's reaction crafts 1 Effigy"))).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1);
  });

  it('does not trigger when the Relic lands on a tile it does not point to', () => {
    const state = baseState({ board: { r1c2: withAbility }, players: { A: player({ hand: [relicCard], effigyDeck: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic#0', cellId: 'r1c3' });
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('does not trigger without the keyword (plain Mason with no printed ability)', () => {
    const state = baseState({ board: { r1c2: mason }, players: { A: player({ hand: [relicCard], effigyDeck: [effigy('living')] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: 'relic#0', cellId: 'r2c2' });
    expect(next.players.A.effigyPool).toHaveLength(0);
  });
});

describe('"Seed Beings that Nursery Attendant Points to cost (-1) Living to activate." (Nursery Attendant)', () => {
  const attendant = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Nursery Attendant', arrows: [1], keywords: { seedActivationCostReduction: { typing: 'Seed', amount: 1, color: 'living' } } }), currentLifespan: 4, engaged: false };
  const seed = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: 'seed#0', name: 'Blooming Seed', typing: 'Seed, Being', strength: 0, lifespan: 2, keywords: { payEffigyCostAbility: { color: 'living', amount: 1, effect: 'Add (1) Growth Counter.' } } }),
    currentLifespan: 2, engaged: false, ...overrides,
  });

  it('offers the ability for free (0 Living) on a pointed Seed with an empty pool', () => {
    const state = baseState({ board: { r1c2: attendant, r2c2: seed() }, players: { A: player({ effigyPool: [] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY' && a.cellId === 'r2c2')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r2c2' });
    expect(next.players.A.effigyPool).toHaveLength(0);
    expect(next.board.r2c2.counters).toEqual({ growth: 1 });
  });

  it('still charges the full cost for a Seed it does not point to', () => {
    const state = baseState({ board: { r1c2: attendant, r1c3: seed() }, players: { A: player({ effigyPool: [] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY' && a.cellId === 'r1c3')).toBe(false);
  });

  it('still charges the full cost for a non-Seed it points to', () => {
    const nonSeed = seed({ card: beingCard({ instanceId: 'ns#0', typing: 'Demon, Being', keywords: { payEffigyCostAbility: { color: 'living', amount: 1, effect: 'Add (1) Growth Counter.' } } }) });
    const state = baseState({ board: { r1c2: attendant, r2c2: nonSeed }, players: { A: player({ effigyPool: [] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY' && a.cellId === 'r2c2')).toBe(false);
  });
});

describe('"Whenever you pay Lifespan gain +1/+1." (Ravenous Lamtukka)', () => {
  const lamtukka = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Ravenous Lamtukka', keywords: { onLifespanPaidGrowth: { strength: 1, lifespan: 1 } } }), currentLifespan: 2, engaged: false };

  it('grows permanently when its controller pays Lifespan for a "pay-lifespan-optional" effect', () => {
    const opened = { kind: 'pay-lifespan-optional', playerId: 'A', cardName: 'Some Card', label: 'Depart', cost: 3, effectText: 'draw (1) card.' };
    const state = baseState({ pendingChoice: opened, board: { r2c1: lamtukka }, players: { A: player({ lifespan: 20, mainDeck: [beingCard({ instanceId: 'draw#0' })] }), B: player() } });
    const next = gameReducer(state, { type: 'RESOLVE_PAY_LIFESPAN_OPTIONAL' });
    expect(next.board.r2c1.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
    expect(next.board.r2c1.currentLifespan).toBe(3);
  });

  it('grows when its controller pays an Engage lifespanCost (NamKaranian Zealot-style)', () => {
    const zealot = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'z#0', keywords: { engage: 'Add (1) Formless Essence.', engageLifespanCost: 2 } }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: lamtukka, r2c2: zealot }, players: { A: player({ lifespan: 20 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c2' });
    expect(next.board.r2c1.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
    expect(next.players.A.lifespan).toBe(18);
  });

  it('does not grow off Engage with no Lifespan cost', () => {
    const zealot = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'z#0', keywords: { engage: 'Add (1) Formless Essence.' } }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: lamtukka, r2c2: zealot }, players: { A: player({ lifespan: 20 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c2' });
    expect(next.board.r2c1.permanentBonus).toBeUndefined();
  });

  it('multiple copies each grow independently', () => {
    const second = { ...lamtukka, card: { ...lamtukka.card, instanceId: 'lam2#0' } };
    const opened = { kind: 'pay-lifespan-optional', playerId: 'A', cardName: 'Some Card', label: 'Depart', cost: 3, effectText: 'draw (1) card.' };
    const state = baseState({ pendingChoice: opened, board: { r2c1: lamtukka, r2c2: second }, players: { A: player({ lifespan: 20, mainDeck: [beingCard({ instanceId: 'draw#0' })] }), B: player() } });
    const next = gameReducer(state, { type: 'RESOLVE_PAY_LIFESPAN_OPTIONAL' });
    expect(next.board.r2c1.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
    expect(next.board.r2c2.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
  });
});

describe('"Engage: Move an Armament in any direction." (Smith Assistant)', () => {
  const smithAssistant = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Smith Assistant', keywords: { engage: 'Move an Armament in any direction.' } }), currentLifespan: 2, engaged: false };
  const rusted = (id = 'rr#0') => equip({ id: 'rr', instanceId: id, name: 'Rusted Rapier', kind: 'relic-armament', keywords: {} });

  it('skips the source choice with only one Armament in play, opening the destination choice directly', () => {
    const withArmament = { ...smithAssistant, armaments: [rusted()] };
    const state = baseState({ board: { r2c1: withArmament }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('move-armament-destination');
    expect(next.pendingChoice.fromCellId).toBe('r2c1');
    expect(next.pendingChoice.armamentInstanceId).toBe('rr#0');
    // From r2c1 (A's front row), the only two legal "any direction" moves
    // are one tile forward (r1c2) or sideways (r2c2) — the Ethereal Realm
    // (row 3) and off-board directions are all illegal.
    expect(next.pendingChoice.allowedCells.sort()).toEqual(['r1c2', 'r2c2']);
  });

  it('actually relocates the Armament once a destination is chosen', () => {
    const withArmament = { ...smithAssistant, armaments: [rusted()] };
    const state = baseState({ board: { r2c1: withArmament }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(opened, { type: 'RESOLVE_MOVE_ARMAMENT_DESTINATION', cellId: 'r2c2' });
    expect(next.board.r2c1.armaments).toEqual([]);
    expect(next.board.r2c2).toEqual({ type: 'armament-stack', ownerId: 'A', armaments: [rusted()] });
    expect(next.pendingChoice).toBeNull();
  });

  it('offers a choice among multiple own Armaments board-wide', () => {
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 5, engaged: false, armaments: [rusted('b#0')] };
    const withArmament = { ...smithAssistant, armaments: [rusted('a#0')] };
    const state = baseState({ board: { r2c1: withArmament, r2c3: ally }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('move-armament-any-source');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_MOVE_ARMAMENT_ANY_SOURCE');
    expect(options.map(o => o.armamentInstanceId).sort()).toEqual(['a#0', 'b#0']);
    const chosen = gameReducer(next, options.find(o => o.armamentInstanceId === 'b#0'));
    expect(chosen.pendingChoice.kind).toBe('move-armament-destination');
    expect(chosen.pendingChoice.fromCellId).toBe('r2c3');
  });

  it('logs an honest "no Armament" instead of crashing when the player controls none', () => {
    const state = baseState({ board: { r2c1: smithAssistant }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes('has no Armament of A\'s to move'))).toBe(true);
  });
});

describe('"Once per turn you may sacrifice a Vine token, summon this from Purgatory on the tile that the sacrificed vine token was on" (Roots of Eternity)', () => {
  const roots = { id: 'roots', instanceId: 'roots#0', name: 'Roots of Eternity', kind: 'being', isToken: false, castingCost: { faithless: 1, colored: {} }, strength: 2, lifespan: 2, timerMax: 0, arrows: [1], keywords: { reanimateOnSacrificedTypedToken: { typing: 'Vine' } } };
  const vineToken = { id: 'vine', instanceId: 'vine#0', name: 'Vine', kind: 'being', isToken: true, typing: 'Being, Vine, Token', castingCost: { faithless: 0, colored: {} }, strength: 0, lifespan: 2, timerMax: 0, arrows: [], keywords: {} };
  const vine = (id = 'vine#0') => ({ type: 'being', ownerId: 'A', card: { ...vineToken, instanceId: id }, currentLifespan: 2, engaged: false });

  it('is offered once a Vine token is on board, sacrificing it and reanimating onto its tile', () => {
    const state = baseState({ board: { r2c2: vine() }, players: { A: player({ purgatory: [roots] }), B: player() } });
    const legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY');
    expect(legal).toEqual([{ type: 'ACTIVATE_REANIMATE_FROM_PURGATORY', purgatoryInstanceId: 'roots#0', sacrificeCellId: 'r2c2' }]);
    const next = gameReducer(state, legal[0]);
    expect(next.board.r2c2.type).toBe('being');
    expect(next.board.r2c2.card.name).toBe('Roots of Eternity');
    expect(next.players.A.purgatory).toHaveLength(0);
  });

  it('is not offered without a Vine token in play', () => {
    const state = baseState({ players: { A: player({ purgatory: [roots] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY')).toBe(false);
  });

  it('offers one legal choice per Vine token when the player controls more than one', () => {
    const state = baseState({ board: { r2c2: vine('vine#0'), r2c3: vine('vine#1') }, players: { A: player({ purgatory: [roots] }), B: player() } });
    const legal = getLegalActions(state, 'A').filter(a => a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY');
    expect(legal.map(a => a.sacrificeCellId).sort()).toEqual(['r2c2', 'r2c3']);
  });

  it('is once per turn per card name, even after re-entering Purgatory the same turn', () => {
    const state = baseState({
      board: { r2c2: vine() },
      players: { A: player({ purgatory: [roots], reanimatedFromPurgatoryThisTurn: ['Roots of Eternity'] }), B: player(),
      },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_REANIMATE_FROM_PURGATORY')).toBe(false);
  });

  it('resets the once-per-turn flag at the start of the controller\'s next turn', () => {
    const state = baseState({
      turnPlayer: 'A', turnNumber: 5,
      players: {
        A: player({ mainDeck: [beingCard({ instanceId: 'd#0' })], reanimatedFromPurgatoryThisTurn: ['Roots of Eternity'] }),
        B: player(),
      },
    });
    const next = beginTurn(state);
    expect(next.players.A.reanimatedFromPurgatoryThisTurn).toEqual([]);
  });
});

describe('"Until the end of turn, target Being has -1/-1 for each Being that died under your control this turn." (Plague doctor)', () => {
  const plagueDoctor = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Plague doctor', keywords: { engage: 'Until the end of turn, target Being has -1/-1 for each Being that died under your control this turn.' } }), currentLifespan: 3, engaged: false };

  it('debuffs the chosen target by the controller\'s own beingsDiedThisTurn count — Strength temporarily, Lifespan as real damage', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: plagueDoctor, r4c1: target }, players: { A: player({ beingsDiedThisTurn: 2 }), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    // Target pool is "any Being on the board", unrestricted by owner —
    // Plague doctor itself is a legal (if pointless) target too, same as
    // SELF_STRENGTH_DEBUFF_TARGET_RE's own precedent, so this is always a
    // choice, never a single-candidate auto-resolve.
    expect(opened.pendingChoice.kind).toBe('debuff-per-own-death-target');
    const next = gameReducer(opened, { type: 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET', cellId: 'r4c1' });
    expect(next.board.r4c1.statBonusUntilEndOfTurn).toEqual({ strength: -2, lifespan: 0 });
    expect(next.board.r4c1.currentLifespan).toBe(3); // 5 - 2 real Lifespan damage
    expect(effectiveStrength(next.board.r4c1)).toBe(3); // 5 - 2
  });

  it('is a harmless no-op debuff when nothing has died yet this turn', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: plagueDoctor, r4c1: target }, players: { A: player(), B: player() } });
    const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    const next = gameReducer(opened, { type: 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET', cellId: 'r4c1' });
    expect(next.board.r4c1.currentLifespan).toBe(5);
    expect(next.board.r4c1.statBonusUntilEndOfTurn).toEqual({ strength: 0, lifespan: 0 });
  });

  it('can target either owner\'s Being (including itself) — opens a choice among more than one', () => {
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0' }), currentLifespan: 4, engaged: false };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e#0' }), currentLifespan: 4, engaged: false };
    const state = baseState({ board: { r2c1: plagueDoctor, r2c2: ally, r4c1: enemy }, players: { A: player({ beingsDiedThisTurn: 1 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('debuff-per-own-death-target');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_DEBUFF_PER_OWN_DEATH_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c1', 'r2c2', 'r4c1']);
  });

  describe('death counting', () => {
    it('counts a combat death (both attacker and defender dying) under each side\'s own controller', () => {
      const attacker = { type: 'being', ownerId: 'A', card: beingCard({ strength: 10, lifespan: 1 }), currentLifespan: 1, engaged: false };
      const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 1 }), currentLifespan: 1, engaged: false };
      const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
      const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      expect(next.players.A.beingsDiedThisTurn).toBe(1);
      expect(next.players.B.beingsDiedThisTurn).toBe(1);
    });

    it('counts a Martyr sacrifice, but not a bare Relic Martyr', () => {
      const martyrBeing = { type: 'being', ownerId: 'A', card: beingCard({ keywords: { martyr: '' } }), currentLifespan: 1, engaged: false };
      const state = baseState({ board: { r2c1: martyrBeing }, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
      expect(next.players.A.beingsDiedThisTurn).toBe(1);

      const martyrRelic = { type: 'relic', ownerId: 'A', card: { id: 'bag', instanceId: 'bag#0', name: "Bag o' Bones", typing: 'Relic, Token', keywords: { martyr: '' } } };
      const relicState = baseState({ board: { r2c1: martyrRelic }, players: { A: player(), B: player() } });
      const relicNext = gameReducer(relicState, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
      expect(relicNext.players.A.beingsDiedThisTurn).toBeFalsy();
    });

    it('counts a destroyBeing-routed forced sacrifice (Venefica: "target opponent sacrifices a Being")', () => {
      const opponentBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ob#0' }), currentLifespan: 2, engaged: false };
      const state = baseState({ board: { r4c1: opponentBeing }, players: { A: player(), B: player() } });
      const next = resolveOrLogEffect(state, 'A', 'Venefica', 'target opponent sacrifices a Being', 'When Summoned', {});
      expect(next.board.r4c1).toBeUndefined();
      expect(next.players.B.beingsDiedThisTurn).toBe(1); // died under ITS OWNER's control, not the caster's
      expect(next.players.A.beingsDiedThisTurn).toBeUndefined();
    });

    it('resets to 0 for BOTH players at the start of every turn', () => {
      const state = baseState({
        turnPlayer: 'A', turnNumber: 5,
        players: {
          A: player({ mainDeck: [beingCard({ instanceId: 'd#0' })], beingsDiedThisTurn: 3 }),
          B: player({ beingsDiedThisTurn: 2 }),
        },
      });
      const next = beginTurn(state);
      expect(next.players.A.beingsDiedThisTurn).toBe(0);
      expect(next.players.B.beingsDiedThisTurn).toBe(0);
    });
  });
});

describe('"Whenever a different Being you control Fights, gain +1/+0 until the end of turn." (Spirit of War)', () => {
  const spiritOfWar = (id = 'sow#0', ownerId = 'A') => ({ type: 'being', ownerId, card: beingCard({ instanceId: id, name: 'Spirit of War', strength: 0, keywords: { onAllyFights: { strength: 1, lifespan: 0 } } }), currentLifespan: 2, engaged: false });

  it('triggers when a different own Being attacks into an open lane', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 3 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r2c2: spiritOfWar() }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c2.statBonusUntilEndOfTurn).toEqual({ strength: 1, lifespan: 0 });
    expect(effectiveStrength(next.board.r2c2)).toBe(1);
  });

  it('triggers in mutual combat too, even when the attacker itself dies', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r2c2: spiritOfWar(), r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1).toBeUndefined(); // the attacker died
    expect(next.board.r2c2.statBonusUntilEndOfTurn).toEqual({ strength: 1, lifespan: 0 });
  });

  it('does not trigger for the opponent\'s own Spirit of War', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 3 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c2: spiritOfWar('sow#0', 'B') }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c2.statBonusUntilEndOfTurn).toBeUndefined();
  });

  it('does not trigger off its own attack', () => {
    const state = baseState({ board: { r2c1: spiritOfWar() }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.statBonusUntilEndOfTurn).toBeUndefined();
  });

  it('multiple copies each trigger independently', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 3 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r2c2: spiritOfWar('sow1#0'), r2c3: spiritOfWar('sow2#0') }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c2.statBonusUntilEndOfTurn).toEqual({ strength: 1, lifespan: 0 });
    expect(next.board.r2c3.statBonusUntilEndOfTurn).toEqual({ strength: 1, lifespan: 0 });
  });

  it('the buff is cleared at end of turn', () => {
    const buffed = { ...spiritOfWar(), statBonusUntilEndOfTurn: { strength: 1, lifespan: 0 } };
    const state = baseState({ turnPlayer: 'A', board: { r2c2: buffed }, players: { A: player(), B: player() } });
    const next = endTurn(state);
    expect(next.board.r2c2.statBonusUntilEndOfTurn).toBeUndefined();
  });
});

describe('"Engage target Being you control: Move it, then move it again." (Acrobatic Escape)', () => {
  const acrobaticEscape = {
    id: 'ae', instanceId: 'ae#0', name: 'Acrobatic Escape', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Engage target Being you control: Move it, then move it again.',
  };

  it('engages the target and moves it twice, choosing a destination each time, landing where the SECOND move goes', () => {
    const mover = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c2: mover }, players: { A: player({ hand: [acrobaticEscape] }), B: player() } });
    let next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ae#0' });
    expect(next.board.r2c2.engaged).toBe(true); // engaged as the cost
    expect(next.pendingChoice.kind).toBe('free-move');
    expect(next.pendingChoice.then).toEqual({ sameActor: true, destinationFilter: 'any' });
    next = gameReducer(next, { type: 'RESOLVE_FREE_MOVE', toCellId: 'r2c3' });
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r2c3.card.instanceId).toBe('m#0');
    // The second move opens automatically from wherever the first one landed — not a fresh "pick a Being" search.
    expect(next.pendingChoice.kind).toBe('free-move');
    expect(next.pendingChoice.fromCellId).toBe('r2c3');
    next = gameReducer(next, { type: 'RESOLVE_FREE_MOVE', toCellId: 'r1c3' });
    expect(next.board.r2c3).toBeUndefined();
    expect(next.board.r1c3.card.instanceId).toBe('m#0');
    expect(next.pendingChoice).toBeNull();
  });

  it('offers a choice among multiple own disengaged Beings to Engage', () => {
    const mover1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm1#0' }), currentLifespan: 3, engaged: false };
    const mover2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm2#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c2: mover1, r2c3: mover2 }, players: { A: player({ hand: [acrobaticEscape] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ae#0' });
    expect(next.pendingChoice.kind).toBe('engage-move-twice');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_ENGAGE_MOVE_TWICE');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c2', 'r2c3']);
  });

  it('logs an honest message when there is no legal Being to Engage', () => {
    const state = baseState({ players: { A: player({ hand: [acrobaticEscape] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ae#0' });
    expect(next.log.some(e => e.message.includes("has no legal Being of A's to Engage"))).toBe(true);
  });

  it('does not crash the "move it again" continuation when the Being\'s own first move already removed it from the board (e.g. "When [it] moves sacrifice it.")', () => {
    // Regression: continueMoveThen's sameActor path re-enters
    // moveOrOfferFreeMove at the Being's post-first-move cell assuming it's
    // still there — but moveBeingFreely (for the first move) already fired
    // triggerOnMoveReaction before returning, and an onMove reaction that
    // itself removes the Being (a self-sacrifice, same shape as "Defective
    // Demon") leaves nothing there for the second move to find. Self-play
    // found this a real, reachable crash reading occupant.card.name off
    // undefined.
    const selfDestructingMover = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', keywords: { onMove: 'sacrifice it.' } }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c2: selfDestructingMover }, players: { A: player({ hand: [acrobaticEscape], lifespan: 30 }), B: player() } });
    let next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ae#0' });
    expect(next.pendingChoice.kind).toBe('free-move');
    expect(() => {
      next = gameReducer(next, { type: 'RESOLVE_FREE_MOVE', toCellId: 'r2c3' });
    }).not.toThrow();
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r2c3).toBeUndefined(); // moved there, then immediately sacrificed by its own onMove
    expect(next.pendingChoice).toBeNull(); // the "then" continuation gracefully found nothing to move again
    expect(next.players.A.purgatory.some(c => c.instanceId === 'm#0')).toBe(true);
  });
});

describe('"Until end of turn target Relic becomes a 1/1 Armament and Being, it can move any direction." (Animate)', () => {
  const animate = {
    id: 'an-1', instanceId: 'an-1#0', name: 'Animate', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Until end of turn target Relic becomes a 1/1 Armament and Being, it can move any direction.',
  };
  const relic = (id = 'relic#0') => ({ type: 'relic', ownerId: 'A', card: { id: 'r', instanceId: id, name: 'Some Relic', typing: 'Relic', keywords: { engage: 'Do something.' } } });

  it('turns the only legal target into a real Animated Armament entry', () => {
    const state = baseState({ board: { r2c1: relic() }, players: { A: player({ hand: [animate] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'an-1#0' });
    expect(next.board.r2c1.type).toBe('armament-stack');
    const entry = next.board.r2c1.armaments[0];
    expect(entry.card.name).toBe('Some Relic');
    expect(entry.card.typing).toBe('Relic, Armament');
    expect(entry.card.strength).toBe(1);
    expect(entry.card.lifespan).toBe(1);
    expect(entry.card.arrows).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(entry.card.keywords.animated).toBe(true);
    expect(entry.card.keywords.engage).toBe('Do something.'); // its own abilities are NOT stripped, unlike Dendrify
  });

  it('can then move in any direction via the existing Animated-Armament movement scan', () => {
    const state = baseState({ board: { r2c1: relic() }, players: { A: player({ hand: [animate] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'an-1#0' });
    const moves = getLegalActions(next, 'A').filter(a => a.type === 'MOVE_OR_ATTACK' && a.fromCellId === 'r2c1' && !a.isAttack);
    expect(moves.length).toBeGreaterThan(1); // more than one direction is open
  });

  it('reverts to a plain Relic at the end of the turn', () => {
    const state = baseState({ turnPlayer: 'A', board: { r2c1: relic() }, players: { A: player({ hand: [animate] }), B: player() } });
    const animated = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'an-1#0' });
    const next = endTurn(animated);
    expect(next.board.r2c1).toEqual(relic());
  });

  it('offers a choice among more than one legal Relic', () => {
    const state = baseState({ board: { r2c1: relic('r1#0'), r2c2: relic('r2#0') }, players: { A: player({ hand: [animate] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'an-1#0' });
    expect(next.pendingChoice.kind).toBe('animate-relic-target');
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_ANIMATE_RELIC_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c1', 'r2c2']);
  });

  it('logs an honest message with no Relic on board', () => {
    const state = baseState({ players: { A: player({ hand: [animate] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'an-1#0' });
    expect(next.log.some(e => e.message.includes('has no Relic to target'))).toBe(true);
  });
});

describe('"Deal (1) damage to each Being and your Lifespan, repeat for each Time Counter on a Prophecy that you control." (Equanimity)', () => {
  const equanimity = {
    id: 'eq-1', instanceId: 'eq-1#0', name: 'Equanimity', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Deal (1) damage to each Being and your Lifespan, repeat for each Time Counter on a Prophecy that you control.\nNo damage is dealt from any Beings that die.',
  };

  it('repeats once per Time Counter across all of the caster\'s own Prophecies, damaging every Being and the caster\'s own Lifespan each time', () => {
    const own = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'o#0', lifespan: 10 }), currentLifespan: 10, engaged: false };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e#0', lifespan: 10 }), currentLifespan: 10, engaged: false };
    const prophecy1 = { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 1, faceDown: true };
    const prophecy2 = { type: 'prophecy', ownerId: 'A', card: { name: 'P2' }, timer: 2, faceDown: true };
    const state = baseState({
      board: { r2c1: own, r4c1: enemy, r3c1: prophecy1, r3c2: prophecy2 },
      players: { A: player({ hand: [equanimity], lifespan: 30 }), B: player({ lifespan: 30 }) },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'eq-1#0' });
    // 1 + 2 = 3 Time Counters total across A's own Prophecies, plus the
    // base trigger that always fires once regardless — 4 total.
    expect(next.board.r2c1.currentLifespan).toBe(6); // 10 - 4, hits the caster's own side too
    expect(next.board.r4c1.currentLifespan).toBe(6); // 10 - 4
    expect(next.players.A.lifespan).toBe(26); // 30 - 4, one per trigger
  });

  it('does not charge the owner death-damage for a Being that dies from this effect, but still fires Depart and counts as a death', () => {
    const fragile = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'f#0', lifespan: 1, keywords: { depart: 'Add (1) Faithless Essence.' } }), currentLifespan: 1, engaged: false };
    const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 1, faceDown: true };
    const state = baseState({
      board: { r4c1: fragile, r3c1: prophecy },
      players: { A: player({ hand: [equanimity], lifespan: 30 }), B: player({ lifespan: 30 }) },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'eq-1#0' });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.B.lifespan).toBe(30); // no death-Lifespan-loss from this effect's own damage
    expect(next.players.B.beingsDiedThisTurn).toBe(1); // still a real death
    expect(next.log.some(e => e.message.includes("Depart triggers"))).toBe(true);
  });

  it('does not re-damage a Being that already died in an earlier iteration', () => {
    const fragile = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'f#0', lifespan: 1 }), currentLifespan: 1, engaged: false };
    const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 3, faceDown: true };
    const state = baseState({
      board: { r4c1: fragile, r3c1: prophecy },
      players: { A: player({ hand: [equanimity], lifespan: 30 }), B: player({ lifespan: 30 }) },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'eq-1#0' });
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.B.beingsDiedThisTurn).toBe(1); // only died once, not 4 times
    expect(next.players.A.lifespan).toBe(26); // still repeats 4 times (3 Time Counters + 1 base) for the caster's own Lifespan
  });

  it('still triggers once (the base trigger) with 0 Time Counters on any Prophecy, not a no-op', () => {
    const own = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'o#0', lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: own }, players: { A: player({ hand: [equanimity], lifespan: 30 }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'eq-1#0' });
    expect(next.board.r2c1.currentLifespan).toBe(9); // 10 - 1, the base trigger still fires
    expect(next.players.A.lifespan).toBe(29); // 30 - 1
    expect(next.log.some(e => e.message.includes('triggers (1/1)'))).toBe(true);
  });

  it('only counts Time Counters on the CASTER\'s own Prophecies, not the opponent\'s — still 1 base trigger either way', () => {
    const own = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'o#0', lifespan: 10 }), currentLifespan: 10, engaged: false };
    const opponentProphecy = { type: 'prophecy', ownerId: 'B', card: { name: 'P1' }, timer: 5, faceDown: true };
    const state = baseState({ board: { r2c1: own, r3c1: opponentProphecy }, players: { A: player({ hand: [equanimity], lifespan: 30 }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'eq-1#0' });
    expect(next.board.r2c1.currentLifespan).toBe(9); // 10 - 1 — no counter from A's own Prophecies, just the base trigger
  });

  it('a repeat cast that kills a Being with an Animated Armament attached hits that Armament, now topmost, on a later iteration', () => {
    const animatedSword = {
      card: { id: 'as', instanceId: 'as#0', name: 'Animated Sword', kind: 'relic-armament', keywords: { animated: true }, strength: 1, lifespan: 3 },
      engaged: false, currentLifespan: 3,
    };
    const fragile = {
      type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'f#0', lifespan: 1 }), currentLifespan: 1, engaged: false,
      armaments: [animatedSword],
    };
    const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P1' }, timer: 2, faceDown: true };
    const state = baseState({
      board: { r4c1: fragile, r3c1: prophecy },
      players: { A: player({ hand: [equanimity], lifespan: 30 }), B: player({ lifespan: 30 }) },
    });
    // 3 total triggers (2 Time Counters + 1 base): iteration 1 kills the
    // Being (1 Lifespan), dropping its Animated Armament to the top of a
    // freestanding pile on the same tile; iterations 2 and 3 then hit that
    // Armament directly (3 printed Lifespan - 2 damage = 1 left).
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'eq-1#0' });
    expect(next.board.r4c1.type).toBe('armament-stack');
    expect(next.board.r4c1.armaments).toHaveLength(1);
    expect(next.board.r4c1.armaments[0].currentLifespan).toBe(1); // 3 - 2 (iterations 2 and 3)
    expect(next.players.B.beingsDiedThisTurn).toBe(1); // the Armament dying isn't counted as a Being death
  });
});

describe('"Pay (5) Lifespan, Engage: you may Summon a Demon, Imp or Null Being directly on this tile, when you do sacrifice Lesser Summoning Circles." (Lesser Summoning Circle)', () => {
  // A real ground Relic (its own printed "Beings may move across this
  // Relic" line — public/default-card-set.csv — RULES.md > Being-Relic
  // co-location), so it lives in state.groundRelics, engaged via
  // ACTIVATE_GROUND_RELIC_ENGAGE, not state.board/ACTIVATE_ENGAGE. Placing
  // this fixture in board with the board-only action type (as this suite
  // used to) would silently never exercise the real cardData.js parsing
  // bug this describe block exists to catch.
  const circle = {
    type: 'relic', ownerId: 'A',
    card: {
      id: 'lsc', instanceId: 'lsc#0', name: 'Lesser Summoning Circle', typing: 'Relic',
      keywords: {
        engage: 'you may Summon a Demon, Imp or Null Being directly on this tile, when you do sacrifice Lesser Summoning Circles.',
        engageLifespanCost: 5, beingsMayMoveAcross: true,
      },
    },
    engaged: false,
  };
  const demon = beingCard({ instanceId: 'd#0', typing: 'Demon, Being' });
  const human = beingCard({ instanceId: 'h#0', typing: 'Human, Being' });

  it('flags the tile with the matching typings after paying its own Lifespan Engage cost', () => {
    const state = baseState({ groundRelics: { r2c1: circle }, players: { A: player({ lifespan: 20 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' });
    expect(next.players.A.lifespan).toBe(15);
    expect(next.groundRelics.r2c1.summonHereTypings).toEqual(['demon', 'imp', 'null']);
    expect(next.groundRelics.r2c1.engaged).toBe(true);
  });

  it('lets a matching Being from hand be legally summoned directly onto the flagged tile, sacrificing the Circle', () => {
    const engaged = gameReducer(
      baseState({ groundRelics: { r2c1: circle }, players: { A: player({ lifespan: 20 }), B: player() } }),
      { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' }
    );
    const state = { ...engaged, players: { ...engaged.players, A: { ...engaged.players.A, hand: [demon], effigyPool: [effigy('faithless')] } } };
    const legal = getLegalActions(state, 'A').filter(a => a.type === 'SUMMON_BEING' && a.cellId === 'r2c1');
    expect(legal).toHaveLength(1);
    const next = gameReducer(state, legal[0]);
    expect(next.board.r2c1.type).toBe('being');
    expect(next.board.r2c1.card.name).toBe(demon.name);
    expect(next.groundRelics.r2c1).toBeUndefined(); // the Circle just vanishes, no Purgatory
    expect(next.players.A.purgatory).toHaveLength(0);
  });

  it('does not offer a non-matching-typed Being from hand', () => {
    const engaged = gameReducer(
      baseState({ groundRelics: { r2c1: circle }, players: { A: player({ lifespan: 20 }), B: player() } }),
      { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r2c1' }
    );
    const state = { ...engaged, players: { ...engaged.players, A: { ...engaged.players.A, hand: [human], effigyPool: [effigy('faithless')] } } };
    const legal = getLegalActions(state, 'A').filter(a => a.type === 'SUMMON_BEING' && a.cellId === 'r2c1');
    expect(legal).toHaveLength(0);
  });

  it('is not offered without its own affordable Lifespan cost', () => {
    const state = baseState({ groundRelics: { r2c1: circle }, players: { A: player({ lifespan: 5 }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE' && a.cellId === 'r2c1')).toBe(false);
  });

  it('real CSV-parsed keywords: Lesser Summoning Circle actually gets both engageLifespanCost and beingsMayMoveAcross, and is placed in groundRelics via PLACE_RELIC', () => {
    const csvRow = {
      'Card Name': 'Lesser Summoning Circle', 'Card Typing': 'Relic', 'Effigy Cost': '2 Formless', 'Conjuring Cost': '2',
      'Text Box': 'Pay (5) Lifespan, Engage: you may Summon a Demon, Imp or Null Being directly on this tile, when you do sacrifice Lesser Summoning Circles.\nBeings may move across this Relic.',
      Strength: '0', Lifespan: '0',
    };
    const card = toGameCard(csvRow, 0);
    expect(card.keywords.engageLifespanCost).toBe(5);
    expect(card.keywords.beingsMayMoveAcross).toBe(true);
    const state = baseState({ players: { A: player({ hand: [card], lifespan: 20, effigyPool: [effigy('formless'), effigy('formless')] }), B: player() } });
    const next = gameReducer(state, { type: 'PLACE_RELIC', instanceId: card.instanceId, cellId: 'r2c1' });
    expect(next.groundRelics.r2c1?.card.name).toBe('Lesser Summoning Circle');
    expect(next.board.r2c1).toBeUndefined();
  });
});

describe('"Until the end of the turn whenever a Being you control loses a Favored Counter a different Being becomes Favored." (Return the Favor)', () => {
  const returnTheFavor = {
    id: 'rtf-1', instanceId: 'rtf-1#0', name: 'Return the Favor', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Until the end of the turn whenever a Being you control loses a Favored Counter a different Being becomes Favored.',
  };

  it('sets the player-scoped flag on cast', () => {
    const state = baseState({ players: { A: player({ hand: [returnTheFavor] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'rtf-1#0' });
    expect(next.players.A.returnTheFavorUntilEndOfTurn).toBe(true);
  });

  it('reacts when a Favored Being of the caster\'s survives combat, granting Favor to a different Being', () => {
    const favoredAttacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false, favorCounter: true };
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 3, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      board: { r2c1: favoredAttacker, r2c2: ally, r4c1: defender },
      players: { A: player({ returnTheFavorUntilEndOfTurn: true }), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.favorCounter).toBe(false); // consumed
    expect(next.board.r2c1.currentLifespan).toBe(1); // fully protected, no damage taken
    expect(next.pendingChoice.kind).toBe('return-the-favor-target'); // a choice between the ally and the defender
    const options = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_RETURN_THE_FAVOR_TARGET');
    expect(options.map(o => o.cellId).sort()).toEqual(['r2c2', 'r4c1']);
    const resolved = gameReducer(next, options.find(o => o.cellId === 'r2c2'));
    expect(resolved.board.r2c2.favorCounter).toBe(true);
    expect(resolved.pendingChoice).toBeNull();
  });

  it('does not react without the flag active', () => {
    const favoredAttacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false, favorCounter: true };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c1: favoredAttacker, r4c1: defender }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r2c1.favorCounter).toBe(false); // still consumed normally
    expect(next.pendingChoice).toBeNull(); // but no reaction fires
  });

  it('only reacts for the flag-owner\'s own Being losing the counter, not the opponent\'s', () => {
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const favoredDefender = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false, favorCounter: true };
    const ally = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ally#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r4c1: attacker, r4c2: ally, r2c1: favoredDefender },
      players: { A: player(), B: player({ returnTheFavorUntilEndOfTurn: true }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(next.board.r2c1.favorCounter).toBe(false);
    // B's own flag is active, but it was A's Being (not B's) that lost the counter — no reaction.
    expect(next.pendingChoice).toBeNull();
  });

  it('resets at the start of the caster\'s next turn', () => {
    const state = baseState({
      turnPlayer: 'A', turnNumber: 5,
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'd#0' })], returnTheFavorUntilEndOfTurn: true }), B: player() },
    });
    const next = endTurn(state);
    expect(next.players.A.returnTheFavorUntilEndOfTurn).toBe(false);
  });
});

describe('"Each Player may move any number of Beings they control (in any direction), any Beings that move lose half their lifespan rounded up." (Diablerie)', () => {
  const diablerie = {
    id: 'db-1', instanceId: 'db-1#0', name: 'Diablerie', kind: 'conjuring',
    castingCost: { faithless: 0, colored: {} },
    textBox: 'Each Player may move any number of Beings they control (in any direction), any Beings that move lose half their lifespan rounded up.',
  };

  it('opens the caster\'s own move-or-done choice first', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: mine }, players: { A: player({ hand: [diablerie] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'db-1#0' });
    expect(next.pendingChoice.kind).toBe('diablerie-select-mover');
    expect(next.pendingChoice.playerId).toBe('A');
    expect(next.pendingChoice.nextPlayerId).toBe('B');
  });

  it('moving a Being deals half its printed Lifespan (rounded up) as real damage, then finishes once nothing is left to move', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c2: mine }, players: { A: player({ hand: [diablerie] }), B: player() } });
    let next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'db-1#0' });
    const selectOptions = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_DIABLERIE_SELECT_MOVER');
    expect(selectOptions.map(o => o.cellId)).toEqual(['r2c2']);
    next = gameReducer(next, selectOptions[0]);
    // Multiple legal destinations from r2c2 — opens a destination choice.
    expect(next.pendingChoice.kind).toBe('diablerie-move-destination');
    const destOptions = getLegalActions(next, 'A').filter(a => a.type === 'RESOLVE_DIABLERIE_MOVE_DESTINATION');
    expect(destOptions.length).toBeGreaterThan(1);
    next = gameReducer(next, destOptions[0]);
    const movedCell = Object.entries(next.board).find(([, o]) => o?.card?.instanceId === 'm#0');
    expect(movedCell[1].currentLifespan).toBe(2); // 5 - ceil(5/2) = 5 - 3
    // No more of A's own Beings left to move (already moved) — hands off to B, who has none either.
    expect(next.pendingChoice).toBeNull();
  });

  it('"Done" ends the caster\'s own side without moving anything, handing off to the opponent', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', lifespan: 5 }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', lifespan: 4 }), currentLifespan: 4, engaged: false };
    const state = baseState({ board: { r2c2: mine, r4c2: theirs }, players: { A: player({ hand: [diablerie] }), B: player() } });
    let next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'db-1#0' });
    next = gameReducer(next, { type: 'RESOLVE_DIABLERIE_DONE' });
    expect(next.board.r2c2.currentLifespan).toBe(5); // untouched
    expect(next.pendingChoice.kind).toBe('diablerie-select-mover');
    expect(next.pendingChoice.playerId).toBe('B'); // now the opponent's own turn at this
  });

  it('a Being can never be moved twice by the same instance of this card', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      pendingChoice: { kind: 'diablerie-select-mover', playerId: 'A', cardName: 'Diablerie', label: 'effect', movedInstanceIds: ['m#0'], nextPlayerId: 'B' },
      board: { r2c2: mine }, players: { A: player(), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'RESOLVE_DIABLERIE_SELECT_MOVER')).toBe(false);
    const next = gameReducer(state, { type: 'RESOLVE_DIABLERIE_SELECT_MOVER', cellId: 'r2c2' });
    expect(next).toBe(state); // rejected, a no-op
  });

  it('finishes with nothing to move on either side', () => {
    const state = baseState({ players: { A: player({ hand: [diablerie] }), B: player() } });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'db-1#0' });
    expect(next.pendingChoice).toBeNull();
  });
});

describe('"Restless Dead has +2/+0 until end of turn for each Being that died under your control this turn." (Restless Dead)', () => {
  const restlessDead = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Restless Dead', strength: 3, lifespan: 4, keywords: { statBonusPerOwnDeathThisTurn: { strength: 2, lifespan: 0 } } }), currentLifespan: 4, engaged: false };

  it('reflects a real death immediately, live — no separate activation needed', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c3: restlessDead, r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.beingsDiedThisTurn).toBe(1); // the attacker died
    expect(effectiveStrength(next.board.r2c3)).toBe(5); // 3 + 2*1
  });

  it('resets to 0 at the start of the controller\'s next turn', () => {
    const state = baseState({
      turnPlayer: 'A', turnNumber: 5,
      board: { r2c1: { ...restlessDead, deathCountBonus: { strength: 4, lifespan: 0 } } },
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'd#0' })], beingsDiedThisTurn: 2 }), B: player() },
    });
    const next = beginTurn(state);
    expect(effectiveStrength(next.board.r2c1)).toBe(3); // back to printed 3, no leftover bonus
  });

  it('a synthetic nonzero Lifespan component heals immediately and does not get clawed back at the next turn reset', () => {
    const healer = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Synthetic Healer', strength: 1, lifespan: 5, keywords: { statBonusPerOwnDeathThisTurn: { strength: 0, lifespan: 1 } } }), currentLifespan: 5, engaged: false };
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c3: healer, r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const afterDeath = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(afterDeath.board.r2c3.currentLifespan).toBe(6); // healed +1 from the one death
    const next = beginTurn({ ...afterDeath, turnPlayer: 'A', turnNumber: afterDeath.turnNumber + 1 });
    expect(next.board.r2c3.currentLifespan).toBe(6); // the heal sticks — not undone by the reset
  });
});

// Dispatching an action type gameReducerCore doesn't recognize is a no-op
// at the core-reducer level (its own `default: return state`) — used below
// purely to drive the gameReducer WRAPPER's own recompute chain
// (recomputeConditionalBonuses among it) against a hand-built board, the
// same entry point production code always goes through, without tying the
// assertion to some unrelated action's own side effects.
const RECOMPUTE_ONLY = { type: '__TEST_RECOMPUTE_ONLY__' };

describe('"Gains +0/+3 if you control a Turanga other than Darmah-Triya." (Darmah-Triya)', () => {
  const darmahTriya = {
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'Darmah-Triya', typing: 'Turanga, Being', strength: 1, lifespan: 2, keywords: { otherSameTypingBonus: { strength: 0, lifespan: 3 } } }),
    currentLifespan: 2, engaged: false,
  };
  const otherTuranga = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'other#0', name: 'Other Turanga', typing: 'Turanga, Being' }), currentLifespan: 3, engaged: false };

  it('is just its printed stats alone with no other Turanga on the board', () => {
    const state = baseState({ board: { r2c1: darmahTriya } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(1);
    expect(next.board.r2c1.currentLifespan).toBe(2);
  });

  it('gains +0/+3 once another Turanga is on the board', () => {
    const state = baseState({ board: { r2c1: darmahTriya, r2c2: otherTuranga } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(1); // Strength half is +0
    expect(next.board.r2c1.currentLifespan).toBe(5); // 2 + 3
  });

  it('loses the bonus (and the Lifespan with it) live, the moment the other Turanga dies in combat', () => {
    const buffed = { ...darmahTriya, currentLifespan: 5, conditionalBonus: { strength: 0, lifespan: 3 } };
    // MOVE_OR_ATTACK computes its own toCellId (computeAttackCell mirrors
    // row2<->row4 in the SAME column) — the attacker at r2c2 lands on r4c2.
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r2c1: buffed, r4c2: otherTuranga, r2c2: attacker },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', toCellId: 'r4c2', isAttack: true });
    expect(next.board.r4c2).toBeUndefined(); // the other Turanga died
    expect(next.board.r2c1.currentLifespan).toBe(2); // the +3 is clawed back — 5 - 3
  });

  it('does not count an opponent\'s own Turanga', () => {
    const opponentTuranga = { ...otherTuranga, ownerId: 'B' };
    const state = baseState({ board: { r2c1: darmahTriya, r4c1: opponentTuranga } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(next.board.r2c1.currentLifespan).toBe(2); // unchanged — the other Turanga is B's, not A's
  });
});

describe('"While you control an Imp, Cat, and a Rat, Menagerie Mistress has +3/+6." (Menagerie Mistress)', () => {
  const menagerie = {
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'Menagerie Mistress', typing: 'Human, Being', strength: 1, lifespan: 3, keywords: { allTypingsBonus: { typings: ['Imp', 'Cat', 'Rat'], strength: 3, lifespan: 6 } } }),
    currentLifespan: 3, engaged: false,
  };
  const imp = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'imp#0', typing: 'Imp, Being' }), currentLifespan: 1, engaged: false };
  const cat = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'cat#0', typing: 'Cat, Being' }), currentLifespan: 1, engaged: false };
  const rat = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'rat#0', typing: 'Rat, Being' }), currentLifespan: 1, engaged: false };

  it('is not buffed with only two of the three typings controlled', () => {
    const state = baseState({ board: { r2c1: menagerie, r2c2: imp, r2c3: cat } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(1);
    expect(next.board.r2c1.currentLifespan).toBe(3);
  });

  it('gains +3/+6 once all three typings are controlled at once', () => {
    const state = baseState({ board: { r2c1: menagerie, r2c2: imp, r2c3: cat, r2c4: rat } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(4); // 1 + 3
    expect(next.board.r2c1.currentLifespan).toBe(9); // 3 + 6
  });

  it('drops the bonus live, the moment one of the three typings is no longer controlled', () => {
    const buffed = { ...menagerie, currentLifespan: 9, conditionalBonus: { strength: 3, lifespan: 6 } };
    // MOVE_OR_ATTACK computes its own toCellId (computeAttackCell mirrors
    // row2<->row4 in the SAME column) — the attacker at r2c4 lands on r4c4.
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'B',
      board: { r2c1: buffed, r2c2: imp, r2c3: cat, r4c4: rat, r2c4: attacker },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c4', toCellId: 'r4c4', isAttack: true });
    expect(next.board.r4c4).toBeUndefined(); // the Rat died
    expect(effectiveStrength(next.board.r2c1)).toBe(1);
    expect(next.board.r2c1.currentLifespan).toBe(3); // the +6 is clawed back
  });
});

describe('"This has +1/+1 for each other Rat you have in play." (Mischief of Rats)', () => {
  const mischief = {
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'Mischief of Rats', typing: 'Rat, Being, Familiar', strength: 2, lifespan: 2, keywords: { perOtherTypingBonus: { typing: 'Rat', strength: 1, lifespan: 1 } } }),
    currentLifespan: 2, engaged: false,
  };
  const otherRat = (n) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: `rat${n}#0`, typing: 'Rat, Being' }), currentLifespan: 1, engaged: false });

  it('is unbuffed alone (it does not count itself)', () => {
    const state = baseState({ board: { r2c1: mischief } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(2);
    expect(next.board.r2c1.currentLifespan).toBe(2);
  });

  it('scales with each OTHER Rat controlled', () => {
    const state = baseState({ board: { r2c1: mischief, r2c2: otherRat(1), r2c3: otherRat(2) } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(4); // 2 + 1*2
    expect(next.board.r2c1.currentLifespan).toBe(4); // 2 + 1*2
  });

  it('does not count an opponent\'s own Rat', () => {
    const state = baseState({ board: { r2c1: mischief, r4c1: { ...otherRat(1), ownerId: 'B' } } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(2);
  });
});

describe('"Has (+1) Lifespan for each Non Armament Relic you control." (Temple Guardian)', () => {
  const templeGuardian = {
    type: 'being', ownerId: 'A',
    card: beingCard({ name: 'Temple Guardian', typing: 'Cat, Being, Familiar', strength: 1, lifespan: 1, keywords: { perNonArmamentRelicLifespan: 1 } }),
    currentLifespan: 1, engaged: false,
  };
  const relic = (n) => ({ type: 'relic', ownerId: 'A', card: { id: `r${n}`, instanceId: `r${n}#0`, name: `Relic ${n}`, kind: 'relic' } });

  it('gains +1 Lifespan (no Strength change) per Relic controlled', () => {
    const state = baseState({ board: { r2c1: templeGuardian, r2c2: relic(1), r2c3: relic(2) } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(1); // Strength untouched
    expect(next.board.r2c1.currentLifespan).toBe(3); // 1 + 1*2
  });

  it('loses the Lifespan bonus, fatally, when its only Relic is already gone and it was carrying damage under the bonus', () => {
    // 1 printed + 1 bonus = 2 max, already at 1 (took 1 damage while buffed) — losing the
    // bonus (no Relic left) drops it the rest of the way to 0.
    const state = baseState({
      board: { r2c1: { ...templeGuardian, currentLifespan: 1, conditionalBonus: { strength: 0, lifespan: 1 } } },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.name === 'Temple Guardian')).toBe(true);
  });
});

describe('"Martyr: Modulate (+1), then repeat for each Time Counter on this." (Time Capsule)', () => {
  const timeCapsule = (timeCounters = 1) => ({
    type: 'relic', ownerId: 'A',
    card: { id: 'tc', instanceId: 'tc#0', name: 'Time Capsule', keywords: { martyr: 'Modulate (+1), then repeat for each Time Counter on this.' } },
    engaged: false, counters: { time: timeCounters },
  });
  const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'Some Prophecy' }, timer: 5, faceDown: true };

  it('repeats once per Time Counter on itself, on top of the base Modulate, then stops', () => {
    const state = baseState({ board: { r2c1: timeCapsule(1), r3c1: prophecy }, players: { A: player(), B: player() } });
    let next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.pendingChoice.kind).toBe('modulate');
    expect(next.pendingChoice.repeatsRemaining).toBe(1); // 1 Time Counter on the sacrificed Capsule
    next = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(next.board.r3c1.timer).toBe(6);
    expect(next.pendingChoice.kind).toBe('modulate'); // the repeat opened a second choice
    expect(next.pendingChoice.repeatsRemaining).toBe(0);
    next = gameReducer(next, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(next.board.r3c1.timer).toBe(7);
    expect(next.pendingChoice).toBeNull(); // done — 1 base + 1 repeat = 2 total
  });

  it('reads the repeat count off the sacrificed Capsule\'s own Counters, captured before it leaves the board', () => {
    const state = baseState({ board: { r2c1: timeCapsule(3), r3c1: prophecy }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.board.r2c1).toBeUndefined(); // the Capsule is already gone
    expect(next.pendingChoice.repeatsRemaining).toBe(3);
  });

  it('stops early with an honest log if there is no Time Counter to Modulate at all', () => {
    const state = baseState({ board: { r2c1: timeCapsule(2) }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.log.some(e => e.message.includes("has no Time Counter of A's to Modulate"))).toBe(true);
    expect(next.pendingChoice).toBeNull();
  });
});

describe('"When Defective Demon moves sacrifice it." (Defective Demon)', () => {
  it('sacrifices itself the moment it moves, no owner Lifespan loss (a real sacrifice, not a death)', () => {
    const defectiveDemon = { type: 'being', ownerId: 'A', card: beingCard({ name: 'Defective Demon', arrows: [7], keywords: { onMove: 'sacrifice it.' } }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c2: defectiveDemon }, players: { A: player({ lifespan: 30 }), B: player() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', toCellId: 'r2c1', direction: 7, isAttack: false });
    expect(next.board.r2c1).toBeUndefined(); // moved there, then immediately sacrificed
    expect(next.board.r2c2).toBeUndefined();
    expect(next.players.A.lifespan).toBe(30); // sacrifice, not death — no Lifespan loss
    expect(next.players.A.purgatory.some(c => c.name === 'Defective Demon')).toBe(true);
  });
});

describe('"When Onoushara is summoned all Beings lose -1/-1. Onoushara gains +1/+1 for each Being affected." + "Whenever a Being you control dies, Onoushara gains +1/+1." (Onoushara)', () => {
  const onoushara = beingCard({
    id: 'ono', instanceId: 'ono#0', name: 'Onoushara', kind: 'deity', isDeity: true, strength: 2, lifespan: 5,
    castingCost: { faithless: 0, colored: {} },
    keywords: {
      whenSummoned: 'all Beings lose -1/-1. this gains +1/+1 for each Being affected.',
      onOwnBeingDiedGrowth: { strength: 1, lifespan: 1 },
    },
  });

  it('debuffs every Being on board (including itself) by -1/-1, then grows by however many were affected', () => {
    const ally = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0', strength: 2, lifespan: 3 }), currentLifespan: 3, engaged: false };
    const enemy = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'e#0', strength: 2, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const state = baseState({
      board: { r2c2: ally, r4c1: enemy },
      players: { A: player({ hand: [onoushara], effigyPool: [] }), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'ono#0', cellId: 'r1c2' });
    expect(next.board.r2c2.currentLifespan).toBe(2); // ally: 3 - 1
    expect(effectiveStrength(next.board.r2c2)).toBe(1); // ally: 2 - 1
    expect(next.board.r4c1).toBeUndefined(); // enemy had only 1 Lifespan — the -1 killed it
    expect(next.players.B.purgatory).toHaveLength(1);
    // Onoushara itself: -1/-1 first (2/5 -> 1/4), then +3/+3 for 3 Beings affected (ally, enemy, itself).
    expect(effectiveStrength(next.board.r1c2)).toBe(4);
    expect(next.board.r1c2.currentLifespan).toBe(7);
  });

  it('gains +1/+1 permanently whenever another of its controller\'s Beings dies', () => {
    const onoushara2 = { type: 'being', ownerId: 'A', card: onoushara, currentLifespan: 5, engaged: false };
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const state = baseState({ board: { r2c3: onoushara2, r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.players.A.beingsDiedThisTurn).toBe(1);
    expect(effectiveStrength(next.board.r2c3)).toBe(3); // printed 2 + 1
    expect(next.board.r2c3.currentLifespan).toBe(6); // 5 + 1 healed
  });

  it('does not react to an opponent\'s own Being dying', () => {
    const onoushara2 = { type: 'being', ownerId: 'A', card: onoushara, currentLifespan: 5, engaged: false };
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c3: onoushara2, r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1).toBeUndefined(); // B's own Being died, not A's
    expect(effectiveStrength(next.board.r2c3)).toBe(2); // unchanged — Onoushara only reacts to ITS OWN controller's Beings
  });
});

describe('Re-audit round: gaps closed after the Deja Vu / Immen Gorta pass', () => {
  it('Imneyat Dryad — "When Imneyat Druid moves" (CSV typo for Dryad) still fires the own-name move trigger', () => {
    const card = beingCard({ name: 'Imneyat Dryad', arrows: [3], keywords: { onMove: 'create a vine token on the tile it moved from.' } });
    const state = baseState({
      board: { r2c2: { type: 'being', ownerId: 'A', card, currentLifespan: 5, engaged: false } },
      players: { A: player(), B: player() },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', direction: 3 });
    expect(next.board.r2c2.type).toBe('being'); // the Vine token landed on the vacated origin tile
    expect(next.board.r2c2.card.name).toBe('Vine');
    // Its real printed row (public/default-card-set.csv row 452) prints
    // Arrows "1" — TOKEN_REGISTRY's createTokenCard() calls used to have no
    // way to pass arrows through at all, so every Being token came out
    // immobile regardless of what its real card prints (the "Rat tokens
    // can't move" report). Confirms the fix actually reaches a token
    // created through a real in-game reaction, not just the registry entry.
    expect(next.board.r2c2.card.arrows).toEqual([1]);
  });

  it('Samara Seed — a cost prefix before "Martyr:" on the same line (parser fix) is now offered and spends the Counters', () => {
    const card = beingCard({ keywords: { martyr: 'Invoke a TreeFolk with cost (4) or less on a tile this points to.', martyrCounterCost: { type: 'growth', amount: 4 } } });
    const state = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card, currentLifespan: 5, engaged: false, counters: { growth: 4 } } },
      players: { A: player(), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_MARTYR' && a.cellId === 'r2c1')).toBe(true);
    const short = { ...state, board: { r2c1: { ...state.board.r2c1, counters: { growth: 3 } } } };
    expect(getLegalActions(short, 'A').some(a => a.type === 'ACTIVATE_MARTYR')).toBe(false);
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.players.A.purgatory).toHaveLength(1); // it really sacrificed itself
  });

  it('Melting Clock — "Pay (1) Timeless Essence, Martyr: X" charges the Essence cost instead of resolving for free', () => {
    const card = beingCard({ keywords: { martyr: 'Add a Being to hand from your Purgatory.', martyrEffigyCost: { color: 'timeless', amount: 1 } } });
    const noEssence = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card, currentLifespan: 5, engaged: false } },
      players: { A: player({ effigyPool: [] }), B: player() },
    });
    expect(getLegalActions(noEssence, 'A').some(a => a.type === 'ACTIVATE_MARTYR')).toBe(false);
    const funded = { ...noEssence, players: { ...noEssence.players, A: player({ effigyPool: [effigy('timeless')] }) } };
    const next = gameReducer(funded, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('Canopic Jar — "Whenever a Being dies add (N) Counter to this" (reversed word order) is now recognized', () => {
    const jar = { id: 'jar-1', instanceId: 'jar-1#0', name: 'Canopic Jar', kind: 'relic', castingCost: { faithless: 0, colored: {} },
      keywords: { gainCounterOnAnyBeingDeath: { type: 'crossing', amount: 1 } } };
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const dying = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'd#0', lifespan: 1 }), currentLifespan: 1, engaged: false };
    const state = baseState({
      board: { r1c1: { type: 'relic', ownerId: 'B', card: jar }, r2c1: attacker, r4c1: dying },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r1c1.counters?.crossing).toBe(1);
  });

  it('Saan tachīan Hunger — bare "Gain +N/+N" permanently buffs the caster, stacking across activations', () => {
    const state = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card: beingCard(), currentLifespan: 5, engaged: false } },
      players: { A: player(), B: player() },
    });
    const once = resolveOrLogEffect(state, 'A', 'Saan tachīan Hunger', 'Gain +1/+1.', 'ability', { selfCellId: 'r2c1' });
    expect(effectiveStrength(once.board.r2c1)).toBe(4); // printed 3 + 1
    expect(once.board.r2c1.currentLifespan).toBe(6);
    const twice = resolveOrLogEffect(once, 'A', 'Saan tachīan Hunger', 'Gain +1/+1.', 'ability', { selfCellId: 'r2c1' });
    expect(effectiveStrength(twice.board.r2c1)).toBe(5);
  });

  it('Onagīous Hunger — bare "Discard a Hunger" (no attached draw) discards a matching card, distinct from DISCARD_KIND_DRAW', () => {
    const hunger = beingCard({ instanceId: 'h#0', name: 'Some Hunger', typing: 'Hunger, Being' });
    const state = baseState({ players: { A: player({ hand: [hunger] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Onagīous Hunger', 'Discard a Hunger.', 'Engage ability', {});
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.purgatory).toEqual([hunger]);
  });

  describe('Onagīous Hunger — "Discard a Hunger, then draw (1) card." (real CSV text)', () => {
    const EFFECT_TEXT = 'Discard a Hunger, then draw (1) card.';
    const nonHunger = beingCard({ instanceId: 'n#0', name: 'Not A Hunger', typing: 'Spirit, Being' });

    it('with no matching Hunger in hand, logs a fizzle and draws nothing', () => {
      const state = baseState({ players: { A: player({ hand: [nonHunger] }), B: player() } });
      const next = resolveOrLogEffect(state, 'A', 'Onagīous Hunger', EFFECT_TEXT, 'Engage ability', {});
      expect(next.players.A.hand).toEqual([nonHunger]);
      expect(next.players.A.mainDeck).toEqual(state.players.A.mainDeck);
    });

    it('with exactly one matching Hunger, discards it and draws immediately, in order', () => {
      const hunger = beingCard({ instanceId: 'h#0', name: 'Some Hunger', typing: 'Hunger, Being' });
      const topOfDeck = beingCard({ instanceId: 'd#0', name: 'Top Card' });
      const state = baseState({
        players: { A: player({ hand: [hunger], mainDeck: [topOfDeck] }), B: player() },
      });
      const next = resolveOrLogEffect(state, 'A', 'Onagīous Hunger', EFFECT_TEXT, 'Engage ability', {});
      expect(next.players.A.hand).toEqual([topOfDeck]);
      expect(next.players.A.purgatory).toEqual([hunger]);
      expect(next.players.A.mainDeck).toHaveLength(0);
    });

    it('with two+ matching Hungers, opens a choice and defers the draw until AFTER it resolves — the actual bug', () => {
      const hungerOne = beingCard({ instanceId: 'h1#0', name: 'First Hunger', typing: 'Hunger, Being' });
      const hungerTwo = beingCard({ instanceId: 'h2#0', name: 'Second Hunger', typing: 'Hunger, Being' });
      const topOfDeck = beingCard({ instanceId: 'd#0', name: 'Top Card' });
      const state = baseState({
        players: { A: player({ hand: [hungerOne, hungerTwo], mainDeck: [topOfDeck] }), B: player() },
      });
      const opened = resolveOrLogEffect(state, 'A', 'Onagīous Hunger', EFFECT_TEXT, 'Engage ability', {});
      // The choice is open — nothing has been discarded or drawn yet.
      expect(opened.pendingChoice).toMatchObject({ kind: 'discard-typed', typing: 'Hunger', drawCount: 1 });
      expect(opened.players.A.hand).toEqual([hungerOne, hungerTwo]);
      expect(opened.players.A.mainDeck).toEqual([topOfDeck]);

      const resolved = gameReducer(opened, { type: 'RESOLVE_DISCARD_TYPED', instanceId: hungerOne.instanceId });
      expect(resolved.pendingChoice).toBeNull();
      expect(resolved.players.A.purgatory).toEqual([hungerOne]);
      // The just-drawn card is never itself a discard candidate, and the
      // un-discarded Hunger stays in hand exactly as the player left it.
      expect(resolved.players.A.hand).toEqual([hungerTwo, topOfDeck]);
    });
  });

  it('Pangs of Hunger — "Deal (N) damage to all Beings" hits every Being on the board, either side', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'a#0', lifespan: 5 }), currentLifespan: 5, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'b#0', lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: mine, r4c1: theirs }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = resolveOrLogEffect(state, 'A', 'Pangs of Hunger', 'Deal (2) damage to all Beings.', 'Prophecy', {});
    expect(next.board.r2c1.currentLifespan).toBe(3);
    expect(next.board.r4c1.currentLifespan).toBe(3);
  });

  it('Cycle of Hunger — "Shuffle (2) Hungers into your deck from your Purgatory, then draw (1) card" resolves both independent clauses', () => {
    const hunger1 = beingCard({ instanceId: 'h1#0', name: 'Hunger One', typing: 'Hunger, Being' });
    const state = baseState({ players: { A: player({ purgatory: [hunger1], mainDeck: [beingCard({ instanceId: 'dk#0' })] }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', 'Cycle of Hunger', 'Shuffle (2) Hungers into your deck from your Purgatory, then draw (1) card.', 'effect', {});
    expect(opened.pendingChoice.kind).toBe('shuffle-purgatory-toggle'); // still open — a real player choice
    expect(opened.players.A.hand).toHaveLength(1); // the "then"-split's second clause already drew, independent of the choice
    const toggled = gameReducer(opened, { type: 'RESOLVE_SHUFFLE_PURGATORY_TOGGLE', instanceId: 'h1#0' });
    const next = gameReducer(toggled, { type: 'RESOLVE_SHUFFLE_PURGATORY_CONFIRM' });
    expect(next.players.A.mainDeck.some(c => c.instanceId === 'h1#0')).toBe(true);
  });

  it('Cursed Commission — "on a tile this points to" (singular) now matches the same as "any tile"', () => {
    const pointedCell = computeMoveDestination('A', 'r3c1', 1);
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { id: 'cc', instanceId: 'cc#0', name: 'Cursed Commission', kind: 'prophecy', castingCost: { faithless: 0, colored: {} }, timerMax: 0, arrows: [1], textBox: 'Summon a Cursed Cutlass token on a tile this points to.', keywords: {} }, timer: 0, faceDown: true } },
      players: { A: player(), B: player() },
    });
    const next = resolveProphecyModulateHitZero(state, 'r3c1');
    expect(next.board[pointedCell]?.armaments?.[0]?.card?.name).toBe('Cursed Cutlass'); // an Armament token lands as a freestanding stack
  });

  it('Smite — "Destroy Being this points to" (own name substituted) destroys without owner Lifespan loss', () => {
    const pointedCell = computeMoveDestination('A', 'r3c1', 1);
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', lifespan: 4 }), currentLifespan: 4, engaged: false };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { id: 'sm', instanceId: 'sm#0', name: 'Smite', kind: 'prophecy', castingCost: { faithless: 0, colored: {} }, timerMax: 0, arrows: [1], textBox: 'Destroy Being Smite points to (Opponent does not take lifespan damage from it dying).', keywords: {} }, timer: 0, faceDown: true }, [pointedCell]: target },
      players: { A: player(), B: player({ lifespan: 50 }) },
    });
    const next = resolveProphecyModulateHitZero(state, 'r3c1');
    expect(next.board[pointedCell]).toBeUndefined();
    expect(next.players.B.lifespan).toBe(50); // no death damage — matches the printed parenthetical
  });

  it('Locust swarm — "Depart: Locust Swarm Shifts (3)" pulls the just-departed card back out of Purgatory and Shifts it', () => {
    const card = beingCard({ name: 'Locust swarm', strength: 1, lifespan: 1, keywords: { depart: 'Locust Swarm Shifts (3).' } });
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card, currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const afterCombat = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(afterCombat.pendingChoice.kind).toBe('shift-from-purgatory-destination'); // 5 empty Ethereal tiles — a real choice
    expect(afterCombat.players.B.purgatory).toHaveLength(0); // pulled back out, not left there
    const destCell = afterCombat.pendingChoice.allowedCells[0];
    const next = gameReducer(afterCombat, { type: 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION', cellId: destCell });
    const shiftedEntry = next.board[destCell];
    expect(shiftedEntry?.type).toBe('prophecy');
    expect(shiftedEntry?.shiftedFromCard?.name).toBe('Locust swarm');
    expect(shiftedEntry?.timer).toBe(3);
  });

  // Regression: the real CSV row's own "Card Name" is "Locust swarm " with
  // a trailing space (confirmed via public/default-card-set.csv) — unlike
  // the test above, which uses a hand-built, already-clean 'Locust swarm'
  // fixture and so never exercised this. Before toGameCard trimmed the
  // name (cardData.js), that trailing space survived into `.name` and got
  // consumed by selfReferentialWhenSummonedText's own substitution
  // ("Locust Swarm Shifts (3)." -> "thisShifts (3)." — note the missing
  // space), which no longer matched SELF_SHIFT_RE — the Depart fired and
  // logged, but the Shift itself silently never happened at all.
  it('Locust swarm — still Shifts correctly when parsed from a real, untrimmed CSV row (own name has a trailing space)', () => {
    const card = toGameCard({
      'Card Name': 'Locust swarm ', 'Card Typing': 'Insect, Being', 'Effigy Costs': '1 Faithless, 2 Shifting',
      'Casting Cost': '3', 'Text Box': 'Depart: Locust Swarm Shifts (3).', 'Strength': '2', 'Lifespan': '1',
      'Arrows (Clockwise top center = 1)': '1',
    }, 0);
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card, currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const afterCombat = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(afterCombat.log.at(-1).message).not.toMatch(/isn't automated yet/);
    expect(afterCombat.pendingChoice?.kind).toBe('shift-from-purgatory-destination');
    const destCell = afterCombat.pendingChoice.allowedCells[0];
    const next = gameReducer(afterCombat, { type: 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION', cellId: destCell });
    const shiftedEntry = next.board[destCell];
    expect(shiftedEntry?.type).toBe('prophecy');
    expect(shiftedEntry?.timer).toBe(3);
    expect(shiftedEntry?.shiftedFromCard?.name).toBe('Locust swarm');
  });

  it('Cutlass — "When the attached Being dies sacrifice this and summon a Cursed Cutlass token on this tile" fires from real combat death', () => {
    const cutlass = { id: 'cut', instanceId: 'cut#0', name: 'Cutlass', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} },
      keywords: { onAttachedBeingDied: 'summon a Cursed Cutlass token on this tile.' } };
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const wearer = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'w#0', lifespan: 1 }), currentLifespan: 1, engaged: false, armaments: [{ card: cutlass, engaged: false }] };
    const state = baseState({ board: { r2c1: attacker, r4c1: wearer }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c1?.armaments?.[0]?.card?.name).toBe('Cursed Cutlass');
  });

  it('Void Channeler — "Gain (1) Crossing Counter each time you Conjure" fires from CAST_CONJURING', () => {
    const channeler = beingCard({ instanceId: 'vc#0', name: 'Void Channeler', keywords: { onConjure: { type: 'crossing', amount: 1 } } });
    const conjuring = { id: 'cj-1', instanceId: 'cj-1#0', name: 'Test Conjuring', kind: 'conjuring', castingCost: { faithless: 0, colored: {} }, textBox: '' };
    const state = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card: channeler, currentLifespan: 3, engaged: false } },
      players: { A: player({ hand: [conjuring] }), B: player() },
    });
    const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'cj-1#0' });
    expect(next.board.r2c1.counters?.crossing).toBe(1);
  });

  it('For the Greater Good — discarding a Turanga grants the bonus draw, a non-Turanga does not', () => {
    const turanga = beingCard({ instanceId: 'tu#0', name: 'A Turanga', typing: 'Turanga, Being' });
    const state = baseState({ players: { A: player({ hand: [turanga], mainDeck: [beingCard({ instanceId: 'dk1#0' }), beingCard({ instanceId: 'dk2#0' })] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'For the Greater Good', 'Discard a Being: Draw one card. If you discarded a Turanga draw one additional card.', 'effect', {});
    expect(next.players.A.hand).toHaveLength(2); // 1 base + 1 bonus
  });

  it('Erroneous Evocation — the deck search and the forced opponent token summon both resolve, neither swallowing the other', () => {
    const demon = beingCard({ instanceId: 'dm#0', name: 'A Demon', typing: 'Demon, Being' });
    const state = baseState({ players: { A: player({ mainDeck: [demon] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Erroneous Evocation', 'Add a Demon Being from deck to hand, your opponent summons (1) Vassal token on any tile they control.', 'effect', {});
    expect(next.pendingChoice.kind).toBe('search'); // the deck search still opens its own choice
    const vassalCell = Object.entries(next.board).find(([, o]) => o?.card?.name === 'Vassal');
    expect(vassalCell?.[1]?.ownerId).toBe('B'); // forced onto the OPPONENT's board
  });

  it('Book of Mahatzu — "Discard a Spirit, add a Turanga to hand from your Purgatory" enforces the discard as a real cost', () => {
    const noSpirit = baseState({ players: { A: player({ hand: [] }), B: player() } });
    const blocked = resolveOrLogEffect(noSpirit, 'A', 'Book of Mahatzu', 'Discard a Spirit, add a Turanga to hand from your Purgatory.', 'Engage ability', {});
    expect(blocked.pendingChoice).toBeNull();
    const spirit = beingCard({ instanceId: 'sp#0', name: 'A Spirit', typing: 'Spirit, Being' });
    const turanga = beingCard({ instanceId: 'tg#0', name: 'A Turanga', typing: 'Turanga, Being' });
    const funded = baseState({ players: { A: player({ hand: [spirit], purgatory: [turanga] }), B: player() } });
    const next = resolveOrLogEffect(funded, 'A', 'Book of Mahatzu', 'Discard a Spirit, add a Turanga to hand from your Purgatory.', 'Engage ability', {});
    expect(next.players.A.hand).toHaveLength(0); // Spirit discarded
    expect(next.players.A.purgatory.some(c => c.instanceId === 'sp#0')).toBe(true);
    expect(next.pendingChoice.kind).toBe('search'); // then the Purgatory search opens
  });

  it('Skeptical Scrawling — "Discard (1) Card, then return a Null Being From Purgatory to hand" resolves both halves', () => {
    const nullBeing = beingCard({ instanceId: 'nb#0', name: 'A Null Being', typing: 'Null, Being' });
    const otherHandCard = beingCard({ instanceId: 'oh#0', name: 'Other Card' });
    const state = baseState({ players: { A: player({ hand: [otherHandCard], purgatory: [nullBeing] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Skeptical Scrawling', 'Discard (1) Card, then return a Null Being From Purgatory to hand.', 'Prophecy', {});
    expect(next.players.A.hand).toHaveLength(0); // the only hand card was discarded (auto, no choice needed)
    expect(next.pendingChoice.kind).toBe('search'); // then the Purgatory return opens
  });

  it('Skeptical Scrawling — enforces the discard as a real cost, an empty hand blocks the Purgatory return entirely', () => {
    const nullBeing = beingCard({ instanceId: 'nb#0', name: 'A Null Being', typing: 'Null, Being' });
    const noHand = baseState({ players: { A: player({ hand: [], purgatory: [nullBeing] }), B: player() } });
    const blocked = resolveOrLogEffect(noHand, 'A', 'Skeptical Scrawling', 'Discard (1) Card, then return a Null Being From Purgatory to hand.', 'Prophecy', {});
    expect(blocked.pendingChoice).toBeNull();
    expect(blocked.players.A.purgatory.some(c => c.instanceId === 'nb#0')).toBe(true); // still in Purgatory, never returned
  });

  it('Skeptical Scrawling — 2+ hand cards opens a discard picker, and the Purgatory return only fires once that choice resolves', () => {
    const nullBeing = beingCard({ instanceId: 'nb#0', name: 'A Null Being', typing: 'Null, Being' });
    const cardA = beingCard({ instanceId: 'ca#0', name: 'Card A' });
    const cardB = beingCard({ instanceId: 'cb#0', name: 'Card B' });
    const state = baseState({ players: { A: player({ hand: [cardA, cardB], purgatory: [nullBeing] }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', 'Skeptical Scrawling', 'Discard (1) Card, then return a Null Being From Purgatory to hand.', 'Prophecy', {});
    expect(opened.pendingChoice).toEqual(expect.objectContaining({ kind: 'discard-one-card', thenReturnPurgatoryQuery: 'Null' }));
    expect(opened.players.A.hand).toHaveLength(2); // nothing discarded yet
    const resolved = gameReducer(opened, { type: 'RESOLVE_DISCARD_ONE_CARD', instanceId: 'ca#0' });
    expect(resolved.players.A.hand).toEqual([cardB]); // only Card A discarded
    expect(resolved.pendingChoice.kind).toBe('search'); // then the Purgatory return opens
  });

  it('Seasons of Regrowth — discards the whole hand, then draws that many back', () => {
    const state = baseState({
      players: {
        A: player({ hand: [beingCard({ instanceId: 'h1#0' }), beingCard({ instanceId: 'h2#0' })], mainDeck: [beingCard({ instanceId: 'd1#0' }), beingCard({ instanceId: 'd2#0' })] }),
        B: player(),
      },
    });
    const next = resolveOrLogEffect(state, 'A', 'Seasons of Regrowth', 'Discard your hand then draw cards equal to the number of cards that you discarded.', 'Prophecy', {});
    expect(next.players.A.purgatory).toHaveLength(2);
    expect(next.players.A.hand).toHaveLength(2);
  });

  it('Rejuvinating Waters — "Gain (2) Lifespan for each TreeFolk, Vine, and Seed you control" scales with the matching count, not a flat amount', () => {
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', typing: 'TreeFolk, Being' }), currentLifespan: 3, engaged: false };
    const vine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'vn#0', typing: 'Vine, Being' }), currentLifespan: 3, engaged: false };
    const unrelated = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'un#0', typing: 'Demon, Being' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: treefolk, r2c2: vine, r2c3: unrelated }, players: { A: player({ lifespan: 40 }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Rejuvinating Waters', 'Gain (2) Lifespan for each TreeFolk, Vine, and Seed you control.', 'Prophecy', {});
    expect(next.players.A.lifespan).toBe(44); // 2 x 2 matching Beings, not 2 flat
  });

  it('Festival of Monatssa — "Draw (1) Card for each Being you control with Dryad" scales with the Dryad count', () => {
    const dryad1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dr1#0', keywords: { dryad: true } }), currentLifespan: 3, engaged: false };
    const dryad2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'dr2#0', keywords: { dryad: true } }), currentLifespan: 3, engaged: false };
    const nonDryad = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'nd#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: dryad1, r2c2: dryad2, r2c3: nonDryad }, players: { A: player({ mainDeck: [beingCard({ instanceId: 'd1#0' }), beingCard({ instanceId: 'd2#0' }), beingCard({ instanceId: 'd3#0' })] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Festival of Monatssa', 'Draw (1) Card for each Being you control with Dryad.', 'Prophecy', {});
    expect(next.players.A.hand).toHaveLength(2);
  });
});

describe('Clarified cards, second wave', () => {
  it('Boknea Druid — "may be summoned directly onto another TreeFolk, Vine, or Seed" attaches (Dryad) instead of needing an empty tile', () => {
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', typing: 'TreeFolk, Being', strength: 2, lifespan: 4 }), currentLifespan: 3, engaged: false };
    const boknea = beingCard({ instanceId: 'bk#0', name: 'Boknea Druid', keywords: { dryad: true }, castingCost: { faithless: 1, colored: {} } });
    const state = baseState({ board: { r2c1: treefolk }, players: { A: player({ hand: [boknea], effigyPool: [effigy('bleeding')] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'SUMMON_BEING' && a.cellId === 'r2c1')).toBe(true);
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'bk#0', cellId: 'r2c1' });
    expect(next.board.r2c1.card.name).toBe('Boknea Druid');
    expect(next.board.r2c1.dryadAttached.card.name).toBe('Test Being'); // the TreeFolk is now the mount
    expect(effectiveStrength(next.board.r2c1)).toBe(3 + 2); // own printed 3 + mount's Strength, live
  });

  it('Vaneach Hunger — paying the extra Formless summons it directly into the Ethereal Realm as a Prophecy with 1 Time Counter', () => {
    const card = beingCard({
      instanceId: 'vh#0', name: 'Vaneach Hunger', castingCost: { faithless: 0, colored: { formless: 2 } },
      keywords: { alternateSummonAsProphecy: { color: 'formless', extraAmount: 1, timeCounters: 1 } },
    });
    const state = baseState({ players: { A: player({ hand: [card], effigyPool: [effigy('formless', 1), effigy('formless', 2), effigy('formless', 3)] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'SUMMON_AS_PROPHECY')).toBe(true);
    const opened = gameReducer(state, { type: 'SUMMON_AS_PROPHECY', instanceId: 'vh#0' });
    expect(opened.players.A.effigyPool).toHaveLength(0); // 2 base + 1 extra Formless spent
    expect(opened.pendingChoice.kind).toBe('shift-from-purgatory-destination'); // 5 empty Ethereal tiles — a real choice
    const destCell = opened.pendingChoice.allowedCells[0];
    const next = gameReducer(opened, { type: 'RESOLVE_SHIFT_FROM_PURGATORY_DESTINATION', cellId: destCell });
    const placed = next.board[destCell];
    expect(placed?.type).toBe('prophecy');
    expect(placed?.shiftedFromCard?.name).toBe('Vaneach Hunger');
    expect(placed?.timer).toBe(1);
    expect(placed?.faceDown).toBe(false);
  });

  it('Vicious Vittles — sacrifices itself and the next Hunger summoned this turn lands directly on its own tile', () => {
    const vittles = beingCard({ instanceId: 'vv#0', name: 'Vicious Vittles' });
    const hunger = beingCard({ instanceId: 'hg#0', name: 'Some Hunger', typing: 'Hunger, Being', castingCost: { faithless: 1, colored: {} } });
    const state = baseState({
      board: { r2c1: { type: 'being', ownerId: 'A', card: vittles, currentLifespan: 2, engaged: false } },
      players: { A: player({ hand: [hunger], lifespan: 50, effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const opened = resolveOrLogEffect(state, 'A', 'Vicious Vittles', 'As an additional cost to summon your next Hunger this turn, sacrifice this and summon the hunger on this tile.', 'Engage ability', { selfCellId: 'r2c1' });
    expect(opened.nextHungerFreeSummonOnTile).toEqual({ ownerId: 'A', cellId: 'r2c1', instanceId: 'vv#0' });
    expect(getLegalActions(opened, 'A').some(a => a.type === 'SUMMON_BEING' && a.instanceId === 'hg#0' && a.cellId === 'r2c1')).toBe(true);
    const next = gameReducer(opened, { type: 'SUMMON_BEING', instanceId: 'hg#0', cellId: 'r2c1' });
    expect(next.board.r2c1.card.name).toBe('Some Hunger');
    expect(next.players.A.purgatory.some(c => c.name === 'Vicious Vittles')).toBe(true);
    expect(next.nextHungerFreeSummonOnTile).toBe(null);
  });

  it('Envoy of the Hungers — "switch this Being with a Hunger you control" trades board positions, keeping each Being\'s own stats', () => {
    const envoy = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ev#0', name: 'Envoy', strength: 3, lifespan: 3 }), currentLifespan: 2, engaged: false };
    const hunger = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'hg#0', name: 'A Hunger', typing: 'Hunger, Being', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: true };
    const state = baseState({ board: { r2c1: envoy, r2c2: hunger }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Envoy of the Hungers', 'switch this Being with a Hunger you control.', 'Engage ability', { selfCellId: 'r2c1' });
    expect(next.board.r2c1.card.name).toBe('A Hunger');
    expect(next.board.r2c1.engaged).toBe(true); // kept its own state, just relocated
    expect(next.board.r2c2.card.name).toBe('Envoy');
    expect(next.board.r2c2.currentLifespan).toBe(2);
  });

  it('Grand Germination — triggers every Seed\'s own Martyr for free, with none of them actually sacrificed', () => {
    const seed1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 's1#0', name: 'Seed One', typing: 'Seed, Being', keywords: { martyr: 'Gain 1 Lifespan.' } }), currentLifespan: 2, engaged: false };
    const seed2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 's2#0', name: 'Seed Two', typing: 'Seed, Being', keywords: { martyr: 'Gain 1 Lifespan.' } }), currentLifespan: 2, engaged: false };
    const nonSeed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ns#0', name: 'Not a Seed', keywords: { martyr: 'Gain 1 Lifespan.' } }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: seed1, r2c2: seed2, r2c3: nonSeed }, players: { A: player({ lifespan: 40 }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Grand Germination', 'Trigger all Martyr abilities on Seeds you control ignoring costs.', 'Prophecy', {});
    expect(next.players.A.lifespan).toBe(42); // both Seeds' Martyr fired
    expect(next.board.r2c1).toBeDefined(); // neither Seed was actually sacrificed
    expect(next.board.r2c2).toBeDefined();
  });

  it('Conscription — "All Beings move forward if possible" moves both sides\' eligible Beings and flags them not to disengage', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', arrows: [1] }), currentLifespan: 3, engaged: true };
    const state = baseState({ board: { r1c1: mine }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Conscription', 'All Beings move forward if possible. Any that move do not disengage during disengage step.', 'Prophecy', {});
    expect(next.board.r1c1).toBeUndefined();
    const moved = Object.entries(next.board).find(([, o]) => o?.card?.instanceId === 'm#0');
    expect(moved[0]).toBe('r2c1'); // A's home row (1) moves forward into the front row (2)
    expect(moved[1].doesNotDisengage).toBe(true);
    expect(next.lastMassMoveNoneMoved).toBe(false);
  });

  it('Conscription — when nothing can move, the controller forces one Being from each side into combat', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', arrows: [], strength: 4, lifespan: 4 }), currentLifespan: 4, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', arrows: [], strength: 1, lifespan: 6 }), currentLifespan: 6, engaged: false };
    const state = baseState({ board: { r2c1: mine, r4c1: theirs }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const afterMove = resolveOrLogEffect(state, 'A', 'Conscription', 'All Beings move forward if possible. Any that move do not disengage during disengage step.', 'Prophecy', {});
    expect(afterMove.lastMassMoveNoneMoved).toBe(true); // neither has an Arrow, so nothing could move
    const next = resolveOrLogEffect(afterMove, 'A', 'Conscription', 'If none move, choose two Beings they Engage in combat.', 'Prophecy', {});
    expect(next.board.r2c1.currentLifespan).toBe(3); // took the opponent's 1 Strength
    expect(next.board.r4c1.currentLifespan).toBe(2); // took the 4 Strength back
  });

  it('Planchette — its granted Martyr really reanimates an Undead OR a Demon from Purgatory ("Being from your Purgatory on this tile" word order, OR\'d typing)', () => {
    const planchette = { id: 'pl', instanceId: 'pl#0', name: 'Planchette', kind: 'relic', castingCost: { faithless: 0, colored: {} },
      keywords: { grantedMartyr: 'Summon an Undead or Demon Being from your Purgatory on this tile.' } };
    const being = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', keywords: {} }), currentLifespan: 5, engaged: false };
    const demon = beingCard({ instanceId: 'd#0', name: 'Imp', typing: 'Demon, Being' });
    const human = beingCard({ instanceId: 'h#0', name: 'Some Human', typing: 'Human, Being' });
    const state = baseState({
      groundRelics: { r2c1: { ownerId: 'A', card: planchette } },
      board: { r2c1: being },
      players: { A: player({ purgatory: [demon, human] }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_MARTYR', cellId: 'r2c1' });
    expect(next.board.r2c1.type).toBe('being');
    expect(next.board.r2c1.card.name).toBe('Imp'); // the Demon, not the Human
    expect(next.players.A.purgatory.some(c => c.name === 'Some Human')).toBe(true); // untouched
    expect(next.players.A.purgatory.some(c => c.name === 'Imp')).toBe(false); // reanimated out
  });

  it('Planchette — loses Lifespan at end of turn equal to whatever Being currently shares its tile, and grants that Being Martyr', () => {
    const planchette = { id: 'pl', instanceId: 'pl#0', name: 'Planchette', kind: 'relic', castingCost: { faithless: 0, colored: {} },
      keywords: { endOfTurnLoseLifespanEqualToCoLocatedBeing: true, grantedMartyr: 'Summon an Undead or Demon Being from your Purgatory on this tile.' } };
    const being = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', keywords: {} }), currentLifespan: 5, engaged: false };
    const state = baseState({
      groundRelics: { r2c1: { ownerId: 'A', card: planchette } },
      board: { r2c1: being },
      players: { A: player({ lifespan: 50 }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_MARTYR' && a.cellId === 'r2c1')).toBe(true);
    const afterTurn = endTurn(beginTurn({ ...state, turnPlayer: 'A', phase: 'playing' }));
    expect(afterTurn.players.A.lifespan).toBeLessThanOrEqual(45); // lost at least the Being's own 5 Lifespan
  });

  it('Brick — "Deal (1) Damge to target Being, then move Brick to the tile occupied by the targeted Being" moves it there even though the target died', () => {
    const brick = { id: 'br', instanceId: 'br#0', name: 'Brick', kind: 'relic-armament', castingCost: { faithless: 1, colored: {} } };
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [{ card: brick, engaged: false }] };
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', lifespan: 1 }), currentLifespan: 1, engaged: false };
    const state = baseState({ board: { r2c1: wearer, r4c1: target }, players: { A: player(), B: player({ lifespan: 50 }) } });
    const opened = resolveOrLogEffect(state, 'A', 'Brick', 'Deal (1) Damge to target Being, then move Brick to the tile occupied by the targeted Being', 'Engage ability', {});
    expect(opened.pendingChoice.kind).toBe('damage-target'); // 2 Beings on board (wearer + target) — a real choice
    const next = gameReducer(opened, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
    expect(next.board.r4c1.type).toBe('armament-stack'); // the target died, so Brick lands as a freestanding pile there
    const relocated = Object.entries(next.board).find(([, o]) => o?.armaments?.some(a => a.card.name === 'Brick'));
    expect(relocated[0]).toBe('r4c1'); // Brick still moved there, unconditional per the ruling
    expect(next.board.r2c1.armaments).toBeUndefined(); // no longer with its old wearer
  });

  it('Blood Rites — choosing X pays it as generic Essence on top of the fixed 1 Bleeding, then searches for an Armament costing exactly X', () => {
    const armament0 = { id: 'a0', instanceId: 'a0#0', name: 'Free Armament', kind: 'relic-armament', typing: 'Relic, Armament', castingCost: { faithless: 0, colored: {} } };
    const armament2 = { id: 'a2', instanceId: 'a2#0', name: 'Two Cost Armament', kind: 'relic-armament', typing: 'Relic, Armament', castingCost: { faithless: 2, colored: {} } };
    const bloodRites = { id: 'br-1', instanceId: 'br-1#0', name: 'Blood Rites', kind: 'conjuring',
      castingCost: { faithless: 0, colored: { bleeding: 1 }, xCostColor: '' },
      keywords: { searchDeckArmamentCostX: true } };
    const state = baseState({
      players: { A: player({ hand: [bloodRites], mainDeck: [armament0, armament2], effigyPool: [effigy('bleeding'), effigy('faithless', 1), effigy('faithless', 2)] }), B: player() },
    });
    const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'br-1#0' });
    expect(opened.pendingChoice.kind).toBe('choose-x-value');
    expect(opened.pendingChoice.maxX).toBe(2); // 2 non-Bleeding Effigies left after the fixed 1 Bleeding
    const next = gameReducer(opened, { type: 'RESOLVE_CHOOSE_X_VALUE', value: 2 });
    expect(next.players.A.effigyPool).toHaveLength(0); // 1 Bleeding + 2 generic spent
    expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', costFilter: 2, cardName: 'Blood Rites' });
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'a2#0' });
    expect(resolved.players.A.hand.some(c => c.instanceId === 'a2#0')).toBe(true);
  });

  const bloodRites = { id: 'br-1', instanceId: 'br-1#0', name: 'Blood Rites', kind: 'conjuring',
    castingCost: { faithless: 0, colored: { bleeding: 1 }, xCostColor: '' },
    keywords: { searchDeckArmamentCostX: true } };

  it('Blood Rites — "each Bleeding Essence in its cost may be paid with (10) lifespan instead": with no Bleeding available, substitutes automatically', () => {
    const state = baseState({
      players: { A: player({ hand: [bloodRites], lifespan: 45, effigyPool: [effigy('faithless', 1), effigy('faithless', 2)] }), B: player() },
    });
    const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'br-1#0' });
    expect(opened.players.A.lifespan).toBe(35); // 45 - 10
    expect(opened.pendingChoice).toEqual(expect.objectContaining({ kind: 'choose-x-value', maxX: 2, baseCost: { faithless: 0, colored: { bleeding: 0 }, xCostColor: '' } }));
    expect(opened.log.some(e => e.message.includes('10 Lifespan instead'))).toBe(true);
    // The substituted baseCost carries no Bleeding requirement anymore, so
    // choosing X pays purely generic Essence — no lingering Bleeding cost.
    const next = gameReducer(opened, { type: 'RESOLVE_CHOOSE_X_VALUE', value: 2 });
    expect(next.players.A.effigyPool).toHaveLength(0);
  });

  it('Blood Rites — does NOT substitute when a Bleeding Essence is actually available, even if the player also has enough Lifespan', () => {
    const state = baseState({
      players: { A: player({ hand: [bloodRites], lifespan: 45, effigyPool: [effigy('bleeding')] }), B: player() },
    });
    const opened = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'br-1#0' });
    expect(opened.players.A.lifespan).toBe(45); // untouched — paid normally
    expect(opened.pendingChoice.baseCost).toEqual(bloodRites.castingCost); // still requires the real Bleeding
  });

  it('Blood Rites — refuses to cast when neither Bleeding Essence nor enough Lifespan (without dropping to 0) is available', () => {
    const tooLittleLifespan = baseState({
      players: { A: player({ hand: [bloodRites], lifespan: 10, effigyPool: [] }), B: player() },
    });
    expect(gameReducer(tooLittleLifespan, { type: 'CAST_CONJURING', instanceId: 'br-1#0' })).toBe(tooLittleLifespan);

    const noResourcesAtAll = baseState({
      players: { A: player({ hand: [bloodRites], lifespan: 3, effigyPool: [] }), B: player() },
    });
    expect(gameReducer(noResourcesAtAll, { type: 'CAST_CONJURING', instanceId: 'br-1#0' })).toBe(noResourcesAtAll);
  });
});

describe('Third wave: more Still Unwired gaps closed', () => {
  it('Passing Doubt — end of turn with 2+ Doubt-family Beings controlled, opens a real choice instead of guessing (see turn.test.js for full coverage)', () => {
    const passingDoubt = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'pd#0', name: 'Passing Doubt', keywords: { endOfTurnDamageNamedFamily: { namePart: 'Doubt', amount: 1 } } }), currentLifespan: 2, engaged: false };
    const lingeringDoubt = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ld#0', name: 'Lingering Doubt', lifespan: 3 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r1c1: passingDoubt, r1c2: lingeringDoubt }, players: { A: player({ lifespan: 50 }), B: player() } });
    const opened = endTurn(beginTurn({ ...state, turnPlayer: 'A', phase: 'playing' }));
    expect(opened.pendingChoice).toEqual({
      kind: 'end-of-turn-damage-named-family-target', playerId: 'A', cardName: 'Passing Doubt', amount: 1, namePart: 'Doubt', remainingSources: [],
    });
    expect(opened.board.r1c1.currentLifespan).toBe(2); // nothing damaged yet
    expect(opened.board.r1c2.currentLifespan).toBe(3);
    const resolved = gameReducer(opened, { type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: 'r1c2' });
    expect(resolved.board.r1c2.currentLifespan).toBe(2); // now the chosen target actually takes it
  });

  it('Illegible Grimoire — generic coin flip: heads draws, tails costs Lifespan', () => {
    const state = baseState({ players: { A: player({ lifespan: 50, mainDeck: [beingCard({ instanceId: 'd1#0' })] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Illegible Grimoire', 'Flip a coin, if heads draw (1) card, if tails Pay (3) Lifespan.', 'Engage ability', {});
    const drew = next.players.A.hand.length === 1;
    const paid = next.players.A.lifespan === 47;
    expect(drew || paid).toBe(true); // exactly one branch actually happened
    expect(drew && paid).toBe(false);
  });

  it('Witching Well — tails reuses the existing "look at opponent\'s top, may shuffle" mechanism', () => {
    // Force tails by stubbing Math.random to return >= 0.5.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const oppTop = beingCard({ instanceId: 'ot#0' });
    const state = baseState({ players: { A: player(), B: player({ mainDeck: [oppTop] }) } });
    // The real pipeline's own keywords.engage capture already strips the
    // "Engage: " prefix (cardData.js's engageMatch[1]) before this text ever
    // reaches resolveOrLogEffect.
    const next = resolveOrLogEffect(state, 'A', 'Witching Well', 'Flip a coin if heads draw (1) card, if tails look at the top card of your opponents deck, you may have them shuffle.', 'Engage ability', {});
    expect(next.pendingChoice.kind).toBe('shuffle-or-keep');
    expect(next.pendingChoice.deckOwner).toBe('B');
    spy.mockRestore();
  });

  it('Exactly on TIme — cost-floor deck search finds only Beings costing (3) or more, typo and redundant "Being" both tolerated', () => {
    const cheap = beingCard({ instanceId: 'ch#0', name: 'Cheap', typing: 'Timeless, Being', castingCost: { faithless: 1, colored: {} } });
    const pricey = beingCard({ instanceId: 'pr#0', name: 'Pricey', typing: 'Timeless, Being', castingCost: { faithless: 3, colored: {} } });
    const state = baseState({ players: { A: player({ mainDeck: [cheap, pricey] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Exactly on TIme', 'Add a Timless Being that costs (3) or more from deck to hand.', 'effect', {});
    expect(next.pendingChoice.kind).toBe('search');
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'pr#0' });
    expect(resolved.players.A.hand.some(c => c.instanceId === 'pr#0')).toBe(true);
    const rejectedCheap = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'ch#0' });
    expect(rejectedCheap.players.A.hand.some(c => c.instanceId === 'ch#0')).toBe(false); // getLegalActions never offers it
  });

  it('Time Capsule — gains a Time Counter on a player-activated Modulate(-1), not on the automatic per-turn tick', () => {
    const capsule = { type: 'relic', ownerId: 'A', card: { id: 'tc', instanceId: 'tc#0', name: 'Time Capsule', kind: 'relic', castingCost: { faithless: 1, colored: { timeless: 2 } }, keywords: { onModulateMinusOneAddCounter: 1 } } };
    const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P1', instanceId: 'p1#0' }, timer: 3, faceDown: true };
    const state = baseState({
      board: { r3c1: prophecy, r1c1: capsule },
      players: { A: player(), B: player() },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test' },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(next.board.r1c1.counters?.time).toBe(1);
  });

  it('Time Keeper — "Modulate a target this points to" only offers the pointed Time-Counter permanent, not every one on the board', () => {
    const timeKeeper = beingCard({ instanceId: 'tk#0', name: 'Time Keeper', arrows: [1] });
    const pointedProphecy = { type: 'prophecy', ownerId: 'A', card: { name: 'Pointed', instanceId: 'pp#0' }, timer: 2, faceDown: true };
    const state = baseState({
      board: { r1c1: { type: 'being', ownerId: 'A', card: timeKeeper, currentLifespan: 3, engaged: false }, r2c1: pointedProphecy, r3c3: { type: 'prophecy', ownerId: 'A', card: { name: 'Unrelated', instanceId: 'up#0' }, timer: 2, faceDown: true } },
      players: { A: player(), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Time Keeper', 'Engage: Modulate (±1) a target this points to.', 'Engage ability', { selfCellId: 'r1c1' });
    expect(next.pendingChoice.kind).toBe('modulate');
    expect(next.pendingChoice.allowedCells).toEqual(['r2c1']);
    const legal = getLegalActions(next, 'A');
    expect(legal.every(a => a.cellId === 'r2c1')).toBe(true);
  });

  it('Horologist\'s Apprentice — gains its own Time Counter whenever a Time Counter is removed from a Prophecy it controls', () => {
    const apprentice = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ha#0', name: "Horologist's Apprentice", keywords: { collectsRemovedProphecyTimeCounters: true } }), currentLifespan: 3, engaged: false };
    const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P1', instanceId: 'p1#0' }, timer: 3, faceDown: true };
    const state = baseState({
      board: { r2c1: apprentice, r3c1: prophecy },
      players: { A: player(), B: player() },
      pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test' },
    });
    const next = gameReducer(state, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(next.board.r2c1.counters?.time).toBe(1);
  });

  it('Horologist\'s Apprentice — "Once per turn remove (3) Time Counters: Shuffle a random card from hand into deck, then draw (1) Card" resolves the whole compound', () => {
    const apprentice = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'ha#0' }), currentLifespan: 3, engaged: false, counters: { time: 3 } };
    const handCard = beingCard({ instanceId: 'hc#0', name: 'Hand Card' });
    const state = baseState({ board: { r2c1: apprentice }, players: { A: player({ hand: [handCard], mainDeck: [beingCard({ instanceId: 'd1#0' })] }), B: player() } });
    // The real pipeline (ACTIVATE_TIMES_PER_TURN_ABILITY) already strips the
    // "Once per turn " prefix via cardData.js's timesPerTurnAbility capture
    // before this text ever reaches resolveOrLogEffect.
    const next = resolveOrLogEffect(state, 'A', "Horologist's Apprentice", 'remove (3) Time Counters: Shuffle a random card from hand into deck, then draw (1) Card.', 'ability', { selfCellId: 'r2c1' });
    expect(next.board.r2c1.counters.time).toBe(0);
    expect(next.players.A.hand).toHaveLength(1); // the shuffled card left, the drawn card arrived
    // The shuffle lands "hc#0" in a 2-card deck and the very next draw is
    // random — it can legally draw either card back out, so "hc#0" ends up
    // in the deck OR back in hand, never lost or duplicated either way.
    const total = [...next.players.A.mainDeck, ...next.players.A.hand];
    expect(total.some(c => c.instanceId === 'hc#0')).toBe(true);
    expect(total).toHaveLength(2);
  });

  it('Balance the Scales — "Sacrifice a Being: Each opponent sacrifices a Being" (no "you control", "Each" not "target") now resolves fully', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0' }), currentLifespan: 3, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r1c1: mine, r4c1: theirs }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Balance the Scales', 'Sacrifice a Being: Each opponent sacrifices a Being', 'Prophecy', {});
    expect(next.board.r1c1).toBeUndefined();
    expect(next.board.r4c1).toBeUndefined();
  });

  it('Blood Moon — whenever ANY Being dies, its own controller gives a different Being +1/+1, read live off Blood Moon\'s own face-up Prophecy', () => {
    const bloodMoon = { type: 'prophecy', ownerId: 'B', card: { name: 'Blood Moon', instanceId: 'bm#0', keywords: { onAnyBeingDiedGiveDifferentBuff: { strength: 1, lifespan: 1 } } }, timer: 5, faceDown: false };
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const dying = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'dy#0', lifespan: 1 }), currentLifespan: 1, engaged: false };
    const survivor = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'sv#0', strength: 1, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r3c1: bloodMoon, r2c1: attacker, r4c1: dying, r4c2: survivor }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(next.board.r4c2.card.name).toBe('Test Being'); // survivor is B's own — buffed by B, not A
    expect(effectiveStrength(next.board.r4c2)).toBe(2); // printed 1 + 1
  });

  it('Blood Moon — a candidate cell that died before the choice resolves is never offered again (self-play found a stale offer looping the AI forever)', () => {
    const opened = {
      kind: 'give-different-typed-buff', playerId: 'B', cardName: 'Blood Moon', label: 'reaction',
      strengthBonus: 1, lifespanBonus: 1, allowedCells: ['r4c1', 'r4c2'],
    };
    // r4c1 has since died (nothing there anymore); only r4c2 is still alive.
    const survivor = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'sv#0', strength: 1, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r4c2: survivor }, pendingChoice: opened, players: { A: player(), B: player() } });
    const legal = getLegalActions(state, 'B');
    expect(legal).toEqual([{ type: 'RESOLVE_GIVE_DIFFERENT_TYPED_BUFF', cellId: 'r4c2' }]);
    // Dispatching the stale cell directly still stays a safe no-op (the
    // reducer's own defensive check), it's just never offered as legal.
    const stale = gameReducer(state, { type: 'RESOLVE_GIVE_DIFFERENT_TYPED_BUFF', cellId: 'r4c1' });
    expect(stale).toBe(state);
  });

  it('Canopic Jar — "Engage: Remove (4) Crossing Counters Shuffle a Being from Purgatory into it\'s owners deck, they draw (1) card" (no punctuation) resolves fully', () => {
    const jar = { type: 'relic', ownerId: 'A', card: { id: 'cj', instanceId: 'cj#0', name: 'Canopic Jar', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: {} }, counters: { crossing: 4 } };
    const purgCard = beingCard({ instanceId: 'pc#0', name: 'Purg Card', typing: 'Human, Being' });
    const state = baseState({ board: { r1c1: jar }, players: { A: player({ purgatory: [purgCard], mainDeck: [] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Canopic Jar', "Remove (4) Crossing Counters Shuffle a Being from Purgatory into it's owners deck, they draw (1) card.", 'Engage ability', { selfCellId: 'r1c1' });
    expect(next.board.r1c1.counters.crossing).toBe(0);
    expect(next.players.A.purgatory).toEqual([]);
    // The deck started empty, so the one card shuffled in is also the one
    // immediately drawn back out — it lands in hand, not left in the deck.
    expect(next.players.A.hand.some(c => c.instanceId === 'pc#0')).toBe(true);
  });

  // Regression: unlike Melting Clock/Temple of Dubiety's own "from YOUR
  // Purgatory" (own-only), Canopic Jar's printed text has no "your" —
  // "into it's owners deck, they draw" both point at whoever the found
  // Being actually belongs to. The old code only ever searched
  // state.players[playerId].purgatory (the activator's own), so an
  // opponent's Purgatory was invisible to it entirely — confirmed with
  // the user as the bug.
  it('Canopic Jar — can find and shuffle a Being from the OPPONENT\'s own Purgatory, and the opponent (not the activator) draws', () => {
    const jar = { type: 'relic', ownerId: 'A', card: { id: 'cj', instanceId: 'cj#0', name: 'Canopic Jar', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: {} }, counters: { crossing: 4 } };
    const oppPurgCard = beingCard({ instanceId: 'opc#0', name: 'Opponent Card', typing: 'Human, Being' });
    const state = baseState({
      board: { r1c1: jar },
      players: { A: player({ purgatory: [], mainDeck: [] }), B: player({ purgatory: [oppPurgCard], mainDeck: [] }) },
    });
    const next = resolveOrLogEffect(state, 'A', 'Canopic Jar', "Remove (4) Crossing Counters Shuffle a Being from Purgatory into it's owners deck, they draw (1) card.", 'Engage ability', { selfCellId: 'r1c1' });
    expect(next.players.B.purgatory).toEqual([]);
    expect(next.players.A.hand).toEqual([]); // the activator gets nothing
    expect(next.players.B.hand.some(c => c.instanceId === 'opc#0')).toBe(true); // the card's own owner draws it
  });

  it('Canopic Jar — offers a real choice across BOTH players\' Purgatories, and resolving the opponent\'s own candidate doesn\'t touch the activator\'s pile', () => {
    const jar = { type: 'relic', ownerId: 'A', card: { id: 'cj', instanceId: 'cj#0', name: 'Canopic Jar', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: {} }, counters: { crossing: 4 } };
    // Same card, same instanceId scheme, one copy in each player's own
    // Purgatory — deck-built instanceIds (deck.js: `${card.id}#${i}`) are
    // only unique WITHIN one player's own deck, so this is a real,
    // reachable collision (e.g. both players on the same precon), not a
    // contrived edge case — only the offer's own explicit ownerId tag
    // (not instanceId alone) can disambiguate which pile a candidate
    // came from.
    const ownPurgCard = beingCard({ instanceId: 'dup#0', name: 'Duplicate Card', typing: 'Human, Being' });
    const oppPurgCard = beingCard({ instanceId: 'dup#0', name: 'Duplicate Card', typing: 'Human, Being' });
    const state = baseState({
      board: { r1c1: jar },
      players: { A: player({ purgatory: [ownPurgCard], mainDeck: [] }), B: player({ purgatory: [oppPurgCard], mainDeck: [] }) },
    });
    const opened = resolveOrLogEffect(state, 'A', 'Canopic Jar', "Remove (4) Crossing Counters Shuffle a Being from Purgatory into it's owners deck, they draw (1) card.", 'Engage ability', { selfCellId: 'r1c1' });
    expect(opened.pendingChoice).toEqual(expect.objectContaining({ kind: 'shuffle-purgatory-into-deck', anyOwner: true }));
    const options = getLegalActions(opened, 'A').filter(a => a.type === 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK');
    expect(options).toContainEqual({ type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: 'dup#0', ownerId: 'A' });
    expect(options).toContainEqual({ type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: 'dup#0', ownerId: 'B' });
    const resolved = gameReducer(opened, { type: 'RESOLVE_SHUFFLE_PURGATORY_INTO_DECK', instanceId: 'dup#0', ownerId: 'B' });
    expect(resolved.players.A.purgatory).toEqual([ownPurgCard]); // A's own copy left untouched
    expect(resolved.players.B.purgatory).toEqual([]);
    expect(resolved.players.B.hand.some(c => c.instanceId === 'dup#0')).toBe(true);
  });

  it('May Break my Bones — "Choose a Being this points to, destroy it and Summon a Bag o\' Bones token on that tile" destroys then summons on the SAME tile', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', lifespan: 3 }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { id: 'mbb', instanceId: 'mbb#0', name: 'May Break my Bones', kind: 'prophecy', castingCost: { faithless: 0, colored: {} }, timerMax: 0, arrows: [1], textBox: "Choose a Being this points to, destroy it and Summon a Bag o' Bones token on that tile.", keywords: {} }, timer: 0, faceDown: true }, r4c1: target },
      players: { A: player(), B: player({ lifespan: 50 }) },
    });
    const next = resolveProphecyModulateHitZero(state, 'r3c1');
    expect(next.board.r4c1.card.name).toBe("Bag o' Bones");
    expect(next.players.B.lifespan).toBe(50); // destroyed, not dealt death damage
  });

  it('Mirage Visage — "Choose (2) Beings this points to, become Favored" grants Favored to up to 2 pointed Beings', () => {
    const b1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b1#0' }), currentLifespan: 3, engaged: false };
    const b2 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'b2#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { id: 'mv', instanceId: 'mv#0', name: 'Mirage Visage', kind: 'prophecy', castingCost: { faithless: 0, colored: {} }, timerMax: 0, arrows: [1, 5], textBox: 'Choose (2) Beings this points to, become Favored.', keywords: {} }, timer: 0, faceDown: true }, r4c1: b1, r2c1: b2 },
      players: { A: player(), B: player() },
    });
    const next = resolveProphecyModulateHitZero(state, 'r3c1');
    // Only 2 pointed Beings exist (<= maxCount 2), so both auto-apply, no choice needed.
    expect(next.board.r4c1.favorCounter).toBe(true);
    expect(next.board.r2c1.favorCounter).toBe(true);
  });
});

describe('Fourth wave: more Still Unwired gaps closed', () => {
  it('Metal Worker — "Once per turn, you may Pay (1) Bleeding Essence: X" is capped at once per turn, enforced by both getLegalActions and the reducer', () => {
    const worker = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'mw#0', name: 'Metal Worker', keywords: { payEffigyCostAbility: { color: 'bleeding', amount: 1, effect: 'The next Relic you summon this turn costs (-2) Faithless.', once: true } } }),
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ board: { r1c1: worker }, players: { A: player({ effigyPool: [effigy('bleeding', 1), effigy('bleeding', 2)] }), B: player() } });
    const first = gameReducer(state, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c1' });
    expect(first.board.r1c1.timesPerTurnUsed).toBe(1);
    expect(first.players.A.effigyPool).toHaveLength(1);
    expect(first.nextRelicCostReduction).toEqual({ color: 'faithless', amount: 2 });
    expect(getLegalActions(first, 'A').some(a => a.type === 'ACTIVATE_PAY_EFFIGY_COST_ABILITY')).toBe(false);
    const second = gameReducer(first, { type: 'ACTIVATE_PAY_EFFIGY_COST_ABILITY', cellId: 'r1c1' });
    expect(second).toBe(first); // no-op — the cap is enforced in the reducer too, not just getLegalActions
  });

  it('Strike the Ore — "Engage a Being you control: Draw (1) card" enforces the Engage cost before drawing (was unconditional)', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r1c1: mine }, players: { A: player({ mainDeck: [beingCard({ instanceId: 'd1#0' })] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Strike the Ore', 'Engage a Being you control: Draw (1) card.', 'effect', {});
    expect(next.board.r1c1.engaged).toBe(true);
    expect(next.players.A.hand).toHaveLength(1);
  });

  it('Strike the Ore — has no Being to Engage, so it gracefully does nothing rather than drawing for free', () => {
    const state = baseState({ players: { A: player({ mainDeck: [beingCard({ instanceId: 'd1#0' })] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Strike the Ore', 'Engage a Being you control: Draw (1) card.', 'effect', {});
    expect(next.players.A.hand).toHaveLength(0);
  });

  it('Collapsing Bridge — "Engage: Remove (1) Crossing Counter, you may summon a Being on a tile that Collapsing Bridge points to" opens a hand-Being choice restricted to the pointed tile', () => {
    const bridge = {
      type: 'relic', ownerId: 'A',
      card: { id: 'cb', instanceId: 'cb#0', name: 'Collapsing Bridge', kind: 'relic', castingCost: { faithless: 0, colored: {} }, arrows: [1], keywords: {} },
      counters: { crossing: 2 },
    };
    const handBeing = beingCard({ instanceId: 'hb#0', name: 'Hand Being', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({ board: { r1c1: bridge }, players: { A: player({ hand: [handBeing] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Collapsing Bridge', 'Remove (1) Crossing Counter, you may summon a Being on a tile that Collapsing Bridge points to.', 'Engage ability', { selfCellId: 'r1c1' });
    expect(next.board.r1c1.counters.crossing).toBe(1); // the counter cost is always spent, even if the "you may" is later declined
    expect(next.pendingChoice.kind).toBe('summon-hand-being-pointed');
    expect(next.pendingChoice.allowedCells).toEqual(['r2c1']); // dir1 from r1c1 (A's home row)
    const placed = gameReducer(next, { type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: 'hb#0', cellId: 'r2c1' });
    expect(placed.board.r2c1.card.name).toBe('Hand Being');
    expect(placed.players.A.hand).toHaveLength(0);
  });

  it('Collapsing Bridge — a Dryad-keyword Being from hand may still target a pointed tile already carrying the player\'s own TreeFolk/Vine/Seed (Dryad-attach, not overwrite)', () => {
    const bridge = {
      type: 'relic', ownerId: 'A',
      card: { id: 'cb', instanceId: 'cb#0', name: 'Collapsing Bridge', kind: 'relic', castingCost: { faithless: 0, colored: {} }, arrows: [1], keywords: {} },
      counters: { crossing: 2 },
    };
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', name: 'Treefolk Host', typing: 'TreeFolk, Being' }), currentLifespan: 4, engaged: false };
    const dryadBeing = beingCard({ instanceId: 'db#0', name: 'Dryad Rider', castingCost: { faithless: 0, colored: {} }, keywords: { dryad: true } });
    const state = baseState({
      board: { r1c1: bridge, r2c1: treefolk },
      players: { A: player({ hand: [dryadBeing] }), B: player() },
    });
    const opened = resolveOrLogEffect(state, 'A', 'Collapsing Bridge', 'Remove (1) Crossing Counter, you may summon a Being on a tile that Collapsing Bridge points to.', 'Engage ability', { selfCellId: 'r1c1' });
    expect(getLegalActions(opened, 'A')).toContainEqual({ type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: 'db#0', cellId: 'r2c1' });
    const placed = gameReducer(opened, { type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: 'db#0', cellId: 'r2c1' });
    // Attached, not overwritten — the Treefolk is still there underneath,
    // now as the rider (same shape placeBeingOnBoard's own Dryad-attach
    // branch always produces for a normal SUMMON_BEING).
    expect(placed.board.r2c1.card.name).toBe('Dryad Rider');
    expect(placed.board.r2c1.dryadAttached?.card.name).toBe('Treefolk Host');
    expect(placed.players.A.hand).toHaveLength(0);
  });

  it('Collapsing Bridge — a NON-Dryad Being from hand still can\'t target an occupied pointed tile', () => {
    const bridge = {
      type: 'relic', ownerId: 'A',
      card: { id: 'cb', instanceId: 'cb#0', name: 'Collapsing Bridge', kind: 'relic', castingCost: { faithless: 0, colored: {} }, arrows: [1], keywords: {} },
      counters: { crossing: 2 },
    };
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', name: 'Treefolk Host', typing: 'TreeFolk, Being' }), currentLifespan: 4, engaged: false };
    const plainBeing = beingCard({ instanceId: 'pb#0', name: 'Plain Being', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({
      board: { r1c1: bridge, r2c1: treefolk },
      players: { A: player({ hand: [plainBeing] }), B: player() },
    });
    const opened = resolveOrLogEffect(state, 'A', 'Collapsing Bridge', 'Remove (1) Crossing Counter, you may summon a Being on a tile that Collapsing Bridge points to.', 'Engage ability', { selfCellId: 'r1c1' });
    expect(getLegalActions(opened, 'A')).not.toContainEqual({ type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: 'pb#0', cellId: 'r2c1' });
    const rejected = gameReducer(opened, { type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: 'pb#0', cellId: 'r2c1' });
    expect(rejected.board.r2c1.card.name).toBe('Treefolk Host'); // untouched
    expect(rejected.players.A.hand).toHaveLength(1); // not spent — the dispatch was rejected
  });

  it('Collapsing Bridge — real CSV-parsed keywords, full end-to-end: engage, Dryad-attach onto the pointed tile', () => {
    const csvRow = {
      'Card Name': 'Collapsing Bridge', 'Card Typing': 'Relic', 'Effigy Cost': '2 Faithless', 'Conjuring Cost': '2',
      'Text Box': 'When summoned gain (2) Crossing Counters.\nEngage: Remove (1) Crossing Counter, you may summon a Being on a tile that Collapsing Bridge points to.',
      Strength: '0', Lifespan: '0', Arrows: '1, 2, 8',
    };
    const bridgeCard = toGameCard(csvRow, 0);
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', name: 'Treefolk Host', typing: 'TreeFolk, Being' }), currentLifespan: 4, engaged: false };
    const dryadBeing = beingCard({ instanceId: 'db#0', name: 'Dryad Rider', castingCost: { faithless: 0, colored: {} }, keywords: { dryad: true } });
    // Direction 1 from r1c1 (A's home row) points to r2c1 (A's front row —
    // same geometry the plain-empty-tile test above already confirms), so
    // the Treefolk sits where Collapsing Bridge's own arrow-1 actually points.
    const state = baseState({
      board: { r1c1: { type: 'relic', ownerId: 'A', card: bridgeCard, engaged: false, counters: { crossing: 2 } }, r2c1: treefolk },
      players: { A: player({ hand: [dryadBeing] }), B: player() },
    });
    const engaged = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r1c1' });
    expect(engaged.pendingChoice?.kind).toBe('summon-hand-being-pointed');
    expect(engaged.pendingChoice.allowedCells).toContain('r2c1');
    const placed = gameReducer(engaged, { type: 'RESOLVE_SUMMON_HAND_BEING_POINTED', instanceId: 'db#0', cellId: 'r2c1' });
    expect(placed.board.r2c1.card.name).toBe('Dryad Rider');
    expect(placed.board.r2c1.dryadAttached?.card.name).toBe('Treefolk Host');
  });

  it('Hurry Up and Wait — "Modulate (-1) and Modulate (+1)" resolves BOTH clauses, not just the first', () => {
    const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P1', instanceId: 'p1#0' }, timer: 3, faceDown: true };
    const state = baseState({ board: { r3c1: prophecy }, players: { A: player(), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', 'Hurry Up and Wait', 'Modulate (-1) and Modulate (+1).', 'effect', {});
    expect(opened.pendingChoice).toEqual(expect.objectContaining({ kind: 'modulate', delta: -1, thenDelta: 1 }));
    const afterFirst = gameReducer(opened, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    expect(afterFirst.board.r3c1.timer).toBe(2);
    expect(afterFirst.pendingChoice).toEqual(expect.objectContaining({ kind: 'modulate', delta: 1 }));
    const afterSecond = gameReducer(afterFirst, { type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    expect(afterSecond.board.r3c1.timer).toBe(3);
    expect(afterSecond.pendingChoice).toBe(null);
  });

  it('Propagate — "If you control a TreeFolk, draw (1) Card" resolves independently of the Vine-conditioned line that follows it', () => {
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', typing: 'TreeFolk, Being' }), currentLifespan: 3, engaged: false };
    const purgTreefolk = beingCard({ instanceId: 'pt#0', name: 'Purg TreeFolk', typing: 'TreeFolk, Being' });
    const state = baseState({
      board: { r1c1: treefolk },
      players: { A: player({ mainDeck: [beingCard({ instanceId: 'd1#0' })], purgatory: [purgTreefolk] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Propagate', 'If you control a TreeFolk, draw (1) Card.\nIf you control a Vine, add a TreeFollk to hand from your Purgatory.\nIf you control both you may do both.', 'effect', {});
    expect(next.players.A.hand).toHaveLength(1);
    expect(next.players.A.hand[0].instanceId).toBe('d1#0'); // drew, not searched — no Vine controlled
    expect(next.players.A.purgatory).toHaveLength(1);
  });

  it('Propagate — the Vine-conditioned Purgatory search (with the CSV\'s own "TreeFollk" typo) fires independently when a Vine is controlled', () => {
    const vine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'v#0', typing: 'Vine, Being' }), currentLifespan: 2, engaged: false };
    const purgTreefolk = beingCard({ instanceId: 'pt#0', name: 'Purg TreeFolk', typing: 'TreeFolk, Being' });
    const state = baseState({ board: { r1c1: vine }, players: { A: player({ purgatory: [purgTreefolk] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Propagate', 'If you control a TreeFolk, draw (1) Card.\nIf you control a Vine, add a TreeFollk to hand from your Purgatory.\nIf you control both you may do both.', 'effect', {});
    // SEARCH_FROM_PURGATORY_RE always opens a 'search' choice, even with a
    // single candidate — same as any other card using that shared pattern.
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'search', source: 'purgatory', query: 'TreeFolk' }));
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'pt#0' });
    expect(resolved.players.A.hand.some(c => c.instanceId === 'pt#0')).toBe(true);
  });

  it('The Roots Remember — "If there are (0) Time Counters on this conjure a (Living) Prophecy from your Purgatory" conjures a real, still-workable Prophecy', () => {
    const purgProphecy = { id: 'lp', instanceId: 'lp#0', name: 'Living Prophecy', kind: 'prophecy', castingCost: { faithless: 0, colored: { living: 1 } }, timerMax: 2, textBox: '', keywords: {} };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'The Roots Remember', instanceId: 'rr#0' }, timer: 0, faceDown: false } },
      players: { A: player({ purgatory: [purgProphecy] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'The Roots Remember', 'If there are (0) Time Counters on this conjure a (Living) Prophecy from your Purgatory.', 'Prophecy', { selfCellId: 'r3c1' });
    const placedCell = Object.keys(next.board).find(c => c !== 'r3c1' && next.board[c]?.type === 'prophecy');
    expect(placedCell).toBeDefined();
    expect(next.board[placedCell].card.name).toBe('Living Prophecy');
    expect(next.board[placedCell].faceDown).toBe(true);
    expect(next.players.A.purgatory).toHaveLength(0);
  });

  it('The Roots Remember — re-checks the live count, so it does nothing once a PRECEDING "Gain (1) Time Counter" line has already made it nonzero', () => {
    const purgProphecy = { id: 'lp', instanceId: 'lp#0', name: 'Living Prophecy', kind: 'prophecy', castingCost: { faithless: 0, colored: { living: 1 } }, timerMax: 2, textBox: '', keywords: {} };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'The Roots Remember', instanceId: 'rr#0' }, timer: 1, faceDown: false } },
      players: { A: player({ purgatory: [purgProphecy] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'The Roots Remember', 'If there are (0) Time Counters on this conjure a (Living) Prophecy from your Purgatory.', 'Prophecy', { selfCellId: 'r3c1' });
    expect(next.players.A.purgatory).toHaveLength(1); // untouched
  });

  it('Shovel — "Engage: Sacrifice Shovel, then reveal the top (3) cards of your deck, you may add any Relics revealed to hand, shuffle the others back" sacrifices the ARMAMENT by its own printed name and keeps only the Relics', () => {
    const shovelCard = { id: 'sh', instanceId: 'sh#0', name: 'Shovel', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} }, keywords: {} };
    const wearer = {
      type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false,
      armaments: [{ card: shovelCard, engaged: false }],
    };
    const relicCard = { id: 'rc', instanceId: 'rc#0', name: 'Some Relic', kind: 'relic', castingCost: { faithless: 1, colored: {} }, keywords: {} };
    const otherCard = beingCard({ instanceId: 'ob#0', name: 'Other Being' });
    const thirdCard = beingCard({ instanceId: 'tb#0', name: 'Third Being' });
    const state = baseState({
      board: { r1c1: wearer },
      players: { A: player({ mainDeck: [relicCard, otherCard, thirdCard] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Test Being', "Sacrifice Shovel, then reveal the top (3) cards of your deck, you may add any Relics revealed to hand, shuffle the others back into your deck.", 'Engage ability', { selfCellId: 'r1c1' });
    expect(next.board.r1c1.armaments).toHaveLength(0);
    expect(next.players.A.hand.some(c => c.instanceId === 'rc#0')).toBe(true);
    expect(next.players.A.mainDeck).toHaveLength(2); // the 2 non-Relics shuffled back
  });

  it('White Whisker — "Sacrifice this when you summon a Familiar" fires from the shared placeBeingOnBoard, so it works off ANY summon path', () => {
    const whisker = {
      type: 'relic', ownerId: 'A',
      card: { id: 'ww', instanceId: 'ww#0', name: 'White Whisker', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: { sacrificeSelfOnSummonTyping: 'Familiar' } },
    };
    const familiarCard = beingCard({ instanceId: 'fam#0', name: 'A Familiar', typing: 'Cat, Being, Familiar', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({ board: { r1c1: whisker }, players: { A: player({ hand: [familiarCard] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'fam#0', cellId: 'r1c2' });
    expect(next.board.r1c1).toBeUndefined();
    expect(next.board.r1c2.card.name).toBe('A Familiar');
  });

  it('White Whisker — does NOT sacrifice itself for a non-Familiar summon', () => {
    const whisker = {
      type: 'relic', ownerId: 'A',
      card: { id: 'ww', instanceId: 'ww#0', name: 'White Whisker', kind: 'relic', castingCost: { faithless: 0, colored: {} }, keywords: { sacrificeSelfOnSummonTyping: 'Familiar' } },
    };
    const plainCard = beingCard({ instanceId: 'pl#0', name: 'Plain Being', typing: 'Demon, Being', castingCost: { faithless: 0, colored: {} } });
    const state = baseState({ board: { r1c1: whisker }, players: { A: player({ hand: [plainCard] }), B: player() } });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'pl#0', cellId: 'r1c2' });
    expect(next.board.r1c1).toBeDefined();
  });

  it('Willing Sacrifice — "Until end of turn target Being gains: \'Martyr: Craft (1) Effigy\'" grants Martyr to any Being, either side, cleared at end of turn', () => {
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r4c1: theirs }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Willing Sacrifice', 'Until end of turn target Being gains: "Martyr: Craft (1) Effigy".', 'effect', {});
    expect(next.board.r4c1.grantedMartyrUntilEndOfTurn).toBe('Craft (1) Effigy');
    // getLegalActions only ever offers an action to the player whose turn
    // it currently is (RULES.md), same as Engage — so this checks it on B's
    // own turn, not A's (the caster's).
    expect(getLegalActions({ ...next, turnPlayer: 'B' }, 'B').some(a => a.type === 'ACTIVATE_MARTYR' && a.cellId === 'r4c1')).toBe(true);
    const afterTurn = endTurn(beginTurn({ ...next, turnPlayer: 'A', phase: 'playing' }));
    expect(afterTurn.board.r4c1.grantedMartyrUntilEndOfTurn).toBeUndefined();
  });

  it('Engrave — "Beings you control gain \'Depart: Summon a Bag o\' Bones token\'" is a one-time grant onto current Beings, and the granted Depart really fires', () => {
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', strength: 1, lifespan: 6 }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: mine }, players: { A: player(), B: player() } });
    const granted = resolveOrLogEffect(state, 'A', 'Engrave', 'Beings you control gain "Depart: Summon a Bag o\' Bones token".', 'effect', {});
    expect(granted.board.r2c1.grantedDepart).toBe("Summon a Bag o' Bones token");
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def', strength: 5, lifespan: 8 }), currentLifespan: 8, engaged: false };
    const withDefender = { ...granted, board: { ...granted.board, r4c1: defender }, players: { A: player({ lifespan: 50 }), B: player() } };
    const afterCombat = gameReducer(withDefender, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
    expect(afterCombat.log.some(e => e.message.includes('Depart triggers'))).toBe(true);
    // The granted text has no "on this tile" of its own, so (like any other
    // bare "Summon a X token" text) it opens a normal token-location choice
    // among every empty Mortal Realm tile, rather than auto-placing.
    expect(afterCombat.pendingChoice.kind).toBe('token-location');
    const next = gameReducer(afterCombat, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r2c1' });
    expect(next.board.r2c1.card.name).toBe("Bag o' Bones");
  });

  it('Natures Bounty — "TreeFolk, Vine, and Seeds you control gain: \'Engage: add (1) Living\'" is a one-time grant, filtered to matching typings only', () => {
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', typing: 'TreeFolk, Being' }), currentLifespan: 3, engaged: false };
    const unrelated = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'un#0', typing: 'Demon, Being' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r1c1: treefolk, r1c2: unrelated }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Natures Bounty', 'TreeFolk, Vine, and Seeds you control gain: "Engage: add (1) Living".', 'Prophecy', {});
    expect(next.board.r1c1.grantedEngage).toBe('add (1) Living');
    expect(next.board.r1c2.grantedEngage).toBeUndefined();
    expect(getLegalActions(next, 'A').some(a => a.type === 'ACTIVATE_ENGAGE' && a.cellId === 'r1c1')).toBe(true);
  });

  it('Natures Bounty — also grants to a "Seed" typing, even though the printed text lists it as plural "Seeds" (regression: typing-group matching used to require the CSV\'s singular typing to literally contain the plural noun)', () => {
    const seed = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'sd#0', typing: 'Seed, Being' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r1c1: seed }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Natures Bounty', 'TreeFolk, Vine, and Seeds you control gain: "Engage: add (1) Living".', 'Prophecy', {});
    expect(next.board.r1c1.grantedEngage).toBe('add (1) Living');
  });

  it('Vadē Rah — "Engage, Sacrifice the Being on this tile: add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being" now works via groundRelics co-location', () => {
    const vadeRah = {
      id: 'vr', instanceId: 'vr#0', name: 'Vadē Rah', kind: 'relic',
      castingCost: { faithless: 0, colored: {} },
      textBox: "If this is engaged at the end of the turn sacrifice it.\nEngage, Sacrifice the Being on this tile: add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being.\n Beings may move across Vadē Rah.",
      keywords: {
        engage: 'add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being.',
        engageExtraCost: 'Sacrifice the Being on this tile',
        beingsMayMoveAcross: true, sacrificeIfEngagedAtEndOfTurn: true,
      },
    };
    const coLocatedBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'colocated', typing: 'Demon, Being' }), currentLifespan: 3, engaged: false };
    const matchingDeity = { id: 'dm', instanceId: 'dm#0', name: 'Rhak-tùrin Deity of Ruin', kind: 'deity', typing: 'Rhak-tùrin, Demon, Deity', castingCost: { faithless: 0, colored: {} } };
    const nonMatchingDeity = { id: 'dl', instanceId: 'dl#0', name: 'Rhak-tùrin Deity of Light', kind: 'deity', typing: 'Rhak-tùrin, Angel, Deity', castingCost: { faithless: 0, colored: {} } };
    const state = baseState({
      board: { r1c1: coLocatedBeing },
      groundRelics: { r1c1: { type: 'relic', ownerId: 'A', card: vadeRah, engaged: false } },
      players: { A: player({ mainDeck: [matchingDeity, nonMatchingDeity] }), B: player() },
    });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE' && a.cellId === 'r1c1')).toBe(true);
    const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r1c1' });
    expect(next.board.r1c1).toBeUndefined(); // the co-located Being was sacrificed
    expect(next.groundRelics.r1c1.engaged).toBe(true);
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'search', sharedTypings: ['demon', 'being'] }));
    // The non-matching Deity (no shared typing with the sacrificed Demon) is never offered.
    expect(getLegalActions(next, 'A').every(a => a.instanceId !== 'dl#0')).toBe(true);
    const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'dm#0' });
    expect(resolved.players.A.hand.some(c => c.instanceId === 'dm#0')).toBe(true);
  });

  it('Vadē Rah — is not offered without a Being co-located on its own tile to sacrifice', () => {
    const vadeRah = {
      id: 'vr', instanceId: 'vr#0', name: 'Vadē Rah', kind: 'relic', castingCost: { faithless: 0, colored: {} },
      keywords: { engage: 'add a Rhak-tùrin Deity to hand from deck that shares a type with the sacrificed Being.', engageExtraCost: 'Sacrifice the Being on this tile', beingsMayMoveAcross: true },
    };
    const state = baseState({ groundRelics: { r1c1: { type: 'relic', ownerId: 'A', card: vadeRah, engaged: false } }, players: { A: player(), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_GROUND_RELIC_ENGAGE')).toBe(false);
    const next = gameReducer(state, { type: 'ACTIVATE_GROUND_RELIC_ENGAGE', cellId: 'r1c1' });
    expect(next).toBe(state);
  });
});

describe('Fifth wave: board-wide aura primitive (Growth Spurt / Crathea\'s Blooming & Withering Life)', () => {
  const growthSpurtProphecy = (overrides = {}) => ({
    type: 'prophecy', ownerId: 'A',
    card: {
      name: 'Growth Spurt', instanceId: 'gs#0',
      keywords: { boardWideAllyBonus: { strength: 1, lifespan: 0, condTyping: 'TreeFolk', condStrength: 2, condLifespan: 0 } },
    },
    timer: 2, faceDown: false,
    ...overrides,
  });

  it('Growth Spurt — face-up with Time Counters left, gives every controlled Being +1/+0, or +2/+0 instead if it\'s a TreeFolk', () => {
    const plain = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'p#0', typing: 'Demon, Being', strength: 1 }), currentLifespan: 3, engaged: false };
    const treefolk = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'tf#0', typing: 'TreeFolk, Being', strength: 1 }), currentLifespan: 3, engaged: false };
    const opponent = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'opp#0', strength: 1 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r3c1: growthSpurtProphecy(), r1c1: plain, r1c2: treefolk, r4c1: opponent } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r1c1)).toBe(2); // 1 + 1
    expect(effectiveStrength(next.board.r1c2)).toBe(3); // 1 + 2 (TreeFolk override, not stacked with the base +1)
    expect(effectiveStrength(next.board.r4c1)).toBe(1); // opponent's own Being, untouched
  });

  it('Growth Spurt — face-down (not yet flipped) grants nothing', () => {
    const plain = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'p#0', strength: 1 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r3c1: growthSpurtProphecy({ faceDown: true, timer: 2 }), r1c1: plain } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r1c1)).toBe(1);
  });

  it('Growth Spurt — the bonus turns off live the moment it runs out of Time Counters and goes to Purgatory', () => {
    const plain = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'p#0', strength: 1, lifespan: 5 }), currentLifespan: 7, engaged: false, boardWideAuraBonus: { strength: 1, lifespan: 0 } };
    const state = baseState({ board: { r1c1: plain }, players: { A: player(), B: player() } }); // Growth Spurt already gone
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(next.board.r1c1.boardWideAuraBonus).toEqual({ strength: 0, lifespan: 0 }); // the stale +1 is clawed back
    expect(effectiveStrength(next.board.r1c1)).toBe(1); // back to its own printed Strength alone
  });

  it('Blooming Life token — "Beings you control have +1/+1" (Lifespan half heals immediately, same as any other live aura)', () => {
    const bloomingLife = { type: 'prophecy', ownerId: 'A', card: { name: 'Blooming Life', instanceId: 'bl#0', keywords: { boardWideAllyBonus: { strength: 1, lifespan: 1 } } }, timer: 3, faceDown: false };
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', strength: 1, lifespan: 3 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r3c1: bloomingLife, r1c1: mine } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r1c1)).toBe(2);
    expect(next.board.r1c1.currentLifespan).toBe(4);
  });

  it('Withering Life token — "Beings you don\'t control have -1/-1" hits only the OPPONENT of the token\'s own controller', () => {
    const witheringLife = { type: 'prophecy', ownerId: 'A', card: { name: 'Withering Life', instanceId: 'wl#0', keywords: { boardWideEnemyBonus: { strength: -1, lifespan: -1 } } }, timer: 3, faceDown: false };
    const mine = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'm#0', strength: 2, lifespan: 3 }), currentLifespan: 3, engaged: false };
    const theirs = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', strength: 2, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r3c1: witheringLife, r1c1: mine, r4c1: theirs } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r1c1)).toBe(2); // its own controller — untouched
    expect(effectiveStrength(next.board.r4c1)).toBe(1); // 2 - 1
    expect(next.board.r4c1.currentLifespan).toBe(4); // 5 - 1
  });

  it('Crathea — "create a face up Blooming Life token... or a Withering Life token..." opens a real choice, placed into the Ethereal Realm face-up with 3 Time Counters', () => {
    // Only r3c1 left open — forces the single-candidate auto-place branch
    // (RESOLVE_ETHEREAL_TOKEN_LOCATION's own multi-candidate picker is
    // covered by the "full" test below instead).
    const filler = (n) => ({ type: 'prophecy', ownerId: 'B', card: { name: `Filler ${n}`, instanceId: `f${n}#0` }, timer: 1, faceDown: true });
    const state = baseState({
      board: { r3c2: filler(2), r3c3: filler(3), r3c4: filler(4), r3c5: filler(5) },
      players: { A: player({ hand: [] }), B: player() },
    });
    const opened = resolveOrLogEffect(
      state, 'A', 'Crathea',
      'create a face up Blooming Life token (0 cost - Divine Prophecy - 3T "Beings you control have +1/+1") or a Withering Life token (0 cost - Divine Prophecy - 3T - "Beings you don\'t control have -1/-1").',
      'When Summoned', {}
    );
    expect(opened.pendingChoice).toEqual(expect.objectContaining({ kind: 'create-token-choice', options: ['blooming life', 'withering life'] }));
    const next = gameReducer(opened, { type: 'RESOLVE_CREATE_TOKEN_CHOICE', tokenKey: 'blooming life' });
    const placedCell = Object.keys(next.board).find(c => next.board[c]?.card?.name === 'Blooming Life');
    expect(placedCell).toBeDefined();
    expect(next.board[placedCell].card.name).toBe('Blooming Life');
    expect(next.board[placedCell].faceDown).toBe(false); // created face UP, unlike a normally-cast Prophecy
    expect(next.board[placedCell].timer).toBe(3);
  });

  // Regression: with more than one empty Ethereal cell open (the normal
  // case on turn 1 — the live bug the user actually hit, reported as
  // "Crathea caused a Frozen Gamestate since I was unable to select a
  // Prophecy to summon"), RESOLVE_CREATE_TOKEN_CHOICE opens a SECOND
  // pendingChoice ('ethereal-token-location') to pick which one. Match.jsx
  // had no UI wired for either this kind or 'create-token-choice' itself —
  // the engine was already correct, the player just had no button to
  // click. This test only proves the engine's own half; the UI fix is
  // Match.jsx's SINGLE_CELL_CHOICE_KINDS['ethereal-token-location'] entry
  // and the new pendingCreateTokenChoiceCandidates modal.
  it('Crathea — with more than one empty Ethereal cell, opens a follow-up ethereal-token-location choice instead of placing directly', () => {
    const state = baseState({ board: {}, players: { A: player({ hand: [] }), B: player() } });
    const opened = resolveOrLogEffect(
      state, 'A', 'Crathea',
      'create a face up Blooming Life token (0 cost - Divine Prophecy - 3T "Beings you control have +1/+1") or a Withering Life token (0 cost - Divine Prophecy - 3T - "Beings you don\'t control have -1/-1").',
      'When Summoned', {}
    );
    const next = gameReducer(opened, { type: 'RESOLVE_CREATE_TOKEN_CHOICE', tokenKey: 'blooming life' });
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'ethereal-token-location', tokenName: 'blooming life', playerId: 'A' }));
    expect(Object.values(next.board).some(o => o?.card?.name === 'Blooming Life')).toBe(false); // not placed yet
    const chosenCell = next.pendingChoice.allowedCells[0];
    const placed = gameReducer(next, { type: 'RESOLVE_ETHEREAL_TOKEN_LOCATION', cellId: chosenCell });
    expect(placed.pendingChoice).toBe(null);
    expect(placed.board[chosenCell].card.name).toBe('Blooming Life');
    expect(placed.board[chosenCell].faceDown).toBe(false);
  });

  it('Crathea — with the Ethereal Realm full, gracefully creates nothing rather than crashing', () => {
    const filler = (n) => ({ type: 'prophecy', ownerId: 'B', card: { name: `Filler ${n}`, instanceId: `f${n}#0` }, timer: 1, faceDown: true });
    const state = baseState({
      board: { r3c1: filler(1), r3c2: filler(2), r3c3: filler(3), r3c4: filler(4), r3c5: filler(5) },
      players: { A: player(), B: player() },
    });
    const opened = resolveOrLogEffect(state, 'A', 'Crathea', 'create a face up Blooming Life token (0 cost) or a Withering Life token (0 cost).', 'When Summoned', {});
    const next = gameReducer(opened, { type: 'RESOLVE_CREATE_TOKEN_CHOICE', tokenKey: 'withering life' });
    expect(next.pendingChoice).toBe(null);
    expect(Object.values(next.board).filter(o => o?.card?.name === 'Withering Life')).toHaveLength(0);
  });
});

describe('Sixth wave: attached-Armament-level Martyr (Armor Animus)', () => {
  const armorAnimus = equip({
    id: 'aa', instanceId: 'aa#0', name: 'Armor Animus', kind: 'relic-armament', castingCost: { faithless: 0, colored: {} },
    keywords: { martyr: 'Being this is attatched to gains "Depart: Summon this in the Mortal Realm engaged".' },
  });

  it('offers ACTIVATE_ARMAMENT_MARTYR for the Armament itself, not the wearer\'s own bare Martyr', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [armorAnimus] };
    const state = baseState({ board: { r2c1: wearer }, players: { A: player(), B: player() } });
    const legal = getLegalActions(state, 'A');
    expect(legal).toContainEqual({ type: 'ACTIVATE_ARMAMENT_MARTYR', cellId: 'r2c1', armamentInstanceId: 'aa#0' });
    expect(legal.some(a => a.type === 'ACTIVATE_MARTYR')).toBe(false); // the wearer itself has no printed Martyr
  });

  it('engaging and sacrificing it grants the WEARER "Depart: Summon this in the Mortal Realm engaged" — the wearer stays put, only the Armament is gone', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [armorAnimus] };
    const state = baseState({ board: { r2c1: wearer }, players: { A: player(), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_MARTYR', cellId: 'r2c1', armamentInstanceId: 'aa#0' });
    expect(next.board.r2c1.armaments).toEqual([]);
    expect(next.board.r2c1.card.name).toBe('Test Being'); // the wearer, untouched otherwise
    expect(next.board.r2c1.grantedDepart).toBe('Summon this in the Mortal Realm engaged');
  });

  it('the granted Depart really fires later, pulling the dying wearer back out of Purgatory onto an empty tile, engaged', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', strength: 1, lifespan: 6 }), currentLifespan: 2, engaged: false, grantedDepart: 'Summon this in the Mortal Realm engaged.' };
    const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const state = baseState({ board: { r2c1: wearer, r4c1: attacker }, players: { A: player({ lifespan: 50 }), B: player() }, turnPlayer: 'B' });
    const afterCombat = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(afterCombat.log.some(e => e.message.includes('Depart triggers'))).toBe(true);
    // Many empty Mortal Realm tiles are open (an almost-bare board), so this
    // is the multi-candidate 'token-location' choice, not an auto-place —
    // see forceEngaged's own handling there.
    expect(afterCombat.pendingChoice).toEqual(expect.objectContaining({ kind: 'token-location', purgatoryInstanceId: 'w#0', forceEngaged: true }));
    const next = gameReducer(afterCombat, { type: 'RESOLVE_TOKEN_LOCATION', cellId: 'r1c2' });
    expect(next.board.r1c2.card.instanceId).toBe('w#0');
    expect(next.board.r1c2.engaged).toBe(true);
    expect(next.players.A.purgatory.some(c => c.instanceId === 'w#0')).toBe(false); // pulled back out, not left there
  });
});

describe('Seventh wave: "When conjured you may have this enter with up to (N) Time Counters" (False Testament)', () => {
  const falseTestamentCard = {
    id: 'ft', instanceId: 'ft#0', name: 'False Testament', kind: 'prophecy', castingCost: { faithless: 0, colored: {} },
    timerMax: 0, textBox: 'Craft (1) Effigy.',
    keywords: { whenConjuredEnterUpTo: 5 },
  };

  it('PLAY_PROPHECY opens a real 0..N choice instead of using its own (uncomputed "X") printed timerMax', () => {
    const state = baseState({ players: { A: player({ hand: [falseTestamentCard] }), B: player() } });
    const next = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'ft#0', cellId: 'r3c1' });
    expect(next.board.r3c1).toMatchObject({ type: 'prophecy', faceDown: true, timer: 0 }); // placed first, timerMax(0) as a placeholder
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'choose-prophecy-timer', cellId: 'r3c1', maxValue: 5 }));
    const legal = getLegalActions(next, 'A');
    expect(legal.filter(a => a.type === 'RESOLVE_CHOOSE_PROPHECY_TIMER')).toHaveLength(6); // 0..5 inclusive
  });

  it('choosing a nonzero value sets that as the real starting timer, still face-down', () => {
    const state = baseState({ players: { A: player({ hand: [falseTestamentCard] }), B: player() } });
    const opened = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'ft#0', cellId: 'r3c1' });
    const next = gameReducer(opened, { type: 'RESOLVE_CHOOSE_PROPHECY_TIMER', value: 3 });
    expect(next.board.r3c1).toMatchObject({ timer: 3, faceDown: true });
    expect(next.pendingChoice).toBe(null);
  });

  it('choosing 0 flips it face up immediately and resolves its own real text ("Craft (1) Effigy.")', () => {
    const state = baseState({ players: { A: player({ hand: [falseTestamentCard], effigyDeck: [effigy('faithless')] }), B: player() } });
    const opened = gameReducer(state, { type: 'PLAY_PROPHECY', instanceId: 'ft#0', cellId: 'r3c1' });
    const next = gameReducer(opened, { type: 'RESOLVE_CHOOSE_PROPHECY_TIMER', value: 0 });
    expect(next.board.r3c1).toBeUndefined(); // resolved and sent to Purgatory — a 0-Counter Prophecy has nothing left to stay face-up for
    expect(next.players.A.purgatory.some(c => c.name === 'False Testament')).toBe(true);
    expect(next.players.A.effigyPool).toHaveLength(1); // "Craft (1) Effigy" really crafted
  });
});

describe('Eighth wave: typed-group temporary buff (Delectable Deviant) and damage redirect (HeartWood Locket)', () => {
  it('Delectable Deviant\'s Martyr buffs every Hunger the player controls, not other typings or the opponent\'s', () => {
    const hunger1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'h1#0', typing: 'Hunger', strength: 2 }), currentLifespan: 3, engaged: false };
    const hunger2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'h2#0', typing: 'Hunger', strength: 1 }), currentLifespan: 2, engaged: false };
    const human = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'hu#0', typing: 'Human', strength: 1 }), currentLifespan: 2, engaged: false };
    const enemyHunger = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'eh#0', typing: 'Hunger', strength: 1 }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: hunger1, r2c2: hunger2, r2c3: human, r4c1: enemyHunger } });
    const next = resolveOrLogEffect(state, 'A', 'Delectable Deviant', 'Hungers you control gain +1/+0 until the end of your turn.', 'Martyr');
    expect(effectiveStrength(next.board.r2c1)).toBe(3);
    expect(effectiveStrength(next.board.r2c2)).toBe(2);
    expect(effectiveStrength(next.board.r2c3)).toBe(1); // Human, unaffected
    expect(effectiveStrength(next.board.r4c1)).toBe(1); // opponent's Hunger, unaffected
  });

  it('the buff is cleared at end of turn', () => {
    const hunger1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'h1#0', typing: 'Hunger', strength: 2 }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r2c1: hunger1 }, players: { A: player({ mainDeck: [] }), B: player() } });
    const buffed = resolveOrLogEffect(state, 'A', 'Delectable Deviant', 'Hungers you control gain +1/+0 until the end of your turn.', 'Martyr');
    const afterTurn = endTurn(buffed);
    expect(effectiveStrength(afterTurn.board.r2c1)).toBe(2);
  });

  it('logs an honest fallback when the player controls no Hunger', () => {
    const human = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'hu#0', typing: 'Human' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: human } });
    const next = resolveOrLogEffect(state, 'A', 'Delectable Deviant', 'Hungers you control gain +1/+0 until the end of your turn.', 'Martyr');
    expect(next.log.some(e => e.message.includes('no matching Being'))).toBe(true);
  });

  const heartwoodLocket = equip({
    id: 'hwl', instanceId: 'hwl#0', name: 'HeartWood Locket', kind: 'relic-armament', castingCost: { colored: {} },
    keywords: { martyr: 'Until end of turn attached Being gains: "Damage dealt to this Being is dealt directly to it\'s controller instead".' },
  });

  it('Martyr-ing HeartWood Locket flags the wearer, redirecting damage to its controller instead of the Being itself', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [heartwoodLocket] };
    const state = baseState({ board: { r2c1: wearer }, players: { A: player({ lifespan: 50 }), B: player() } });
    const activated = gameReducer(state, { type: 'ACTIVATE_ARMAMENT_MARTYR', cellId: 'r2c1', armamentInstanceId: 'hwl#0' });
    expect(activated.board.r2c1.damageRedirectToController).toBe(true);
    expect(activated.board.r2c1.armaments).toEqual([]); // the Locket itself is gone (sacrificed)
  });

  it('the redirect really moves Lifespan loss to the controller, leaving the Being untouched, on a hit that would otherwise be lethal', () => {
    const wearer = {
      type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', lifespan: 5 }), currentLifespan: 2, engaged: false,
      damageRedirectToController: true,
    };
    const state = baseState({ board: { r2c1: wearer }, players: { A: player({ lifespan: 50 }), B: player() } });
    const next = dealDamageToBeing(state, 'r2c1', 10); // would be lethal if applied to the Being
    expect(next.board.r2c1.currentLifespan).toBe(2); // untouched
    expect(next.players.A.lifespan).toBe(40); // controller took it instead
    expect(next.players.A.purgatory).toHaveLength(0); // no death at all
  });

  it('the redirect flag is cleared at end of turn', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, damageRedirectToController: true };
    const state = baseState({ board: { r2c1: wearer }, players: { A: player({ mainDeck: [] }), B: player() } });
    const next = endTurn(state);
    expect(next.board.r2c1.damageRedirectToController).toBeUndefined();
  });
});

describe('Ninth wave: Chronostasis\'s two-clause flip trigger', () => {
  const chronostasisText = 'Gain (2) Time Counters. \nBefore drawing a card(s) that player may reveal the top card of their deck, they may shuffle.';

  it('gains 2 Time Counters AND opens the reveal-and-maybe-shuffle choice, instead of silently dropping the second clause', () => {
    const prophecy = { type: 'prophecy', ownerId: 'A', faceDown: false, timer: 1, card: { name: 'Chronostasis', textBox: chronostasisText } };
    const deckCard = { instanceId: 'top#0', name: 'Top Card' };
    const state = baseState({ board: { r3c1: prophecy }, players: { A: player({ mainDeck: [deckCard] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'Chronostasis', chronostasisText, 'Prophecy', { selfCellId: 'r3c1' });
    expect(next.board.r3c1.timer).toBe(3); // 1 + 2
    expect(next.pendingChoice).toEqual({ kind: 'shuffle-or-keep', playerId: 'A', cardName: 'Chronostasis', deckOwner: 'A' });
  });

  it('choosing to shuffle really shuffles the caster\'s own deck', () => {
    const prophecy = { type: 'prophecy', ownerId: 'A', faceDown: false, timer: 1, card: { name: 'Chronostasis', textBox: chronostasisText } };
    const deck = [{ instanceId: 'c1#0', name: 'C1' }, { instanceId: 'c2#0', name: 'C2' }, { instanceId: 'c3#0', name: 'C3' }];
    const state = baseState({ board: { r3c1: prophecy }, players: { A: player({ mainDeck: deck }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', 'Chronostasis', chronostasisText, 'Prophecy', { selfCellId: 'r3c1' });
    const next = gameReducer(opened, { type: 'RESOLVE_SHUFFLE_OR_KEEP', shuffle: true });
    expect(next.pendingChoice).toBe(null);
    expect(next.players.A.mainDeck).toHaveLength(3); // still all 3 cards, just reordered (or coincidentally same order)
    expect(next.log.some(e => e.message.includes('shuffled'))).toBe(true);
  });
});

describe('Tenth wave: By Teeth and Bounds — a Prophecy\'s three condition-gated lines', () => {
  const moreLine = 'If you control more Beings than your opponent: sacrifice a Hunger, then add Immen Gorta from deck to hand.';
  const lessLine = 'If you control less beings than your opponent: draw (2) cards.';
  const tieLine = 'If it is tied: choose one.';
  const immenGorta = { id: 'ig', instanceId: 'ig#0', name: 'Immen Gorta, the Boundless Hunger', kind: 'being', typing: 'Hunger, Being, Deity', castingCost: { faithless: 0, colored: {} }, strength: 5, lifespan: 5, arrows: [1] };
  const hunger = (n) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: `h${n}#0`, typing: 'Hunger, Being' }), currentLifespan: 3, engaged: false });

  it('"more Beings" line no-ops when the condition is false, without touching the deck or board', () => {
    const state = baseState({ board: {}, players: { A: player({ mainDeck: [immenGorta] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', moreLine, 'Prophecy', {});
    expect(next).toBe(state); // untouched — condition false
  });

  it('"more Beings" line, condition true, single Hunger: sacrifices it and searches Immen Gorta in one step', () => {
    const state = baseState({ board: { r2c1: hunger(1) }, players: { A: player({ mainDeck: [immenGorta] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', moreLine, 'Prophecy', {});
    expect(next.board.r2c1).toBeUndefined();
    expect(next.players.A.purgatory.some(c => c.instanceId === 'h1#0')).toBe(true);
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'search', query: 'Immen Gorta' }));
  });

  it('"more Beings" line, condition true, multiple Hungers: opens a choice of which to sacrifice', () => {
    const state = baseState({ board: { r2c1: hunger(1), r2c2: hunger(2) }, players: { A: player({ mainDeck: [immenGorta] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', moreLine, 'Prophecy', {});
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'teeth-bounds-sacrifice-hunger', playerId: 'A' }));
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER', cellId: 'r2c1' });
    expect(legal).toContainEqual({ type: 'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER', cellId: 'r2c2' });
    const resolved = gameReducer(next, { type: 'RESOLVE_TEETH_BOUNDS_SACRIFICE_HUNGER', cellId: 'r2c2' });
    expect(resolved.board.r2c2).toBeUndefined();
    expect(resolved.board.r2c1).toBeDefined(); // the OTHER Hunger survives
    expect(resolved.pendingChoice).toEqual(expect.objectContaining({ kind: 'search' }));
  });

  it('"more Beings" line, condition true, but no Hunger to sacrifice: honest no-op log, Immen Gorta not added', () => {
    const human = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'hu#0', typing: 'Human' }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r2c1: human }, players: { A: player({ mainDeck: [immenGorta] }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', moreLine, 'Prophecy', {});
    expect(next.log.some(e => e.message.includes('no Hunger'))).toBe(true);
    expect(next.pendingChoice).toBe(null);
  });

  it('"less Beings" line no-ops when the condition is false', () => {
    const state = baseState({ board: { r2c1: hunger(1) }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', lessLine, 'Prophecy', {});
    expect(next).toBe(state);
  });

  it('"less Beings" line, condition true: draws 2 cards', () => {
    const deck = [{ instanceId: 'c1#0', name: 'C1' }, { instanceId: 'c2#0', name: 'C2' }];
    const opponentBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ob#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r4c1: opponentBeing }, players: { A: player({ hand: [], mainDeck: deck }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', lessLine, 'Prophecy', {});
    expect(next.players.A.hand).toHaveLength(2);
    expect(next.players.A.mainDeck).toHaveLength(0);
  });

  it('"tied" line no-ops when Being counts differ, and opens a real choice when they match', () => {
    const state = baseState({ board: { r2c1: hunger(1) }, players: { A: player(), B: player() } });
    const untied = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', tieLine, 'Prophecy', {});
    expect(untied).toBe(state);

    const opponentBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ob#0' }), currentLifespan: 3, engaged: false };
    const tied = baseState({ board: { r2c1: hunger(1), r4c1: opponentBeing }, players: { A: player({ mainDeck: [immenGorta] }), B: player() } });
    const next = resolveOrLogEffect(tied, 'A', 'By Teeth and Bounds', tieLine, 'Prophecy', {});
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'teeth-bounds-tie-choice', playerId: 'A' }));
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'more' });
    expect(legal).toContainEqual({ type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'less' });
  });

  it('an Animated Armament acting as a Being (topmost of its own pile) counts towards the Being total on either side', () => {
    // A alone: 1 real Being (hunger). B: no real Beings, but an Animated
    // Armament stack whose topmost entry counts as one — so it's tied
    // (1 vs 1), not "A controls more" the way a bare armament-stack count
    // (ignoring Animated) would incorrectly read.
    const animatedTop = { card: { id: 'aa', instanceId: 'aa#0', name: 'Animated Armament', kind: 'relic-armament', keywords: { animated: true } }, engaged: false, currentLifespan: 2 };
    const opponentAnimatedStack = { type: 'armament-stack', ownerId: 'B', armaments: [animatedTop] };
    const state = baseState({ board: { r2c1: hunger(1), r4c1: opponentAnimatedStack }, players: { A: player(), B: player() } });
    const next = resolveOrLogEffect(state, 'A', 'By Teeth and Bounds', tieLine, 'Prophecy', {});
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'teeth-bounds-tie-choice', playerId: 'A' }));
  });

  it('choosing "less" on a tie really draws 2 cards, bypassing the (now-false) "less" condition check', () => {
    const deck = [{ instanceId: 'c1#0', name: 'C1' }, { instanceId: 'c2#0', name: 'C2' }];
    const opponentBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ob#0' }), currentLifespan: 3, engaged: false };
    const tied = baseState({ board: { r2c1: hunger(1), r4c1: opponentBeing }, players: { A: player({ hand: [], mainDeck: deck }), B: player() } });
    const opened = resolveOrLogEffect(tied, 'A', 'By Teeth and Bounds', tieLine, 'Prophecy', {});
    const next = gameReducer(opened, { type: 'RESOLVE_TEETH_BOUNDS_TIE_CHOICE', choice: 'less' });
    expect(next.players.A.hand).toHaveLength(2);
    expect(next.pendingChoice).toBe(null);
  });

  it('the full printed text resolves correctly line-by-line, matching how a real Prophecy flip processes it (resolveProphecyModulateHitZero)', () => {
    const opponentBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ob#0' }), currentLifespan: 3, engaged: false };
    const byTeethAndBounds = {
      id: 'btb', instanceId: 'btb#0', name: 'By Teeth and bounds', kind: 'prophecy', castingCost: { formless: 2, colored: {} },
      timerMax: 2, textBox: `${moreLine}\n${lessLine}\n${tieLine}`,
    };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', faceDown: true, timer: 0, card: byTeethAndBounds }, r2c1: hunger(1), r4c1: opponentBeing },
      players: { A: player({ mainDeck: [immenGorta] }), B: player() },
    });
    const next = resolveProphecyModulateHitZero(state, 'r3c1');
    // 1 Being (A) vs 1 Being (B) — tied, so this opens the tie choice rather
    // than silently running all three lines' effects at once.
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'teeth-bounds-tie-choice' }));
  });
});

describe('Eleventh wave: Midnight Mass — "Sacrifice target Being this points to: Invoke a Demon with equal Strength on a tile this points to"', () => {
  const midnightMassCard = (arrows) => ({
    id: 'mm', instanceId: 'mm#0', name: 'Midnight Mass', kind: 'prophecy', castingCost: { formless: 0, colored: {} },
    timerMax: 2, arrows, textBox: 'Sacrifice target Being this points to: Invoke a Demon with equal Strength on a tile this points to.',
  });
  const demonInDeck = { id: 'd1', instanceId: 'd1#0', name: 'Deck Demon', kind: 'being', typing: 'Demon, Being', castingCost: { formless: 2, colored: {} }, strength: 9, lifespan: 3, arrows: [1] };
  const text = 'Sacrifice target Being this points to: Invoke a Demon with equal Strength on a tile this points to.';

  it('a single pointed Being: sacrifices it, then invokes a Demon from deck with strengthOverride equal to the sacrificed Being\'s live Strength', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0', strength: 4 }), currentLifespan: 3, engaged: false, statBonusUntilEndOfTurn: { strength: 2, lifespan: 0 } };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', faceDown: false, timer: 2, card: midnightMassCard([5]) }, r2c1: target },
      players: { A: player({ mainDeck: [demonInDeck] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Midnight Mass', text, 'Prophecy', { selfCellId: 'r3c1' });
    expect(next.players.B.purgatory.some(c => c.instanceId === 't#0')).toBe(true);
    // Only one empty Mortal tile the Prophecy points to (r2c1, now vacated) —
    // auto-places there directly instead of opening invoke-destination.
    expect(next.board.r2c1.card.name).toBe('Deck Demon');
    expect(next.board.r2c1.strengthOverride).toBe(6); // 4 printed + 2 temp bonus, snapshotted at sacrifice time
    expect(next.players.A.mainDeck).toEqual([]);
  });

  it('more than one pointed Being: opens a real choice of which to sacrifice', () => {
    const target1 = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't1#0', strength: 3 }), currentLifespan: 3, engaged: false };
    const target2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 't2#0', strength: 7 }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r3c2: { type: 'prophecy', ownerId: 'A', faceDown: false, timer: 2, card: midnightMassCard([5, 6]) }, r2c2: target1, r2c1: target2 },
      players: { A: player({ mainDeck: [demonInDeck] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Midnight Mass', text, 'Prophecy', { selfCellId: 'r3c2' });
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'midnight-mass-sacrifice-target', typing: 'Demon' }));
    const legal = getLegalActions(next, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET', cellId: 'r2c1' });
    expect(legal).toContainEqual({ type: 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET', cellId: 'r2c2' });

    const resolved = gameReducer(next, { type: 'RESOLVE_MIDNIGHT_MASS_SACRIFICE_TARGET', cellId: 'r2c1' });
    expect(resolved.board.r2c1.card.name).toBe('Deck Demon'); // landed right back on the now-empty sacrificed tile
    expect(resolved.board.r2c1.strengthOverride).toBe(7);
    expect(resolved.board.r2c2).toBe(target1); // the OTHER pointed Being survives, untouched
  });

  it('no Being on a pointed tile: honest no-op, deck untouched', () => {
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', faceDown: false, timer: 2, card: midnightMassCard([5]) } },
      players: { A: player({ mainDeck: [demonInDeck] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Midnight Mass', text, 'Prophecy', { selfCellId: 'r3c1' });
    expect(next.log.some(e => e.message.includes('no Being on a tile'))).toBe(true);
    expect(next.players.A.mainDeck).toEqual([demonInDeck]);
  });

  it('no Demon in deck: sacrifices anyway, then honestly logs finding nothing to invoke', () => {
    const target = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 't#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', faceDown: false, timer: 2, card: midnightMassCard([5]) }, r2c1: target },
      players: { A: player({ mainDeck: [] }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', 'Midnight Mass', text, 'Prophecy', { selfCellId: 'r3c1' });
    expect(next.board.r2c1).toBeUndefined(); // still sacrificed — the cost is paid regardless
    expect(next.log.some(e => e.message.includes('finds no "Demon"'))).toBe(true);
  });
});

describe('Twelfth wave: Legion\'s Onset — "Pay (X) Lifespan, then Summon a Vassal token, for every (5) Lifespan paid"', () => {
  const text = 'Pay (X) Lifespan, then Summon a Vassal token, for every (5) Lifespan paid.';

  it('opens a count choice (not a raw Lifespan amount), capped by the Lifespan floor', () => {
    const state = baseState({ players: { A: player({ lifespan: 23 }), B: player() } });
    const next = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    // floor((23-1)/5) = 4; empty Mortal Realm tiles for A (10, an untouched
    // board) don't bind here, so Lifespan is the limiting factor.
    expect(next.pendingChoice).toEqual({ kind: 'legion-onset-choose-count', playerId: 'A', cardName: "Legion's Onset", label: 'Prophecy', maxCount: 4 });
  });

  it('the offered count is also capped by how many empty tiles are actually available, even with Lifespan to spare', () => {
    // Fill every one of A's Mortal Realm tiles but one.
    const filler = (id) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: id }), currentLifespan: 5, engaged: false });
    const state = baseState({
      board: { r1c2: filler('f1'), r1c3: filler('f2'), r1c4: filler('f3'), r1c5: filler('f4'), r2c2: filler('f5'), r2c3: filler('f6'), r2c4: filler('f7'), r2c5: filler('f8') },
      players: { A: player({ lifespan: 100 }), B: player() },
    });
    const next = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    expect(next.pendingChoice.maxCount).toBe(1); // only r2c1 is still open (of A's 8 usable Mortal Realm tiles), not floor(99/5)=19
  });

  it('choosing a count pays 5 Lifespan per token, then opens a board-native tile choice for exactly that many', () => {
    const state = baseState({ board: {}, players: { A: player({ lifespan: 20 }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    const next = gameReducer(opened, { type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value: 2 });
    expect(next.players.A.lifespan).toBe(10);
    expect(next.pendingChoice).toEqual({
      kind: 'summon-vine-tokens-toggle', playerId: 'A', cardName: "Legion's Onset", label: 'Prophecy',
      maxCount: 2, selected: [], tokenKey: 'vassal', tokenName: 'Vassal',
    });
    expect(Object.values(next.board).filter(o => o?.type === 'being')).toHaveLength(0); // nothing placed yet
  });

  it('the player chooses where each Vassal token lands, not an auto-placement', () => {
    const state = baseState({ board: {}, players: { A: player({ lifespan: 20 }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    const counted = gameReducer(opened, { type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value: 2 });
    const toggled1 = gameReducer(counted, { type: 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE', cellId: 'r2c4' });
    const toggled2 = gameReducer(toggled1, { type: 'RESOLVE_SUMMON_VINE_TOKENS_TOGGLE', cellId: 'r2c5' });
    const resolved = gameReducer(toggled2, { type: 'RESOLVE_SUMMON_VINE_TOKENS_CONFIRM' });
    expect(resolved.board.r2c4?.card.name).toBe('Vassal');
    expect(resolved.board.r2c5?.card.name).toBe('Vassal');
    expect(Object.values(resolved.board).filter(o => o?.type === 'being')).toHaveLength(2);
    expect(resolved.pendingChoice).toBeNull();
  });

  it('choosing a count of 0 summons nothing and pays no Lifespan', () => {
    const state = baseState({ players: { A: player({ lifespan: 20 }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    const next = gameReducer(opened, { type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value: 0 });
    expect(next.players.A.lifespan).toBe(20);
    expect(next.pendingChoice).toBeNull();
    expect(Object.values(next.board).filter(o => o?.type === 'being')).toHaveLength(0);
  });

  it('rejects a count above maxCount or below 0', () => {
    const state = baseState({ players: { A: player({ lifespan: 20 }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    const tooHigh = gameReducer(opened, { type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value: 4 }); // maxCount is floor(19/5)=3
    expect(tooHigh.pendingChoice.kind).toBe('legion-onset-choose-count'); // rejected, still pending
    const negative = gameReducer(opened, { type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value: -1 });
    expect(negative.pendingChoice.kind).toBe('legion-onset-choose-count');
  });

  it('triggers Ravenous Lamtukka\'s "Whenever you pay Lifespan gain +1/+1" off the token-count Lifespan payment', () => {
    const lamtukka = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'lam#0', name: 'Ravenous Lamtukka', keywords: { onLifespanPaidGrowth: { strength: 1, lifespan: 1 } } }), currentLifespan: 2, engaged: false };
    const state = baseState({ board: { r1c2: lamtukka }, players: { A: player({ lifespan: 20 }), B: player() } });
    const opened = resolveOrLogEffect(state, 'A', "Legion's Onset", text, 'Prophecy', {});
    const next = gameReducer(opened, { type: 'RESOLVE_LEGION_ONSET_CHOOSE_COUNT', value: 1 });
    expect(next.board.r1c2.permanentBonus).toEqual({ strength: 1, lifespan: 1 });
  });
});

describe('Thirteenth wave: Smithing Tools — two bare activated abilities on a Relic', () => {
  const smithingToolsCard = (overrides = {}) => ({
    id: 'st', instanceId: 'st#0', name: 'Smithing Tools', kind: 'relic', castingCost: { bleeding: 2, colored: {} },
    keywords: {
      engageBeingGrantCounter: { amount: 1, counterType: 'forge' },
      removeCountersXSearchArmament: { counterType: 'forge' },
    },
    ...overrides,
  });
  const smithingTools = (counters = {}) => ({ type: 'relic', ownerId: 'A', card: smithingToolsCard(), engaged: false, counters });

  describe('"Engage a Being, Gain (1) Forge Counter."', () => {
    it('offers the ability whenever an un-Engaged Being exists, regardless of Smithing Tools\' own engaged state', () => {
      const being = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b#0' }), currentLifespan: 3, engaged: false };
      const state = baseState({ board: { r2c1: smithingTools(), r2c2: being } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER' && a.cellId === 'r2c1')).toBe(true);
      const engagedTools = baseState({ board: { r2c1: { ...smithingTools(), engaged: true }, r2c2: being } });
      expect(getLegalActions(engagedTools, 'A').some(a => a.type === 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER')).toBe(true);
    });

    it('is not offered with no un-Engaged Being to Engage', () => {
      const state = baseState({ board: { r2c1: smithingTools() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER')).toBe(false);
    });

    it('a single candidate: Engages it directly and grants the counter', () => {
      const being = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b#0' }), currentLifespan: 3, engaged: false };
      const state = baseState({ board: { r2c1: smithingTools(), r2c2: being } });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER', cellId: 'r2c1' });
      expect(next.board.r2c2.engaged).toBe(true);
      expect(next.board.r2c1.counters.forge).toBe(1);
      expect(next.pendingChoice).toBeNull();
    });

    it('multiple candidates: opens a real choice of which to Engage', () => {
      const b1 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b1#0' }), currentLifespan: 3, engaged: false };
      const b2 = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'b2#0' }), currentLifespan: 3, engaged: false };
      const state = baseState({ board: { r2c1: smithingTools({ forge: 2 }), r2c2: b1, r2c3: b2 } });
      const opened = gameReducer(state, { type: 'ACTIVATE_ENGAGE_BEING_GRANT_COUNTER', cellId: 'r2c1' });
      expect(opened.pendingChoice).toEqual({ kind: 'engage-grant-counter-source', playerId: 'A', cardName: 'Smithing Tools', selfCellId: 'r2c1', counterType: 'forge', amount: 1 });
      const legal = getLegalActions(opened, 'A');
      expect(legal).toContainEqual({ type: 'RESOLVE_ENGAGE_GRANT_COUNTER_SOURCE', cellId: 'r2c2' });
      expect(legal).toContainEqual({ type: 'RESOLVE_ENGAGE_GRANT_COUNTER_SOURCE', cellId: 'r2c3' });
      const next = gameReducer(opened, { type: 'RESOLVE_ENGAGE_GRANT_COUNTER_SOURCE', cellId: 'r2c3' });
      expect(next.board.r2c3.engaged).toBe(true);
      expect(next.board.r2c2.engaged).toBe(false); // the OTHER candidate untouched
      expect(next.board.r2c1.counters.forge).toBe(3); // 2 already there + 1 granted
    });
  });

  describe('"Engage, Remove (X) Forge Counters: Add an Armament from deck to hand with conjuring cost (X)."', () => {
    it('is not offered while already Engaged, or with 0 Forge Counters', () => {
      const engagedState = baseState({ board: { r2c1: { ...smithingTools({ forge: 2 }), engaged: true } } });
      expect(getLegalActions(engagedState, 'A').some(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT')).toBe(false);
      const noCountersState = baseState({ board: { r2c1: smithingTools() } });
      expect(getLegalActions(noCountersState, 'A').some(a => a.type === 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT')).toBe(false);
    });

    it('Engages itself and opens the numeric-choice UI bounded by its own current Forge Counter count', () => {
      const state = baseState({ board: { r2c1: smithingTools({ forge: 3 }) } });
      const next = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT', cellId: 'r2c1' });
      expect(next.board.r2c1.engaged).toBe(true);
      expect(next.pendingChoice).toEqual({
        kind: 'choose-x-value', playerId: 'A', cardName: 'Smithing Tools', maxX: 3,
        effect: 'search-armament-cost-x-via-counters', cellId: 'r2c1', counterType: 'forge',
      });
    });

    it('choosing X removes that many Forge Counters (not Essence) and searches for an Armament costing exactly X', () => {
      const armament2 = { id: 'a2', instanceId: 'a2#0', name: 'Two Cost Armament', kind: 'relic-armament', typing: 'Relic, Armament', castingCost: { faithless: 2, colored: {} } };
      const state = baseState({
        board: { r2c1: smithingTools({ forge: 3 }) },
        players: { A: player({ mainDeck: [armament2] }), B: player() },
      });
      const opened = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT', cellId: 'r2c1' });
      const next = gameReducer(opened, { type: 'RESOLVE_CHOOSE_X_VALUE', value: 2 });
      expect(next.board.r2c1.counters.forge).toBe(1); // 3 - 2
      expect(next.pendingChoice).toEqual({ kind: 'search', playerId: 'A', source: 'mainDeck', query: 'Armament', costFilter: 2, cardName: 'Smithing Tools' });
      const resolved = gameReducer(next, { type: 'RESOLVE_CHOICE', instanceId: 'a2#0' });
      expect(resolved.players.A.hand.some(c => c.instanceId === 'a2#0')).toBe(true);
    });

    it('rejects a value above the actual Forge Counter count', () => {
      const state = baseState({ board: { r2c1: smithingTools({ forge: 2 }) } });
      const opened = gameReducer(state, { type: 'ACTIVATE_REMOVE_COUNTERS_X_SEARCH_ARMAMENT', cellId: 'r2c1' });
      const rejected = gameReducer(opened, { type: 'RESOLVE_CHOOSE_X_VALUE', value: 3 });
      expect(rejected.pendingChoice).not.toBeNull(); // still pending, nothing spent
      expect(rejected.board.r2c1.counters.forge).toBe(2);
    });
  });
});

describe('Fourteenth wave: Appease the Masses — "All cards cost (-1) Faithless", a board-wide cost-reduction aura', () => {
  const appeaseTheMasses = (overrides = {}) => ({
    type: 'prophecy', ownerId: 'A', faceDown: false, timer: 1,
    card: { name: 'Appease the Masses', textBox: 'Gain (1) Time Counter\nAll cards cost (-1) Faithless.', keywords: { allCardsCostReduction: { amount: 1, color: 'faithless' } } },
    ...overrides,
  });

  it('reduces a Being\'s effective casting cost by 1 Faithless, floored at 0', () => {
    const being = { id: 'b1', instanceId: 'b1#0', name: 'Cheap Being', kind: 'being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 1, arrows: [1] };
    const state = baseState({ board: { r3c1: appeaseTheMasses() }, players: { A: player({ hand: [being] }), B: player() } });
    expect(effectiveCastingCost(being, state, 'A')).toEqual({ faithless: 0, colored: {} });
    const zeroCostBeing = { ...being, castingCost: { faithless: 0, colored: {} } };
    expect(effectiveCastingCost(zeroCostBeing, state, 'A')).toEqual({ faithless: 0, colored: {} }); // never goes negative
  });

  it('does not reduce a colored (non-Faithless) portion of the cost', () => {
    const being = { id: 'b1', instanceId: 'b1#0', name: 'Colored Being', kind: 'being', castingCost: { faithless: 1, colored: { bleeding: 2 } }, strength: 1, lifespan: 1, arrows: [1] };
    const state = baseState({ board: { r3c1: appeaseTheMasses() } });
    expect(effectiveCastingCost(being, state, 'A')).toEqual({ faithless: 0, colored: { bleeding: 2 } });
  });

  it('only applies to the controller of the face-up Prophecy, not their opponent', () => {
    const being = { id: 'b1', instanceId: 'b1#0', name: 'Cheap Being', kind: 'being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 1, arrows: [1] };
    const state = baseState({ board: { r3c1: appeaseTheMasses() } });
    expect(effectiveCastingCost(being, state, 'B')).toEqual({ faithless: 1, colored: {} });
  });

  it('does nothing while face-down or out of Time Counters', () => {
    const being = { id: 'b1', instanceId: 'b1#0', name: 'Cheap Being', kind: 'being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 1, arrows: [1] };
    const faceDown = baseState({ board: { r3c1: appeaseTheMasses({ faceDown: true }) } });
    expect(effectiveCastingCost(being, faceDown, 'A')).toEqual({ faithless: 1, colored: {} });
    const outOfCounters = baseState({ board: { r3c1: appeaseTheMasses({ timer: 0 }) } });
    expect(effectiveCastingCost(being, outOfCounters, 'A')).toEqual({ faithless: 1, colored: {} });
  });

  it('lets a Being with 0 affordable Faithless actually get cast for real, via SUMMON_BEING', () => {
    const being = { id: 'b1', instanceId: 'b1#0', name: 'Cheap Being', kind: 'being', castingCost: { faithless: 1, colored: {} }, strength: 1, lifespan: 1, arrows: [1] };
    const state = baseState({ board: { r3c1: appeaseTheMasses() }, players: { A: player({ hand: [being], effigyPool: [] }), B: player() } });
    expect(getLegalActions(state, 'A').some(a => a.type === 'SUMMON_BEING' && a.instanceId === 'b1#0')).toBe(true);
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'b1#0', cellId: 'r1c2' });
    expect(next.players.A.hand).toHaveLength(0); // really summoned, no Essence spent
  });

  it('also reduces a Relic\'s (PLACE_RELIC), Prophecy\'s (PLAY_PROPHECY), Altar\'s (PLACE_ALTAR), and Armament\'s (ATTACH_ARMAMENT) real payment, not just the affordability check', () => {
    const relic = { id: 'r1', instanceId: 'r1#0', name: 'Cheap Relic', kind: 'relic', castingCost: { faithless: 1, colored: {} } };
    const prophecy = { id: 'p1', instanceId: 'p1#0', name: 'Cheap Prophecy', kind: 'prophecy', castingCost: { faithless: 1, colored: {} }, timerMax: 1 };
    const altar = { id: 'al1', instanceId: 'al1#0', name: 'Cheap Altar', kind: 'altar', castingCost: { faithless: 1, colored: {} } };
    const armament = { id: 'ar1', instanceId: 'ar1#0', name: 'Cheap Armament', kind: 'relic-armament', castingCost: { faithless: 1, colored: {} } };

    const relicState = baseState({ board: { r3c1: appeaseTheMasses() }, players: { A: player({ hand: [relic], effigyPool: [] }), B: player() } });
    const afterRelic = gameReducer(relicState, { type: 'PLACE_RELIC', instanceId: 'r1#0', cellId: 'r2c1' });
    expect(afterRelic.board.r2c1.card.name).toBe('Cheap Relic');

    const prophecyState = baseState({ board: { r3c1: appeaseTheMasses() }, players: { A: player({ hand: [prophecy], effigyPool: [] }), B: player() } });
    const afterProphecy = gameReducer(prophecyState, { type: 'PLAY_PROPHECY', instanceId: 'p1#0', cellId: 'r3c2' });
    expect(afterProphecy.board.r3c2.card.name).toBe('Cheap Prophecy');

    const altarState = baseState({ board: { r3c1: appeaseTheMasses() }, players: { A: player({ hand: [altar], effigyPool: [] }), B: player() } });
    const afterAltar = gameReducer(altarState, { type: 'PLACE_ALTAR', instanceId: 'al1#0' });
    expect(afterAltar.altars.A).toHaveLength(1);

    const armamentState = baseState({ board: { r3c1: appeaseTheMasses() }, players: { A: player({ hand: [armament], effigyPool: [] }), B: player() } });
    const afterArmament = gameReducer(armamentState, { type: 'ATTACH_ARMAMENT', instanceId: 'ar1#0', cellId: 'r2c1' });
    expect(afterArmament.board.r2c1.armaments[0].card.name).toBe('Cheap Armament');
  });
});

describe('Fifteenth wave: Sha-KaRah — "Pay (5) Lifespan to move an adjacent Armament one tile in any direction."', () => {
  const shaKaRah = (overrides = {}) => ({
    type: 'being', ownerId: 'A',
    card: beingCard({ instanceId: 'sk#0', name: 'Sha-KaRah', keywords: { payLifespanCostAbility: { amount: 5, effect: 'move an adjacent Armament one tile in any direction.' } } }),
    currentLifespan: 3, engaged: false, ...overrides,
  });
  const armamentPile = (ownerId, name = 'Some Armament') => ({
    type: 'armament-stack', ownerId, armaments: [{ card: { id: 'am', instanceId: `${name}#0`, name, kind: 'relic-armament' }, engaged: false }],
  });

  it('offers the ability when Lifespan allows, not when it would drop to 0', () => {
    const affordable = baseState({ board: { r2c2: shaKaRah() }, players: { A: player({ lifespan: 10 }), B: player() } });
    expect(getLegalActions(affordable, 'A').some(a => a.type === 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY' && a.cellId === 'r2c2')).toBe(true);
    const tooLow = baseState({ board: { r2c2: shaKaRah() }, players: { A: player({ lifespan: 5 }), B: player() } });
    expect(getLegalActions(tooLow, 'A').some(a => a.type === 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY')).toBe(false);
  });

  it('a single adjacent Armament: pays the Lifespan and, with several open destination tiles, opens the destination choice', () => {
    // r2c3 is adjacent to r2c2 (direction 3); r2c5 is NOT adjacent (3 tiles away).
    const state = baseState({
      board: { r2c2: shaKaRah(), r2c3: armamentPile('A', 'Adjacent Armament'), r2c5: armamentPile('A', 'Distant Armament') },
      players: { A: player({ lifespan: 10 }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY', cellId: 'r2c2' });
    expect(next.players.A.lifespan).toBe(5); // 10 - 5
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'move-armament-destination', fromCellId: 'r2c3', armamentInstanceId: 'Adjacent Armament#0' }));
  });

  it('either owner\'s adjacent Armament is a legal source — no "you control" restriction', () => {
    const state = baseState({
      board: { r2c2: shaKaRah(), r2c3: armamentPile('B', 'Enemy Armament') },
      players: { A: player({ lifespan: 10 }), B: player() },
    });
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY', cellId: 'r2c2' });
    expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'move-armament-destination', fromCellId: 'r2c3' }));
  });

  it('more than one adjacent Armament: opens a real choice of which to move, restricted to adjacent tiles only', () => {
    const state = baseState({
      board: { r2c2: shaKaRah(), r2c3: armamentPile('A', 'East'), r1c2: armamentPile('B', 'North'), r2c5: armamentPile('A', 'Distant, not adjacent') },
      players: { A: player({ lifespan: 10 }), B: player() },
    });
    const opened = gameReducer(state, { type: 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY', cellId: 'r2c2' });
    expect(opened.pendingChoice).toEqual({ kind: 'move-adjacent-armament-source', playerId: 'A', cardName: 'Sha-KaRah', label: 'ability', selfCellId: 'r2c2' });
    const legal = getLegalActions(opened, 'A');
    expect(legal).toContainEqual({ type: 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE', cellId: 'r2c3', armamentInstanceId: 'East#0' });
    expect(legal).toContainEqual({ type: 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE', cellId: 'r1c2', armamentInstanceId: 'North#0' });
    expect(legal.some(a => a.armamentInstanceId === 'Distant, not adjacent#0')).toBe(false); // 2 tiles away — excluded
    const resolved = gameReducer(opened, { type: 'RESOLVE_MOVE_ADJACENT_ARMAMENT_SOURCE', cellId: 'r1c2', armamentInstanceId: 'North#0' });
    expect(resolved.pendingChoice).toEqual(expect.objectContaining({ kind: 'move-armament-destination', fromCellId: 'r1c2', armamentInstanceId: 'North#0' }));
  });

  it('no adjacent Armament: still pays the Lifespan, then honestly logs nothing to move', () => {
    const state = baseState({ board: { r2c2: shaKaRah() }, players: { A: player({ lifespan: 10 }), B: player() } });
    const next = gameReducer(state, { type: 'ACTIVATE_PAY_LIFESPAN_COST_ABILITY', cellId: 'r2c2' });
    expect(next.players.A.lifespan).toBe(5); // paid regardless — matches this file's "still taps/spends, still gracefully no-ops" precedent
    expect(next.log.some(e => e.message.includes('no adjacent Armament'))).toBe(true);
  });
});

describe('Sixteenth wave: Afterimage — "Whenever target Being moves this turn, summon an Afterimage token on the tile it moved from"', () => {
  const afterimageText = 'Whenever target Being moves this turn, summon an Afterimage token on the tile it moved from.';
  const mover = (ownerId = 'A') => ({ type: 'being', ownerId, card: beingCard({ instanceId: 'mv#0', arrows: [3] }), currentLifespan: 3, engaged: false });

  it('a single candidate: watches it directly, no choice needed', () => {
    const state = baseState({ board: { r4c2: mover() } });
    const next = resolveOrLogEffect(state, 'A', 'Afterimage', afterimageText, 'Conjuring', {});
    expect(next.board.r4c2.afterimageWatchOwnerId).toBe('A');
  });

  it('more than one candidate: opens a real choice', () => {
    const other = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'ot#0' }), currentLifespan: 3, engaged: false };
    const state = baseState({ board: { r4c2: mover(), r1c1: other } });
    const opened = resolveOrLogEffect(state, 'A', 'Afterimage', afterimageText, 'Conjuring', {});
    expect(opened.pendingChoice).toEqual({ kind: 'afterimage-target', playerId: 'A', cardName: 'Afterimage', label: 'Conjuring' });
    const next = gameReducer(opened, { type: 'RESOLVE_AFTERIMAGE_TARGET', cellId: 'r4c2' });
    expect(next.board.r4c2.afterimageWatchOwnerId).toBe('A');
    expect(next.board.r1c1.afterimageWatchOwnerId).toBeUndefined();
  });

  it('a watched Being moving creates a real Afterimage token on the vacated tile, owned by the CASTER even when a different player\'s Being is the one watched', () => {
    // Watched Being belongs to A and is moved on A's own turn; Afterimage
    // was cast by B (afterimageWatchOwnerId: 'B') — the resulting token
    // must belong to B, the caster, not A, the mover's own controller.
    const watched = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mv#0', arrows: [3] }), currentLifespan: 3, engaged: false, afterimageWatchOwnerId: 'B' };
    const state = baseState({ turnPlayer: 'A', board: { r4c2: watched } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c2', toCellId: 'r4c3', direction: 3, isAttack: false });
    expect(next.board.r4c3.card.instanceId).toBe('mv#0'); // the mover itself, relocated
    expect(next.board.r4c2.type).toBe('being');
    expect(next.board.r4c2.card.name).toBe('AfterImage'); // the token, at the now-vacated tile
    expect(next.board.r4c2.ownerId).toBe('B'); // the CASTER's token, not A's (the mover's own owner)
    expect(next.board.r4c2.counters.time).toBe(2);
  });

  it('an unwatched Being moving creates no token', () => {
    const state = baseState({ board: { r4c2: mover() } });
    const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c2', toCellId: 'r4c3', direction: 3, isAttack: false });
    expect(next.board.r4c2).toBeUndefined();
  });

  it('the token self-sacrifices once its own Time Counters tick to 0 (2 of its controller\'s own turns after creation)', () => {
    const afterimageTokenCard = beingCard({ instanceId: 'ai#0', name: 'AfterImage', strength: 0, lifespan: 3, arrows: [], keywords: { sacrificeAtZeroTimeCounters: true } });
    const token = { type: 'being', ownerId: 'A', card: afterimageTokenCard, currentLifespan: 3, engaged: false, counters: { time: 2 } };
    let state = baseState({ turnNumber: 3, turnPlayer: 'A', board: { r4c2: token }, players: { A: player({ mainDeck: [] }), B: player() } });
    state = beginTurn({ ...state, turnPlayer: 'A' }); // tick 2 -> 1
    expect(state.board.r4c2?.counters?.time).toBe(1);
    state = { ...state, turnPlayer: 'B' };
    state = beginTurn(state); // opponent's turn — no tick (owner-scoped)
    expect(state.board.r4c2?.counters?.time).toBe(1);
    state = { ...state, turnPlayer: 'A' };
    state = beginTurn(state); // tick 1 -> 0, then sacrificed
    expect(state.board.r4c2).toBeUndefined();
    expect(state.players.A.purgatory.some(c => c.name === 'AfterImage')).toBe(true);
  });

  it('the watch flag is cleared at end of turn — a move on a LATER turn creates no further token', () => {
    const watched = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'mv#0', arrows: [3] }), currentLifespan: 3, engaged: false, afterimageWatchOwnerId: 'A' };
    const state = baseState({ turnPlayer: 'A', board: { r4c2: watched }, players: { A: player({ mainDeck: [] }), B: player() } });
    const afterEndTurn = endTurn(state);
    expect(afterEndTurn.board.r4c2.afterimageWatchOwnerId).toBeUndefined();
  });
});

describe('Seventeenth wave: Kalmahka — "Armaments you control are 3/1 Relic - Armaments with \'Animated. Attached Being has +0/+0\' and lose all other text"', () => {
  const kalmahkaProphecy = (overrides = {}) => ({
    type: 'prophecy', ownerId: 'A',
    card: { name: 'Kalmahka', instanceId: 'km#0', keywords: { armamentIdentityOverride: true } },
    timer: 2, faceDown: false,
    ...overrides,
  });
  const martyrArmament = equip({
    id: 'ma', instanceId: 'ma#0', name: 'Real Armament', kind: 'relic-armament', castingCost: { colored: {} },
    keywords: { martyr: 'Craft (1) Effigy.', statBonus: { strength: 5, lifespan: 2 } },
  });

  it('overrides an Armament the controller owns to a vanilla 3/1 Animated pile with no other text', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [martyrArmament] };
    const state = baseState({ board: { r3c1: kalmahkaProphecy(), r2c1: wearer } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    const entry = next.board.r2c1.armaments[0];
    expect(entry.card.strength).toBe(3);
    expect(entry.card.lifespan).toBe(1);
    expect(entry.card.keywords.animated).toBe(true);
    expect(entry.card.keywords.martyr).toBeUndefined(); // lost, along with its own stat bonus
    expect(entry.card.instanceId).toBe('ma#0'); // preserved for game-logic tracking
  });

  it('neutralizes the Armament\'s own stat bonus to the wearer (now +0/+0, not the real +5/+2)', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', strength: 2 }), currentLifespan: 3, engaged: false, armaments: [martyrArmament] };
    const state = baseState({ board: { r3c1: kalmahkaProphecy(), r2c1: wearer } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(effectiveStrength(next.board.r2c1)).toBe(2); // 2 + 0, not 2 + 5
  });

  it('does not override the opponent\'s own Armaments', () => {
    const enemyWearer = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [martyrArmament] };
    const state = baseState({ board: { r3c1: kalmahkaProphecy(), r4c1: enemyWearer } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(next.board.r4c1.armaments[0].card.keywords.martyr).toBe('Craft (1) Effigy.'); // untouched
  });

  it('grants nothing while face-down', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [martyrArmament] };
    const state = baseState({ board: { r3c1: kalmahkaProphecy({ faceDown: true }), r2c1: wearer } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(next.board.r2c1.armaments[0].card.keywords.martyr).toBe('Craft (1) Effigy.');
  });

  it('reverts to the real original card the instant the source Prophecy leaves play', () => {
    const wearer = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0' }), currentLifespan: 3, engaged: false, armaments: [martyrArmament] };
    const state = baseState({ board: { r3c1: kalmahkaProphecy(), r2c1: wearer } });
    const overridden = gameReducer(state, RECOMPUTE_ONLY);
    expect(overridden.board.r2c1.armaments[0].card.keywords.martyr).toBeUndefined();
    // Kalmahka itself is removed (its Prophecy expired/left play) — the very
    // next recompute must restore the real card, not leave it warped forever.
    const kalmahkaGone = { ...overridden, board: { r2c1: overridden.board.r2c1 } };
    const restored = gameReducer(kalmahkaGone, RECOMPUTE_ONLY);
    expect(restored.board.r2c1.armaments[0].card).toEqual(martyrArmament.card);
    expect(restored.board.r2c1.armaments[0].kalmahkaOriginalCard).toBeUndefined();
  });

  it('also overrides a freestanding (Being-less) Armament pile, not just an attached one', () => {
    const pile = { type: 'armament-stack', ownerId: 'A', armaments: [martyrArmament] };
    const state = baseState({ board: { r3c1: kalmahkaProphecy(), r2c1: pile } });
    const next = gameReducer(state, RECOMPUTE_ONLY);
    expect(next.board.r2c1.armaments[0].card.strength).toBe(3);
  });

  describe('the synthetic override card must never leak into a permanent zone (Purgatory) once the real Armament actually dies', () => {
    // Regression: dying while overridden used to push the synthetic
    // "Warped Armament" stand-in (no castingCost, no real identity) into
    // Purgatory instead of the real card underneath (kalmahkaOriginalCard)
    // — self-play found this crashing later (canPayCost reading .colored
    // off the missing castingCost) the moment that fake card got searched
    // back to hand by an unrelated effect (Crucible).
    it('combat death of an overridden, Animated (via the override itself) freestanding pile sends the REAL card to Purgatory, not "Warped Armament"', () => {
      const pile = { type: 'armament-stack', ownerId: 'A', armaments: [{ ...martyrArmament, currentLifespan: 1 }] };
      const attacker = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'atk#0', strength: 5, lifespan: 10 }), currentLifespan: 10, engaged: false };
      const state = baseState({ turnPlayer: 'B', board: { r3c1: kalmahkaProphecy(), r2c1: pile, r4c1: attacker } });
      const overridden = gameReducer(state, RECOMPUTE_ONLY);
      expect(overridden.board.r2c1.armaments[0].card.name).toBe('Warped Armament'); // confirms the override really is active
      let next;
      expect(() => {
        next = gameReducer(overridden, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
      }).not.toThrow();
      expect(next.board.r2c1).toBeUndefined(); // the 3/1 pile dies to a 5-Strength attacker
      const purgatoryNames = next.players.A.purgatory.map(c => c.name);
      expect(purgatoryNames).toContain('Real Armament');
      expect(purgatoryNames).not.toContain('Warped Armament');
      expect(next.players.A.purgatory.find(c => c.name === 'Real Armament').castingCost).toBeDefined();
    });
  });
});

describe('Eighteenth wave: Ethereal Conjuring reactive timing (priority window)', () => {
  const etherealConjuring = (overrides = {}) => ({
    id: 'ec', instanceId: 'ec#0', name: 'Test Ethereal', kind: 'ethereal-conjuring',
    castingCost: { faithless: 0, colored: {} }, textBox: 'Gain 3 Lifespan.', ...overrides,
  });
  const summonableBeing = (overrides = {}) => ({
    id: 'sb', instanceId: 'sb#0', name: 'Summonable', kind: 'being',
    castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 1, timerMax: 0, arrows: [1], ...overrides,
  });

  it('a normal action by A opens a window for B when B holds an affordable Ethereal Conjuring', () => {
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ hand: [summonableBeing()] }), B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' })] }) },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c2' });
    expect(next.board.r1c2.card.name).toBe('Summonable'); // the summon itself still went through normally
    expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    // The window carries a human-readable description of what A just did,
    // so B's UI can say what they're being asked to respond to (Match.jsx's
    // own Respond banner, above the Pass Priority button) instead of B
    // having to guess.
    expect(next.reactiveWindow.triggerDescription).toContain('Summonable');
    const legal = getLegalActions(next, 'B');
    expect(legal).toContainEqual({ type: 'PASS_PRIORITY' });
    expect(legal).toContainEqual({ type: 'CAST_CONJURING', instanceId: 'ec-b#0' });
    expect(getLegalActions(next, 'A')).toEqual([]); // A has no actions while B holds the window
  });

  it('auto-closes within the same dispatch when the opponent has nothing to cast — invisible in practice', () => {
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ hand: [summonableBeing()] }), B: player({ hand: [] }) },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c2' });
    expect(next.reactiveWindow).toBeNull();
  });

  it('auto-closes when the opponent holds an Ethereal Conjuring but can\'t afford it', () => {
    const unaffordable = etherealConjuring({ instanceId: 'ec-b#0', castingCost: { faithless: 5, colored: {} } });
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ hand: [summonableBeing()] }), B: player({ hand: [unaffordable], effigyPool: [] }) },
    });
    const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c2' });
    expect(next.reactiveWindow).toBeNull();
  });

  it('a real reactive cast resolves through the exact same CAST_CONJURING/resolveOrLogEffect pipeline as a normal cast', () => {
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ hand: [summonableBeing()] }), B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' })], lifespan: 50 }) },
    });
    const opened = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c2' });
    const next = gameReducer(opened, { type: 'CAST_CONJURING', instanceId: 'ec-b#0' });
    expect(next.players.B.lifespan).toBe(53); // the real effect really applied
    expect(next.players.B.hand).toHaveLength(0);
    expect(next.players.B.purgatory).toHaveLength(1);
  });

  it('an explicit PASS_PRIORITY closes the window outright, returning control to the active player', () => {
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ hand: [summonableBeing()] }), B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' })] }) },
    });
    const opened = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c2' });
    const next = gameReducer(opened, { type: 'PASS_PRIORITY' });
    expect(next.reactiveWindow).toBeNull();
  });

  it('chains: B casts, priority flips to A; A casts back, priority flips to B; B declines, window closes', () => {
    let state = baseState({
      turnPlayer: 'A',
      players: {
        A: player({ hand: [summonableBeing(), etherealConjuring({ instanceId: 'ec-a#0' })], lifespan: 50 }),
        // B holds a second Ethereal Conjuring too, so the final PASS_PRIORITY
        // below is a real decline, not just running out of cards.
        B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' }), etherealConjuring({ instanceId: 'ec-b2#0' })], lifespan: 50 }),
      },
    });
    state = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'sb#0', cellId: 'r1c2' });
    expect(state.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    state = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ec-b#0' });
    expect(state.players.B.lifespan).toBe(53);
    expect(state.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'A' })); // flipped back — A may respond to B's cast
    state = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'ec-a#0' });
    expect(state.players.A.lifespan).toBe(53);
    expect(state.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' })); // flipped again — B may respond to A's cast
    state = gameReducer(state, { type: 'PASS_PRIORITY' });
    expect(state.reactiveWindow).toBeNull(); // B declines — the whole chain closes
  });

  it('never opens during the mulligan phase', () => {
    const state = baseState({
      phase: 'mulligan',
      players: { A: player({ keptHand: false }), B: player({ keptHand: false, hand: [etherealConjuring({ instanceId: 'ec-b#0' })] }) },
    });
    const next = gameReducer(state, { type: 'KEEP_HAND', player: 'A' });
    expect(next.reactiveWindow).toBeNull();
  });

  it('never opens once the game is already won', () => {
    const winner = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'w#0', strength: 100 }), currentLifespan: 5, engaged: false };
    const state = baseState({
      turnPlayer: 'A',
      board: { r4c1: winner },
      players: { A: player({ hand: [summonableBeing({ instanceId: 'sb2#0' })] }), B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' })], lifespan: 3 }) },
    });
    // Attacking now declares first (Phase 3 of the priority-window rework
    // — see the approved plan): the game genuinely isn't won yet at this
    // point (combat hasn't resolved), and B holds a real response, so the
    // window correctly opens here — exactly the point of this phase, a
    // real chance to respond before what would otherwise be lethal damage
    // lands. B declines, letting the attack resolve for real.
    const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(declared.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    expect(declared.winner).toBeNull();
    const next = gameReducer(declared, { type: 'PASS_PRIORITY' });
    expect(next.winner).toBe('A');
    expect(next.reactiveWindow).toBeNull(); // no window re-opens once the game is actually won
  });

  it('never opens while a pendingChoice is still being resolved — only once the whole chain finishes', () => {
    const armament0 = { id: 'a0', instanceId: 'a0#0', name: 'Free Armament', kind: 'relic-armament', typing: 'Relic, Armament', castingCost: { faithless: 0, colored: {} } };
    const searchConjuring = { id: 'sc', instanceId: 'sc#0', name: 'Search Conjuring', kind: 'conjuring', castingCost: { faithless: 0, colored: {} }, textBox: 'Add an Armament to hand from deck.' };
    const state = baseState({
      turnPlayer: 'A',
      players: {
        A: player({ hand: [searchConjuring], mainDeck: [armament0] }),
        B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' })] }),
      },
    });
    const midChoice = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'sc#0' });
    expect(midChoice.pendingChoice).toEqual(expect.objectContaining({ kind: 'search' }));
    expect(midChoice.reactiveWindow).toBeNull(); // not yet — the choice hasn't finished
    const resolved = gameReducer(midChoice, { type: 'RESOLVE_CHOICE', instanceId: 'a0#0' });
    expect(resolved.pendingChoice).toBeNull();
    expect(resolved.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' })); // NOW it opens, for A's real opponent
  });

  it('does not open around PASS_TURN — the begin/endTurn pipeline stays atomic', () => {
    const state = baseState({
      turnPlayer: 'A',
      players: { A: player({ lifespan: 50, mainDeck: [] }), B: player({ hand: [etherealConjuring({ instanceId: 'ec-b#0' })], lifespan: 50 }) },
    });
    const next = gameReducer(state, { type: 'PASS_TURN' });
    expect(next.turnPlayer).toBe('B');
    expect(next.reactiveWindow).toBeNull();
  });

  it('a RESOLVE_* dispatched by the NON-turn-player (finishing their own pendingChoice) opens the window for the real opponent, not naively opponentOf(turnPlayer)', () => {
    // A attacks; the defender's (B's) Being Departs, opening a search
    // pendingChoice owned by B even though it's A's turn — the classic
    // "getLegalActions: it can fire on either player's turn" case.
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
    const departCard = { id: 'dep', instanceId: 'dep#0', name: 'Departing Being', kind: 'being', castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 1, timerMax: 0, arrows: [1], keywords: { depart: 'Add an Armament to hand from deck.' } };
    const defender = { type: 'being', ownerId: 'B', card: departCard, currentLifespan: 1, engaged: false };
    const armament0 = { id: 'a0', instanceId: 'a0#0', name: 'Free Armament', kind: 'relic-armament', typing: 'Relic, Armament', castingCost: { faithless: 0, colored: {} } };
    const state = baseState({
      turnPlayer: 'A',
      board: { r4c1: attacker, r2c1: defender },
      players: {
        A: player({ hand: [etherealConjuring({ instanceId: 'ec-a#0' })] }),
        B: player({ mainDeck: [armament0] }),
      },
    });
    const afterCombat = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    expect(afterCombat.pendingChoice).toEqual(expect.objectContaining({ kind: 'search', playerId: 'B' }));
    expect(afterCombat.reactiveWindow).toBeNull();
    const resolved = gameReducer(afterCombat, { type: 'RESOLVE_CHOICE', instanceId: 'a0#0' });
    expect(resolved.pendingChoice).toBeNull();
    // The real actor was B (Depart's own owner), not A (turnPlayer) — so
    // the window must open for A, B's real opponent.
    expect(resolved.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'A' }));
  });

  it('a Being flagged sacrificeAtEndOfTurn is still sacrificed regardless of its owner vs turnPlayer (Desperate Finale reactive-cast fix)', () => {
    // Simulates what a reactively-cast Desperate-Finale-shaped Ethereal
    // Conjuring would leave behind: the flagged Being belongs to the
    // NON-turn-player, since it was THEIR own cast that flagged it.
    const flagged = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'f#0', lifespan: 7 }), currentLifespan: 4, engaged: true, sacrificeAtEndOfTurn: true };
    const state = baseState({ turnPlayer: 'A', board: { r4c1: flagged }, players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) } });
    const next = endTurn(state);
    expect(next.board.r4c1).toBeUndefined();
    expect(next.players.B.purgatory.some(c => c.instanceId === 'f#0')).toBe(true);
  });

  describe('Engage abilities are also "ethereal speed" (reactive), but attacking, moving, and Shift stay conjuring/sorcery-speed only', () => {
    const engageBeing = (overrides = {}) => ({
      type: 'being', ownerId: 'B',
      card: beingCard({ instanceId: 'eb#0', name: 'Engage Being', keywords: { engage: 'Gain (1) Lifespan.', shift: { amount: 1, effect: null } } }),
      currentLifespan: 3, engaged: false, ...overrides,
    });

    it('offers ACTIVATE_ENGAGE (but not ACTIVATE_SHIFT or MOVE_OR_ATTACK) to whoever holds an open reactive window', () => {
      const state = baseState({
        turnPlayer: 'A', reactiveWindow: { openFor: 'B' },
        board: { r4c1: engageBeing() },
        players: { A: player(), B: player({ lifespan: 50 }) },
      });
      const legal = getLegalActions(state, 'B');
      expect(legal).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r4c1' });
      expect(legal.some(a => a.type === 'ACTIVATE_SHIFT')).toBe(false);
      expect(legal.some(a => a.type === 'MOVE_OR_ATTACK')).toBe(false);
    });

    it('does not offer a counter-gated Engage reactively without enough Counters either (offerReactiveEngageActions\' own copy of the same fix)', () => {
      const shortOnCounters = {
        type: 'being', ownerId: 'B',
        card: beingCard({ instanceId: 'vc#0', name: 'Void Channeler', keywords: { engageCounterCost: { type: 'crossing', amount: 3 }, engage: 'Add a Formless Being to hand from deck.' } }),
        currentLifespan: 3, engaged: false, counters: { crossing: 1 },
      };
      const state = baseState({
        turnPlayer: 'A', reactiveWindow: { openFor: 'B' },
        board: { r4c1: shortOnCounters },
        players: { A: player(), B: player() },
      });
      expect(getLegalActions(state, 'B').some(a => a.type === 'ACTIVATE_ENGAGE')).toBe(false);
    });

    it('really resolves ACTIVATE_ENGAGE while a window is open, even though it isn\'t the activator\'s own turn', () => {
      const state = baseState({
        turnPlayer: 'A', reactiveWindow: { openFor: 'B' },
        board: { r4c1: engageBeing() },
        players: { A: player(), B: player({ lifespan: 50 }) },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r4c1' });
      expect(next.board.r4c1.engaged).toBe(true);
      expect(next.players.B.lifespan).toBe(51); // its Engage effect really resolved
    });

    it('flips priority to the opponent after a reactive Engage, same as a reactive cast does', () => {
      // A needs a real option of its own or the auto-close sweep would
      // (correctly) collapse the flipped window right back to null.
      const opponentEngageBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'oeb#0', name: 'Opponent Engage Being', keywords: { engage: 'Gain (1) Lifespan.' } }), currentLifespan: 3, engaged: false };
      const state = baseState({
        turnPlayer: 'A', reactiveWindow: { openFor: 'B' },
        board: { r4c1: engageBeing(), r2c1: opponentEngageBeing },
        players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r4c1' });
      expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'A' }));
    });

    it('a mid-turn Engage by the active player itself still opens a reactive window for the opponent, offering Engage back (not just casting)', () => {
      const opponentEngageBeing = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'oeb#0', name: 'Opponent Engage Being', keywords: { engage: 'Gain (1) Lifespan.' } }), currentLifespan: 3, engaged: false };
      const state = baseState({
        turnPlayer: 'B',
        board: { r4c1: engageBeing(), r2c1: opponentEngageBeing },
        players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r4c1' });
      expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'A' }));
      expect(getLegalActions(next, 'A')).toContainEqual({ type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
    });
  });

  describe('a Conjuring\'s own additional-cost/target-availability gates apply reactively too, not just at main-phase (self-play found an infinite CAST_CONJURING ping-pong otherwise)', () => {
    const strikeDown = (instanceId) => ({
      id: 'sd', instanceId, name: 'Strike Down', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} },
      textBox: 'Destroy target blocking Being, its controller is not dealt damage when it dies; the attacking Being deals no damage.',
    });

    // Phase 3 of the priority-window rework changed WHY this is refused —
    // Strike Down is no longer gated on "does the holder have an
    // unengaged front-row Being," it's gated on "is a real attack
    // currently declared" (state.pendingResolution.kind === 'attack' —
    // see attackPendingBlockingCell) — but a defender sitting there with
    // no attack in progress at all is refused either way, so this
    // assertion still holds under the new gate too.
    it('never offers a reactive Strike Down with no attack currently declared', () => {
      const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'defender' }), currentLifespan: 5, engaged: false };
      const state = baseState({
        turnPlayer: 'B', reactiveWindow: { openFor: 'A' },
        board: { r4c1: defender },
        players: { A: player({ hand: [strikeDown('sd#0')] }), B: player() },
      });
      expect(getLegalActions(state, 'A')).not.toContainEqual({ type: 'CAST_CONJURING', instanceId: 'sd#0' });
    });

    it('never flips the reactive window on a no-op response, even if one somehow got dispatched (defense in depth in manageReactiveWindow itself)', () => {
      // Hand-forces a CAST_CONJURING through even though getLegalActions
      // (correctly, per the test above) would never offer it — this is
      // exactly the shape self-play found: the offer/reducer mismatch used
      // to let the AI "cast" Strike Down every turn, reactiveWindow flipped
      // A -> B -> A -> B forever, and the card never actually left hand.
      const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'defender' }), currentLifespan: 5, engaged: false };
      const state = baseState({
        turnPlayer: 'B', reactiveWindow: { openFor: 'A' },
        board: { r4c1: defender },
        players: { A: player({ hand: [strikeDown('sd#0')] }), B: player() },
      });
      const next = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'sd#0' });
      expect(next.players.A.hand).toHaveLength(1); // never left hand — the reducer's own gate still refused it
      expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'A' })); // did NOT flip to B
    });
  });

  // Phase 1 of the priority-window rework (see the approved plan): certain
  // declared-but-not-yet-applied effects — currently just a Being's own
  // When Summoned trigger — ride behind this SAME reactiveWindow instead
  // of resolving inline, so the opponent's window opens BEFORE the effect
  // applies, not after. Medium Mage ("When summoned if you control a
  // Prophecy deal (3) damage to target Being") + One Above All ("Target
  // Being becomes Favored") is the user's own example: the opponent
  // should be able to make the target Favored BEFORE Medium Mage's own
  // damage lands, not after it's already dead.
  describe('state.pendingResolution — deferred When Summoned triggers (Medium Mage / One Above All)', () => {
    const mediumMage = (overrides = {}) => ({
      id: 'mm', instanceId: 'mm#0', name: 'Medium Mage', kind: 'being',
      castingCost: { faithless: 0, colored: {} }, strength: 1, lifespan: 3, timerMax: 0, arrows: [1],
      keywords: { whenSummoned: 'if you control a Prophecy deal (3) damage to target Being.' },
      ...overrides,
    });
    const oneAboveAll = (overrides = {}) => ({
      id: 'oaa', instanceId: 'oaa#0', name: 'One Above All', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Target Being becomes Favored.', ...overrides,
    });
    const ownProphecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P', instanceId: 'p#0' }, timer: 2, faceDown: true };
    const targetBeing = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'tgt#0' }), currentLifespan: 4, engaged: false };

    it('summons the Being immediately but defers the When Summoned trigger, opening a real window when the opponent has a response', () => {
      const state = baseState({
        turnPlayer: 'A', board: { r3c1: ownProphecy, r4c1: targetBeing },
        players: { A: player({ hand: [mediumMage()] }), B: player({ hand: [oneAboveAll()], lifespan: 50 }) },
      });
      const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'mm#0', cellId: 'r1c2' });
      expect(next.board.r1c2.card.name).toBe('Medium Mage'); // the summon itself already happened
      expect(next.board.r4c1.currentLifespan).toBe(4); // damage NOT yet applied
      expect(next.pendingResolution).toEqual({
        kind: 'summon-being', declaringPlayer: 'A', cellId: 'r1c2', cardName: 'Medium Mage',
        whenSummonedText: 'if you control a Prophecy deal (3) damage to target Being.', instanceId: 'mm#0',
      });
      expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    });

    it('resolves the deferred damage once the opponent passes, with no response — same outcome as before this existed', () => {
      const state = baseState({
        turnPlayer: 'A', board: { r3c1: ownProphecy, r4c1: targetBeing },
        players: { A: player({ hand: [mediumMage()] }), B: player({ hand: [] }) },
      });
      // B has nothing to respond with, so this auto-closes and resolves
      // within the SAME dispatch — transparent, matching the old inline
      // behavior exactly (see the "auto-closes... invisible in practice"
      // test above for the same precedent on a plain post-hoc window).
      // Medium Mage's own "target Being" pool includes itself (no self-
      // exclusion in DAMAGE_ANY_TARGET_RE's own candidate scan) alongside
      // the real target, so resolving still needs one explicit pick —
      // same as any other 2-candidate damage effect.
      const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'mm#0', cellId: 'r1c2' });
      expect(next.pendingResolution).toBeNull();
      expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'damage-target' }));
      const resolved = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
      expect(resolved.board.r4c1.currentLifespan).toBe(1); // 4 - 3
    });

    it('the user\'s own example: the opponent makes the target Favored BEFORE the damage resolves, preventing it', () => {
      const state = baseState({
        turnPlayer: 'A', board: { r3c1: ownProphecy, r4c1: targetBeing },
        players: { A: player({ hand: [mediumMage()] }), B: player({ hand: [oneAboveAll()], lifespan: 50 }) },
      });
      const declared = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'mm#0', cellId: 'r1c2' });
      // B responds with One Above All, targeting the very Being about to
      // take Medium Mage's pending damage.
      const responded = gameReducer(declared, { type: 'CAST_CONJURING', instanceId: 'oaa#0' });
      const favored = gameReducer(responded, { type: 'RESOLVE_GRANT_FAVOR', cellId: 'r4c1' });
      expect(favored.board.r4c1.favorCounter).toBe(true);
      expect(favored.board.r4c1.currentLifespan).toBe(4); // still undamaged
      // A (the declaring player) has nothing left to add either, so the
      // window auto-closes and the deferred damage resolves within this
      // SAME dispatch — opening its own damage-target choice (Medium Mage
      // is also a legal "target Being" for its own effect), not yet
      // applying anything.
      expect(favored.reactiveWindow).toBeNull();
      expect(favored.pendingResolution).toBeNull();
      expect(favored.pendingChoice).toEqual(expect.objectContaining({ kind: 'damage-target' }));
      const resolved = gameReducer(favored, { type: 'RESOLVE_DAMAGE_TARGET', cellId: 'r4c1' });
      expect(resolved.board.r4c1.currentLifespan).toBe(4); // the Favor Counter absorbed it — 0 net damage
      expect(resolved.board.r4c1.favorCounter).toBe(false); // consumed
    });

    it('fizzles gracefully instead of crashing if the summoned Being is somehow gone by resolve time', () => {
      const state = baseState({
        turnPlayer: 'A', board: { r3c1: ownProphecy, r4c1: targetBeing },
        players: { A: player({ hand: [mediumMage()] }), B: player({ hand: [oneAboveAll()], lifespan: 50 }) },
      });
      const declared = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'mm#0', cellId: 'r1c2' });
      // Simulate Medium Mage itself having left the board by resolve time
      // (no in-scope response can currently do this — defensive coverage
      // for the re-validation guard itself).
      const goneMidWindow = { ...declared, board: { ...declared.board, r1c2: undefined } };
      const next = gameReducer(goneMidWindow, { type: 'PASS_PRIORITY' });
      expect(next.pendingResolution).toBeNull();
      expect(next.log.some(e => e.message.includes('fizzles'))).toBe(true);
      expect(next.board.r4c1.currentLifespan).toBe(4); // untouched
    });

    it('does not open pendingResolution at all for a Being with no When Summoned text', () => {
      const plainBeing = beingCard({ instanceId: 'pb#0' });
      const state = baseState({ players: { A: player({ hand: [plainBeing] }), B: player() } });
      const next = gameReducer(state, { type: 'SUMMON_BEING', instanceId: 'pb#0', cellId: 'r1c2' });
      expect(next.pendingResolution).toBeNull();
    });
  });

  // Phase 2 of the priority-window rework: a fresh ACTIVATE_ENGAGE
  // declares — costs are sunk, but the engaged-flip itself and the
  // ability's own effect are BOTH deferred, unlike Phase 1's
  // summon-being kind (which only defers the trigger, not the summon
  // itself). This is the design fork the approved plan calls out: Boknean
  // Wine's own "Engage target being" (applyEngageStatBuff) already
  // excludes already-engaged Beings from its own candidate pool, so
  // flipping `engaged: true` at declare time would make the user's own
  // negation example structurally impossible.
  describe('state.pendingResolution — deferred Engage attempts (Boknean Wine / Arbosalis Zealot)', () => {
    const arbosalisZealot = {
      type: 'being', ownerId: 'A',
      card: beingCard({ instanceId: 'az#0', name: 'Arbosalis Zealot', keywords: { engage: 'Add (1) Living Essence.' } }),
      currentLifespan: 1, engaged: false,
    };
    const boknean = (overrides = {}) => ({
      id: 'bw-1', instanceId: 'bw-1#0', name: 'Boknean Wine', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Engage target being, it has +2/+0 until end of turn.', ...overrides,
    });

    it('declares (Engage not yet applied) and opens a real window when the opponent has a response', () => {
      const state = baseState({
        board: { r2c1: arbosalisZealot },
        players: { A: player(), B: player({ hand: [boknean()] }) },
      });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      expect(next.board.r2c1.engaged).toBe(false); // NOT yet engaged
      expect(next.players.A.effigyPool).toHaveLength(0); // effect not yet applied either
      expect(next.pendingResolution).toEqual({
        kind: 'activate-engage', declaringPlayer: 'A', cellId: 'r2c1', cardName: 'Arbosalis Zealot',
        engageEffect: 'Add (1) Living Essence.', context: { selfCellId: 'r2c1' },
      });
      expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    });

    it('resolves normally (engages, applies the effect) when the opponent has no response', () => {
      const state = baseState({ board: { r2c1: arbosalisZealot }, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      expect(next.pendingResolution).toBeNull();
      expect(next.board.r2c1.engaged).toBe(true);
      expect(next.players.A.effigyPool).toHaveLength(1);
      expect(next.players.A.effigyPool[0].effigyType).toBe('living');
    });

    it('the user\'s own example: Boknean Wine engages the Zealot FIRST, negating the original Engage attempt entirely', () => {
      const state = baseState({
        board: { r2c1: arbosalisZealot },
        players: { A: player(), B: player({ hand: [boknean()], lifespan: 50 }) },
      });
      const declared = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      // B responds with Boknean Wine, targeting the very Being A is
      // trying to Engage. Only one legal target exists (the Zealot), so
      // this auto-resolves rather than opening its own pendingChoice.
      const responded = gameReducer(declared, { type: 'CAST_CONJURING', instanceId: 'bw-1#0' });
      expect(responded.board.r2c1.engaged).toBe(true); // Boknean Wine's own Engage already landed
      expect(effectiveStrength(responded.board.r2c1)).toBe(5); // +2/+0 (base 3)
      expect(responded.players.A.effigyPool).toHaveLength(0); // A's own Engage effect still hasn't resolved
      // A (the declaring player) has nothing to add either — the window
      // auto-closes and A's original Engage attempt tries to resolve,
      // finding the Zealot already Engaged.
      const resolved = gameReducer(responded, { type: 'PASS_PRIORITY' });
      expect(resolved.pendingResolution).toBeNull();
      expect(resolved.players.A.effigyPool).toHaveLength(0); // negated — no Living Essence ever added
      expect(resolved.log.some(e => e.message.includes("Arbosalis Zealot's Engage ability fails to resolve — it's already Engaged"))).toBe(true);
    });

    it('a response (ACTIVATE_ENGAGE dispatched during an open window) still resolves atomically, with no new deferred window of its own', () => {
      // The responder's OWN Being, engaged reactively — a completely
      // separate scenario from the declared attempt above, just
      // confirming a response never gets the new declare/resolve split.
      const responderBeing = {
        type: 'being', ownerId: 'B',
        card: beingCard({ instanceId: 'rb#0', name: 'Responder', keywords: { engage: 'Add (1) Formless Essence.' } }),
        currentLifespan: 3, engaged: false,
      };
      const openerConjuring = {
        id: 'oc', instanceId: 'oc#0', name: 'Test Ethereal', kind: 'ethereal-conjuring',
        castingCost: { faithless: 0, colored: {} }, textBox: 'Gain 3 Lifespan.',
      };
      const state = baseState({
        turnPlayer: 'A', board: { r4c1: responderBeing },
        players: { A: player({ hand: [openerConjuring], lifespan: 50 }), B: player() },
      });
      const declared = gameReducer(state, { type: 'CAST_CONJURING', instanceId: 'oc#0' });
      expect(declared.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
      const responded = gameReducer(declared, { type: 'ACTIVATE_ENGAGE', cellId: 'r4c1' });
      // Resolved immediately, in the SAME dispatch — no pendingResolution
      // at all, unlike a fresh declared Engage.
      expect(responded.pendingResolution).toBeNull();
      expect(responded.board.r4c1.engaged).toBe(true);
      expect(responded.players.B.effigyPool).toHaveLength(1);
    });

    it('fizzles gracefully instead of crashing if the Being is somehow gone by resolve time', () => {
      const state = baseState({
        board: { r2c1: arbosalisZealot },
        players: { A: player(), B: player({ hand: [boknean()] }) },
      });
      const declared = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      const goneMidWindow = { ...declared, board: { ...declared.board, r2c1: undefined } };
      const next = gameReducer(goneMidWindow, { type: 'PASS_PRIORITY' });
      expect(next.pendingResolution).toBeNull();
      expect(next.log.some(e => e.message.includes("fails to resolve — it's no longer on the battlefield"))).toBe(true);
    });
  });

  // Phase 3 of the priority-window rework: a normal attack now declares
  // first — the attacker engages immediately (RULES.md: "starting an
  // attack engages it"), but combat itself (mutual damage, death,
  // Depart, etc.) is deferred behind a real priority window. This phase
  // (3a) deliberately leaves resolveAttackFrom's own combat math
  // completely unchanged — Strike Down's own "the attacking Being deals
  // no damage" clause is a separate, later change.
  describe('state.pendingResolution — deferred attack resolution (attack declaration)', () => {
    const attacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'atk#0', name: 'Attacker', strength: 3, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const defender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'def#0', name: 'Defender', strength: 2, lifespan: 5 }), currentLifespan: 5, engaged: false };
    const etherealConjuring = (overrides = {}) => ({
      id: 'ec', instanceId: 'ec#0', name: 'Test Ethereal', kind: 'ethereal-conjuring',
      castingCost: { faithless: 0, colored: {} }, textBox: 'Gain 3 Lifespan.', ...overrides,
    });

    it('declares (attacker engaged, combat not yet resolved) and opens a real window when the defender has a response', () => {
      const state = baseState({
        board: { r2c1: attacker, r4c1: defender },
        players: { A: player(), B: player({ hand: [etherealConjuring()], lifespan: 50 }) },
      });
      const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      expect(next.board.r2c1.engaged).toBe(true); // engaged immediately, per RULES.md
      expect(next.board.r2c1.currentLifespan).toBe(5); // combat NOT yet resolved
      expect(next.board.r4c1.currentLifespan).toBe(5);
      expect(next.pendingResolution).toEqual({ kind: 'attack', declaringPlayer: 'A', fromCellId: 'r2c1', cardName: 'Attacker' });
      expect(next.reactiveWindow).toEqual(expect.objectContaining({ openFor: 'B' }));
    });

    it('resolves normally (real mutual combat) once the window closes with no response', () => {
      const state = baseState({ board: { r2c1: attacker, r4c1: defender }, players: { A: player(), B: player() } });
      const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      expect(next.pendingResolution).toBeNull();
      expect(next.board.r2c1.currentLifespan).toBe(3); // 5 - 2 (defender's Strength)
      expect(next.board.r4c1.currentLifespan).toBe(2); // 5 - 3 (attacker's Strength)
    });

    it('an open lane still resolves correctly once the window closes', () => {
      const state = baseState({ board: { r2c1: attacker }, players: { A: player(), B: player({ lifespan: 50 }) } });
      const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      expect(next.pendingResolution).toBeNull();
      expect(next.players.B.lifespan).toBe(47); // 50 - 3 (attacker's Strength)
    });

    it('re-validates the DEFENDER fresh at resolve time — a response that removes it changes the outcome to an open-lane hit', () => {
      const state = baseState({
        board: { r2c1: attacker, r4c1: defender },
        // B needs a real reason to hold the window open (an affordable
        // Ethereal Conjuring) — otherwise it auto-closes and resolves
        // within the same declare dispatch, leaving nothing pending for
        // this test's own "remove the defender mid-window" simulation to
        // act on.
        players: { A: player(), B: player({ hand: [etherealConjuring()], lifespan: 50 }) },
      });
      const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      expect(declared.pendingResolution).not.toBeNull();
      // Simulate a response removing the defender mid-window (no in-scope
      // card can do this yet in phase 3a — Strike Down's own removal
      // lands in phase 3b) — defensive coverage for the re-validation
      // itself, same precedent every other pendingResolution kind's own
      // fresh-refetch already has a test for.
      const defenderGone = { ...declared, board: { ...declared.board, r4c1: undefined } };
      const next = gameReducer(defenderGone, { type: 'PASS_PRIORITY' });
      expect(next.pendingResolution).toBeNull();
      expect(next.board.r2c1.currentLifespan).toBe(5); // no defender left to hit back
      expect(next.players.B.lifespan).toBe(47); // 50 - 3, straight through the now-open lane
    });

    it('fizzles gracefully instead of crashing if the ATTACKER is somehow gone by resolve time', () => {
      const state = baseState({
        board: { r2c1: attacker, r4c1: defender },
        players: { A: player(), B: player({ hand: [etherealConjuring()], lifespan: 50 }) },
      });
      const declared = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      const attackerGone = { ...declared, board: { ...declared.board, r2c1: undefined } };
      const next = gameReducer(attackerGone, { type: 'PASS_PRIORITY' });
      expect(next.pendingResolution).toBeNull();
      expect(next.log.some(e => e.message.includes("fizzles — it's no longer on the battlefield"))).toBe(true);
      expect(next.board.r4c1.currentLifespan).toBe(5); // defender untouched
    });

    it('a live aura correctly picks up a death that happens only inside the deferred resolution, not the original declare dispatch', () => {
      // Regression: gameReducer's own live-recompute chain (recomputeXBeings
      // et al.) used to run only once, on gameReducerCore's own direct
      // output — before manageReactiveWindow ever got a chance to actually
      // apply a deferred resolution (e.g. real combat damage). A Being
      // dying only inside that deferred step was invisible to a live aura
      // like this one until some LATER, unrelated dispatch happened to
      // trigger a fresh recompute.
      const restlessDead = {
        type: 'being', ownerId: 'A',
        card: beingCard({ instanceId: 'rd#0', name: 'Restless Dead', strength: 3, lifespan: 4, keywords: { statBonusPerOwnDeathThisTurn: { strength: 2, lifespan: 0 } } }),
        currentLifespan: 4, engaged: false,
      };
      const weakAttacker = { type: 'being', ownerId: 'A', card: beingCard({ instanceId: 'wa#0', strength: 1, lifespan: 1 }), currentLifespan: 1, engaged: false };
      const strongDefender = { type: 'being', ownerId: 'B', card: beingCard({ instanceId: 'sd#0', strength: 10, lifespan: 10 }), currentLifespan: 10, engaged: false };
      const state = baseState({
        board: { r2c3: restlessDead, r2c1: weakAttacker, r4c1: strongDefender },
        players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
      });
      const next = gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true });
      expect(next.board.r2c1).toBeUndefined(); // the attacker died
      expect(effectiveStrength(next.board.r2c3)).toBe(5); // 3 + 2*1 — picked up live, same dispatch
    });
  });
});

describe('Nineteenth wave: user-reported bug sweep', () => {
  describe('Cycle of Hunger: "Shuffle (2) Hungers into your deck from your Purgatory, then draw (1) card." — never offered without 2 real Hungers in Purgatory', () => {
    const cycleOfHunger = {
      id: 'coh', instanceId: 'coh#0', name: 'Cycle of Hunger', kind: 'conjuring',
      castingCost: { faithless: 1, colored: {} }, textBox: 'Shuffle (2) Hungers into your deck from your Purgatory, then draw (1) card.',
    };
    const hunger = (n) => ({ instanceId: `hunger${n}#0`, name: `Some Hunger ${n}`, kind: 'being', typing: 'Hunger, Being' });

    it('is not offered with 0 Hungers in Purgatory', () => {
      const state = baseState({ players: { A: player({ hand: [cycleOfHunger] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING' && a.instanceId === 'coh#0')).toBe(false);
    });

    it('is not offered with only 1 Hunger in Purgatory', () => {
      const state = baseState({ players: { A: player({ hand: [cycleOfHunger], purgatory: [hunger(1)] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING' && a.instanceId === 'coh#0')).toBe(false);
    });

    it('is offered once 2 Hungers are in Purgatory and the cost is payable', () => {
      const state = baseState({ players: { A: player({ hand: [cycleOfHunger], purgatory: [hunger(1), hunger(2)], effigyPool: [effigy('faithless', 1)] }), B: player() } });
      expect(getLegalActions(state, 'A').some(a => a.type === 'CAST_CONJURING' && a.instanceId === 'coh#0')).toBe(true);
    });
  });

  describe('Mausoleum Gates: "...Engage: You may summon Undead from your Purgatory until the end of your turn." still costs the Being\'s own casting cost', () => {
    const undeadCard = (cost) => ({
      instanceId: 'u1#0', name: 'Some Undead', kind: 'being', typing: 'Undead, Being',
      castingCost: { faithless: cost, colored: {} },
    });

    it('is not offered when the summon window is open but the pool can\'t afford the Being', () => {
      const state = baseState({
        board: {},
        players: { A: player({ purgatory: [undeadCard(2)], effigyPool: [], summonTypedFromPurgatoryWindows: ['Undead'] }), B: player() },
      });
      expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW')).toBe(false);
    });

    it('really spends Effigy from the pool when summoned through the window', () => {
      // Fills every one of A's 8 Mortal Realm cells but one (r2c5), so the
      // summon places immediately instead of opening a 'token-location'
      // tile-choice pendingChoice — same single-empty-tile precedent
      // summonFromPurgatoryToOpenCell's own comment documents.
      const filler = (n) => ({ type: 'being', ownerId: 'A', card: beingCard({ instanceId: `filler${n}#0` }), currentLifespan: 5, engaged: false });
      const board = {};
      ['r1c2', 'r1c3', 'r1c4', 'r2c1', 'r2c2', 'r2c3', 'r2c4'].forEach((cell, i) => { board[cell] = filler(i); });
      const state = baseState({
        board,
        players: {
          A: player({ purgatory: [undeadCard(2)], effigyPool: [effigy('faithless', 1), effigy('faithless', 2)], summonTypedFromPurgatoryWindows: ['Undead'] }),
          B: player(),
        },
      });
      expect(getLegalActions(state, 'A').some(a => a.type === 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW' && a.instanceId === 'u1#0')).toBe(true);
      const next = gameReducer(state, { type: 'ACTIVATE_SUMMON_TYPED_FROM_PURGATORY_WINDOW', instanceId: 'u1#0' });
      expect(next.players.A.effigyPool).toHaveLength(0);
      expect(next.players.A.purgatory).toHaveLength(0);
      expect(next.board.r2c5?.card?.instanceId).toBe('u1#0');
    });
  });

  describe('Modulate: a card already at 0 Time Counters is not a legal target (Dial of Metatoris on an Eònion Altar at 0)', () => {
    const dialOfMetatoris = {
      type: 'relic', ownerId: 'A',
      card: { id: 'dial', instanceId: 'dial#0', name: 'Dial of Metatoris', kind: 'relic', keywords: { engage: 'Modulate (±1) on a target you control' } },
      engaged: false,
    };

    it('excludes an Eònion Altar sitting at 0 Time Counters — with no other target, Engage fizzles instead of opening an empty Modulate choice', () => {
      const eonionAltar = { card: { instanceId: 'eonion#0', name: 'Eònion Altar' }, counters: { time: 0 } };
      let state = baseState({ board: { r2c1: dialOfMetatoris }, altars: { A: [eonionAltar], B: [] } });
      state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      expect(state.pendingChoice).toBeNull();
      expect(state.board.r2c1.engaged).toBe(true);
    });

    it('still offers a second, real target alongside an excluded 0-counter Altar', () => {
      const zeroAltar = { card: { instanceId: 'zero#0', name: 'Eònion Altar' }, counters: { time: 0 } };
      const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true };
      let state = baseState({ board: { r2c1: dialOfMetatoris, r3c1: prophecy }, altars: { A: [zeroAltar], B: [] } });
      state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      const legal = getLegalActions(state, 'A').filter(a => a.type === 'RESOLVE_MODULATE');
      expect(legal.some(a => a.altarInstanceId === 'zero#0')).toBe(false);
      expect(legal.some(a => a.cellId === 'r3c1')).toBe(true);
    });

    it('still allows a Hourglass-style relic (collectsRemovedProphecyTimeCounters) to be Modulated UP from 0', () => {
      const hourglassAtZero = { card: { instanceId: 'hg#0', name: 'Hourglass', kind: 'relic', keywords: { collectsRemovedProphecyTimeCounters: true } }, counters: { time: 0 } };
      let state = baseState({ board: { r2c1: dialOfMetatoris, r2c2: { ...hourglassAtZero, type: 'relic', ownerId: 'A', engaged: false } }, altars: { A: [], B: [] } });
      state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      const legal = getLegalActions(state, 'A').filter(a => a.type === 'RESOLVE_MODULATE');
      expect(legal.some(a => a.cellId === 'r2c2')).toBe(true);
    });

    // Regression: merely being a Prophecy (capable of holding Time
    // Counters) isn't enough on its own — isModulateTarget's own
    // `occupant.type === 'prophecy'` clause used to skip the `timer > 0`
    // check the Altar/generic-occupant branches already had, so a
    // Prophecy genuinely sitting at 0 (an edge case, but reachable) was
    // still offered as a target.
    it('excludes a Prophecy sitting at 0 Time Counters — same rule as an Altar', () => {
      const emptyProphecy = { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 0, faceDown: true };
      let state = baseState({ board: { r2c1: dialOfMetatoris, r3c1: emptyProphecy }, altars: { A: [], B: [] } });
      state = gameReducer(state, { type: 'ACTIVATE_ENGAGE', cellId: 'r2c1' });
      expect(state.pendingChoice).toBeNull(); // no legal target at all — Engage fizzles
      expect(state.board.r2c1.engaged).toBe(true);
      const legal = getLegalActions(state, 'A').filter(a => a.type === 'RESOLVE_MODULATE');
      expect(legal.some(a => a.cellId === 'r3c1')).toBe(false);
    });
  });
});
