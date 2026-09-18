import { describe, it, expect } from 'vitest';
import { resolveMutualCombat, deathDamageFor, effectiveStrength, armamentStrengthBonus } from './combat.js';

const being = (strength, lifespan, currentLifespan = lifespan, armaments = []) => ({
  type: 'being',
  card: { name: 'Test Being', strength, lifespan },
  currentLifespan,
  armaments,
});

const armament = (strengthBonus) => ({
  card: { name: 'Test Armament', keywords: { statBonus: { strength: strengthBonus, lifespan: 0 } } },
  engaged: false,
});

describe('effectiveStrength / armamentStrengthBonus', () => {
  it('is just the base Strength with no Armaments attached', () => {
    expect(effectiveStrength(being(1, 1))).toBe(1);
  });

  it('adds a single Armament\'s Strength bonus (e.g. a 1/1 with +3/+0 becomes a 4/1)', () => {
    const occupant = being(1, 1, 1, [armament(3)]);
    expect(armamentStrengthBonus(occupant)).toBe(3);
    expect(effectiveStrength(occupant)).toBe(4);
  });

  it('sums multiple attached Armaments\' Strength bonuses', () => {
    const occupant = being(1, 1, 1, [armament(3), armament(1)]);
    expect(effectiveStrength(occupant)).toBe(5);
  });

  it('applies a negative Strength bonus too', () => {
    const occupant = being(5, 5, 5, [armament(-2)]);
    expect(effectiveStrength(occupant)).toBe(3);
  });
});

describe('resolveMutualCombat', () => {
  it('deals each side the other\'s Strength simultaneously', () => {
    const attacker = being(3, 5);
    const defender = being(2, 4);
    const result = resolveMutualCombat(attacker, defender);
    expect(result.attackerLifespanAfter).toBe(5 - 2); // took defender's Strength
    expect(result.defenderLifespanAfter).toBe(4 - 3); // took attacker's Strength
  });

  it('damage persists on top of prior damage', () => {
    const attacker = being(3, 5, 2); // already damaged down to 2
    const defender = being(2, 4, 1); // already damaged down to 1
    const result = resolveMutualCombat(attacker, defender);
    expect(result.attackerLifespanAfter).toBe(0);
    expect(result.defenderLifespanAfter).toBe(-2);
  });

  it('uses each side\'s Armament-boosted Strength, not just the printed value', () => {
    const attacker = being(1, 5, 5, [armament(3)]); // effective Strength 4
    const defender = being(2, 10);
    const result = resolveMutualCombat(attacker, defender);
    expect(result.attackerLifespanAfter).toBe(3); // 5 - defender's Strength 2
    expect(result.defenderLifespanAfter).toBe(6); // 10 - attacker's effective Strength 4
  });
});

describe('Fidian Nol: "During Combat if the opposing Being is not Faithless it has (-1) Strength."', () => {
  const fidianNol = (overrides = {}) => ({
    type: 'being',
    card: { name: 'Fidian Nol', strength: 1, lifespan: 2, castingCost: { faithless: 2, colored: {} }, keywords: { combatOpponentStrengthPenaltyIfNotFaithless: 1 } },
    currentLifespan: 2,
    armaments: [],
    ...overrides,
  });
  const coloredOpponent = being(3, 5, 5); // being() fixture has no castingCost -> treated as Faithless by default
  const coloredCard = (strength, lifespan) => ({
    type: 'being', card: { name: 'Colored Being', strength, lifespan, castingCost: { faithless: 0, colored: { bleeding: 1 } } }, currentLifespan: lifespan, armaments: [],
  });

  it('reduces a non-Faithless opponent\'s combat Strength by the printed amount', () => {
    const attacker = fidianNol();
    const defender = coloredCard(3, 10);
    const result = resolveMutualCombat(attacker, defender);
    expect(result.attackerLifespanAfter).toBe(2 - 2); // defender's 3 Strength, reduced by 1
    expect(result.defenderLifespanAfter).toBe(10 - 1); // Fidian Nol's own Strength unaffected
  });

  it('does not reduce a Faithless opponent\'s Strength at all', () => {
    const attacker = fidianNol();
    const defender = coloredOpponent; // no colored casting cost -> Faithless
    const result = resolveMutualCombat(attacker, defender);
    expect(result.attackerLifespanAfter).toBe(2 - 3); // full, unreduced Strength
  });

  it('floors the penalty at 0 rather than going negative', () => {
    const attacker = fidianNol({ card: { ...fidianNol().card, keywords: { combatOpponentStrengthPenaltyIfNotFaithless: 1 } } });
    const defender = coloredCard(0, 5); // already 0 Strength
    const result = resolveMutualCombat(attacker, defender);
    expect(result.attackerLifespanAfter).toBe(2); // 0 Strength - 1 penalty, floored at 0
  });

  it('only ever reduces a NON-Faithless opponent — the attacker\'s own Faithless-ness exempts it from the defender\'s identical ability', () => {
    const attacker = fidianNol({ card: { ...fidianNol().card, name: 'Fidian Nol A' } }); // Faithless itself
    const defenderCard = { name: 'Fidian Nol B', strength: 2, lifespan: 3, castingCost: { faithless: 0, colored: { bleeding: 1 } }, keywords: { combatOpponentStrengthPenaltyIfNotFaithless: 1 } };
    const defender = { type: 'being', card: defenderCard, currentLifespan: 3, armaments: [] };
    const result = resolveMutualCombat(attacker, defender);
    // Attacker's own ability fires (defender isn't Faithless): defender's 2 Strength -> 1.
    expect(result.attackerLifespanAfter).toBe(2 - 1);
    // Defender's identical ability does NOT fire back — the attacker IS Faithless, exempt by the card's own text.
    expect(result.defenderLifespanAfter).toBe(3 - 1); // attacker's full, unreduced 1 Strength
  });
});

describe('deathDamageFor', () => {
  it('is the base (printed) Lifespan, not the current one', () => {
    const occupant = being(3, 7, 0);
    expect(deathDamageFor(occupant)).toBe(7);
  });
});
