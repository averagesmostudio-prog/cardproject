import React from 'react';

// Pack reveal sparkle around a card: bronze (Historic Common/Uncommon/Rare),
// silver (Sacred Rare upgrade), gold (Historic Sacred Rare), prismatic
// colour-cycling (Immortal Rare). Sits behind the
// card as a glow ring plus twinkling stars scattered around its edge.
const COLORS = {
  bronze: { glow: '#cd7f32', star: '#e8a05a' },
  silver: { glow: '#c0c8d4', star: '#f1f5fb' },
  gold: { glow: '#ffc933', star: '#fff0a0' },
  immortal: { glow: '#d94bff', star: '#ffffff' },
};

// Fixed positions (percent of the card box, spilling slightly outside it) so
// the pattern is stable between renders.
const STARS = [
  [-6, 8], [-8, 32], [-5, 58], [-9, 82], [4, -6], [28, -9], [52, -5], [76, -8], [98, -4],
  [106, 14], [104, 40], [107, 66], [103, 90], [14, 104], [38, 107], [62, 104], [86, 108],
];

export default function SparkleFrame({ tier }) {
  const c = COLORS[tier];
  if (!c) return null;
  return (
    <div
      className={`absolute inset-0 pointer-events-none ${tier === 'immortal' ? 'sparkle-prismatic' : ''}`}
      aria-hidden="true"
    >
      <div
        className="sparkle-glow absolute inset-0 rounded-lg"
        style={{ '--sparkle-glow': c.glow }}
      />
      {STARS.map(([x, y], i) => (
        <span
          key={i}
          className="sparkle-star absolute"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            '--sparkle-star': c.star,
            '--sparkle-glow': c.glow,
            animationDelay: `${(i * 137) % 1100}ms`,
            width: i % 3 === 0 ? 16 : 11,
            height: i % 3 === 0 ? 16 : 11,
          }}
        />
      ))}
    </div>
  );
}
