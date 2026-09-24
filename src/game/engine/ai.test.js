import { describe, it, expect } from 'vitest';
import { pickAiAction, pickAiReaction, bestFirst, opponentReplyValue, evaluateState, synergyValue, knownComboValue } from './ai.js';
import { getLegalActions, gameReducer } from './actions.js';

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

  // Regression: a flat reposition score left the AI directionally blind —
  // every MOVE_OR_ATTACK reposition tied at the same value regardless of
  // whether it advanced toward the front row (where attacking becomes
  // possible) or retreated from it. Self-play's own complaint: "moves
  // backward when working toward an attack would clearly be better."
  it('prefers advancing toward the front row over a sideways reposition, when no attack is available yet', () => {
    const homeRowBeing = {
      type: 'being', ownerId: 'B', card: { name: 'H', kind: 'being', strength: 2, lifespan: 3, arrows: [1, 7] }, currentLifespan: 3, engaged: false,
    };
    // r5c2 is B's home row — no attack is legal from there yet (computeAttackCell
    // only fires from the front row), isolating pure reposition-direction scoring.
    const state = baseState({ board: { r5c2: homeRowBeing } });
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r5c2', toCellId: 'r4c2', direction: 1, isAttack: false });
  });

  it('prefers a sideways reposition over retreating backward toward home, when no attack is available', () => {
    const frontRowBeing = {
      type: 'being', ownerId: 'B',
      card: { name: 'F', kind: 'being', strength: 2, lifespan: 3, arrows: [3, 5], keywords: { cannotAttack: true } },
      currentLifespan: 3, engaged: false,
    };
    const state = baseState({ board: { r4c2: frontRowBeing } });
    const action = pickAiAction(state, 'B');
    expect(action).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c2', toCellId: 'r4c1', direction: 3, isAttack: false });
  });

  // Regression: self-play found the AI cheerfully summoning a "when
  // summoned ... deal damage to target Being" card (Mini Mage's own shape)
  // into a board with no opposing Being at all, shooting one of its own
  // instead for no benefit — a flat SUMMON_BEING score had no way to know
  // its own trigger would find no real target.
  describe('SUMMON_BEING self-damage risk ("if you control a Prophecy deal (N) damage to target Being")', () => {
    const selfRiskCard = {
      id: 'srk', instanceId: 'srk#0', name: 'Mini Mage', kind: 'being', strength: 5, lifespan: 2, timerMax: 0, arrows: [1],
      castingCost: { faithless: 0, colored: {} },
      keywords: { whenSummoned: 'if you control a Prophecy deal (2) damage to target Being.' },
    };
    const saferCard = {
      id: 'saf', instanceId: 'saf#0', name: 'Plain Being', kind: 'being', strength: 1, lifespan: 2, timerMax: 0, arrows: [1],
      castingCost: { faithless: 0, colored: {} },
    };
    const ownFaceDownProphecy = { type: 'prophecy', ownerId: 'B', card: { name: 'Some Prophecy' }, timer: 3, faceDown: true };

    it('avoids it when only its own Being(s) could be hit', () => {
      const state = baseState({
        // Engaged so it has no attack/move options of its own to compete
        // with — it's here purely as a legal (bad) target for the trigger.
        board: { r3c1: ownFaceDownProphecy, r4c1: { ...being('B', 2), engaged: true } },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [selfRiskCard, saferCard] }) },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'SUMMON_BEING', instanceId: 'saf#0', cellId: expect.any(String) });
    });

    it('summons it normally once a real opposing target is on the board (its own strength advantage wins)', () => {
      const state = baseState({
        board: { r3c1: ownFaceDownProphecy, r2c1: being('A', 2) },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [selfRiskCard, saferCard] }) },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'SUMMON_BEING', instanceId: 'srk#0', cellId: expect.any(String) });
    });

    it('does not apply the risk penalty when its own "if you control a Prophecy" condition is unmet — it can never even fire', () => {
      const state = baseState({
        board: { r4c1: { ...being('B', 2), engaged: true } }, // an own Being present, but no Prophecy anywhere
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [selfRiskCard, saferCard] }) },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'SUMMON_BEING', instanceId: 'srk#0', cellId: expect.any(String) });
    });
  });

  // Regression: RESOLVE_MODULATE's own +1/-1 "choose" pair both fell
  // through to the flat 0 default, so pickAiAction's strict tie-break
  // always kept getLegalActions' own first-pushed option (+1) — the AI
  // reflexively delayed its own Prophecies every time, never letting one
  // actually resolve. Self-play's own complaint: "not allowing a Prophecy
  // to resolve, modulating it up instead."
  describe('RESOLVE_MODULATE "choose" preference — generalized to every target shape by ownership, not just a face-down Prophecy', () => {
    // A Prophecy with no real face-up text at all (the original fixture
    // here) resolves to nothing evaluateState can actually see either way
    // — no material, life, or hand-size change — so the fast-forward
    // simulation below genuinely ties, and only the fallback tie-break
    // (first-pushed +1) would decide it. A real effect is needed to prove
    // the AI is actually reading and weighing the consequence, not just
    // getting lucky on a tie.
    const drawACardProphecy = { type: 'prophecy', card: { name: 'P', textBox: 'Draw (1) card.' }, timer: 3 };

    it('hastens (Modulate -1) its own face-down Prophecy with a real beneficial effect, letting it actually resolve within the lookahead window', () => {
      const state = baseState({
        board: { r3c1: { ...drawACardProphecy, ownerId: 'B', faceDown: true } },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', mainDeck: [{ instanceId: 'd1' }] }) },
        pendingChoice: { kind: 'modulate', playerId: 'B', cardName: 'Test', delta: 'choose' },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: -1 });
    });

    it('delays (Modulate +1) an opponent\'s face-down Prophecy with a real beneficial effect, instead of hastening a card draw FOR THEM', () => {
      const state = baseState({
        board: { r3c1: { ...drawACardProphecy, ownerId: 'A', faceDown: true } },
        players: { A: player({ id: 'A', mainDeck: [{ instanceId: 'd1' }] }), B: player({ id: 'B' }) },
        pendingChoice: { kind: 'modulate', playerId: 'B', cardName: 'Test', delta: 'choose', anyOwner: true },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    });

    // A face-up Prophecy hitting 0 is pure cleanup in this engine — its own
    // face-up text already resolved back at the moment it FLIPPED, not
    // again here (resolveProphecyModulateHitZero's own "face-up, timer 0:
    // already resolved back at the flip" branch) — so unlike a face-down
    // one, hastening vs. delaying a face-up Prophecy genuinely has no
    // differentiable consequence for this lookahead to weigh either way.
    // This just confirms the Prophecy-specific branch is still correctly
    // entered (not silently falling through to something broken) and
    // still returns a real, valid choice, without asserting a winner that
    // wouldn't actually be meaningful.
    it('still resolves cleanly for a face-up Prophecy, which has no differentiable resolve-at-0 consequence either way', () => {
      const state = baseState({
        board: { r3c1: { ...drawACardProphecy, ownerId: 'B', faceDown: false } },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', mainDeck: [{ instanceId: 'd1' }] }) },
        pendingChoice: { kind: 'modulate', playerId: 'B', cardName: 'Test', delta: 'choose' },
      });
      const action = pickAiAction(state, 'B');
      expect(['RESOLVE_MODULATE']).toContain(action.type);
      expect([1, -1]).toContain(action.delta);
    });

    // The actual point of this whole feature, per the user's own follow-up
    // ("it should read the effect of the card... and weigh the impact of
    // either option"): a blanket "always hasten your own" heuristic is
    // WRONG here — this Prophecy actively hurts its own controller when it
    // resolves, so delaying it is correct, the exact opposite of what the
    // plain ownership fallback (still used for Altars/etc.) would guess.
    it('delays (Modulate +1) its OWN Prophecy when the real effect is actually harmful to itself, contradicting the plain ownership fallback', () => {
      const selfHarmProphecy = { type: 'prophecy', ownerId: 'B', card: { name: 'P', textBox: 'you take (20) Lifespan Damage.' }, timer: 3, faceDown: true };
      const state = baseState({
        board: { r3c1: selfHarmProphecy },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', lifespan: 25 }) },
        pendingChoice: { kind: 'modulate', playerId: 'B', cardName: 'Test', delta: 'choose' },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'RESOLVE_MODULATE', cellId: 'r3c1', delta: 1 });
    });

    it('hastens (Modulate -1) its own Altar toward 0 Time Counters instead of delaying it, when given a free choice', () => {
      const ownAltar = { card: { instanceId: 'alt#0', name: 'Eònion Altar' }, counters: { time: 2 } };
      const state = baseState({
        altars: { A: [], B: [ownAltar] },
        pendingChoice: { kind: 'modulate', playerId: 'B', cardName: 'Test', delta: 'choose' },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'RESOLVE_MODULATE', altarInstanceId: 'alt#0', delta: -1 });
    });

    it('delays (Modulate +1) an opponent\'s Altar instead of hastening it toward 0, when given a free choice', () => {
      const opponentAltar = { card: { instanceId: 'alt#0', name: 'Eònion Altar' }, counters: { time: 2 } };
      const state = baseState({
        altars: { A: [opponentAltar], B: [] },
        pendingChoice: { kind: 'modulate', playerId: 'B', cardName: 'Test', delta: 'choose', anyOwner: true },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'RESOLVE_MODULATE', altarInstanceId: 'alt#0', delta: 1 });
    });
  });
});

describe('pickAiAction with aiDifficulty "hard" (the shallow search)', () => {
  it('still identifies an obvious lethal attack, same as the default greedy picker', () => {
    const state = baseState({ board: { r4c2: being('B', 60) }, players: { A: player({ id: 'A', lifespan: 5 }), B: player({ id: 'B' }) } });
    const action = pickAiAction(state, 'B', 'hard');
    expect(action).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c2', toCellId: 'r2c2', isAttack: true });
  });

  // The actual point of the search: a flat greedy score has no way to know
  // a reposition leaves a lethal lane wide open for the opponent's free
  // reply next turn. Both of the Being's own reposition options here tie
  // at the SAME greedy "sideways" score (this session's own earlier
  // advancing/retreating fix only distinguishes row direction, not which
  // column), so greedy's own strict tie-break keeps whichever
  // getLegalActions happens to list first — which here is the one that
  // does NOT block. Only a search that looks past its own move to the
  // opponent's best reply can tell these two apart.
  it('blocks a lethal open lane instead of a same-scored-but-wrong sideways reposition, once it foresees the opponent\'s free lethal attack next turn', () => {
    const blocker = {
      type: 'being', ownerId: 'B',
      card: { name: 'Blocker', kind: 'being', strength: 1, lifespan: 1, arrows: [7, 3], keywords: { cannotAttack: true } },
      currentLifespan: 1, engaged: false,
    };
    const lethalAttacker = {
      type: 'being', ownerId: 'A',
      card: { name: 'Big', kind: 'being', strength: 10, lifespan: 10, arrows: [] },
      currentLifespan: 10, engaged: false,
    };
    // B's own Lifespan (5) is exactly lethal to a straight open lane out of
    // r2c2 (into r4c2). Direction 7 moves the blocker OUT of that lane
    // (r4c3 -> r4c4, leaving it open); direction 3 moves it INTO r4c2,
    // blocking it (downgrading A's reply from a lethal face hit to merely
    // killing the blocker).
    const state = baseState({ board: { r4c3: blocker, r2c2: lethalAttacker }, players: { A: player({ id: 'A' }), B: player({ id: 'B', lifespan: 5 }) } });

    const greedyAction = pickAiAction(state, 'B');
    expect(greedyAction).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c3', toCellId: 'r4c4', direction: 7, isAttack: false });

    const hardAction = pickAiAction(state, 'B', 'hard');
    expect(hardAction).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c3', toCellId: 'r4c2', direction: 3, isAttack: false });
  });

  it('does not throw on a moderately busy board (search stays bounded), and finishes well within an interactive time budget', () => {
    const cheapBeing = { id: 'c', instanceId: 'c#0', name: 'Cheap', kind: 'being', strength: 2, lifespan: 2, timerMax: 0, arrows: [1], castingCost: { faithless: 0, colored: {} } };
    const state = baseState({
      board: {
        r4c1: being('B', 2), r4c2: being('B', 3), r4c3: being('B', 1),
        r2c1: being('A', 4), r2c2: being('A', 2),
      },
      players: {
        A: player({ id: 'A' }),
        B: player({ id: 'B', hand: [cheapBeing, { ...cheapBeing, instanceId: 'c#1' }] }),
      },
    });
    const start = Date.now();
    expect(() => pickAiAction(state, 'B', 'hard')).not.toThrow();
    // Regression guard against the node budget being set too high — a
    // single Hard-mode pick should stay well under a "feels laggy"
    // ceiling even on this moderately busy board.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  // bestFirst is the search's own move-ordering (see its comment in
  // ai.js) — sorts candidates by the plain greedy heuristic, descending,
  // so a bounded node budget is always spent on the most promising
  // branches first rather than whatever order getLegalActions happened to
  // produce them in.
  it('bestFirst sorts candidate actions by scoreAction, descending', () => {
    const state = baseState({ board: { r4c2: being('B', 60) }, players: { A: player({ id: 'A', lifespan: 5 }), B: player({ id: 'B' }) } });
    const actions = getLegalActions(state, 'B');
    const ordered = bestFirst(state, 'B', actions);
    // A lethal open-lane attack (score 1000) must sort ahead of PASS_TURN
    // (score -100, the file's own explicit "last resort").
    expect(ordered[0]).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c2', toCellId: 'r2c2', isAttack: true });
    expect(ordered[ordered.length - 1]).toEqual({ type: 'PASS_TURN' });
  });

  // opponentReplyValue is what searchValue folds in once the turn/priority
  // passes to the opponent (see its own comment in ai.js) — the direct
  // regression test for "defend against the worst of the opponent's
  // CLOSE-scoring replies, not just their literal single best move."
  describe('opponentReplyValue', () => {
    // A has two attackers that can each cleanly kill (without dying) one
    // of B's two Beings — X (strength 4, lifespan 15 — big board material:
    // 4+15=19) and Y (strength 5, lifespan 2 — small material: 5+2=7).
    // Y is A's own nominal top pick under the plain greedy heuristic
    // (scoreAction: 80+5=85 for Y vs 80+4=84 for X — X is a CLOSE second,
    // not the top), but losing X is far worse for B than losing Y. Old
    // single-best-reply modeling would only ever have looked at attacking
    // Y (mild); this confirms the search now also considers X.
    const beingX = { type: 'being', ownerId: 'B', card: { name: 'X', kind: 'being', strength: 4, lifespan: 15, arrows: [1] }, currentLifespan: 15, engaged: true };
    const beingY = { type: 'being', ownerId: 'B', card: { name: 'Y', kind: 'being', strength: 5, lifespan: 2, arrows: [1] }, currentLifespan: 2, engaged: true };
    const attacker1 = { type: 'being', ownerId: 'A', card: { name: 'A1', kind: 'being', strength: 15, lifespan: 10, arrows: [1] }, currentLifespan: 10, engaged: false };
    const attacker2 = { type: 'being', ownerId: 'A', card: { name: 'A2', kind: 'being', strength: 5, lifespan: 10, arrows: [1] }, currentLifespan: 10, engaged: false };
    const state = baseState({
      turnPlayer: 'A',
      board: { r4c1: beingX, r4c2: beingY, r2c1: attacker1, r2c2: attacker2 },
      players: { A: player({ id: 'A' }), B: player({ id: 'B', lifespan: 30 }) },
    });

    it('picks the worse-for-B outcome (losing X) over the opponent\'s own literal top-scored reply (attacking Y)', () => {
      const afterAttackingX = evaluateState(gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c1', toCellId: 'r4c1', isAttack: true }), 'B');
      const afterAttackingY = evaluateState(gameReducer(state, { type: 'MOVE_OR_ATTACK', fromCellId: 'r2c2', toCellId: 'r4c2', isAttack: true }), 'B');
      expect(afterAttackingX).toBeLessThan(afterAttackingY); // losing X really is worse for B, confirming the scenario is set up as intended

      const budget = { remaining: 100 };
      const value = opponentReplyValue(state, 'B', budget);
      expect(value).toBe(afterAttackingX); // the worse outcome won, not just A's own top-ranked pick
    });

    it('degrades to the plain static eval instead of throwing when the node budget is already exhausted', () => {
      const budget = { remaining: 0 };
      const value = opponentReplyValue(state, 'B', budget);
      expect(value).toBe(evaluateState(state, 'B')); // no candidate could be simulated — falls back cleanly
    });
  });

  // Regression coverage for a real, reachable infinite loop found via
  // self-play: a "toggle candidates in, then confirm" pendingChoice
  // (sacrifice-x-toggle, shuffle-purgatory-toggle, etc.) doesn't change
  // any board material at all until CONFIRM commits, so the generic
  // recursive search has no signal that re-toggling is a no-progress
  // round trip — it can end up scoring "undo the toggle I just made"
  // HIGHER than actually confirming, even when confirming is clearly
  // correct, causing the AI to flip-flop the same toggle forever (see
  // valueOfCandidate's own comment for the exact captured numbers: a real
  // sacrifice-x-toggle with CONFIRM legal scored 47.5 by search vs. 51 for
  // undoing the very candidate it had just added).
  describe('toggle-then-confirm pendingChoices never loop (valueOfCandidate\'s scoreAction bypass)', () => {
    // Cemetery Physician: "sacrifice (X) Bag o' Bones: Summon a Being
    // from your Purgatory with cost (X)." One Bag o' Bones already
    // toggled in, and a real cost-1 Being sitting in Purgatory — CONFIRM
    // is legal and correct.
    const fodder = { type: 'relic', ownerId: 'A', card: { name: "Bag o' Bones", kind: 'relic', keywords: { martyr: '' } } };
    const purgatoryMatch = { instanceId: 'pb#0', name: 'Cheap Being', kind: 'being', castingCost: { faithless: 1, colored: {} } };
    const stateWithMatch = baseState({
      turnPlayer: 'A',
      board: { r1c2: fodder },
      players: { A: player({ id: 'A', purgatory: [purgatoryMatch] }), B: player({ id: 'B' }) },
      pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r1c1', fodderName: "Bag o' Bones", selected: ['r1c2'], optional: true },
    });

    it('confirms instead of undoing the toggle it just made, once CONFIRM is legal and correct', () => {
      const legal = getLegalActions(stateWithMatch, 'A').map((a) => a.type);
      expect(legal).toContain('RESOLVE_SACRIFICE_X_CONFIRM'); // sanity: this is really the "confirm is legal" shape, not the dead-end one
      const action = pickAiAction(stateWithMatch, 'A', 'hard');
      expect(action).toEqual({ type: 'RESOLVE_SACRIFICE_X_CONFIRM' });
    });

    it('still declines cleanly (does not loop) when no selection could ever match a real Purgatory cost', () => {
      const stateNoMatch = baseState({
        turnPlayer: 'A',
        board: { r1c2: fodder },
        players: { A: player({ id: 'A', purgatory: [] }), B: player({ id: 'B' }) },
        pendingChoice: { kind: 'sacrifice-x-toggle', playerId: 'A', cardName: 'Cemetery Physician', cellId: 'r1c1', fodderName: "Bag o' Bones", selected: ['r1c2'], optional: true },
      });
      const action = pickAiAction(stateNoMatch, 'A', 'hard');
      expect(action).toEqual({ type: 'RESOLVE_DECLINE' });
    });

    it('does not short-circuit RESOLVE_DECLINE on an unrelated, non-toggle optional pendingChoice', () => {
      // An optional Modulate (kind: 'modulate', not '*-toggle') — RESOLVE_DECLINE
      // here should still be judged through the normal recursive search,
      // not scoreAction's toggle-specific bypass, since this pendingChoice
      // kind was never part of the loop this fix targets.
      const prophecy = { type: 'prophecy', ownerId: 'A', card: { name: 'Some Prophecy' }, timer: 1, faceDown: true };
      const state = baseState({
        turnPlayer: 'A',
        board: { r3c1: prophecy },
        players: { A: player({ id: 'A' }), B: player({ id: 'B' }) },
        pendingChoice: { kind: 'modulate', playerId: 'A', cardName: 'Test', delta: 'choose', optional: true, anyOwner: true },
      });
      expect(() => pickAiAction(state, 'A', 'hard')).not.toThrow();
      const legal = getLegalActions(state, 'A').map((a) => a.type);
      expect(legal).toContain('RESOLVE_DECLINE'); // confirms this scenario genuinely offers Decline as an alternative
    });
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

  // The Boundless Hunger loop's own reactive windows (actions.js >
  // manageReactiveWindow's 'boundless-hunger-*' re-arm block) are ordinary
  // reactiveWindow objects — pickAiReaction needs no special-casing for
  // them, but this confirms the AI actually doesn't stall on one (passing
  // cleanly with nothing to respond with) and that doing so lets the loop's
  // own chain keep advancing rather than getting stuck waiting forever.
  it('does not stall on a Boundless Hunger reactive window — passes, and the loop keeps advancing', () => {
    const state = baseState({
      reactiveWindow: { openFor: 'B', triggerDescription: 'test', everResponded: false, passedOnce: false },
      pendingResolution: {
        kind: 'boundless-hunger-return', ownerId: 'A', cellId: 'r2c1',
        cardName: 'Immen Gorta, the Boundless Hunger', instanceId: 'immen#0', bounceCount: 0,
      },
      board: {
        r2c1: {
          type: 'being', ownerId: 'A', engaged: true, currentLifespan: 4,
          card: {
            id: 'immen', instanceId: 'immen#0', name: 'Immen Gorta, the Boundless Hunger', lifespan: 4,
            keywords: { onMovedIntoMortalRealm: 'deal (1) damage to any target.' },
          },
        },
      },
      players: { A: player({ id: 'A' }), B: player({ id: 'B' }) },
    });
    const action = pickAiReaction(state, 'B');
    expect(action).toEqual({ type: 'PASS_PRIORITY' });
    const next = gameReducer(state, action);
    // The AI's pass closed the window and resolved the deferred reaction —
    // the loop advanced to Immen Gorta's own real damage-target choice
    // rather than stalling on the window it just passed.
    expect(next.pendingChoice).toEqual(expect.objectContaining({
      kind: 'damage-target', boundlessHunger: expect.objectContaining({ bounceCount: 0 }),
    }));
  });
});

describe('synergy and combo awareness', () => {
  const mouthOfMadness = (ownerId) => ({
    type: 'relic', ownerId, card: { name: 'Mouth of Madness', kind: 'relic', keywords: { duringEndStepForceShift: 1 } },
  });
  const terraneanGates = (ownerId) => ({
    type: 'relic', ownerId, card: { name: 'Terranean Gates', kind: 'relic', keywords: { duringEndStepLoseTimeCounters: 2 } },
  });
  const immenGortaOnBoard = (ownerId = 'B') => ({
    type: 'being', ownerId,
    card: { name: 'Immen Gorta, the Boundless Hunger', kind: 'being', strength: 0, lifespan: 8, arrows: [] },
    currentLifespan: 8, engaged: false,
  });

  describe('synergyValue / evaluateState — generic keyword cross-referencing', () => {
    const typedAlly = (typing) => ({
      type: 'being', ownerId: 'B', card: { name: 'Ally', kind: 'being', strength: 2, lifespan: 3, typing, arrows: [1] },
      currentLifespan: 3, engaged: false,
    });
    // otherSameTypingBonus's own hand-potential branch (synergyValue) —
    // deliberately NOT tested via an on-board occupant: that value is
    // already priced into effectiveStrength/currentLifespan once
    // gameReducer's own recomputeLiveAuras chain has run, and synergyValue
    // deliberately skips it there to avoid double-counting (see its own
    // comment in ai.js) — testing the hand branch is what actually
    // isolates the new code.
    const synergyHandCard = {
      id: 'oth', instanceId: 'oth#0', name: 'Kin', kind: 'being', strength: 2, lifespan: 3, typing: 'Cat, Being',
      keywords: { otherSameTypingBonus: { strength: 2, lifespan: 2 } },
    };

    it('evaluateState values a hand card whose synergy condition is already met on board over an otherwise-identical board where it is not', () => {
      const withAlly = baseState({
        board: { r4c1: typedAlly('Cat, Being') },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [synergyHandCard] }) },
      });
      const withoutAlly = baseState({
        board: { r4c1: typedAlly('Rat, Being') },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [synergyHandCard] }) },
      });
      expect(evaluateState(withAlly, 'B')).toBeGreaterThan(evaluateState(withoutAlly, 'B'));
    });

    it('synergyValue caps hand-potential credit rather than growing unbounded with hand size', () => {
      const manyCopies = Array.from({ length: 6 }, (_, i) => ({ ...synergyHandCard, instanceId: `oth#${i}` }));
      const state = baseState({
        board: { r4c1: typedAlly('Cat, Being') },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: manyCopies }) },
      });
      // 6 matching hand cards, capped at HAND_POTENTIAL_SYNERGY_CAP (3) —
      // confirms the cap is real, not just a high-but-finite number.
      expect(synergyValue(state, 'B')).toBe(3 * 2); // HAND_POTENTIAL_SYNERGY_BONUS × cap
    });
  });

  describe('knownComboValue (Boundless Hunger loop)', () => {
    // Regression: piece 1 (Immen Gorta alone) deliberately scores the SAME
    // as 0 pieces, not just a smaller positive bump — self-play validation
    // found that even a small bonus for "just Immen Gorta, assembled"
    // made Hard-mode camp on re-Shifting it every turn to keep collecting
    // that credit (it already has its own self-contained Shift/damage
    // ping ability, independent of the other two pieces), losing every
    // game in that pattern instead of developing the board or actually
    // working toward the real combo. See KNOWN_COMBOS' own comment.
    it('is flat across 0-1 assembled pieces, then increasing with a disproportionate jump on the final piece', () => {
      const v0 = knownComboValue(baseState(), 'B');
      const v1 = knownComboValue(baseState({ board: { r4c1: immenGortaOnBoard() } }), 'B');
      const v2 = knownComboValue(baseState({ board: { r4c1: immenGortaOnBoard(), r2c1: mouthOfMadness('B') } }), 'B');
      const v3 = knownComboValue(baseState({
        board: { r4c1: immenGortaOnBoard(), r2c1: mouthOfMadness('B'), r2c2: terraneanGates('B') },
      }), 'B');
      expect(v0).toBe(0);
      expect(v1).toBe(v0);
      expect(v2).toBeGreaterThan(v1);
      expect(v3).toBeGreaterThan(v2);
      expect(v3 - v2).toBeGreaterThan(v2 - v1);
    });

    // Regression guard: RULES.md prints Mouth of Madness/Terranean Gates
    // with no "you control" restriction, and this is easy to get backwards
    // — a relic-keyword piece owned by the OPPONENT still counts.
    it('counts a relic-keyword piece regardless of which player owns it', () => {
      const ownedByOpponent = knownComboValue(baseState({
        board: { r4c1: immenGortaOnBoard('B'), r2c1: mouthOfMadness('A'), r2c2: terraneanGates('A') },
      }), 'B');
      const ownedBySelf = knownComboValue(baseState({
        board: { r4c1: immenGortaOnBoard('B'), r2c1: mouthOfMadness('B'), r2c2: terraneanGates('B') },
      }), 'B');
      expect(ownedByOpponent).toBe(ownedBySelf);
    });
  });

  describe('scoreAction — SUMMON_BEING/PLACE_RELIC combo preference', () => {
    const immenGortaCard = {
      id: 'immen', instanceId: 'immen#0', name: 'Immen Gorta, the Boundless Hunger', kind: 'being',
      strength: 0, lifespan: 8, timerMax: 0, arrows: [1], castingCost: { faithless: 0, colored: {} },
    };
    const vanillaCard = {
      id: 'van', instanceId: 'van#0', name: 'Big Vanilla', kind: 'being',
      strength: 8, lifespan: 8, timerMax: 0, arrows: [1], castingCost: { faithless: 0, colored: {} },
    };

    it('prefers summoning a low-strength card that completes the combo\'s final piece over a much higher-strength vanilla card', () => {
      const state = baseState({
        board: { r2c1: mouthOfMadness('B'), r2c2: terraneanGates('B') },
        players: { A: player({ id: 'A' }), B: player({ id: 'B', hand: [vanillaCard, immenGortaCard] }) },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'SUMMON_BEING', instanceId: 'immen#0', cellId: expect.any(String) });
    });

    it('a genuine lethal attack still outranks a combo-completing summon (the combo bonus can never override a real win)', () => {
      const lethalAttacker = {
        type: 'being', ownerId: 'B', card: { name: 'Lethal', kind: 'being', strength: 99, lifespan: 3, arrows: [1] },
        currentLifespan: 3, engaged: false,
      };
      const state = baseState({
        board: { r4c1: lethalAttacker, r2c1: mouthOfMadness('B'), r2c2: terraneanGates('B') },
        players: { A: player({ id: 'A', lifespan: 1 }), B: player({ id: 'B', hand: [immenGortaCard] }) },
      });
      const action = pickAiAction(state, 'B');
      expect(action).toEqual({ type: 'MOVE_OR_ATTACK', fromCellId: 'r4c1', toCellId: 'r2c1', isAttack: true });
    });
  });

  it('does not throw on a board carrying several synergy-keyword cards, and finishes well within an interactive time budget', () => {
    const costReductionCard = {
      id: 'cr', instanceId: 'cr#0', name: 'Bag o\' Bones', kind: 'relic', strength: 0, lifespan: 0, timerMax: 0, arrows: [], castingCost: { faithless: 0, colored: {} },
    };
    const typedBeing = (name, typing, ownerId) => ({
      type: 'being', ownerId, card: { name, kind: 'being', strength: 2, lifespan: 2, typing, arrows: [1] }, currentLifespan: 2, engaged: false,
    });
    const state = baseState({
      board: {
        r4c1: immenGortaOnBoard('B'), r4c2: mouthOfMadness('B'), r4c3: terraneanGates('B'),
        r5c1: typedBeing('Skeletal Colossus', 'Undead, Being', 'B'),
        r2c1: typedBeing('Opponent', 'Undead, Being', 'A'), r2c2: typedBeing('Opponent2', 'Rat, Being', 'A'),
      },
      players: {
        A: player({ id: 'A' }),
        B: player({ id: 'B', hand: [costReductionCard, { ...costReductionCard, instanceId: 'cr#1' }] }),
      },
    });
    const start = Date.now();
    expect(() => pickAiAction(state, 'B', 'hard')).not.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
