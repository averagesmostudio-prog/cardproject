import { describe, it, expect } from 'vitest';
import { beginTurn, endTurn, checkWin } from './turn.js';
import { gameReducer, getLegalActions } from './actions.js';

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
  turnNumber: 1,
  winner: null,
  board: {},
  groundRelics: {},
  altars: { A: [], B: [] },
  log: [],
  players: { A: player({ id: 'A' }), B: player({ id: 'B' }) },
  ...overrides,
});

describe('beginTurn', () => {
  it('ticks a controlled Prophecy down by 1 without resolving it early', () => {
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 3, faceDown: true } },
    });
    const next = beginTurn(state);
    expect(next.board.r3c1.timer).toBe(2);
  });

  it('resolves a Prophecy to Purgatory when its timer hits 0', () => {
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card: { name: 'P' }, timer: 1, faceDown: true } },
    });
    const next = beginTurn(state);
    expect(next.board.r3c1).toBeUndefined();
    expect(next.players.A.purgatory).toHaveLength(1);
  });

  it('flips face up (instead of resolving to Purgatory) when its flip trigger grants new Time Counters', () => {
    const card = { name: 'Daylight Savings', textBox: 'Gain (3) Time Counters. \nDraw three Cards.\nYou do not draw during the start of your turn.', keywords: { skipsControllerDraw: true } };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card, timer: 1, faceDown: true } },
      players: { A: player({ mainDeck: [{ instanceId: 'd1' }, { instanceId: 'd2' }, { instanceId: 'd3' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r3c1).toEqual({ type: 'prophecy', ownerId: 'A', card, timer: 3, faceDown: false });
    expect(next.players.A.purgatory).toHaveLength(0); // stays in play, face up
    expect(next.players.A.hand).toHaveLength(3); // "Draw three Cards" really drew
  });

  it('a face-up Prophecy running out of its own new Time Counters resolves to Purgatory — no second effect fires', () => {
    const card = { name: 'Daylight Savings', textBox: 'Gain (3) Time Counters. \nDraw three Cards.\nYou do not draw during the start of your turn.', keywords: { skipsControllerDraw: true } };
    const state = baseState({
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card, timer: 1, faceDown: false } },
      players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r3c1).toBeUndefined();
    expect(next.players.A.purgatory).toEqual([card]);
    expect(next.players.A.hand).toHaveLength(0); // no further draw — already resolved at the flip
  });

  it('drawStep skips the draw while a face-up Prophecy with skipsControllerDraw and Time Counters remains', () => {
    const card = { name: 'Daylight Savings', textBox: 'irrelevant here', keywords: { skipsControllerDraw: true } };
    const state = baseState({
      turnNumber: 3,
      board: { r3c1: { type: 'prophecy', ownerId: 'A', card, timer: 2, faceDown: false } },
      players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.mainDeck).toHaveLength(1); // nothing drawn
  });

  it('drawStep draws normally once that same Prophecy has left the board', () => {
    const state = baseState({
      turnNumber: 3,
      players: { A: player({ mainDeck: [{ instanceId: 'd1' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.players.A.hand).toHaveLength(1);
  });

  it('disengages only the turn player\'s engaged Beings', () => {
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: { name: 'A1', strength: 1, lifespan: 1 }, currentLifespan: 1, engaged: true },
        r4c1: { type: 'being', ownerId: 'B', card: { name: 'B1', strength: 1, lifespan: 1 }, currentLifespan: 1, engaged: true },
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.engaged).toBe(false);
    expect(next.board.r4c1.engaged).toBe(true);
  });

  it('Instigator\'s "does not disengage" flag skips exactly one Disengage Step, self-consuming', () => {
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: { name: 'A1', strength: 1, lifespan: 1 }, currentLifespan: 1, engaged: true, doesNotDisengage: true },
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.engaged).toBe(true); // stayed engaged this Disengage Step
    expect(next.board.r2c1.doesNotDisengage).toBe(false); // but the flag is now spent
    const afterNextDisengage = beginTurn({ ...next, turnNumber: next.turnNumber + 1 });
    expect(afterNextDisengage.board.r2c1.engaged).toBe(false); // untaps normally next time
  });

  it('disengages only the turn player\'s engaged Relics', () => {
    const state = baseState({
      board: {
        r2c2: { type: 'relic', ownerId: 'A', card: { name: 'Dial' }, engaged: true },
        r4c2: { type: 'relic', ownerId: 'B', card: { name: 'Other Dial' }, engaged: true },
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c2.engaged).toBe(false);
    expect(next.board.r4c2.engaged).toBe(true);
  });

  it('disengages a "Beings may move across this" ground Relic too, not just board Relics (RULES.md > Being-Relic co-location)', () => {
    const state = baseState({
      groundRelics: {
        r2c3: { type: 'relic', ownerId: 'A', card: { name: 'Shifting Sands' }, engaged: true, counters: { crossing: 1 } },
        r4c3: { type: 'relic', ownerId: 'B', card: { name: 'Other Sands' }, engaged: true, counters: { crossing: 1 } },
      },
    });
    const next = beginTurn(state);
    expect(next.groundRelics.r2c3.engaged).toBe(false);
    expect(next.groundRelics.r4c3.engaged).toBe(true); // not the turn player's
  });

  it('disengages only the turn player\'s engaged Armaments, whether attached to a Being or in a freestanding pile', () => {
    const state = baseState({
      board: {
        r2c1: {
          type: 'being', ownerId: 'A', card: { name: 'Recruit', strength: 1, lifespan: 1 }, currentLifespan: 1, engaged: false,
          armaments: [{ card: { name: 'Feathers' }, engaged: true }, { card: { name: 'Rapier' }, engaged: false }],
        },
        r2c2: { type: 'armament-stack', ownerId: 'A', armaments: [{ card: { name: 'Loose Feathers' }, engaged: true }] },
        r4c1: { type: 'armament-stack', ownerId: 'B', armaments: [{ card: { name: 'Their Feathers' }, engaged: true }] },
      },
    });
    const next = beginTurn(state);
    expect(next.board.r2c1.armaments).toEqual([{ card: { name: 'Feathers' }, engaged: false }, { card: { name: 'Rapier' }, engaged: false }]);
    expect(next.board.r2c2.armaments).toEqual([{ card: { name: 'Loose Feathers' }, engaged: false }]);
    expect(next.board.r4c1.armaments).toEqual([{ card: { name: 'Their Feathers' }, engaged: true }]); // not turn player's
  });

  it('flips 2 effigies only on turn 1, else 1', () => {
    const deck = [
      { instanceId: 'e1', effigyType: 'bleeding' },
      { instanceId: 'e2', effigyType: 'living' },
      { instanceId: 'e3', effigyType: 'formless' },
    ];
    const turn1 = beginTurn(baseState({ turnNumber: 1, players: { A: player({ effigyDeck: deck }), B: player() } }));
    expect(turn1.players.A.effigyPool).toHaveLength(2);

    const turn3 = beginTurn(baseState({ turnNumber: 3, players: { A: player({ effigyDeck: deck }), B: player() } }));
    expect(turn3.players.A.effigyPool).toHaveLength(1);
  });

  it('the bonus is only for the very first turn of the game, not each player\'s own first turn', () => {
    // Turn 2 is B's first turn (A went first on turn 1) — B still only
    // flips 1, the same baseline as every other turn.
    const deck = [{ instanceId: 'e1', effigyType: 'bleeding' }, { instanceId: 'e2', effigyType: 'living' }];
    const turn2 = beginTurn(baseState({ turnNumber: 2, turnPlayer: 'B', players: { A: player(), B: player({ effigyDeck: deck }) } }));
    expect(turn2.players.B.effigyPool).toHaveLength(1);
  });

  it('crafts for the non-turn player too, during the turn player\'s own craft step', () => {
    const state = baseState({
      turnNumber: 3, turnPlayer: 'B',
      players: {
        A: player({ effigyDeck: [{ instanceId: 'e1', effigyType: 'bleeding' }] }),
        B: player({ effigyDeck: [{ instanceId: 'e2', effigyType: 'living' }] }),
      },
    });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toContainEqual({ instanceId: 'e1', effigyType: 'bleeding' }); // not B's turn, still crafts
    expect(next.players.B.effigyPool).toContainEqual({ instanceId: 'e2', effigyType: 'living' });
  });

  it('only the starting player gets the first-turn bonus — the other player still just crafts its base 1', () => {
    const state = baseState({
      turnNumber: 1, turnPlayer: 'A',
      players: {
        A: player({ effigyDeck: [{ instanceId: 'a1' }, { instanceId: 'a2' }] }),
        B: player({ effigyDeck: [{ instanceId: 'b1' }, { instanceId: 'b2' }] }),
      },
    });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(2); // starting player: base bonus
    expect(next.players.B.effigyPool).toHaveLength(1); // not the starting player: base 1 only
  });

  it('flips an extra effigy for each Altar the turn player controls ("Craft (N) additional Effigy")', () => {
    const deck = [
      { instanceId: 'e1', effigyType: 'bleeding' },
      { instanceId: 'e2', effigyType: 'living' },
    ];
    const altar = { card: { name: 'Arbosalis Altar', keywords: { craftBonus: 1 } } };
    const state = baseState({ turnNumber: 3, altars: { A: [altar], B: [] }, players: { A: player({ effigyDeck: deck }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(2); // base 1 + Altar's 1
  });

  it('stacks the bonus across every Altar the turn player controls', () => {
    const deck = [
      { instanceId: 'e1', effigyType: 'bleeding' },
      { instanceId: 'e2', effigyType: 'living' },
      { instanceId: 'e3', effigyType: 'formless' },
    ];
    const altar = { card: { name: 'Arbosalis Altar', keywords: { craftBonus: 1 } } };
    const state = baseState({ turnNumber: 3, altars: { A: [altar, altar], B: [] }, players: { A: player({ effigyDeck: deck }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(3); // base 1 + 1 + 1, two Altars in play at once
  });

  it('does not grant an Altar\'s craft bonus on the opponent\'s turn (but its owner still gets their own base craft)', () => {
    const deckA = [{ instanceId: 'e1', effigyType: 'bleeding' }];
    const deckB = [{ instanceId: 'e2', effigyType: 'living' }];
    const altar = { card: { name: 'Arbosalis Altar', keywords: { craftBonus: 1 } } };
    const state = baseState({ turnNumber: 3, turnPlayer: 'A', altars: { A: [], B: [altar] }, players: { A: player({ effigyDeck: deckA }), B: player({ effigyDeck: deckB }) } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(1); // base only, B's Altar doesn't apply on A's turn
    expect(next.players.B.effigyPool).toHaveLength(1); // B still crafts its own base 1 even off-turn — just not the Altar's extra
  });

  it('grants Faithless Altar\'s conditional bonus when the player controls only Faithless permanents', () => {
    const deck = [{ instanceId: 'e1', effigyType: 'bleeding' }, { instanceId: 'e2', effigyType: 'living' }];
    const altar = {
      card: { name: 'Faithless Altar', castingCost: { faithless: 3, colored: {} }, keywords: { craftBonus: 1, craftBonusCondition: 'faithless-only' } },
    };
    const state = baseState({ turnNumber: 3, altars: { A: [altar], B: [] }, players: { A: player({ effigyDeck: deck }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(2); // base 1 + Altar's 1 (only Faithless permanent: itself)
  });

  it('withholds Faithless Altar\'s conditional bonus when the player controls a colored permanent', () => {
    const deck = [{ instanceId: 'e1', effigyType: 'bleeding' }];
    const altar = {
      card: { name: 'Faithless Altar', castingCost: { faithless: 3, colored: {} }, keywords: { craftBonus: 1, craftBonusCondition: 'faithless-only' } },
    };
    const coloredBeing = { type: 'being', ownerId: 'A', card: { name: 'Colored Being', castingCost: { faithless: 0, colored: { living: 1 } } }, currentLifespan: 3, engaged: false };
    const state = baseState({
      turnNumber: 3,
      altars: { A: [altar], B: [] },
      board: { r2c1: coloredBeing },
      players: { A: player({ effigyDeck: deck }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(1); // base only, condition fails
  });

  it('withholds Faithless Altar\'s conditional bonus when a second Altar itself has a colored cost', () => {
    const deck = [{ instanceId: 'e1', effigyType: 'bleeding' }, { instanceId: 'e2', effigyType: 'living' }];
    const faithlessAltar = {
      card: { name: 'Faithless Altar', castingCost: { faithless: 3, colored: {} }, keywords: { craftBonus: 1, craftBonusCondition: 'faithless-only' } },
    };
    const coloredAltar = { card: { name: 'Arbosalis Altar', castingCost: { faithless: 0, colored: { living: 3 } }, keywords: { craftBonus: 1 } } };
    const state = baseState({
      turnNumber: 3,
      altars: { A: [faithlessAltar, coloredAltar], B: [] },
      players: { A: player({ effigyDeck: deck }), B: player() },
    });
    const next = beginTurn(state);
    // Base 1 + Arbosalis Altar's unconditional 1 = 2, but NOT Faithless
    // Altar's own conditional 1 — the colored Altar it's stacked with
    // disqualifies "only Faithless permanents" same as a colored Being would.
    expect(next.players.A.effigyPool).toHaveLength(2);
  });

  it('withholds Eònion Altar\'s craft bonus while it still has Time Counters', () => {
    const deck = [{ instanceId: 'e1', effigyType: 'bleeding' }];
    const eonionAltar = { card: { name: 'Eònion Altar', keywords: { craftBonus: 1, craftBonusCondition: 'zero-time-counters' } }, counters: { time: 3 } };
    const state = baseState({ turnNumber: 3, altars: { A: [eonionAltar], B: [] }, players: { A: player({ effigyDeck: deck }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(1); // base only — still has Time Counters
  });

  it('grants Eònion Altar\'s craft bonus once its Time Counters read 0', () => {
    const deck = [{ instanceId: 'e1', effigyType: 'bleeding' }, { instanceId: 'e2', effigyType: 'living' }];
    const eonionAltar = { card: { name: 'Eònion Altar', keywords: { craftBonus: 1, craftBonusCondition: 'zero-time-counters' } }, counters: { time: 0 } };
    const state = baseState({ turnNumber: 3, altars: { A: [eonionAltar], B: [] }, players: { A: player({ effigyDeck: deck }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.effigyPool).toHaveLength(2); // base 1 + Eònion Altar's 1, now that it's at 0
  });

  it('ticks an Altar\'s own Time Counters down by 1 each controller turn, same "Modulate -1" mechanic as a Prophecy', () => {
    const eonionAltar = { card: { name: 'Eònion Altar', keywords: { craftBonus: 1, craftBonusCondition: 'zero-time-counters' } }, counters: { time: 3 } };
    const state = baseState({ turnNumber: 3, altars: { A: [eonionAltar], B: [] }, players: { A: player(), B: player() } });
    const next = beginTurn(state);
    expect(next.altars.A[0].counters.time).toBe(2);
  });

  it('floors an Altar\'s Time Counters at 0 — never negative, and the Altar itself is never removed', () => {
    const eonionAltar = { card: { name: 'Eònion Altar', keywords: { craftBonus: 1, craftBonusCondition: 'zero-time-counters' } }, counters: { time: 0 } };
    const state = baseState({ turnNumber: 3, altars: { A: [eonionAltar], B: [] }, players: { A: player(), B: player() } });
    const next = beginTurn(state);
    expect(next.altars.A).toHaveLength(1);
    expect(next.altars.A[0].counters.time).toBe(0);
  });

  it('does not tick down an Altar\'s Time Counters on the opponent\'s turn', () => {
    const eonionAltar = { card: { name: 'Eònion Altar', keywords: { craftBonus: 1, craftBonusCondition: 'zero-time-counters' } }, counters: { time: 3 } };
    const state = baseState({ turnNumber: 3, turnPlayer: 'B', altars: { A: [eonionAltar], B: [] }, players: { A: player(), B: player() } });
    const next = beginTurn(state);
    expect(next.altars.A[0].counters.time).toBe(3);
  });

  it('also ticks down any other board occupant\'s own Time Counters (Hourglass), not just a Prophecy\'s timer', () => {
    const hourglass = {
      type: 'relic', ownerId: 'A',
      card: { id: 'hg', instanceId: 'hg#0', name: 'Hourglass', kind: 'relic', keywords: { collectsRemovedProphecyTimeCounters: true } },
      engaged: false, counters: { time: 3 },
    };
    const state = baseState({ turnNumber: 3, board: { r2c1: hourglass } });
    const next = beginTurn(state);
    expect(next.board.r2c1.counters.time).toBe(2);
  });

  it('floors a non-Prophecy occupant\'s Time Counters at 0, and does not tick it down on the opponent\'s turn', () => {
    const hourglass = {
      type: 'relic', ownerId: 'A',
      card: { id: 'hg', instanceId: 'hg#0', name: 'Hourglass', kind: 'relic', keywords: { collectsRemovedProphecyTimeCounters: true } },
      engaged: false, counters: { time: 0 },
    };
    const state = baseState({ turnNumber: 3, board: { r2c1: hourglass } });
    const next = beginTurn(state);
    expect(next.board.r2c1.counters.time).toBe(0);

    const hourglass2 = { ...hourglass, counters: { time: 3 } };
    const opponentTurnState = baseState({ turnNumber: 3, turnPlayer: 'B', board: { r2c1: hourglass2 } });
    const nextOpp = beginTurn(opponentTurnState);
    expect(nextOpp.board.r2c1.counters.time).toBe(3);
  });

  it('applies the draw-from-empty penalty', () => {
    // Not the game's first turn — turn 1 doesn't draw at all (see below),
    // so the draw-from-empty penalty can only apply from turn 2 onward.
    const state = baseState({ turnNumber: 3, players: { A: player({ mainDeck: [] }), B: player() } });
    const next = beginTurn(state);
    expect(next.players.A.lifespan).toBe(40);
  });

  it('does not draw on the game\'s first turn, even with cards available', () => {
    const state = baseState({
      turnNumber: 1,
      players: { A: player({ mainDeck: [{ instanceId: 'c1' }, { instanceId: 'c2' }], hand: [] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.players.A.hand).toHaveLength(0);
    expect(next.players.A.mainDeck).toHaveLength(2);
  });

  it('draws normally on the second player\'s own first turn (turn 2)', () => {
    const state = baseState({
      turnNumber: 2, turnPlayer: 'B',
      players: { A: player(), B: player({ mainDeck: [{ instanceId: 'c1' }], hand: [] }) },
    });
    const next = beginTurn(state);
    expect(next.players.B.hand).toHaveLength(1);
    expect(next.players.B.mainDeck).toHaveLength(0);
  });

  it('Distant Debator: "When revealed on the top of your deck, ..." fires the moment it is actually drawn in the normal Draw Step', () => {
    const distantDebator = { instanceId: 'dd#0', name: 'Distant Debator', keywords: { onRevealedTopOfDeck: 'you may engage a non Deity Being in the Mortal Realm until your next turn.' } };
    const ownBeing = { type: 'being', ownerId: 'B', card: { id: 'ob', instanceId: 'ob#0', name: 'Own Being', isDeity: false }, currentLifespan: 3, engaged: false };
    const state = baseState({
      turnNumber: 2, turnPlayer: 'B',
      board: { r2c1: ownBeing },
      players: { A: player(), B: player({ mainDeck: [distantDebator], hand: [] }) },
    });
    const next = beginTurn(state);
    expect(next.players.B.hand).toContainEqual(distantDebator);
    // Only one legal (non-Deity) candidate, but "you may" keeps this a
    // real choice rather than auto-applying — a Decline stays legal too.
    expect(next.pendingChoice).toEqual({ kind: 'doesnt-disengage', playerId: 'B', cardName: 'Distant Debator', optional: true });
  });

  it('Minute-taur moves forward (direction 1) at the start of its controller\'s turn', () => {
    const minuteTaur = {
      type: 'being', ownerId: 'A',
      card: { id: 'mt', instanceId: 'mt#0', name: 'Minute-taur', strength: 4, lifespan: 1, arrows: [1, 5], keywords: { moveForwardAtTurnStart: true } },
      currentLifespan: 1, engaged: false,
    };
    const state = baseState({
      turnNumber: 3, turnPlayer: 'A',
      board: { r1c2: minuteTaur },
      players: { A: player({ mainDeck: [{ instanceId: 'filler#0' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r1c2).toBeUndefined();
    expect(next.board.r2c2?.card.name).toBe('Minute-taur');
  });

  it('does not move a Being it does not own, and does not move it forward if it lacks the keyword', () => {
    const opponentTaur = { type: 'being', ownerId: 'B', card: { id: 'mt', instanceId: 'mt#0', name: 'Minute-taur', arrows: [1, 5], keywords: { moveForwardAtTurnStart: true } }, currentLifespan: 1, engaged: false };
    const plainBeing = { type: 'being', ownerId: 'A', card: { id: 'p', instanceId: 'p#0', name: 'Plain', arrows: [1] }, currentLifespan: 1, engaged: false };
    const state = baseState({
      turnNumber: 3, turnPlayer: 'A',
      board: { r4c2: opponentTaur, r1c1: plainBeing },
      players: { A: player({ mainDeck: [{ instanceId: 'filler#0' }] }), B: player() },
    });
    const next = beginTurn(state);
    expect(next.board.r4c2?.card.name).toBe('Minute-taur'); // B's own — not A's turn to move it
    expect(next.board.r1c1?.card.name).toBe('Plain'); // no keyword — untouched
    expect(next.board.r2c1).toBeUndefined();
  });
});

describe('endTurn', () => {
  it('costs 1 Lifespan, shuffles spent effigies back, and hands off to the next player', () => {
    const state = baseState({
      turnPlayer: 'A',
      turnNumber: 1,
      players: {
        // One pre-existing deck card plus the one shuffled back = 2; B's own
        // beginTurn (the turn this hands off to) crafts 1 for *every*
        // player now, including A — so A's deck still has exactly 1 left
        // afterward, same as before this fixture had a pre-existing card.
        A: player({ lifespan: 50, effigyDeck: [{ instanceId: 'e0', effigyType: 'bleeding' }], effigySpentThisTurn: [{ instanceId: 'e1', effigyType: 'living' }] }),
        B: player({ lifespan: 50 }),
      },
    });
    const next = endTurn(state);
    expect(next.players.A.lifespan).toBe(49);
    expect(next.players.A.effigyDeck).toHaveLength(1);
    expect(next.players.A.effigySpentThisTurn).toHaveLength(0);
    expect(next.turnPlayer).toBe('B');
    expect(next.turnNumber).toBe(2);
  });

  it('The Fountain reduces the end-of-turn Lifespan cost, stacking across copies, floored at 0', () => {
    const fountain = { type: 'relic', ownerId: 'A', card: { id: 'f', instanceId: 'f#0', name: 'The Fountain', keywords: { downTickLifespanReduction: 1 } } };
    const state = baseState({
      turnPlayer: 'A',
      board: { r1c2: fountain },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.players.A.lifespan).toBe(50); // -1 fully offset by the one copy
    expect(next.log.some(e => e.message.includes('passes the turn (-0 Lifespan)'))).toBe(true);
  });

  it('The Fountain only reduces its OWN controller\'s cost, not the opponent\'s', () => {
    const fountain = { type: 'relic', ownerId: 'B', card: { id: 'f', instanceId: 'f#0', name: 'The Fountain', keywords: { downTickLifespanReduction: 1 } } };
    const state = baseState({
      turnPlayer: 'A',
      board: { r1c2: fountain },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.players.A.lifespan).toBe(49); // A's own turn ends, but the Fountain is B's
  });

  it('Lingering Doubt gains +1/+1 for each other "Doubt"-named Being controlled, once, at end of turn (name-family, not a typing)', () => {
    const lingeringDoubt = {
      type: 'being', ownerId: 'A',
      card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: { endOfTurnGrowthPerName: { strength: 1, lifespan: 1, namePart: 'Doubt' } } },
      currentLifespan: 2, engaged: false,
    };
    const passingDoubt = {
      type: 'being', ownerId: 'A',
      card: { id: 'pd', instanceId: 'pd#0', name: 'Passing Doubt', typing: 'Null, Being', strength: 2, lifespan: 2 },
      currentLifespan: 2, engaged: false,
    };
    const state = baseState({
      turnPlayer: 'A', turnNumber: 3,
      board: { r2c1: lingeringDoubt, r2c2: passingDoubt },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.log.some(e => e.message.includes('Lingering Doubt grows +1/+1'))).toBe(true);
  });

  it('Lingering Doubt does not grow (and does not count itself) with no other "Doubt"-named Being controlled', () => {
    const lingeringDoubt = {
      type: 'being', ownerId: 'A',
      card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: { endOfTurnGrowthPerName: { strength: 1, lifespan: 1, namePart: 'Doubt' } } },
      currentLifespan: 2, engaged: false,
    };
    const state = baseState({
      turnPlayer: 'A', turnNumber: 3,
      board: { r2c1: lingeringDoubt },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.log.some(e => e.message.includes('Lingering Doubt grows'))).toBe(false);
  });

  it('Lingering Doubt does not count an opponent\'s own "Doubt"-named Being', () => {
    const lingeringDoubt = {
      type: 'being', ownerId: 'A',
      card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: { endOfTurnGrowthPerName: { strength: 1, lifespan: 1, namePart: 'Doubt' } } },
      currentLifespan: 2, engaged: false,
    };
    const opponentDoubt = { type: 'being', ownerId: 'B', card: { id: 'pd', instanceId: 'pd#0', name: 'Passing Doubt', strength: 2, lifespan: 2 }, currentLifespan: 2, engaged: false };
    const state = baseState({
      turnPlayer: 'A', turnNumber: 3,
      board: { r2c1: lingeringDoubt, r4c1: opponentDoubt },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.log.some(e => e.message.includes('Lingering Doubt grows'))).toBe(false);
  });

  describe('Passing Doubt: "At the end of your turn target Doubt you control is dealt (1) Lifespan Damage." — a real choice among 2+ candidates', () => {
    const passingDoubt = (ownerId, instanceId, overrides = {}) => ({
      type: 'being', ownerId,
      card: { id: 'pd', instanceId, name: 'Passing Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: { endOfTurnDamageNamedFamily: { amount: 1, namePart: 'Doubt' } } },
      currentLifespan: 2, engaged: false, ...overrides,
    });

    it('with only itself as a candidate, damages itself directly — no choice needed', () => {
      const state = baseState({
        turnPlayer: 'A',
        board: { r2c1: passingDoubt('A', 'pd#0') },
        players: { A: player({ lifespan: 50 }), B: player() },
      });
      const next = endTurn(state);
      expect(next.pendingChoice).toBeFalsy();
      expect(next.board.r2c1.currentLifespan).toBe(1);
      expect(next.log.some(e => e.message.includes("end-of-turn trigger deals 1 Lifespan Damage"))).toBe(true);
    });

    it('with 2+ Doubt-family Beings controlled, opens a real choice instead of guessing', () => {
      const lingeringDoubt = {
        type: 'being', ownerId: 'A',
        card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: {} },
        currentLifespan: 2, engaged: false,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r2c1: passingDoubt('A', 'pd#0'), r2c2: lingeringDoubt },
        players: { A: player({ lifespan: 50 }), B: player() },
      });
      const next = endTurn(state);
      expect(next.pendingChoice).toEqual({
        kind: 'end-of-turn-damage-named-family-target', playerId: 'A', cardName: 'Passing Doubt', amount: 1, namePart: 'Doubt', remainingSources: [],
      });
      // Nothing damaged yet — both candidates still at full Lifespan.
      expect(next.board.r2c1.currentLifespan).toBe(2);
      expect(next.board.r2c2.currentLifespan).toBe(2);
    });

    it('offers both the trigger source itself and the other Doubt-family Being as legal targets', () => {
      const lingeringDoubt = {
        type: 'being', ownerId: 'A',
        card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: {} },
        currentLifespan: 2, engaged: false,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r2c1: passingDoubt('A', 'pd#0'), r2c2: lingeringDoubt },
        players: { A: player({ lifespan: 50 }), B: player() },
      });
      const opened = endTurn(state);
      const legal = getLegalActions(opened, 'A');
      expect(legal).toContainEqual({ type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: 'r2c1' });
      expect(legal).toContainEqual({ type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: 'r2c2' });
    });

    it('resolving the choice damages exactly the chosen target, still works after the turn has switched', () => {
      const lingeringDoubt = {
        type: 'being', ownerId: 'A',
        card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: {} },
        currentLifespan: 2, engaged: false,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r2c1: passingDoubt('A', 'pd#0'), r2c2: lingeringDoubt },
        players: { A: player({ lifespan: 50 }), B: player() },
      });
      const opened = endTurn(state);
      expect(opened.turnPlayer).toBe('B'); // the turn already switched — the choice just gates further play
      const resolved = gameReducer(opened, { type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: 'r2c2' });
      expect(resolved.board.r2c1.currentLifespan).toBe(2); // untouched — not the chosen one
      expect(resolved.board.r2c2.currentLifespan).toBe(1);
      expect(resolved.pendingChoice).toBeNull();
    });

    it('never offers a target belonging to the opponent', () => {
      const opponentDoubt = {
        type: 'being', ownerId: 'B',
        card: { id: 'od', instanceId: 'od#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: {} },
        currentLifespan: 2, engaged: false,
      };
      const anotherOwn = {
        type: 'being', ownerId: 'A',
        card: { id: 'ad', instanceId: 'ad#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: {} },
        currentLifespan: 2, engaged: false,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r2c1: passingDoubt('A', 'pd#0'), r2c2: anotherOwn, r4c1: opponentDoubt },
        players: { A: player({ lifespan: 50 }), B: player() },
      });
      const opened = endTurn(state);
      const legal = getLegalActions(opened, 'A');
      expect(legal.some(a => a.cellId === 'r4c1')).toBe(false);
    });

    it('a Doubt-only build: two SEPARATE ambiguous trigger sources in the same End Step each get their own real choice, chained — not just the first', () => {
      // Two copies of Passing Doubt plus a third Doubt-family Being: BOTH
      // copies independently trigger, and each is ambiguous (3 real
      // candidates each time it fires) — the exact shape that used to
      // leave every source after the first silently unresolved for the
      // turn.
      const other = {
        type: 'being', ownerId: 'A',
        card: { id: 'ld', instanceId: 'ld#0', name: 'Lingering Doubt', typing: 'Null, Being', strength: 2, lifespan: 2, keywords: {} },
        currentLifespan: 2, engaged: false,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r2c1: passingDoubt('A', 'pd1#0'), r2c2: passingDoubt('A', 'pd2#0'), r2c3: other },
        players: { A: player({ lifespan: 50 }), B: player() },
      });
      const opened = endTurn(state);
      // First choice is open, with the second source queued up.
      expect(opened.pendingChoice.kind).toBe('end-of-turn-damage-named-family-target');
      expect(opened.pendingChoice.remainingSources).toEqual(['r2c2']);
      expect(opened.board.r2c1.currentLifespan).toBe(2);
      expect(opened.board.r2c2.currentLifespan).toBe(2);
      expect(opened.board.r2c3.currentLifespan).toBe(2);

      // Resolving the first choice damages exactly the chosen target, AND
      // immediately opens the second source's own real choice — it is not
      // skipped.
      const afterFirst = gameReducer(opened, { type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: 'r2c3' });
      expect(afterFirst.board.r2c3.currentLifespan).toBe(1); // the first choice's target took it
      expect(afterFirst.pendingChoice.kind).toBe('end-of-turn-damage-named-family-target');
      expect(afterFirst.pendingChoice.remainingSources).toEqual([]);

      // Resolving the second choice damages ITS chosen target and finally
      // clears pendingChoice — the whole queue is drained.
      const afterSecond = gameReducer(afterFirst, { type: 'RESOLVE_END_OF_TURN_DAMAGE_NAMED_FAMILY_TARGET', cellId: 'r2c1' });
      expect(afterSecond.board.r2c1.currentLifespan).toBe(1);
      expect(afterSecond.pendingChoice).toBeNull();
    });
  });

  it('Minute-taur moves backward (direction 5) at the end of its controller\'s turn', () => {
    const minuteTaur = {
      type: 'being', ownerId: 'A',
      card: { id: 'mt', instanceId: 'mt#0', name: 'Minute-taur', strength: 4, lifespan: 1, arrows: [1, 5], keywords: { moveBackwardAtTurnEnd: true } },
      currentLifespan: 1, engaged: false,
    };
    const state = baseState({
      turnPlayer: 'A', turnNumber: 3,
      board: { r2c2: minuteTaur },
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.board.r2c2).toBeUndefined();
    expect(next.board.r1c2?.card.name).toBe('Minute-taur');
  });

  it('Minute-taur\'s backward move is a graceful no-op with nowhere legal to go', () => {
    const minuteTaur = {
      type: 'being', ownerId: 'A',
      card: { id: 'mt', instanceId: 'mt#0', name: 'Minute-taur', strength: 4, lifespan: 1, arrows: [1, 5], keywords: { moveBackwardAtTurnEnd: true } },
      currentLifespan: 1, engaged: false,
    };
    const state = baseState({
      turnPlayer: 'A', turnNumber: 3,
      board: { r1c2: minuteTaur }, // already in the back row — nowhere further back to go
      players: { A: player({ lifespan: 50 }), B: player({ lifespan: 50 }) },
    });
    const next = endTurn(state);
    expect(next.board.r1c2?.card.name).toBe('Minute-taur'); // unchanged, no crash
  });

  it('expires an unspent Zealot "Add Essence" temporary effigy instead of carrying it forward', () => {
    const state = baseState({
      players: {
        A: player({
          effigyPool: [
            { instanceId: 'essence-living#0', effigyType: 'living', temporary: true },
            { instanceId: 'e-real', effigyType: 'formless' },
          ],
        }),
        B: player(),
      },
    });
    const next = endTurn(state);
    expect(next.players.A.effigyPool).toEqual([{ instanceId: 'e-real', effigyType: 'formless' }]);
  });

  it('IkVarem\'s "becomes Favored until end of turn" expires at the granting player\'s own end of turn', () => {
    const state = baseState({
      board: {
        r2c1: {
          type: 'being', ownerId: 'A', card: { name: 'Ally', strength: 1, lifespan: 1 },
          currentLifespan: 1, engaged: false, favorCounter: true, favorCounterExpiresEndOfTurn: true,
        },
      },
    });
    const next = endTurn(state);
    expect(next.board.r2c1.favorCounter).toBe(false);
    expect(next.board.r2c1.favorCounterExpiresEndOfTurn).toBe(false);
  });

  it('leaves a permanent Favored (no expiry flag) untouched at end of turn', () => {
    const state = baseState({
      board: {
        r2c1: { type: 'being', ownerId: 'A', card: { name: 'Ally', strength: 1, lifespan: 1 }, currentLifespan: 1, engaged: false, favorCounter: true },
      },
    });
    const next = endTurn(state);
    expect(next.board.r2c1.favorCounter).toBe(true);
  });

  it('does not shuffle a spent temporary essence back into the real Effigy Deck', () => {
    const state = baseState({
      players: {
        A: player({
          // A spare pre-existing deck card so the one real card shuffled
          // back (below) survives A's own craft during B's beginTurn (both
          // players craft every step now) and is still there to check.
          effigyDeck: [{ instanceId: 'e-spare', effigyType: 'bleeding' }],
          effigySpentThisTurn: [
            { instanceId: 'essence-living#0', effigyType: 'living', temporary: true },
            { instanceId: 'e-real', effigyType: 'formless' },
          ],
        }),
        B: player(),
      },
    });
    const next = endTurn(state);
    expect(next.players.A.effigyDeck).toEqual([{ instanceId: 'e-real', effigyType: 'formless' }]);
  });

  it('ends the game instead of continuing when the end-step cost drops Lifespan to 0', () => {
    const state = baseState({ players: { A: player({ lifespan: 1 }), B: player() } });
    const next = endTurn(state);
    expect(next.phase).toBe('gameover');
    expect(next.winner).toBe('B');
  });

  describe('the Boundless Hunger bounce loop (Immen Gorta + Mouth of Madness + Terranean Gates — confirmed intentional with the user)', () => {
    const immenGortaCard = {
      id: 'immen', instanceId: 'immen#0', name: 'Immen Gorta, the Boundless Hunger', typing: 'Hunger, Being, Deity', strength: 4, lifespan: 4,
      keywords: {
        shift: { amount: 1, effect: 'At the end of your turn, this loses (2) Time Counters' },
        onMovedIntoMortalRealm: 'deal (1) damage to any target.',
      },
    };
    const shiftedImmenGorta = (timer = 1) => ({
      type: 'prophecy', ownerId: 'A',
      card: { ...immenGortaCard, textBox: 'At the end of your turn, this loses (2) Time Counters', typing: '', keywords: { endOfTurnRemoveOwnTimeCounters: 2 } },
      timer, faceDown: false, shiftedFromCard: immenGortaCard,
    });
    const mouthOfMadness = { type: 'relic', ownerId: 'A', card: { id: 'mouth', instanceId: 'mouth#0', name: 'Mouth of Madness', kind: 'relic', keywords: { duringEndStepForceShift: 1 } } };
    const terraneanGates = { type: 'relic', ownerId: 'A', card: { id: 'gates', instanceId: 'gates#0', name: 'Terranean Gates', kind: 'relic', keywords: { duringEndStepLoseTimeCounters: 2 } } };

    // Regression: per the user's own later ruling, the controller now gets
    // a REAL target choice for Immen Gorta's "any target" damage on all 5
    // illustrated returns (not just the ordinary no-Mouth-of-Madness case
    // below) — forcing the next Shift waits for that choice to actually
    // resolve (resolvePendingResolution's own 'boundless-hunger-reshift'
    // branch), rather than auto-hitting the opponent the instant it fires.
    // `bounceCount` is 0 on the first (non-forced) return, so the 5th
    // occurrence is bounceCount === 4 — only once THAT choice resolves does
    // the loop get declared and its controller win outright (win-by-loop,
    // not by Lifespan exhaustion). Interruptibility itself (a real response
    // during one of the windows in between) is covered by its own tests
    // below — this one exercises the plain "nobody has anything to respond
    // with" path, where every reactive window auto-skips invisibly and only
    // the 5 real damage-target choices are ever player-visible, same
    // observable shape as the loop had before it became interruptible.
    it('lets the controller choose Immen Gorta\'s target for all 5 illustrated returns, then declares the loop and ends the game', () => {
      // B needs a real mainDeck card here: unlike the original (fully
      // synchronous, no-pendingChoice) version of this loop, endTurn now
      // finishes its own turn-switch/beginTurn sequence for B (a real
      // pendingChoice partway through end-of-turn processing doesn't pause
      // endTurn itself — a separate, pre-existing quirk, not something this
      // change touches) before the loop's first choice is even resolved, so
      // an empty deck would otherwise contaminate B's Lifespan via the
      // unrelated draw-from-empty penalty.
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: shiftedImmenGorta(1), r2c1: mouthOfMadness, r2c2: terraneanGates },
        players: { A: player(), B: player({ lifespan: 1000, mainDeck: [{ instanceId: 'd1' }] }) },
      });
      // Real (gameReducer, not bare endTurn) PASS_TURN — the loop's first
      // pause only exists through manageReactiveWindow, which bare endTurn
      // never runs. Neither player has anything to respond with in this
      // fixture, so every reactive window auto-skips invisibly (same
      // "nobody can act on it" behavior every other reactive window in this
      // engine already has) straight through to the first real pause: the
      // damage-target choice itself.
      let next = gameReducer(state, { type: 'PASS_TURN' });
      expect(next.phase).toBe('playing');
      expect(next.players.B.lifespan).toBe(1000);
      expect(next.pendingChoice).toEqual(expect.objectContaining({
        kind: 'damage-target', damage: 1, includesPlayers: true,
        boundlessHunger: expect.objectContaining({ bounceCount: 0 }),
      }));

      for (let bounceCount = 1; bounceCount <= 3; bounceCount += 1) {
        next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
        expect(next.phase).toBe('playing');
        expect(next.players.B.lifespan).toBe(1000 - bounceCount);
        expect(next.pendingChoice).toEqual(expect.objectContaining({
          kind: 'damage-target', boundlessHunger: expect.objectContaining({ bounceCount }),
        }));
      }

      // 5th (final illustrated) return: still a real choice.
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(next.phase).toBe('playing');
      expect(next.players.B.lifespan).toBe(996);
      expect(next.pendingChoice).toEqual(expect.objectContaining({
        kind: 'damage-target', boundlessHunger: expect.objectContaining({ bounceCount: 4 }),
      }));

      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(next.phase).toBe('gameover');
      expect(next.winner).toBe('A');
      expect(next.players.B.lifespan).toBe(995); // all 5 illustrated returns dealt real, player-chosen damage
      expect(next.pendingChoice).toBeFalsy();
      expect(next.pendingResolution).toBeFalsy();
      expect(next.reactiveWindow).toBeFalsy();
      expect(next.loopWin).toEqual({
        winnerId: 'A',
        cards: expect.arrayContaining([
          expect.objectContaining({ name: 'Mouth of Madness' }),
          expect.objectContaining({ name: 'Terranean Gates' }),
          expect.objectContaining({ name: 'Immen Gorta, the Boundless Hunger' }),
        ]),
      });
      expect(next.log.some(e => e.message.includes('assembled the Boundless Hunger loop'))).toBe(true);
    });

    it('still wins outright via the loop even when the opponent would easily have survived 1-damage-per-bounce forever (no more 100-bounce grind for this specific combo)', () => {
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: shiftedImmenGorta(1), r2c1: mouthOfMadness, r2c2: terraneanGates },
        players: { A: player(), B: player({ lifespan: 1_000_000, mainDeck: [{ instanceId: 'd1' }] }) },
      });
      let next = gameReducer(state, { type: 'PASS_TURN' });
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(next.phase).toBe('gameover');
      expect(next.winner).toBe('A');
    });

    it('lets the opponent interrupt the loop by destroying Immen Gorta during the return window', () => {
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: shiftedImmenGorta(1), r2c1: mouthOfMadness, r2c2: terraneanGates },
        players: { A: player(), B: player({ lifespan: 1000, mainDeck: [{ instanceId: 'd1' }] }) },
      });
      let next = gameReducer(state, { type: 'PASS_TURN' });
      const returnedCellId = Object.entries(next.board).find(([, o]) => o?.card?.name === 'Immen Gorta, the Boundless Hunger')?.[0];
      expect(returnedCellId).toBeTruthy();
      // Resolve the 1st damage choice, then simulate a response destroying
      // Immen Gorta before the deferred reshift step re-validates it — the
      // exact same "never trust stale data across a window" shape every
      // other pendingResolution kind already handles.
      next = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      // By now the whole rest of the chain (with nobody to respond) has
      // already auto-resolved to the next damage-target choice — remove
      // Immen Gorta directly and resolve THAT choice to reach the next
      // 'boundless-hunger-reshift' pendingResolution's own re-validation.
      const cellId = Object.entries(next.board).find(([, o]) => o?.card?.name === 'Immen Gorta, the Boundless Hunger')?.[0];
      expect(cellId).toBeTruthy();
      const withoutImmenGorta = { ...next, board: { ...next.board } };
      delete withoutImmenGorta.board[cellId];
      const resolved = gameReducer(withoutImmenGorta, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(resolved.phase).toBe('playing');
      expect(resolved.pendingChoice).toBeFalsy();
      expect(resolved.pendingResolution).toBeFalsy();
      expect(resolved.loopWin).toBeUndefined();
      expect(resolved.log.some(e => e.message.includes("Boundless Hunger loop fizzles — it's no longer on the battlefield"))).toBe(true);
    });

    it('lets the opponent interrupt the loop by destroying Mouth of Madness before the forced re-Shift', () => {
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: shiftedImmenGorta(1), r2c1: mouthOfMadness, r2c2: terraneanGates },
        players: { A: player(), B: player({ lifespan: 1000, mainDeck: [{ instanceId: 'd1' }] }) },
      });
      let next = gameReducer(state, { type: 'PASS_TURN' });
      // Remove Mouth of Madness before resolving the 1st damage choice, so
      // the resulting 'boundless-hunger-reshift' pendingResolution's own
      // re-validation (not the earlier board.js check inside
      // placeReturnedFromShift, which already ran) is what actually stops it.
      const withoutMouthOfMadness = { ...next, board: { ...next.board } };
      delete withoutMouthOfMadness.board.r2c1;
      const resolved = gameReducer(withoutMouthOfMadness, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(resolved.phase).toBe('playing');
      expect(resolved.players.B.lifespan).toBe(999); // the damage that was already applied still counts
      expect(resolved.pendingChoice).toBeFalsy();
      expect(resolved.pendingResolution).toBeFalsy();
      expect(resolved.loopWin).toBeUndefined();
      const immenGorta = Object.values(resolved.board).find(o => o?.card?.name === 'Immen Gorta, the Boundless Hunger');
      expect(immenGorta?.type).toBe('being'); // stays put in the Mortal Realm — no reshift happened
      expect(resolved.log.some(e => e.message.includes('Boundless Hunger loop stops — Mouth of Madness is no longer on the battlefield'))).toBe(true);
    });

    // Synthesizes the exact mid-chain shape a real cascade produces right
    // after Mouth of Madness's own reshift — Immen Gorta already Shifted
    // into the Ethereal Realm, its own 'boundless-hunger-terranean-gates'
    // pendingResolution already open and waiting behind a reactive window
    // — since the ordinary cascade (nobody has anything to respond with)
    // collapses this specific pause into the same single dispatch as every
    // other step, same as the two interruption tests above; targeting the
    // re-validation directly here is more precise than fighting that
    // collapse with a fragile pre-dispatch board mutation.
    it('lets the opponent interrupt the loop by destroying Terranean Gates before it strips Time Counters', () => {
      const ethereal = {
        type: 'prophecy', ownerId: 'A',
        card: { ...immenGortaCard, textBox: 'At the end of your turn, this loses (2) Time Counters', typing: '', keywords: { endOfTurnRemoveOwnTimeCounters: 2 } },
        timer: 1, faceDown: false, shiftedFromCard: immenGortaCard,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r4c1: ethereal, r2c1: mouthOfMadness },
        players: { A: player(), B: player({ lifespan: 1000 }) },
        pendingResolution: {
          kind: 'boundless-hunger-terranean-gates', ownerId: 'A', cellId: 'r4c1',
          cardInstanceId: immenGortaCard.instanceId, cardName: immenGortaCard.name, bounceCount: 1,
        },
        reactiveWindow: { openFor: 'B', triggerDescription: 'test', everResponded: false, passedOnce: false },
      });
      const resolved = gameReducer(state, { type: 'PASS_PRIORITY' });
      expect(resolved.phase).toBe('playing');
      expect(resolved.pendingChoice).toBeFalsy();
      expect(resolved.pendingResolution).toBeFalsy();
      expect(resolved.loopWin).toBeUndefined();
      expect(resolved.board.r4c1?.type).toBe('prophecy');
      expect(resolved.board.r4c1?.timer).toBe(1); // unchanged — Terranean Gates never applied
      expect(resolved.log.some(e => e.message.includes('Boundless Hunger loop stops — Terranean Gates is no longer on the battlefield'))).toBe(true);
    });

    // The general 100-bounce safety net (offerOrPerformShift/
    // placeReturnedFromShift) stays in place for the underlying mechanism
    // itself — only Immen Gorta BY NAME gets the loop-declaration
    // short-circuit, so a different card sharing the same Shift-decay +
    // "deal damage on return" shape (hypothetical — no other real card
    // does today) would still need it.
    it('the general 100-bounce cap still applies to a differently-named card sharing the same mechanic shape', () => {
      const otherCard = { ...immenGortaCard, name: 'Some Other Hunger', instanceId: 'other#0' };
      const shiftedOther = {
        type: 'prophecy', ownerId: 'A',
        card: { ...otherCard, textBox: 'At the end of your turn, this loses (2) Time Counters', typing: '', keywords: { endOfTurnRemoveOwnTimeCounters: 2 } },
        timer: 1, faceDown: false, shiftedFromCard: otherCard,
      };
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: shiftedOther, r2c1: mouthOfMadness, r2c2: terraneanGates },
        players: { A: player(), B: player({ lifespan: 1000, mainDeck: [{ instanceId: 'd1' }] }) },
      });
      const next = endTurn(state);
      expect(next.phase).toBe('playing'); // not lethal — the 100-bounce cap stopped it first
      expect(next.players.B.lifespan).toBe(900); // 1000 - 100 bounces x 1 damage each
      expect(next.loopWin).toBeUndefined();
    });

    // Regression: with no Mouth of Madness on the board, the loop can
    // never re-trigger after this single return — so unlike the two tests
    // above (which genuinely have nowhere safe to pause), this ordinary
    // end-of-turn return now opens a REAL "any target" choice for the
    // player instead of silently auto-hitting the opponent, per the
    // user's own ruling ("Immen Gorta returning should allow the player
    // to target where the damage goes").
    it('does not bounce at all without both Relics in play — only its own quoted decay applies, and opens a real target choice for the damage', () => {
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: shiftedImmenGorta(1) },
        players: { A: player(), B: player({ lifespan: 50, mainDeck: [{ instanceId: 'd1' }] }) },
      });
      const next = endTurn(state);
      expect(next.players.B.lifespan).toBe(50); // no damage yet — a real choice is pending, not auto-resolved
      const returned = Object.values(next.board).find(o => o?.card?.name === 'Immen Gorta, the Boundless Hunger');
      expect(returned?.type).toBe('being');
      expect(next.pendingChoice).toEqual(expect.objectContaining({ kind: 'damage-target', playerId: 'A', damage: 1, includesPlayers: true }));
      const resolved = gameReducer(next, { type: 'RESOLVE_DAMAGE_TARGET_PLAYER', targetPlayerId: 'B' });
      expect(resolved.players.B.lifespan).toBe(49);
    });
  });
});

describe('checkWin', () => {
  it('declares the other player the winner when one hits 0 Lifespan', () => {
    const state = baseState({ players: { A: player({ lifespan: 0 }), B: player({ lifespan: 20 }) } });
    const next = checkWin(state);
    expect(next.phase).toBe('gameover');
    expect(next.winner).toBe('B');
  });

  it('leaves the game in progress when both players are alive', () => {
    const state = baseState();
    expect(checkWin(state).phase).toBe('playing');
  });
});
