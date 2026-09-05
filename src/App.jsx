import React, { useState, useRef, useEffect } from 'react';
import { Upload, Download, ChevronLeft, ChevronRight, Settings2, LayoutGrid } from 'lucide-react';

const SHEET_COLS = 3;
const SHEET_ROWS = 3;
const CARDS_PER_SHEET = SHEET_COLS * SHEET_ROWS;

const getColumnData = (card, possibleNames) => {
  for (let name of possibleNames) {
    if (card[name] !== undefined && card[name] !== '') {
      return card[name];
    }
  }
  return '';
};

const wrapText = (ctx, text, x, y, maxWidth, lineHeight) => {
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
const renderCardOnCanvas = (canvas, card, img, positions) => {
  const ctx = canvas.getContext('2d');
  if (!img || !img.naturalWidth) return;

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  ctx.drawImage(img, 0, 0);

  const w = canvas.width;
  const h = canvas.height;

  const effigyCost = card['effigy costs'] || card['Effigy Costs'] || card['Effigy Cost'] || card['C'] || card['Column C'] || '';
  const cardTyping = getColumnData(card, ['Card typing', 'Card Typing', 'B', 'Column B']);
  const arrowsValue = getColumnData(card, ['Arrows (Clockwise top center = 1)', 'Arrows (Clockwise top center = 1', 'Arrows', 'I', 'Column I']);
  const cardName = getColumnData(card, ['Card Name', 'A', 'Column A']);
  const textBox = getColumnData(card, ['Text Box', 'E', 'Column E']);
  const strength = getColumnData(card, ['Strength', 'F', 'Column F']);
  const lifespan = getColumnData(card, ['Lifespan', 'G', 'Column G']);
  const timer = getColumnData(card, ['Timer', 'H', 'Column H']);
  const rarity = getColumnData(card, ['Rarity', 'rarity']);

  const parseEffigyCost = (cost) => {
    const parts = [];

    if (!cost || cost.trim() === '') {
      return parts;
    }

    const segments = cost.split(',').map(s => s.trim()).filter(s => s);

    segments.forEach(segment => {
      const match = segment.match(/^([X\d]+)\s*([A-Za-z]+)?$/i);

      if (match) {
        const number = match[1].toUpperCase();
        const type = match[2] ? match[2].toLowerCase() : '';
        parts.push({ number, type });
      }
    });

    return parts;
  };

  const costParts = parseEffigyCost(effigyCost);

  if (costParts.length > 0) {
    ctx.save();
    ctx.translate(w * positions.effigyCost.x, h * positions.effigyCost.y);
    ctx.rotate(-45 * Math.PI / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    const fontSize = Math.floor(w * 0.07);
    ctx.font = `bold ${fontSize}px 'Rye', serif`;
    const spaceWidth = ctx.measureText(' ').width;

    const typeMap = {
      'bleeding': '#dc2626',
      'living': '#15803d',
      'formless': '#6d28d9',
      'timeless': '#87CEEB',
      'shifting': '#fbbf24',
      'shifitng': '#fbbf24',
      'faithless': '#FFFFFF'
    };

    // Non-faithless numeric costs render as a compact cluster of colored pips,
    // sized/positioned to stay tight in the top-left corner.
    const pipRadius = Math.max(4, w * 0.016);
    const pipGap = pipRadius * 0.9;
    const maxPipsPerRow = 3;

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

    const usesPips = (part) => {
      const isFaithless = part.type === 'faithless' || part.type === '';
      return !isFaithless && /^\d+$/.test(part.number) && parseInt(part.number, 10) > 0;
    };

    // Measure pass: figure out each part's width so the whole cost block can be centered.
    let xOffset = 0;
    costParts.forEach((part) => {
      const partWidth = usesPips(part)
        ? getPipLayout(parseInt(part.number, 10)).maxRowWidth
        : ctx.measureText(part.number).width;
      xOffset += partWidth + spaceWidth;
    });

    xOffset = -xOffset / 2;

    // Draw pass
    costParts.forEach((part) => {
      const color = typeMap[part.type] || '#000000';
      const isFaithless = part.type === 'faithless' || part.type === '';

      if (usesPips(part)) {
        const count = parseInt(part.number, 10);
        const layout = getPipLayout(count);
        const partWidth = layout.maxRowWidth;
        const xPos = xOffset + partWidth / 2;

        const rowHeight = pipRadius * 2 + pipGap;
        const startY = -layout.totalHeight / 2 + pipRadius;

        layout.rowCounts.forEach((n, rowIndex) => {
          const rowWidth = n * pipRadius * 2 + Math.max(0, n - 1) * pipGap;
          const rowStartX = xPos - rowWidth / 2 + pipRadius;
          const y = startY + rowIndex * rowHeight;
          for (let j = 0; j < n; j++) {
            const px = rowStartX + j * (pipRadius * 2 + pipGap);
            ctx.beginPath();
            ctx.arc(px, y, pipRadius, 0, Math.PI * 2);
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

        ctx.fillStyle = color;
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
    // Bottom-center: shorter than top so it doesn't extend past the border
    const bottomTriangleHeight = triangleHeight * 0.95;

    let triangleFillColor = '#FFFFFF';
    const costLower = effigyCost.toLowerCase();
    if (costLower.includes('bleeding')) {
      triangleFillColor = '#dc2626';
    } else if (costLower.includes('timeless')) {
      triangleFillColor = '#87CEEB';
    } else if (costLower.includes('formless')) {
      triangleFillColor = '#6d28d9';
    } else if (costLower.includes('living')) {
      triangleFillColor = '#15803d';
    } else if (costLower.includes('shifting') || costLower.includes('shifitng')) {
      triangleFillColor = '#fbbf24';
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
        case 5:
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, h * 0.967, w, h - h * 0.967);
          ctx.clip();
          drawArrow(w * 0.5, h - borderOffset * 1.5, 180, triangleBaseWidth, bottomTriangleHeight, 0.1);
          ctx.restore();
          break;
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

  ctx.font = `600 ${Math.floor(w * 0.055)}px 'Rye', serif`;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxCardNameWidth = w * 0.7;
  let cardNameFontSize = Math.floor(w * 0.055);
  ctx.font = `600 ${cardNameFontSize}px 'Rye', serif`;
  let textWidth = ctx.measureText(cardName).width;

  while (textWidth > maxCardNameWidth && cardNameFontSize > Math.floor(w * 0.03)) {
    cardNameFontSize -= 2;
    ctx.font = `600 ${cardNameFontSize}px 'Rye', serif`;
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
      ctx.fillText(line1, w * positions.cardName.x, h * positions.cardName.y - lineHeight / 2);
      ctx.fillText(line2, w * positions.cardName.x, h * positions.cardName.y + lineHeight / 2);
    } else {
      ctx.fillText(cardName, w * positions.cardName.x, h * positions.cardName.y);
    }
  } else {
    ctx.fillText(cardName, w * positions.cardName.x, h * positions.cardName.y);
  }

  let textBoxFontSize = Math.floor(w * 0.046);
  ctx.font = `${textBoxFontSize}px 'Rye', serif`;
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
        ctx.font = `${textBoxFontSize}px 'Rye', serif`;

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

  if (strength === 'XXX' && lifespan === 'XXX' && timer === 'XXX') {
    // Leave blank
  } else if (strength === 'XXX' && lifespan === 'XXX') {
    ctx.save();
    ctx.translate(w * positions.strength.x, h * positions.strength.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * 0.055)}px 'Rye', serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timer, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(w * positions.lifespan.x, h * positions.lifespan.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * 0.065)}px Arial`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('T', 0, 0);
    ctx.restore();
  } else {
    ctx.save();
    ctx.translate(w * positions.strength.x, h * positions.strength.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * 0.055)}px Arial`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(strength, 0, 0);
    ctx.restore();

    const lifespanNum = parseInt(lifespan);
    const lifespanColor = (!isNaN(lifespanNum) && lifespanNum > 0) ? '#DC143C' : '#000000';

    ctx.save();
    ctx.translate(w * positions.lifespan.x, h * positions.lifespan.y);
    ctx.rotate(45 * Math.PI / 180);
    ctx.font = `bold ${Math.floor(w * 0.055)}px Arial`;
    ctx.fillStyle = lifespanColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lifespan, 0, 0);
    ctx.restore();
  }

  if (cardTyping) {
    const displayTyping = cardTyping.replace(/,/g, ' -');
    ctx.font = `bold ${Math.floor(w * 0.035)}px 'Rye', serif`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayTyping, w * positions.cardTyping.x, h * positions.cardTyping.y);
  }

  ctx.font = `bold ${Math.floor(w * 0.032)}px 'Rye', serif`;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('Artist', w * positions.rarity.x, h * positions.artist.y);

  if (rarity) {
    // Set and number, stays on the type bar
    ctx.font = `bold ${Math.floor(w * 0.032)}px 'Rye', serif`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('TST - x/x', w * positions.artist.x, h * positions.rarity.y);
  }

  // Small watermark in the bottom black border, between the center ornament and
  // the right corner ornament (border band measured at ~0.968h-0.995h on the reference card).
  ctx.font = `bold ${Math.floor(h * 0.019)}px 'Rye', serif`;
  ctx.fillStyle = '#D9D9D9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('© Well Played', w * positions.wellPlayed.x, h * positions.wellPlayed.y);

  if (rarity) {
    const displayRarity = rarity.toLowerCase().includes('sacred') ? 'SR' : rarity.toUpperCase();
    // Mirrors the Well Played watermark: same bottom black border band, same styling,
    // symmetric position on the left side (between the left corner ornament and the center ornament).
    ctx.font = `bold ${Math.floor(h * 0.019)}px 'Rye', serif`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayRarity, w * positions.rarityCorner.x, h * positions.rarityCorner.y);
  }
};

const TradingCardGenerator = () => {
  const [referenceImageStats, setReferenceImageStats] = useState(null);
  const [referenceImageNoStats, setReferenceImageNoStats] = useState(null);
  const [csvData, setCsvData] = useState([]);
  const [currentCard, setCurrentCard] = useState(0);
  const [imageStatsLoaded, setImageStatsLoaded] = useState(false);
  const [imageNoStatsLoaded, setImageNoStatsLoaded] = useState(false);
  const [showPositioning, setShowPositioning] = useState(false);
  const [fontLoaded, setFontLoaded] = useState(false);
  const canvasRef = useRef(null);
  const refImageStatsRef = useRef(null);
  const refImageNoStatsRef = useRef(null);

  // Load Rye — an antique/letterpress display serif, standing in for Caslon Antique
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Rye&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);

    document.fonts.load("400 16px 'Rye'").finally(() => setFontLoaded(true));

    return () => {
      if (link.parentNode) link.parentNode.removeChild(link);
    };
  }, []);

  const [positions, setPositions] = useState({
    effigyCost: { x: 0.14, y: 0.1 },
    cardTyping: { x: 0.5, y: 0.935 },
    cardName: { x: 0.5, y: 0.605 },
    arrowText: { x: 0.5, y: 0.095 },
    textBox: { x: 0.08, y: 0.686 },
    strength: { x: 0.83, y: 0.07 },
    lifespan: { x: 0.89, y: 0.11 },
    rarity: { x: 0.88, y: 0.935 },
    artist: { x: 0.12, y: 0.935 },
    wellPlayed: { x: 0.75, y: 0.982 },
    rarityCorner: { x: 0.164, y: 0.982 }
  });

  const handleReferenceUploadStats = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setReferenceImageStats(event.target.result);
        setImageStatsLoaded(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleReferenceUploadNoStats = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setReferenceImageNoStats(event.target.result);
        setImageNoStatsLoaded(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target.result;
        parseCSV(text);
      };
      reader.readAsText(file);
    }
  };

  const parseCSV = (text) => {
    const lines = [];
    let currentLine = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === '"') {
        inQuotes = !inQuotes;
        currentLine += char;
      } else if (char === '\n' && !inQuotes) {
        if (currentLine.trim()) {
          lines.push(currentLine);
        }
        currentLine = '';
      } else {
        currentLine += char;
      }
    }
    if (currentLine.trim()) {
      lines.push(currentLine);
    }

    const parseLine = (line) => {
      const result = [];
      let current = '';
      let inQ = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
          inQ = !inQ;
        } else if (char === ',' && !inQ) {
          let value = current.trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          result.push(value);
          current = '';
        } else {
          current += char;
        }
      }
      let value = current.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      result.push(value);
      return result;
    };

    if (lines.length === 0) {
      setCsvData([]);
      return;
    }

    const headers = parseLine(lines[0]);
    const data = [];

    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      const values = parseLine(lines[i]);
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });
      data.push(row);
    }

    setCsvData(data);
    setCurrentCard(0);
  };

  const handleImageStatsLoad = () => {
    setImageStatsLoaded(true);
  };

  const handleImageNoStatsLoad = () => {
    setImageNoStatsLoaded(true);
  };

  const pickTemplateImage = (card) => {
    const strengthEarly = getColumnData(card, ['Strength', 'F', 'Column F']);
    const lifespanEarly = getColumnData(card, ['Lifespan', 'G', 'Column G']);
    const timerEarly = getColumnData(card, ['Timer', 'H', 'Column H']);
    const hasStats = !(strengthEarly === 'XXX' && lifespanEarly === 'XXX' && timerEarly === 'XXX');

    // Pick whichever template applies; fall back to the other one if only one was uploaded
    if (hasStats && referenceImageStats) {
      return { img: refImageStatsRef.current, loaded: imageStatsLoaded };
    } else if (!hasStats && referenceImageNoStats) {
      return { img: refImageNoStatsRef.current, loaded: imageNoStatsLoaded };
    } else if (referenceImageStats) {
      return { img: refImageStatsRef.current, loaded: imageStatsLoaded };
    } else if (referenceImageNoStats) {
      return { img: refImageNoStatsRef.current, loaded: imageNoStatsLoaded };
    }
    return { img: null, loaded: false };
  };

  useEffect(() => {
    if (!fontLoaded) return;
    if (csvData.length === 0) return;

    const card = csvData[currentCard];
    if (!card) return;

    const { img, loaded } = pickTemplateImage(card);
    if (!img || !loaded) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    renderCardOnCanvas(canvas, card, img, positions);
  }, [imageStatsLoaded, imageNoStatsLoaded, csvData, currentCard, referenceImageStats, referenceImageNoStats, positions, fontLoaded]);

  const [previewUrl, setPreviewUrl] = useState(null);
  const [isExportingAll, setIsExportingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const downloadCard = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setPreviewUrl(canvas.toDataURL('image/png'));
  };

  const downloadAll = async () => {
    setIsExportingAll(true);
    setExportProgress(0);
    for (let i = 0; i < csvData.length; i++) {
      setCurrentCard(i);
      await new Promise(resolve => setTimeout(resolve, 200));
      const canvas = canvasRef.current;
      const card = csvData[i];
      const filename = card['Card Name'] || `card_${i + 1}`;
      const link = document.createElement('a');
      link.download = `${filename}.png`;
      link.href = canvas.toDataURL();
      link.click();
      setExportProgress(i + 1);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    setIsExportingAll(false);
  };

  const [isExportingSheets, setIsExportingSheets] = useState(false);
  const [sheetProgress, setSheetProgress] = useState(0);
  const totalSheets = Math.ceil(csvData.length / CARDS_PER_SHEET);

  const downloadPrintSheets = async () => {
    const primaryImg = imageStatsLoaded && refImageStatsRef.current
      ? refImageStatsRef.current
      : (imageNoStatsLoaded && refImageNoStatsRef.current ? refImageNoStatsRef.current : null);
    if (!primaryImg) return;

    const cardW = primaryImg.naturalWidth;
    const cardH = primaryImg.naturalHeight;

    setIsExportingSheets(true);
    setSheetProgress(0);

    const cardCanvas = document.createElement('canvas');

    for (let page = 0; page < totalSheets; page++) {
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = cardW * SHEET_COLS;
      pageCanvas.height = cardH * SHEET_ROWS;
      const pctx = pageCanvas.getContext('2d');
      pctx.fillStyle = '#ffffff';
      pctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

      for (let slot = 0; slot < CARDS_PER_SHEET; slot++) {
        const cardIndex = page * CARDS_PER_SHEET + slot;
        if (cardIndex >= csvData.length) break;

        const card = csvData[cardIndex];
        const { img, loaded } = pickTemplateImage(card);
        if (!img || !loaded) continue;

        renderCardOnCanvas(cardCanvas, card, img, positions);

        const col = slot % SHEET_COLS;
        const row = Math.floor(slot / SHEET_COLS);
        pctx.drawImage(cardCanvas, col * cardW, row * cardH, cardW, cardH);
      }

      const link = document.createElement('a');
      link.download = `print_sheet_${page + 1}.png`;
      link.href = pageCanvas.toDataURL('image/png');
      link.click();

      setSheetProgress(page + 1);
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    setIsExportingSheets(false);
  };

  return (
    <div className="min-h-screen bg-stone-100 p-4 md:p-8" style={{ fontFamily: "'Georgia', serif" }}>
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl md:text-4xl font-bold text-stone-800 mb-1">Trading Card Generator</h1>
        <p className="text-stone-500 mb-8 text-sm">Upload a blank card template and a CSV of card data to batch-generate finished cards.</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200">
            <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-stone-300 rounded cursor-pointer hover:border-blue-500 transition-colors">
              <Upload className="w-8 h-8 text-stone-400 mb-2" />
              <span className="text-sm text-stone-600 text-center px-2">Template — With Strength/Lifespan</span>
              <input type="file" accept="image/*" onChange={handleReferenceUploadStats} className="hidden" />
            </label>
            {referenceImageStats && <p className="text-green-600 mt-2 text-sm">✓ Image loaded</p>}
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200">
            <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-stone-300 rounded cursor-pointer hover:border-blue-500 transition-colors">
              <Upload className="w-8 h-8 text-stone-400 mb-2" />
              <span className="text-sm text-stone-600 text-center px-2">Template — No Strength/Lifespan</span>
              <input type="file" accept="image/*" onChange={handleReferenceUploadNoStats} className="hidden" />
            </label>
            {referenceImageNoStats && <p className="text-green-600 mt-2 text-sm">✓ Image loaded</p>}
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200">
            <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed border-stone-300 rounded cursor-pointer hover:border-blue-500 transition-colors">
              <Upload className="w-8 h-8 text-stone-400 mb-2" />
              <span className="text-sm text-stone-600">Upload CSV File</span>
              <input type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" />
            </label>
            {csvData.length > 0 && <p className="text-green-600 mt-2 text-sm">✓ {csvData.length} cards loaded</p>}
          </div>
        </div>

        {(referenceImageStats || referenceImageNoStats) && !(referenceImageStats && referenceImageNoStats) && (
          <p className="text-amber-600 text-sm mb-6 -mt-4">
            Only one template uploaded — it will be used for every card until you add the other one.
          </p>
        )}

        {csvData.length > 0 && (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200 mb-8">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <span className="text-lg font-semibold text-stone-800">
                Card {currentCard + 1} of {csvData.length}
                {csvData[currentCard]?.['Card Name'] ? ` — ${csvData[currentCard]['Card Name']}` : ''}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowPositioning(!showPositioning)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-sm"
                >
                  <Settings2 className="w-4 h-4" />
                  {showPositioning ? 'Hide' : 'Show'} Position Controls
                </button>
                <button
                  onClick={() => setCurrentCard(Math.max(0, currentCard - 1))}
                  disabled={currentCard === 0}
                  className="flex items-center gap-1 px-3 py-2 bg-stone-200 rounded disabled:opacity-40 hover:bg-stone-300 transition-colors text-sm"
                >
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>
                <button
                  onClick={() => setCurrentCard(Math.min(csvData.length - 1, currentCard + 1))}
                  disabled={currentCard === csvData.length - 1}
                  className="flex items-center gap-1 px-3 py-2 bg-stone-200 rounded disabled:opacity-40 hover:bg-stone-300 transition-colors text-sm"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>

            {showPositioning && (
              <div className="bg-yellow-50 p-4 rounded mb-4 border border-yellow-200">
                <h3 className="font-bold mb-3 text-stone-800">Position Controls (values 0.0 to 1.0)</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {Object.keys(positions).map(key => (
                    <div key={key} className="space-y-1">
                      <label className="font-semibold text-xs text-stone-600">{key}</label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={positions[key].x}
                          onChange={(e) => setPositions({
                            ...positions,
                            [key]: { ...positions[key], x: parseFloat(e.target.value) || 0 }
                          })}
                          className="w-20 px-2 py-1 border rounded text-sm"
                          placeholder="X"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={positions[key].y}
                          onChange={(e) => setPositions({
                            ...positions,
                            [key]: { ...positions[key], y: parseFloat(e.target.value) || 0 }
                          })}
                          className="w-20 px-2 py-1 border rounded text-sm"
                          placeholder="Y"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <details className="bg-stone-50 p-4 rounded mb-4 text-sm border border-stone-200">
              <summary className="font-bold cursor-pointer text-stone-700">Current Card Data (Debug)</summary>
              <pre className="whitespace-pre-wrap mt-2 text-stone-600">{JSON.stringify(csvData[currentCard], null, 2)}</pre>
            </details>

            <div className="flex flex-wrap items-center gap-4">
              <button
                onClick={downloadCard}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                <Download className="w-4 h-4" />
                Export This Card
              </button>
              <button
                onClick={downloadAll}
                disabled={isExportingAll}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                {isExportingAll ? `Exporting ${exportProgress}/${csvData.length}…` : 'Download All'}
              </button>
              <button
                onClick={downloadPrintSheets}
                disabled={isExportingSheets}
                className="flex items-center gap-2 px-4 py-2 bg-amber-700 text-white rounded hover:bg-amber-800 transition-colors disabled:opacity-60"
              >
                <LayoutGrid className="w-4 h-4" />
                {isExportingSheets
                  ? `Building sheet ${sheetProgress}/${totalSheets}…`
                  : `Download Print Sheets (3×3, ${totalSheets} page${totalSheets === 1 ? '' : 's'})`}
              </button>
            </div>
          </div>
        )}

        <div className="bg-white p-6 rounded-lg shadow-sm border border-stone-200">
          {previewUrl && (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-300 rounded">
              <p className="text-sm font-semibold text-yellow-800 mb-2">Right-click the image below and choose "Save image as…" to save it.</p>
              <img src={previewUrl} alt="Card export" className="max-w-full border border-stone-300 mx-auto block" />
            </div>
          )}
          {(!referenceImageStats && !referenceImageNoStats) || csvData.length === 0 ? (
            <div className="text-center text-stone-400 py-16 text-sm">
              Upload at least one reference template and a CSV to see the card preview here.
            </div>
          ) : (
            <canvas ref={canvasRef} className="max-w-full max-h-[70vh] w-auto h-auto border border-stone-300 mx-auto block" />
          )}
          {referenceImageStats && (
            <img
              ref={refImageStatsRef}
              src={referenceImageStats}
              onLoad={handleImageStatsLoad}
              className="hidden"
              alt="Reference (with stats)"
            />
          )}
          {referenceImageNoStats && (
            <img
              ref={refImageNoStatsRef}
              src={referenceImageNoStats}
              onLoad={handleImageNoStatsLoad}
              className="hidden"
              alt="Reference (no stats)"
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default TradingCardGenerator;
