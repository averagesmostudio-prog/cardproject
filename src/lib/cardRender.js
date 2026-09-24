// Canvas rendering pipeline for a finished card (border art + all card
// text/pips), extracted from the Generator so the Game can render the exact
// same card visuals (deckbuilder thumbnails, board/hand tiles, etc.).
// `card` throughout is a raw CSV row (the shape getColumnData expects) —
// callers holding a Game engine card should pass its `.raw` field.
import { getColumnData, EFFIGY_TYPE_COLORS, parseEffigyCost, getBorderTypeForCard } from './cardData.js';

// Standard Magic: The Gathering trim size (2.5in x 3.5in) at 300 DPI print resolution.
export const CARD_PX_WIDTH = 750;
export const CARD_PX_HEIGHT = 1050;

// "On Board" alternate style: a shorter card cropped down from the standard
// stock rather than the full 2.5in x 3.5in trim, sized to match its own
// border art's proportions (near-square) instead of being force-fit into
// the taller default shape. Same 2.5in width, ~2.4in height.
export const ONBOARD_CARD_PX_WIDTH = 750;
export const ONBOARD_CARD_PX_HEIGHT = 720;

// MakePlayingCards.com's required upload size: 2.72in x 3.70in (bleed-inclusive) at 300 DPI.
export const MPC_PX_WIDTH = 816;
export const MPC_PX_HEIGHT = 1110;

export const SHEET_COLS = 3;
export const SHEET_ROWS = 3;
export const CARDS_PER_SHEET = SHEET_COLS * SHEET_ROWS;
export const EXPORT_DPI = 300;

let crc32Table = null;
const crc32 = (bytes) => {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

// canvas.toBlob()/toDataURL() never embed a physical resolution, so viewers and
// printers default to 72-96 DPI and render a 750x1050px (300 DPI) card several
// times too large. This stamps a pHYs chunk right after IHDR so the file always
// reports its true print size (2.5in x 3.5in at 300 DPI) to anything that reads it.
export const pngBlobWithDpi = async (canvas, dpi = EXPORT_DPI) => {
  const rawBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const buf = new Uint8Array(await rawBlob.arrayBuffer());

  const ihdrEnd = 8 + 25; // 8-byte signature + (4 len + 4 type + 13 data + 4 crc)
  const pixelsPerMeter = Math.round(dpi / 0.0254);

  const typeAndData = new Uint8Array(4 + 9);
  typeAndData.set([0x70, 0x48, 0x59, 0x73], 0); // "pHYs"
  const dataView = new DataView(typeAndData.buffer);
  dataView.setUint32(4, pixelsPerMeter);
  dataView.setUint32(8, pixelsPerMeter);
  typeAndData[12] = 1; // unit specifier: meters

  const chunk = new Uint8Array(4 + typeAndData.length + 4);
  new DataView(chunk.buffer).setUint32(0, 9);
  chunk.set(typeAndData, 4);
  new DataView(chunk.buffer).setUint32(4 + typeAndData.length, crc32(typeAndData));

  const result = new Uint8Array(buf.length + chunk.length);
  result.set(buf.subarray(0, ihdrEnd), 0);
  result.set(chunk, ihdrEnd);
  result.set(buf.subarray(ihdrEnd), ihdrEnd + chunk.length);

  return new Blob([result], { type: 'image/png' });
};

export const DEFAULT_POSITIONS = {
  effigyCost: { x: 0.125, y: 0.085 },
  cardTyping: { x: 0.12, y: 0.935 },
  cardName: { x: 0.5, y: 0.605 },
  arrowText: { x: 0.5, y: 0.095 },
  textBox: { x: 0.08, y: 0.686 },
  strength: { x: 0.83, y: 0.07 },
  lifespan: { x: 0.89, y: 0.11 },
  rarity: { x: 0.88, y: 0.935 },
  artist: { x: 0.12, y: 0.935 },
  wellPlayed: { x: 0.75, y: 0.982 },
  rarityCorner: { x: 0.164, y: 0.982 },
  setNumber: { x: 0.22, y: 0.982 },
};

export const wrapText = (ctx, text, x, y, maxWidth, lineHeight) => {
  if (!text) return;

  const normalizedText = text.replace(/\\n/g, '\n');
  const paragraphs = normalizedText.split('\n');
  let currentY = y;

  paragraphs.forEach((paragraph, pIndex) => {
    const words = paragraph.trim().split(' ');
    let line = '';

    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i] + ' ';
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;

      if (testWidth > maxWidth && i > 0) {
        ctx.fillText(line, x, currentY);
        currentY += lineHeight;
        line = words[i] + ' ';
      } else {
        line = testLine;
      }
    }
    if (line.trim()) {
      ctx.fillText(line, x, currentY);
    }

    if (pIndex < paragraphs.length - 1) {
      currentY += lineHeight;
    }
  });

  return Math.ceil((currentY - y) / lineHeight) + 1;
};

// Draws one fully rendered card (template + all card data) onto `canvas`.
// Pure function of its arguments so it can be reused for both the live
// preview and the print-sheet export, which render cards off-screen.
export const renderCardOnCanvas = (canvas, card, img, positions, targetWidth = CARD_PX_WIDTH, targetHeight = CARD_PX_HEIGHT, borderStyle = 'default', artImg = null, artBoxRect = null) => {
  const ctx = canvas.getContext('2d');
  // Accepts an HTMLImageElement (naturalWidth/Height) or a canvas (width/height) —
  // the latter is how a tinted basic-effigy template gets drawn.
  const imgWidth = img && (img.naturalWidth || img.width);
  const imgHeight = img && (img.naturalHeight || img.height);
  if (!img || !imgWidth) return;

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  // A card with a real illustration passes its art image plus the matching
  // transparent-art-box border (as `img`) — draw the art first so the
  // border's punched-out hole reveals it instead of the plain white/tan
  // placeholder. Cover-fit into artBoxRect (fractions of the card canvas,
  // not the whole canvas) so the illustration fills its box with no
  // distortion, cropping any excess.
  if (artImg && artBoxRect) {
    const artNW = artImg.naturalWidth || artImg.width;
    const artNH = artImg.naturalHeight || artImg.height;
    if (artNW && artNH) {
      const boxX = artBoxRect.x0 * canvas.width;
      const boxY = artBoxRect.y0 * canvas.height;
      const boxW = (artBoxRect.x1 - artBoxRect.x0) * canvas.width;
      const boxH = (artBoxRect.y1 - artBoxRect.y0) * canvas.height;
      const artScale = Math.max(boxW / artNW, boxH / artNH);
      const artDrawW = artNW * artScale;
      const artDrawH = artNH * artScale;
      const artOffsetX = boxX + (boxW - artDrawW) / 2;
      const artOffsetY = boxY + (boxH - artDrawH) / 2;
      ctx.drawImage(artImg, artOffsetX, artOffsetY, artDrawW, artDrawH);
    }
  }

  // Cover-fit the template art into the standard card frame so it fills the
  // frame with no distortion, cropping any slight excess from the source image.
  const scale = Math.max(canvas.width / imgWidth, canvas.height / imgHeight);
  const drawWidth = imgWidth * scale;
  const drawHeight = imgHeight * scale;
  const offsetX = (canvas.width - drawWidth) / 2;
  const offsetY = (canvas.height - drawHeight) / 2;
  ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

  const w = canvas.width;
  const h = canvas.height;

  // The On Board style's shorter, differently-curved corners need their own
  // anchor points for the cost/stat clusters — reusing the default card's
  // positions left them sitting too high, not settled into the curve the
  // way they are on the standard card. These are independent of `positions`
  // (which the Default style's Position Controls still fully own).
  // 'onboardStats' (cardData.js > BORDER_STYLES) reuses every bit of the
  // On Board shape/geometry below — only the two blocks guarded by
  // `isOnboardStats` further down (the cost corner and the Strength/
  // Lifespan corner) actually differ.
  const isOnboard = borderStyle === 'onboard' || borderStyle === 'onboardStats';
  const isOnboardStats = borderStyle === 'onboardStats';
  const effigyCostPos = isOnboard ? { x: 0.135, y: 0.13 } : positions.effigyCost;
  const onboardStrengthX = 0.825;
  const onboardStrengthY = 0.115;
  const onboardStatStep = 0.06;
  const strengthPos = isOnboard ? { x: onboardStrengthX, y: onboardStrengthY } : positions.strength;
  // strength/lifespan sit on a true 45deg diagonal (matching their own glyph
  // tilt and the divider between them) — the x/y step must be equal in actual
  // pixels, not just in each axis's own fraction, or the shorter On Board
  // canvas compresses the vertical step and the two numbers look unevenly
  // staggered relative to each other.
  const lifespanPos = isOnboard
    ? { x: onboardStrengthX + onboardStatStep, y: onboardStrengthY + onboardStatStep * (w / h) }
    : positions.lifespan;
  const onboardMixedAnchor = { x: 0.135, y: 0.107 };
  // On Board Border's Strength numeral starts from the exact spot a real
  // single-pip Casting Cost (e.g. cost 1) already lands on — same formula as
  // that pip's own final position further down (arcCounts loop, count===1
  // case): stepped out from the corner ornament's own apex (w*0.0675,
  // w*0.0675 — a true pixel offset, not a per-axis fraction, since it has to
  // hold on the non-square On Board canvas) along the ornament's own 45deg
  // axis by the same startOffset a pip clears its base by. A big bold
  // numeral needs more clearance than that tiny pip even centered on its
  // exact spot, though — its own ascender still reached into the border's
  // decorative corner rays there — so `onboardStatsExtraPush` (scaled off
  // the numeral's own font size, not a flat pixel value, so it still clears
  // at any render size) steps it further down the same diagonal, deeper
  // into the black curve. Lifespan mirrors it into the top-right corner,
  // landing on the strength/lifespan side's own dividing line.
  const onboardStatsFontSizeFraction = 0.09;
  // Shared by Full Border and Digital Border's own Strength/Lifespan corner
  // (and the same font's Timer-instead-of-stats branch, and an Armament's
  // own +X/+Y bonus numbers — all draw through this same block) — bumped
  // from the original 0.055 so both styles read at the same size as each
  // other. On Board Border's own numerals are bigger still (see
  // onboardStatsFontSizeFraction) since it only ever shows one at a time.
  const regularStatFontFraction = 0.07;
  const onboardStatsPipRadius = Math.max(4, w * 0.016);
  const onboardStatsPipStartOffset = w * 0.036 + onboardStatsPipRadius;
  const onboardStatsExtraPush = w * onboardStatsFontSizeFraction * 0.6;
  const onboardStatsCornerStep = w * 0.0675 + Math.SQRT1_2 * (onboardStatsPipStartOffset + onboardStatsExtraPush);
  const onboardStatsCostAnchor = { x: onboardStatsCornerStep / w, y: onboardStatsCornerStep / h };
  const onboardStatsLifespanAnchor = { x: 1 - onboardStatsCornerStep / w, y: onboardStatsCornerStep / h };

  const effigyCost = card['effigy costs'] || card['Effigy Costs'] || card['Effigy Cost'] || card['C'] || card['Column C'] || '';
  const cardTyping = getColumnData(card, ['Card typing', 'Card Typing', 'B', 'Column B']);
  const arrowsValue = getColumnData(card, ['Arrows (Clockwise top center = 1)', 'Arrows (Clockwise top center = 1', 'Arrows', 'I', 'Column I']);
  const cardName = getColumnData(card, ['Card Name', 'A', 'Column A']);
  const textBox = getColumnData(card, ['Text Box', 'E', 'Column E']);
  let strength = getColumnData(card, ['Strength', 'F', 'Column F']);
  let lifespan = getColumnData(card, ['Lifespan', 'G', 'Column G']);
  const timer = getColumnData(card, ['Timer', 'H', 'Column H']);
  const rarity = getColumnData(card, ['Rarity', 'rarity']);

  // Armaments don't carry their own Strength/Lifespan — their stat boost lives
  // in the rules text instead ("Being gains +1/+1"). Pull those two signed
  // numbers out and show them where Strength/Lifespan normally go.
  if (cardTyping.toLowerCase().includes('armament')) {
    const gainsMatch = textBox.match(/Being gains\s*([+-]?\d+)\s*\/\s*([+-]?\d+)/i);
    if (gainsMatch) {
      const signedNumber = (raw) => (raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`);
      strength = signedNumber(gainsMatch[1]);
      lifespan = signedNumber(gainsMatch[2]);
    }
  }
  const effigyTypeColumn = getColumnData(card, ['Effigy type', 'Effigy Type', 'K', 'Column K']).toLowerCase();

  // On Board Border only actually swaps stats for a Being or Armament (the
  // only kinds with a real Strength/Lifespan to show) — a Relic/Prophecy/
  // Conjuring styled 'onboardStats' renders exactly like Digital Border,
  // same as cardData.js > BORDER_STYLES.onboardStats says it should.
  const typingLower = cardTyping.toLowerCase();
  const appliesStatSwap = isOnboardStats && (typingLower.includes('being') || typingLower.includes('armament'));

  const costParts = parseEffigyCost(effigyCost);

  const usesPips = (part) => {
    const isFaithless = part.type === 'faithless' || part.type === '';
    return !isFaithless && /^\d+$/.test(part.number) && parseInt(part.number, 10) > 0;
  };

  if (appliesStatSwap) {
    // On Board Border: the cost corner shows this card's Strength instead of
    // its casting cost — once something is actually sitting on the board,
    // what it cost to get there doesn't matter anymore, but Strength does,
    // and giving it this corner's own room lets it read as a single big
    // numeral instead of splitting the diagonal Strength/Lifespan corner
    // (below) between two smaller ones.
    ctx.save();
    ctx.translate(w * onboardStatsCostAnchor.x, h * onboardStatsCostAnchor.y);
    ctx.rotate(-45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * onboardStatsFontSizeFraction)}px Cinzel`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, Math.floor(w * 0.005));
    ctx.strokeStyle = '#000000';
    ctx.strokeText(strength, 0, 0);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(strength, 0, 0);
    ctx.restore();
  } else if (costParts.length > 0) {
    // A written number combined with pips needs more room than a number alone —
    // centering both together around the number's own anchor pushed the pips
    // into the border curve, so a mixed cost gets its own, more generous anchor.
    const isMixedCost = costParts.some(usesPips) && costParts.some(p => !usesPips(p));
    const mixedAnchor = isOnboard ? onboardMixedAnchor : { x: 0.142, y: 0.075 };
    const anchorX = isMixedCost ? w * mixedAnchor.x : w * effigyCostPos.x;
    const anchorY = isMixedCost ? h * mixedAnchor.y : h * effigyCostPos.y;

    ctx.save();
    ctx.translate(anchorX, anchorY);
    ctx.rotate(-45 * Math.PI / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    const fontSize = Math.floor(w * 0.062);
    ctx.font = `bold ${fontSize}px Cinzel, serif`;
    const spaceWidth = ctx.measureText(' ').width;

    const typeMap = EFFIGY_TYPE_COLORS;

    // Non-faithless numeric costs render as a compact cluster of colored pips,
    // sized/positioned to stay tight in the top-left corner.
    const pipRadius = Math.max(4, w * 0.016);
    const pipGap = pipRadius * 0.9;
    // This grid (used when a cost mixes a written number with pips) has no
    // per-row curve/border awareness like the pure-pip layout does, so it wraps
    // into narrower rows of 2 rather than 3 to keep from reaching past the top
    // border or the curve on wider, multi-row costs.
    const maxPipsPerRow = 2;

    const getPipLayout = (count) => {
      const rows = Math.ceil(count / maxPipsPerRow);
      const rowCounts = [];
      let remaining = count;
      for (let i = 0; i < rows; i++) {
        const n = Math.min(maxPipsPerRow, remaining);
        rowCounts.push(n);
        remaining -= n;
      }
      let maxRowWidth = 0;
      rowCounts.forEach(n => {
        const rw = n * pipRadius * 2 + Math.max(0, n - 1) * pipGap;
        if (rw > maxRowWidth) maxRowWidth = rw;
      });
      const totalHeight = rows * pipRadius * 2 + Math.max(0, rows - 1) * pipGap;
      return { rows, rowCounts, maxRowWidth, totalHeight };
    };

    // Written-number parts always render before pip parts, regardless of the
    // order they appear in the cost string, so a written number stays on the
    // left of the cluster and pips stay on the right.
    const orderedCostParts = [...costParts].sort((a, b) => (usesPips(a) ? 1 : 0) - (usesPips(b) ? 1 : 0));

    // Measure pass: figure out each part's width so the whole cost block (number
    // and pips together) can be centered as one group.
    const partWidthOf = (part) => usesPips(part)
      ? getPipLayout(parseInt(part.number, 10)).maxRowWidth
      : ctx.measureText(part.number).width;
    let totalCostWidth = 0;
    orderedCostParts.forEach((part) => {
      totalCostWidth += partWidthOf(part) + spaceWidth;
    });
    let xOffset = -totalCostWidth / 2;

    // Draw pass
    orderedCostParts.forEach((part) => {
      const color = typeMap[part.type] || '#000000';
      const isFaithless = part.type === 'faithless' || part.type === '';

      if (usesPips(part) && costParts.length === 1) {
        // Center the whole cluster directly on the corner ornament's own dividing
        // line (case 8, rotated 315deg) instead of an arc measured from the far-off
        // border-curve circle — that mismatch was why the pips kept reading high
        // and to the right instead of tracking the ornament itself. Rows step
        // outward from the ornament along that line's own axis; pips within a row
        // spread perpendicular to it.
        const count = parseInt(part.number, 10);
        const arcSpacing = pipRadius * 2 + pipGap;
        const maxPerArc = 3;
        const arcCount = Math.ceil(count / maxPerArc);
        const arcCounts = [];
        let remaining = count;
        for (let i = 0; i < arcCount; i++) {
          const n = Math.min(maxPerArc, remaining);
          arcCounts.push(n);
          remaining -= n;
        }

        const ornamentX = w * 0.0675;
        const ornamentY = w * 0.0675;
        const cos45 = Math.SQRT1_2;
        // Direction pointing from the ornament's apex out through its base, i.e.
        // away from the card's corner and into the black border — where the pips
        // have room to sit.
        const lineDirX = cos45;
        const lineDirY = cos45;
        const perpDirX = -cos45;
        const perpDirY = cos45;
        // Clear the ornament's own base edge (~31px at the standard 750px-wide
        // card, so expressed as a fraction of w) before the first row starts —
        // must scale with w, not sit at a fixed pixel value, or it reads wildly
        // too far from the ornament on small renders like search thumbnails.
        const startOffset = w * 0.036 + pipRadius;

        arcCounts.forEach((n, arcIndex) => {
          const alongLine = startOffset + arcIndex * arcSpacing;
          const rowCenterX = ornamentX + lineDirX * alongLine;
          const rowCenterY = ornamentY + lineDirY * alongLine;
          for (let j = 0; j < n; j++) {
            const perpOffset = (j - (n - 1) / 2) * arcSpacing;
            const gx = rowCenterX + perpDirX * perpOffset;
            const gy = rowCenterY + perpDirY * perpOffset;
            // Convert the absolute canvas target back into this context's rotated
            // (-45deg) local space, since ctx.arc below still runs inside that rotation.
            const dx = gx - w * effigyCostPos.x;
            const dy = gy - h * effigyCostPos.y;
            const px = cos45 * (dx - dy);
            const py = cos45 * (dx + dy);
            ctx.beginPath();
            ctx.arc(px, py, pipRadius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        });

        xOffset += getPipLayout(count).maxRowWidth + spaceWidth;
      } else if (usesPips(part)) {
        const count = parseInt(part.number, 10);
        const layout = getPipLayout(count);
        const partWidth = layout.maxRowWidth;
        const xPos = xOffset + partWidth / 2;

        const rowHeight = pipRadius * 2 + pipGap;
        // Centered on y=0 so the pip block's vertical middle lines up with the
        // written number, which is always drawn at y=0.
        const startY = -layout.totalHeight / 2 + pipRadius;

        layout.rowCounts.forEach((n, rowIndex) => {
          const rowWidth = n * pipRadius * 2 + Math.max(0, n - 1) * pipGap;
          const rowStartX = xPos - rowWidth / 2 + pipRadius;
          const y = startY + rowIndex * rowHeight;
          for (let j = 0; j < n; j++) {
            const px = rowStartX + j * (pipRadius * 2 + pipGap);
            // The row closest to the corner (row 0, when there's more than one row)
            // needs to clear the top border above it, which even the outer pip was
            // still poking into. Rows only ever hold up to 2 pips now, so both get
            // the same drop — an uneven amount between just two pips read as
            // misaligned rather than protective.
            const cornerDrop = (layout.rows > 1 && rowIndex === 0)
              ? pipRadius * 0.8
              : 0;
            const py = y + cornerDrop;
            ctx.beginPath();
            ctx.arc(px, py, pipRadius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        });

        xOffset += partWidth + spaceWidth;
      } else {
        const numWidth = ctx.measureText(part.number).width;
        const xPos = xOffset + numWidth / 2;

        if (isFaithless) {
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1;
          ctx.strokeText(part.number, xPos, 0);
        } else {
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 4;
          ctx.strokeText(part.number, xPos, 0);
        }

        // A written "0" has no pip-worthy type of its own to color it by, so it
        // falls back to the card's overall effigy type instead (e.g. Kernel).
        // A written "X" cost is always white, regardless of type.
        let numColor = color;
        if (part.number === 'X') {
          numColor = '#FFFFFF';
        } else if (part.number === '0') {
          numColor = EFFIGY_TYPE_COLORS[effigyTypeColumn] || color;
        }

        ctx.fillStyle = numColor;
        ctx.fillText(part.number, xPos, 0);

        xOffset += numWidth + spaceWidth;
      }
    });

    ctx.restore();
  }

  if (arrowsValue && arrowsValue !== 'XXX') {
    const borderOffset = w * 0.025;
    // Proportions measured from the card's border ornament triangle (~2.75:1 width:height)
    const triangleBaseWidth = w * 0.15;
    const triangleHeight = w * 0.0545;
    // Corners: taller and narrower than the top/bottom triangle
    const cornerTriangleBaseWidth = triangleBaseWidth * 0.85;
    const cornerTriangleHeight = triangleHeight * 2.3;
    // Slight outward bulge on the base to echo the border's rounded corner curve
    const cornerBaseCurve = cornerTriangleHeight * -0.4;
    // Sides: matches the top/bottom triangle width, same height
    const sideTriangleBaseWidth = triangleBaseWidth;
    const sideTriangleHeight = triangleHeight;
    // Bottom-center: extended further down so the tip reaches the border's
    // ornament point instead of stopping short of it. The On Board art has a
    // noticeably bigger V-notch there than the default border, so it gets its
    // own larger multiplier rather than sharing the default's.
    const bottomTriangleHeight = triangleHeight * (isOnboard ? 1.4 : 1.15);
    const bottomTriangleBaseWidth = triangleBaseWidth * (isOnboard ? 1.4 : 1);

    let triangleFillColor = '#FFFFFF';
    const costLower = effigyCost.toLowerCase();
    if (costLower.includes('bleeding')) {
      triangleFillColor = EFFIGY_TYPE_COLORS.bleeding;
    } else if (costLower.includes('timeless')) {
      triangleFillColor = EFFIGY_TYPE_COLORS.timeless;
    } else if (costLower.includes('formless')) {
      triangleFillColor = EFFIGY_TYPE_COLORS.formless;
    } else if (costLower.includes('living')) {
      triangleFillColor = EFFIGY_TYPE_COLORS.living;
    } else if (costLower.includes('shifting') || costLower.includes('shifitng')) {
      triangleFillColor = EFFIGY_TYPE_COLORS.shifting;
    }

    const arrowPositions = arrowsValue.split('').map(n => parseInt(n)).filter(n => !isNaN(n));

    const drawArrow = (x, y, rotation, baseWidth = triangleBaseWidth, height = triangleHeight, dividerWidthFactor = 0.06, baseCurve = 0, dividerLengthFactor = 1) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((rotation * Math.PI) / 180);

      const apexY = -height * (2 / 3);
      const baseY = height * (1 / 3);
      const halfWidth = baseWidth / 2;

      ctx.fillStyle = triangleFillColor;
      ctx.beginPath();
      ctx.moveTo(0, apexY);
      ctx.lineTo(-halfWidth, baseY);
      if (baseCurve !== 0) {
        ctx.quadraticCurveTo(0, baseY + baseCurve, halfWidth, baseY);
      } else {
        ctx.lineTo(halfWidth, baseY);
      }
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(2, height * 0.1);
      ctx.stroke();

      // Bisect the triangle down the center, apex to base midpoint (optionally shortened
      // so it doesn't poke past the border on larger triangles)
      const dividerMid = (apexY + baseY) / 2;
      const dividerApexY = dividerMid + (apexY - dividerMid) * dividerLengthFactor;
      const dividerBaseY = dividerMid + (baseY - dividerMid) * dividerLengthFactor;
      ctx.beginPath();
      ctx.moveTo(0, dividerApexY);
      ctx.lineTo(0, dividerBaseY);
      ctx.lineWidth = Math.max(1.5, height * dividerWidthFactor);
      ctx.stroke();

      ctx.restore();
    };

    arrowPositions.forEach(pos => {
      switch (pos) {
        case 1:
          drawArrow(w * 0.5, borderOffset * 1.5, 0, triangleBaseWidth, triangleHeight, 0.1);
          break;
        case 2:
          drawArrow(w - borderOffset * 2.7, borderOffset * 2.7, 45, cornerTriangleBaseWidth, cornerTriangleHeight, 0.06, cornerBaseCurve, 0.65);
          break;
        case 3:
          drawArrow(w - borderOffset * 1.5, h * 0.5, 90, sideTriangleBaseWidth, sideTriangleHeight, 0.1);
          break;
        case 4:
          drawArrow(w - borderOffset * 2.4, h - borderOffset * 2.4, 135, cornerTriangleBaseWidth, cornerTriangleHeight, 0.06, cornerBaseCurve, 0.65);
          break;
        case 5: {
          // The clip keeps the triangle from bleeding past the card's bottom
          // trim edge — the On Board triangle is much bigger, so it needs a
          // taller clip window than the default's, or most of it gets cut off.
          const clipStart = isOnboard ? h * 0.94 : h * 0.967;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, clipStart, w, h - clipStart);
          ctx.clip();
          drawArrow(w * 0.5, h - borderOffset * 1.5, 180, bottomTriangleBaseWidth, bottomTriangleHeight, 0.1);
          ctx.restore();
          break;
        }
        case 6:
          drawArrow(borderOffset * 2.4, h - borderOffset * 2.4, 225, cornerTriangleBaseWidth, cornerTriangleHeight, 0.06, cornerBaseCurve, 0.65);
          break;
        case 7:
          drawArrow(borderOffset * 1.5, h * 0.5, 270, sideTriangleBaseWidth, sideTriangleHeight, 0.1);
          break;
        case 8:
          drawArrow(borderOffset * 2.7, borderOffset * 2.7, 315, cornerTriangleBaseWidth, cornerTriangleHeight, 0.06, cornerBaseCurve, 0.65);
          break;
        default:
          break;
      }
    });
  }

  // The On Board style has no text box/typeline/artist/set info/copyright —
  // those measurements were taken from the reference card and don't apply to
  // this shorter, differently-proportioned art, and the card reads cleaner
  // as art-plus-name-plus-cost/stats alone. The name moves down into the
  // border art's own tan bar since that's otherwise empty once the type
  // line/artist row it normally holds is gone. The three On Board images'
  // own tan bars don't quite match in thickness/position, so rather than
  // chase each one separately, every On Board card uses one shared box —
  // the Being/Armament/Prophecy border's tan bar (its best-proportioned one),
  // measured at ~0.856h-0.939h on the 750x720 On Board canvas — and centers
  // the name in it the same way regardless of which border is showing.
  const ONBOARD_NAME_BOX = { top: 0.856, bottom: 0.939 };
  // Cinzel renders the name in all-caps with no true descenders, so
  // textBaseline 'middle' (which centers on the font's full ascent/descent
  // box) sits the visible glyphs a hair above true center. +0.008 nudges the
  // draw point down to compensate, confirmed by measuring actual glyph ink
  // against the tan bar's own border lines rather than trusting the metric.
  const nameOpticalCenterFix = 0.008;
  const cardNameY = (isOnboard ? (ONBOARD_NAME_BOX.top + ONBOARD_NAME_BOX.bottom) / 2 : positions.cardName.y) + nameOpticalCenterFix;

  ctx.font = `600 ${Math.floor(w * 0.06)}px Cinzel, serif`;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Widened from 0.7 — an unusually long name (Immen Gorta, the Boundless
  // Hunger) was shrinking all the way down near the floor just to fit one
  // line, well past where the auto-shrink loop needs to kick in for a more
  // typical name. Bar's own physical width is ~0.896 of the card (measured
  // off the border art itself), so this still leaves real margin either side.
  const maxCardNameWidth = w * 0.78;
  let cardNameFontSize = Math.floor(w * 0.06);
  ctx.font = `600 ${cardNameFontSize}px Cinzel, serif`;
  let textWidth = ctx.measureText(cardName).width;

  while (textWidth > maxCardNameWidth && cardNameFontSize > Math.floor(w * 0.035)) {
    cardNameFontSize -= 2;
    ctx.font = `600 ${cardNameFontSize}px Cinzel, serif`;
    textWidth = ctx.measureText(cardName).width;
  }

  if (textWidth > maxCardNameWidth) {
    const words = cardName.split(' ');
    let line1 = '';
    let line2 = '';
    let foundBreak = false;

    for (let i = 0; i < words.length; i++) {
      const testLine = line1 + (line1 ? ' ' : '') + words[i];
      if (ctx.measureText(testLine).width > maxCardNameWidth && line1) {
        foundBreak = true;
        line2 = words.slice(i).join(' ');
        break;
      } else {
        line1 = testLine;
      }
    }

    if (foundBreak) {
      const lineHeight = cardNameFontSize * 1.2;
      ctx.fillText(line1, w * positions.cardName.x, h * cardNameY - lineHeight / 2);
      ctx.fillText(line2, w * positions.cardName.x, h * cardNameY + lineHeight / 2);
    } else {
      ctx.fillText(cardName, w * positions.cardName.x, h * cardNameY);
    }
  } else {
    ctx.fillText(cardName, w * positions.cardName.x, h * cardNameY);
  }

  if (!isOnboard) {
  let textBoxFontSize = Math.floor(w * 0.05);
  ctx.font = `700 ${textBoxFontSize}px Cinzel, serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let textBoxX = w * positions.textBox.x;
  // Right margin mirrors the left margin (positions.textBox.x), so the box is always
  // centered within the card regardless of how that margin is tuned.
  let textBoxWidth = w * (1 - 2 * positions.textBox.x);
  let lineHeight = textBoxFontSize * 1.1;
  let textBoxY = h * positions.textBox.y;
  // Name/text divider line sits at ~0.636h (measured from the "bottom border matched"
  // reference card). Enforce a gap of at least a full line-height between the divider and
  // the top of the first text line — since textBaseline is 'middle', that means textBoxY
  // must be at least 1.5x lineHeight below the divider.
  const nameTextDividerY = h * 0.636;
  const minTextBoxY = nameTextDividerY + lineHeight * 1.5;
  textBoxY = Math.max(textBoxY, minTextBoxY);
  // Hard cap: text must never start lower than this, measured from the reference card
  textBoxY = Math.min(textBoxY, h * 0.686);
  const lowerBorder = h * 0.85;
  // Shrink-to-fit logic must never pull text back up past the same minimum gap used above
  const upperBorder = minTextBoxY;
  const minFontSize = Math.floor(w * 0.025);

  const testLineCount = (width) => {
    const normalizedText = (textBox || '').replace(/\\n/g, '\n');
    const paragraphs = normalizedText.split('\n');
    let totalLines = 0;

    paragraphs.forEach(paragraph => {
      const words = paragraph.trim().split(' ');
      if (words.length === 0 || words[0] === '') return;

      let line = '';
      let lineCount = 0;

      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + ' ';
        const metrics = ctx.measureText(testLine);

        if (metrics.width > width && i > 0) {
          lineCount++;
          line = words[i] + ' ';
        } else {
          line = testLine;
        }
      }
      lineCount++;
      totalLines += lineCount;
    });

    return totalLines;
  };

  let lineCount = testLineCount(textBoxWidth);

  let textEndY = textBoxY + (lineCount * lineHeight);
  if (textEndY > lowerBorder) {
    const adjustment = textEndY - lowerBorder;
    let newTextBoxY = textBoxY - adjustment;

    if (newTextBoxY < upperBorder) {
      while (newTextBoxY < upperBorder && textBoxFontSize > minFontSize) {
        textBoxFontSize -= 1;
        lineHeight = textBoxFontSize * 1.1;
        ctx.font = `700 ${textBoxFontSize}px Cinzel, serif`;

        lineCount = testLineCount(textBoxWidth);
        textEndY = textBoxY + (lineCount * lineHeight);

        if (textEndY > lowerBorder) {
          const newAdjustment = textEndY - lowerBorder;
          newTextBoxY = textBoxY - newAdjustment;
        } else {
          newTextBoxY = textBoxY;
          break;
        }
      }
    }

    textBoxY = Math.max(upperBorder, newTextBoxY);
  }

  wrapText(ctx, textBox, textBoxX, textBoxY, textBoxWidth, lineHeight);
  }

  if (strength === 'XXX' && lifespan === 'XXX' && timer === 'XXX') {
    // Leave blank
  } else if (strength === 'XXX' && lifespan === 'XXX') {
    ctx.save();
    ctx.translate(w * strengthPos.x, h * strengthPos.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * regularStatFontFraction)}px Cinzel, serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timer, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(w * lifespanPos.x, h * lifespanPos.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * regularStatFontFraction)}px Cinzel`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('T', 0, 0);
    ctx.restore();
  } else {
    // On Board Border already drew Strength in the cost corner above — this
    // corner shows Lifespan alone instead of the usual Strength/Lifespan
    // pair, per BORDER_STYLES.onboardStats's own comment (cardData.js).
    if (!appliesStatSwap) {
      ctx.save();
      ctx.translate(w * strengthPos.x, h * strengthPos.y);
      ctx.rotate(45 * Math.PI / 180);
      ctx.font = `bold ${Math.floor(w * regularStatFontFraction)}px Cinzel`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(strength, 0, 0);
      ctx.restore();
    }

    // White (matching Strength) rather than red — red's own black outline
    // barely showed up against the border art's own dark corner texture,
    // making Lifespan hard to read across every style; confirmed by mocking
    // up outline/shadow/alternate-color fixes side by side and preferred
    // over all of them, including keeping red at all.
    const lifespanColor = '#FFFFFF';
    const lifespanDrawPos = appliesStatSwap ? onboardStatsLifespanAnchor : lifespanPos;

    ctx.save();
    ctx.translate(w * lifespanDrawPos.x, h * lifespanDrawPos.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * (appliesStatSwap ? onboardStatsFontSizeFraction : regularStatFontFraction))}px Cinzel`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, Math.floor(w * 0.004));
    ctx.strokeStyle = '#000000';
    ctx.strokeText(lifespan, 0, 0);
    ctx.fillStyle = lifespanColor;
    ctx.fillText(lifespan, 0, 0);
    ctx.restore();
  }

  if (!appliesStatSwap && !(strength === 'XXX' && lifespan === 'XXX')) {
    // A divider between strength and lifespan, drawn perpendicular to the line
    // connecting those two fixed positions and centered on their midpoint —
    // this only depends on positions.strength/positions.lifespan, not on which
    // border art is loaded, so it stays correctly placed across all border
    // images. Its reach toward the corner (t < 0) and toward the card face
    // (t > 0) is tuned per border art so it spans that art's own curve
    // without crossing into the strength/lifespan numerals themselves.
    const dividerMidX = w * (strengthPos.x + lifespanPos.x) / 2;
    const dividerMidY = h * (strengthPos.y + lifespanPos.y) / 2;
    const DIVIDER_REACH = {
      beingProphecy: { corner: 0.075, face: 0.04 },
      relicAltar: { corner: 0.1, face: 0.016 },
      conjuring: { corner: 0.09, face: 0.016 },
      // First-pass values for the On Board set, borrowed from the default
      // border with the closest corner shape — not yet individually tuned.
      onboardBeing: { corner: 0.075, face: 0.04 },
      onboardConjuring: { corner: 0.09, face: 0.016 },
      onboardRelic: { corner: 0.1, face: 0.016 },
    };
    const reach = DIVIDER_REACH[getBorderTypeForCard(card, borderStyle)] || DIVIDER_REACH.beingProphecy;

    ctx.save();
    ctx.translate(dividerMidX, dividerMidY);
    ctx.rotate(45 * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(0, -w * reach.corner);
    ctx.lineTo(0, w * reach.face);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, Math.floor(w * 0.009));
    ctx.stroke();
    ctx.restore();
  }

  if (!isOnboard && cardTyping) {
    const displayTyping = cardTyping.replace(/,/g, ' -');
    ctx.font = `bold ${Math.floor(w * 0.035)}px Cinzel, serif`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayTyping, w * positions.cardTyping.x, h * positions.cardTyping.y);
  }

  if (!isOnboard) {
    ctx.font = `bold ${Math.floor(w * 0.032)}px Cinzel, serif`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('Artist', w * positions.rarity.x, h * positions.artist.y);
  }

  if (!isOnboard) {
    // Small watermark in the bottom black border, between the center ornament and
    // the right corner ornament (border band measured at ~0.968h-0.995h on the reference card).
    ctx.font = `bold ${Math.floor(h * 0.019)}px Cinzel, serif`;
    ctx.fillStyle = '#D9D9D9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('© Well Played', w * positions.wellPlayed.x, h * positions.wellPlayed.y);
  }

  if (rarity) {
    const displayRarity = rarity.toLowerCase().includes('sacred') ? 'SR' : rarity.toUpperCase();
    // Mirrors the Well Played watermark: same bottom black border band, same styling,
    // symmetric position on the left side (between the left corner ornament and the center ornament).
    ctx.font = `bold ${Math.floor(h * 0.019)}px Cinzel, serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayRarity, w * positions.rarityCorner.x, h * positions.rarityCorner.y);

    if (!isOnboard) {
      // Set and number, sharing the same bottom-border line as the rarity letter.
      ctx.font = `bold ${Math.floor(h * 0.019)}px Cinzel, serif`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('TST - x/x', w * positions.setNumber.x, h * positions.rarityCorner.y);
    }
  }
};

// This card's border art carries real content (rarity letter, artist name,
// corner ornaments, watermark) flush to the trim edge — there's no throwaway
// margin. So bleed can't be added by scaling the whole finished card up to
// fill the bigger canvas; that would drag that border content out into the
// strip the printer trims off. Instead: render the exact trim-accurate card
// once, fill the bleed margin with solid black (matching the card's border
// color, so the seam is invisible) rather than a scaled duplicate of the
// card — a duplicate would show doubled text/ornaments in the margin — then
// stamp the untouched trim render centered on top at native size so every
// bit of border content survives the trim intact.
export const renderCardWithBleed = (canvas, card, img, positions, trimWidth, trimHeight, bleedWidth, bleedHeight, borderStyle = 'default', artImg = null, artBoxRect = null) => {
  const trimCanvas = document.createElement('canvas');
  renderCardOnCanvas(trimCanvas, card, img, positions, trimWidth, trimHeight, borderStyle, artImg, artBoxRect);

  canvas.width = bleedWidth;
  canvas.height = bleedHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, bleedWidth, bleedHeight);

  const offsetX = (bleedWidth - trimWidth) / 2;
  const offsetY = (bleedHeight - trimHeight) / 2;
  ctx.drawImage(trimCanvas, offsetX, offsetY);
};
