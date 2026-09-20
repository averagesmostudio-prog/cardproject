import React from 'react';
import CardTile from './CardTile.jsx';

const SIZE_PX = { sm: 64, md: 96, lg: 144, xl: 192 };
const MAX_GHOSTS = 2; // extra copies peeking out behind the front card
const GHOST_OFFSET = 5; // px shift per ghost layer

export default function Hand({ cards, playableIds, selectedInstanceId, onSelect, borderImages, borderImagesLoaded, artImages, artBorderImages, artImagesLoaded, fontLoaded, cardSize = 'md', stack = true, justDrawnIds }) {
  if (cards.length === 0) {
    return <div className="text-xs text-stone-400 italic py-4">Hand is empty.</div>;
  }

  // Group same-named cards into a single stack so duplicates in hand read as
  // "one card, x N" rather than taking up N full slots of hand space. Callers
  // that need every card fully visible and unobscured (e.g. the mulligan
  // screen) can pass stack={false} to skip grouping entirely.
  const groups = [];
  const groupByName = new Map();
  for (const card of cards) {
    const key = stack ? card.name : card.instanceId;
    let group = groupByName.get(key);
    if (!group) {
      group = { name: key, cards: [] };
      groupByName.set(key, group);
      groups.push(group);
    }
    group.cards.push(card);
  }

  const widthPx = SIZE_PX[cardSize] || SIZE_PX.md;
  const ghostCount = Math.min(MAX_GHOSTS, groups.reduce((m, g) => Math.max(m, g.cards.length - 1), 0));

  return (
    <div className="flex gap-2 overflow-x-auto py-2">
      {groups.map((group) => {
        const front = group.cards[group.cards.length - 1];
        const ghosts = group.cards.slice(0, -1).slice(-MAX_GHOSTS);
        return (
          <div
            key={group.name}
            className="relative shrink-0"
            style={{ width: widthPx + ghostCount * GHOST_OFFSET, paddingTop: ghosts.length ? 4 : 0 }}
          >
            {ghosts.map((card, i) => (
              <div
                key={card.instanceId}
                className="absolute top-0 pointer-events-none"
                style={{
                  left: (i + 1) * GHOST_OFFSET,
                  transform: `rotate(${(i + 1) * 3}deg)`,
                }}
              >
                <CardTile
                  card={card}
                  dimmed={!playableIds.has(card.instanceId)}
                  size={cardSize}
                  onboard
                  hoverDelayMs={0}
                  borderImages={borderImages}
                  borderImagesLoaded={borderImagesLoaded}
                  artImages={artImages}
                  artBorderImages={artBorderImages}
                  artImagesLoaded={artImagesLoaded}
                  fontLoaded={fontLoaded}
                />
              </div>
            ))}
            <div
              key={justDrawnIds?.has(front.instanceId) ? `drawn-${front.instanceId}` : undefined}
              className={`relative ${justDrawnIds?.has(front.instanceId) ? 'card-draw-in' : ''}`}
            >
              <CardTile
                card={front}
                selected={selectedInstanceId === front.instanceId}
                dimmed={!playableIds.has(front.instanceId)}
                onClick={() => onSelect(front.instanceId)}
                borderImages={borderImages}
                borderImagesLoaded={borderImagesLoaded}
                artImages={artImages}
                artBorderImages={artBorderImages}
                artImagesLoaded={artImagesLoaded}
                fontLoaded={fontLoaded}
                size={cardSize}
                onboard
                hoverDelayMs={0}
              />
              {group.cards.length > 1 && (
                <span className="absolute -bottom-1 -right-1 z-10 bg-stone-900 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shadow">
                  {group.cards.length}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
