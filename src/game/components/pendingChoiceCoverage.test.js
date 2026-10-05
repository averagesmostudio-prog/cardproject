import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every pendingChoice kind the engine can open must be answerable somewhere
// in the UI. A kind with legal RESOLVE_* actions but no component that
// renders or highlights anything for it freezes the game for the human: the
// open pendingChoice blocks every other action and nothing on screen can
// resolve it (Animate with 2+ Relics did exactly this). This scans the
// source for each kind's string literal — crude, but it catches the whole
// class the moment a new kind is added without any UI.
const here = path.dirname(fileURLToPath(import.meta.url));
const actionsSource = fs.readFileSync(path.join(here, '../engine/actions.js'), 'utf8');
const componentSources = fs.readdirSync(here)
  .filter(f => f.endsWith('.jsx'))
  .map(f => fs.readFileSync(path.join(here, f), 'utf8'))
  .join('\n');

// Kinds resolved by the engine/AI on a seat that never shows a human UI, or
// that are intentionally prompt-less. Keep empty unless there's a reason.
const EXEMPT = new Set([]);

describe('pendingChoice UI coverage', () => {
  it('every pendingChoice kind offered by getLegalActions is referenced by a component', () => {
    const kinds = new Set([
      ...[...actionsSource.matchAll(/state\.pendingChoice\.kind === '([a-z0-9-]+)'/g)].map(m => m[1]),
    ]);
    const missing = [...kinds].filter(k => !EXEMPT.has(k) && !componentSources.includes(`'${k}'`)).sort();
    expect(missing).toEqual([]);
  });
});
