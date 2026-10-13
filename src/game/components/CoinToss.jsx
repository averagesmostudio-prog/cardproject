import React, { useEffect, useRef } from 'react';
import './coinToss.css';

// The game's gold coin: heads is the S, tails is the sunburst. A real 3D
// object (a stack of gold slices between the two faces gives it thickness),
// tossed with a parabolic arc, a tumble about its horizontal axis and a
// damped wobble as it lands. Purely presentational — the caller decides the
// result (`result`: 'heads' | 'tails'; null = resting, nothing happening yet)
// and learns the moment it lands through `onLanded(result)`.
const BASE = import.meta.env.BASE_URL;
const FACE = { heads: `${BASE}coin/coin_heads.png`, tails: `${BASE}coin/coin_tails.png` };
const EDGES = [0, 1, 2, 3, 4, 5].map(i => `${BASE}coin/coin_edge${i}.png`);
const SLICES = 44;
const REST_PITCH = 32;         // tilted toward the viewer so the rim reads at rest
export const COIN_FLIP_MS = 4200;

// Warm the cache at import time so the first in-game flip never pops in blank.
if (typeof Image !== 'undefined') {
  [FACE.heads, FACE.tails, ...EDGES].forEach(src => { new Image().src = src; });
}

const faceAt = (angle) => ((((Math.round(angle / 180) % 2) + 2) % 2) === 0 ? 'heads' : 'tails');
const rand = (a, b) => a + Math.random() * (b - a);
const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const paint = (els, angle, y, scale, tiltY, tiltZ, wobble, h) => {
  const { coin, wrap, shadow, front, back } = els;
  coin.style.transform = `rotateX(${(REST_PITCH + angle + wobble).toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) rotateZ(${tiltZ.toFixed(2)}deg)`;
  wrap.style.transform = `translate3d(0,${y.toFixed(1)}px,0) scale(${scale.toFixed(3)})`;
  shadow.style.transform = `scale(${(1 - 0.45 * h).toFixed(3)})`;
  shadow.style.opacity = (0.95 - 0.6 * h).toFixed(3);
  // the face turned toward the light is bright, the turned-away one dim, with a glint near the tilt where it mirrors the light
  const c = Math.cos((angle + wobble + REST_PITCH) * Math.PI / 180);
  const glint = 0.28 * Math.exp(-Math.pow((Math.abs(c) - 0.82) / 0.07, 2));
  front.style.filter = `brightness(${(0.5 + 0.5 * Math.max(0, c) + (c > 0 ? glint : 0)).toFixed(3)})`;
  back.style.filter = `brightness(${(0.5 + 0.5 * Math.max(0, -c) + (c < 0 ? glint : 0)).toFixed(3)})`;
};

export default function CoinToss({ result = null, size = 180, duration = COIN_FLIP_MS, onLanded }) {
  const stageRef = useRef(null);
  const wrapRef = useRef(null);
  const coinRef = useRef(null);
  const shadowRef = useRef(null);
  const frontRef = useRef(null);
  const backRef = useRef(null);
  const rotRef = useRef(0);          // multiples of 360 = heads up, odd multiples of 180 = tails up
  const restZRef = useRef(-2);
  const onLandedRef = useRef(onLanded);
  useEffect(() => { onLandedRef.current = onLanded; });

  const elements = () => ({
    stage: stageRef.current, wrap: wrapRef.current, coin: coinRef.current,
    shadow: shadowRef.current, front: frontRef.current, back: backRef.current,
  });

  // resting pose on mount
  useEffect(() => {
    paint(elements(), rotRef.current, 0, 1, 0, restZRef.current, 0, 0);
  }, []);

  // the toss, whenever a result comes in
  useEffect(() => {
    if (!result) return undefined;
    const els = elements();
    const reduced = prefersReducedMotion();
    const start = rotRef.current;
    const same = faceAt(start) === result;
    const halfTurns = reduced ? (same ? 0 : 1) : 2 * (5 + Math.floor(Math.random() * 3)) + (same ? 0 : 1);
    const delta = 180 * halfTurns;
    const D = reduced ? 450 : duration;
    const stageH = els.stage.clientHeight;
    const Hmax = reduced ? 0 : Math.max(24, Math.min(stageH * 0.30, stageH * 0.62 - els.wrap.offsetHeight * 0.5 - 6));
    const tiltZ0 = rand(-9, 9);
    const tiltYamp = rand(6, 13);
    const endZ = rand(-4, 4);
    const AIR = 0.78;
    const t0 = performance.now();
    let raf = 0;

    const frame = (now) => {
      const t = Math.min(1, (now - t0) / D);
      let y; let angle; let wobble = 0; let tiltY = 0; let tiltZ;
      if (t < AIR) {
        const u = t / AIR;
        y = -Hmax * 4 * u * (1 - u);
        angle = start + delta * 0.965 * u;
        tiltY = tiltYamp * Math.sin(u * Math.PI * 2);
        tiltZ = tiltZ0 * (1 - 0.5 * u);
      } else {
        const v = (t - AIR) / (1 - AIR);
        y = -Hmax * 0.06 * Math.sin(Math.PI * v) * (1 - v);
        angle = start + delta * (0.965 + 0.035 * (1 - Math.pow(1 - v, 3)));
        wobble = 9 * Math.exp(-5 * v) * Math.sin(v * 26) * (1 - v);
        tiltZ = tiltZ0 * 0.5 + (endZ - tiltZ0 * 0.5) * v;
      }
      const h = Hmax ? Math.min(1, -y / Hmax) : 0;
      paint(els, angle, y, 1 + 0.16 * h, tiltY, tiltZ, wobble, h);
      if (t < 1) { raf = requestAnimationFrame(frame); return; }
      rotRef.current = start + delta;
      restZRef.current = endZ;
      paint(els, rotRef.current, 0, 1, 0, endZ, 0, 0);
      onLandedRef.current?.(result);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [result, duration]);

  return (
    <div ref={stageRef} className="ct-stage" style={{ '--ct-d': `${size}px` }} aria-hidden="true">
      <div ref={shadowRef} className="ct-shadow" />
      <div ref={wrapRef} className="ct-wrap">
        <div ref={coinRef} className="ct-coin">
          {Array.from({ length: SLICES }, (_, i) => {
            const p = 1 - Math.pow(Math.abs(2 * i / (SLICES - 1) - 1), 1.7);   // brightest through the middle: a rounded rim
            return (
              <img
                key={i}
                src={EDGES[Math.round(p * (EDGES.length - 1))]}
                alt=""
                style={{ transform: `translateZ(calc(var(--ct-t) * ${(-0.5 + i / (SLICES - 1)).toFixed(4)}))` }}
              />
            );
          })}
          <img ref={frontRef} className="ct-face ct-front" src={FACE.heads} alt="" />
          <img ref={backRef} className="ct-face ct-back" src={FACE.tails} alt="" />
        </div>
      </div>
    </div>
  );
}
