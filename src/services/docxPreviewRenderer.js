// ── ZIP extraction ────────────────────────────────────────────────────────

const readUint16 = (view, offset) => view.getUint16(offset, true);
const readUint32 = (view, offset) => view.getUint32(offset, true);

const inflateRaw = async (data) => {
  if (typeof DecompressionStream === 'undefined') return null;
  for (const format of ['deflate-raw', 'deflate']) {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
      return await new Response(stream).arrayBuffer();
    } catch {
      // browser support differs between deflate and deflate-raw
    }
  }
  return null;
};

const fileDataFromZip = async (arrayBuffer, fileName) => {
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder();
  const minEocd = 22;
  const maxComment = 65535;
  const start = Math.max(0, view.byteLength - minEocd - maxComment);
  let eocdOffset = -1;

  for (let offset = view.byteLength - minEocd; offset >= start; offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) { eocdOffset = offset; break; }
  }
  if (eocdOffset === -1) return '';

  const totalEntries = readUint16(view, eocdOffset + 10);
  let cursor = readUint32(view, eocdOffset + 16);

  for (let i = 0; i < totalEntries; i += 1) {
    if (readUint32(view, cursor) !== 0x02014b50) break;
    const compression      = readUint16(view, cursor + 10);
    const compressedSize   = readUint32(view, cursor + 20);
    const fileNameLength   = readUint16(view, cursor + 28);
    const extraLength      = readUint16(view, cursor + 30);
    const commentLength    = readUint16(view, cursor + 32);
    const localHeaderOffset = readUint32(view, cursor + 42);
    const nameBytes = new Uint8Array(arrayBuffer, cursor + 46, fileNameLength);
    const name = decoder.decode(nameBytes);

    if (name === fileName && readUint32(view, localHeaderOffset) === 0x04034b50) {
      const localNameLength  = readUint16(view, localHeaderOffset + 26);
      const localExtraLength = readUint16(view, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = arrayBuffer.slice(dataStart, dataStart + compressedSize);
      const content = compression === 0 ? compressed : await inflateRaw(compressed);
      return content || null;
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return null;
};

const fileFromZip = async (arrayBuffer, fileName) => {
  const content = await fileDataFromZip(arrayBuffer, fileName);
  if (!content) return '';
  return new TextDecoder().decode(content);
};

const bytesToBase64 = (arrayBuffer) => {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const imageMimeType = (path) => {
  const ext = String(path || '').split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
};

const targetToWordPath = (target) => {
  const value = String(target || '').replace(/\\/g, '/');
  if (!value || /^[a-z]+:/i.test(value)) return '';
  const parts = value.startsWith('/') ? value.slice(1).split('/') : `word/${value}`.split('/');
  const resolved = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
};

const parseRelationships = (xml) => {
  if (!xml) return {};
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const map = {};

  for (const rel of Array.from(doc.getElementsByTagName('*') || [])) {
    if (local(rel) !== 'Relationship') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map[id] = target;
  }

  return map;
};

const buildImageMap = async (arrayBuffer, relsXml) => {
  const rels = parseRelationships(relsXml);
  const entries = await Promise.all(Object.entries(rels).map(async ([id, target]) => {
    const path = targetToWordPath(target);
    if (!path || !/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(path)) return null;
    const data = await fileDataFromZip(arrayBuffer, path);
    if (!data) return null;
    return [id, `data:${imageMimeType(path)};base64,${bytesToBase64(data)}`];
  }));

  return Object.fromEntries(entries.filter(Boolean));
};

const numeric = (v) => {
  if (v === null || v === undefined || v === '') return Number.NaN;
  return Number(v);
};

const emuToPx = (v, fallback = null) => {
  const n = numeric(v);
  return Number.isFinite(n) && n > 0 ? Number(((n / 914400) * 96).toFixed(2)) : fallback;
};

const cssSize = (value, property) =>
  Number.isFinite(value) && value > 0 ? `${property}:${value}px` : '';

const imageStyleFromNode = (node) => {
  const extent = desc(node, 'extent')[0] || desc(node, 'ext')[0];
  const width = emuToPx(attr(extent, 'cx'));
  const height = emuToPx(attr(extent, 'cy'));
  return [cssSize(width, 'width'), cssSize(height, 'height')].filter(Boolean).join(';');
};

const renderEmbeddedImage = (node, imageMap) => {
  const blip = desc(node, 'blip')[0];
  const imagedata = desc(node, 'imagedata')[0];
  const relId = attr(blip, 'embed') || attr(blip, 'link') || attr(imagedata, 'id');
  const src = imageMap?.[relId];
  if (!src) return '';
  const inlineStyle = imageStyleFromNode(node);
  const docPr = desc(node, 'docPr')[0];
  const alt = escapeHtml(attr(docPr, 'descr') || attr(docPr, 'title'));
  return `<img class="docx-image" src="${src}" alt="${alt}"${inlineStyle ? ` style="${inlineStyle}"` : ''} />`;
};

// ── XML traversal helpers ─────────────────────────────────────────────────

const escapeHtml = (v) =>
  String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const local = (n) => n?.localName || n?.nodeName?.split(':').pop();
const children  = (n, tag) => Array.from(n?.childNodes || []).filter(c => local(c) === tag);
const first     = (n, tag) => children(n, tag)[0] ?? null;
const desc      = (n, tag) => Array.from(n?.getElementsByTagName('*') || []).filter(c => local(c) === tag);
const attr      = (n, name) => {
  if (!n) return '';
  const direct = n.getAttribute?.(`w:${name}`)
    ?? n.getAttribute?.(`a:${name}`)
    ?? n.getAttribute?.(`r:${name}`)
    ?? n.getAttribute?.(name);
  if (direct != null && direct !== '') return direct;
  for (const item of Array.from(n.attributes || [])) {
    if (local(item) === name) return item.value || '';
  }
  return '';
};

const twipsToPx = (v, fallback) => {
  const n = numeric(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n / 15) : fallback;
};

const twipsToCssPx = (v, fallback = null) => {
  const n = numeric(v);
  return Number.isFinite(n) ? Number((n / 15).toFixed(2)) : fallback;
};

const halfPointsToPt = (v, fallback = null) => {
  const n = numeric(v);
  return Number.isFinite(n) && n > 0 ? Number((n / 2).toFixed(1)) : fallback;
};

const cssEscapeString = (value) => String(value || '').replace(/["\\\n\r]/g, ' ').trim();

const fontStack = (font) => {
  const name = cssEscapeString(font);
  if (!name) return '';
  const generic = /(cambria|times|georgia|garamond|serif)/i.test(name) ? 'serif' : 'sans-serif';
  const fallbacks = generic === 'serif'
    ? '"Times New Roman", serif'
    : '"Aptos", "Calibri", "Carlito", "Candara", Arial, sans-serif';
  return `"${name}", ${fallbacks}`;
};

const hexColor = (value) =>
  value && value !== 'auto' && /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : '';

const isOff = (value) => ['0', 'false', 'off'].includes(String(value || '').toLowerCase());

const toggleValue = (node) => {
  if (!node) return null;
  return !isOff(attr(node, 'val'));
};

// ── Roman numerals & counter formatting ──────────────────────────────────

const toRoman = (n) => {
  const V = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const S = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let r = '';
  V.forEach((v, i) => { while (n >= v) { r += S[i]; n -= v; } });
  return r;
};

const fmtCount = (n, fmt) => {
  if (fmt === 'decimal')     return String(n);
  if (fmt === 'lowerLetter') return String.fromCharCode(96 + ((n - 1) % 26 + 1));
  if (fmt === 'upperLetter') return String.fromCharCode(64 + ((n - 1) % 26 + 1));
  if (fmt === 'lowerRoman')  return toRoman(n).toLowerCase();
  if (fmt === 'upperRoman')  return toRoman(n);
  return String(n);
};

// ── Numbering parser (word/numbering.xml) ─────────────────────────────────

const parseNumbering = (xml) => {
  if (!xml) return { abs: {}, nums: {} };
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const abs = {};
  const nums = {};

  for (const an of desc(doc, 'abstractNum')) {
    const id = attr(an, 'abstractNumId');
    const levels = {};
    for (const lvl of children(an, 'lvl')) {
      const li   = Number(attr(lvl, 'ilvl'));
      const pPr  = first(lvl, 'pPr');
      const ind  = first(pPr, 'ind');
      levels[li] = {
        numFmt:  attr(first(lvl, 'numFmt'),  'val') || 'bullet',
        lvlText: attr(first(lvl, 'lvlText'), 'val'),
        start:   Number(attr(first(lvl, 'start'), 'val') || '1'),
        indLeft:    twipsToPx(attr(ind, 'left'),    null),
        indHanging: twipsToPx(attr(ind, 'hanging'), null),
      };
    }
    abs[id] = levels;
  }

  for (const num of desc(doc, 'num')) {
    nums[attr(num, 'numId')] = attr(first(num, 'abstractNumId'), 'val');
  }

  return { abs, nums };
};

// ── Theme/settings/styles parsers ────────────────────────────────────────

const parseTheme = (xml) => {
  const theme = {
    majorLatin: 'Cambria',
    minorLatin: 'Calibri',
    majorEastAsia: '',
    minorEastAsia: '',
    majorBidi: '',
    minorBidi: '',
  };

  if (!xml) return theme;

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const fontScheme = desc(doc, 'fontScheme')[0];
  const major = first(fontScheme, 'majorFont');
  const minor = first(fontScheme, 'minorFont');

  const readFont = (node, tag) => attr(first(node, tag), 'typeface');

  return {
    ...theme,
    majorLatin: readFont(major, 'latin') || theme.majorLatin,
    minorLatin: readFont(minor, 'latin') || theme.minorLatin,
    majorEastAsia: readFont(major, 'ea') || '',
    minorEastAsia: readFont(minor, 'ea') || '',
    majorBidi: readFont(major, 'cs') || '',
    minorBidi: readFont(minor, 'cs') || '',
  };
};

const themedFont = (value, theme) => {
  if (!value) return '';
  if (/^major/i.test(value)) {
    if (/eastAsia/i.test(value)) return theme.majorEastAsia || theme.majorLatin;
    if (/bidi|cs/i.test(value)) return theme.majorBidi || theme.majorLatin;
    return theme.majorLatin;
  }
  if (/^minor/i.test(value)) {
    if (/eastAsia/i.test(value)) return theme.minorEastAsia || theme.minorLatin;
    if (/bidi|cs/i.test(value)) return theme.minorBidi || theme.minorLatin;
    return theme.minorLatin;
  }
  return '';
};

const parseSettings = (xml) => {
  if (!xml) return { defaultTabPx: 48 };
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return {
    defaultTabPx: twipsToCssPx(attr(desc(doc, 'defaultTabStop')[0], 'val'), 48),
  };
};

const parseStyles = (xml) => {
  const empty = {
    defaults: { pPr: null, rPr: null },
    styles: {},
    defaultParagraphStyleId: '',
    defaultCharacterStyleId: '',
  };
  if (!xml) return empty;

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const docDefaults = desc(doc, 'docDefaults')[0];
  const pPrDefault = first(docDefaults, 'pPrDefault');
  const rPrDefault = first(docDefaults, 'rPrDefault');
  const styles = {};
  let defaultParagraphStyleId = '';
  let defaultCharacterStyleId = '';

  for (const s of desc(doc, 'style')) {
    const id = attr(s, 'styleId');
    if (!id) continue;

    const type = attr(s, 'type') || 'paragraph';
    const style = {
      id,
      type,
      name: attr(first(s, 'name'), 'val'),
      basedOn: attr(first(s, 'basedOn'), 'val'),
      isDefault: attr(s, 'default') === '1' || attr(s, 'default') === 'true',
      pPr: first(s, 'pPr'),
      rPr: first(s, 'rPr'),
      tblPr: first(s, 'tblPr'),
      tcPr: first(s, 'tcPr'),
      tblStylePr: children(s, 'tblStylePr').map((stylePr) => ({
        type: attr(stylePr, 'type'),
        tblPr: first(stylePr, 'tblPr'),
        tcPr: first(stylePr, 'tcPr'),
      })),
    };

    styles[id] = style;
    if (style.isDefault && type === 'paragraph') defaultParagraphStyleId = id;
    if (style.isDefault && type === 'character') defaultCharacterStyleId = id;
  }

  return {
    defaults: {
      pPr: first(pPrDefault, 'pPr'),
      rPr: first(rPrDefault, 'rPr'),
    },
    styles,
    defaultParagraphStyleId,
    defaultCharacterStyleId,
  };
};

const styleChain = (styles, styleId, type) => {
  const chain = [];
  const seen = new Set();
  let id = styleId;

  while (id && styles[id] && !seen.has(id)) {
    const style = styles[id];
    if (!type || style.type === type) chain.unshift(style);
    seen.add(id);
    id = style.basedOn;
  }

  return chain;
};

const prAttr = (sources, tag, attrName) => {
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const node = first(sources[i], tag);
    const value = attr(node, attrName);
    if (value !== '') return value;
  }
  return '';
};

const prNode = (sources, tag) => {
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const node = first(sources[i], tag);
    if (node) return node;
  }
  return null;
};

// ── Counter state ─────────────────────────────────────────────────────────

const makeCounters = () => {
  const m = {};
  return {
    next(numId, ilvl, start) {
      const k = `${numId}-${ilvl}`;
      if (!(k in m)) m[k] = (start ?? 1) - 1;
      for (let i = ilvl + 1; i < 9; i++) delete m[`${numId}-${i}`];
      return ++m[k];
    },
    peek: (numId, ilvl) => m[`${numId}-${ilvl}`] ?? 0,
  };
};

const buildLabel = (lvlText, numId, ilvl, counters, nb) => {
  if (!lvlText) return '•';
  const levels = nb.abs[nb.nums[numId]] || {};
  return lvlText.replace(/%(\d+)/g, (_, n) => {
    const li  = Number(n) - 1;
    const def = levels[li];
    if (!def || def.numFmt === 'bullet') return def?.lvlText || '•';
    return fmtCount(counters.peek(numId, li), def.numFmt);
  });
};

// Normalize common Word private-use bullet characters
const normBullet = (ch) => {
  if (!ch) return '•';
  const code = ch.codePointAt(0);
  if (code === 0xF0B7 || code === 0x00B7 || code === 0x2022) return '•';
  if (code === 0xF0A7 || code === 0x25AA) return '▪';
  if (code === 0x2013 || ch === '-') return '–';
  return ch;
};

// ── Run rendering ─────────────────────────────────────────────────────────

const fontFromRPr = (rPr, theme) => {
  const rFonts = first(rPr, 'rFonts');
  if (!rFonts) return '';

  return attr(rFonts, 'ascii')
    || attr(rFonts, 'hAnsi')
    || attr(rFonts, 'eastAsia')
    || attr(rFonts, 'cs')
    || themedFont(attr(rFonts, 'asciiTheme') || attr(rFonts, 'hAnsiTheme'), theme)
    || themedFont(attr(rFonts, 'eastAsiaTheme'), theme)
    || themedFont(attr(rFonts, 'cstheme'), theme);
};

const rPrToStyle = (rPr, theme) => {
  if (!rPr) return {};
  const style = {};

  const bold = toggleValue(first(rPr, 'b'));
  if (bold !== null) style.bold = bold;

  const italic = toggleValue(first(rPr, 'i'));
  if (italic !== null) style.italic = italic;

  const uNode = first(rPr, 'u');
  if (uNode) {
    const uVal = attr(uNode, 'val');
    style.underline = uVal !== 'none' && uVal !== '' && !isOff(uVal);
  }

  const strike = toggleValue(first(rPr, 'strike') || first(rPr, 'dstrike'));
  if (strike !== null) style.strike = strike;

  const color = hexColor(attr(first(rPr, 'color'), 'val'));
  if (color) style.color = color;

  const size = halfPointsToPt(attr(first(rPr, 'sz'), 'val') || attr(first(rPr, 'szCs'), 'val'));
  if (size) style.fontSizePt = size;

  const font = fontFromRPr(rPr, theme);
  if (font) style.fontFamily = fontStack(font);

  const highlight = attr(first(rPr, 'highlight'), 'val');
  if (highlight && highlight !== 'none') style.background = '#fff3bf';

  const shadeFill = hexColor(attr(first(rPr, 'shd'), 'fill'));
  if (shadeFill) style.background = shadeFill;

  const va = attr(first(rPr, 'vertAlign'), 'val');
  if (va === 'superscript' || va === 'subscript') style.verticalAlign = va;

  const caps = toggleValue(first(rPr, 'caps'));
  if (caps) style.textTransform = 'uppercase';

  const smallCaps = toggleValue(first(rPr, 'smallCaps'));
  if (smallCaps) style.fontVariant = 'small-caps';

  return style;
};

const mergeRPr = (sources, theme) =>
  sources.reduce((merged, source) => ({ ...merged, ...rPrToStyle(source, theme) }), {});

const rStyleToCss = (style, { includeVertical = true } = {}) => {
  const css = [];
  if (style.bold === true) css.push('font-weight:700');
  if (style.bold === false) css.push('font-weight:400');
  if (style.italic === true) css.push('font-style:italic');
  if (style.italic === false) css.push('font-style:normal');
  if (style.color) css.push(`color:${style.color}`);
  if (style.fontSizePt) css.push(`font-size:${style.fontSizePt}pt`);
  if (style.fontFamily) css.push(`font-family:${style.fontFamily}`);
  if (style.background) css.push(`background:${style.background}`);
  if (style.textTransform) css.push(`text-transform:${style.textTransform}`);
  if (style.fontVariant) css.push(`font-variant:${style.fontVariant}`);

  const decorations = [];
  if (style.underline) decorations.push('underline');
  if (style.strike) decorations.push('line-through');
  if (decorations.length) css.push(`text-decoration:${decorations.join(' ')}`);
  if (style.underline === false && style.strike === false) css.push('text-decoration:none');

  if (includeVertical && style.verticalAlign === 'superscript') css.push('vertical-align:super;font-size:0.75em');
  if (includeVertical && style.verticalAlign === 'subscript') css.push('vertical-align:sub;font-size:0.75em');

  return css;
};

const styleAttr = (css) => css.length ? ` style="${css.join(';')}"` : '';

const preservedText = (value) =>
  escapeHtml(value).replace(/ {2,}/g, (spaces) => '&nbsp;'.repeat(spaces.length));

const textWidthEstimate = (text) =>
  String(text || '').replace(/\s+/g, ' ').length * 6.2;

const nextDefaultTabStop = (position, defaultTabPx) => {
  const interval = Number(defaultTabPx) > 0 ? Number(defaultTabPx) : 48;
  return (Math.floor(Math.max(0, position) / interval) + 1) * interval;
};

const paragraphTabStops = (pPrSources) => {
  const tabs = prNode(pPrSources, 'tabs');
  return children(tabs, 'tab')
    .map((tab) => ({
      pos: twipsToCssPx(attr(tab, 'pos'), null),
      align: attr(tab, 'val') || 'left',
      leader: attr(tab, 'leader') || '',
    }))
    .filter((tab) => tab.pos !== null && tab.align !== 'clear')
    .sort((a, b) => a.pos - b.pos);
};

const tokensHtml = (tokens) => tokens.map((token) => token.html || '').join('');
const tokensText = (tokens) => tokens.map((token) => token.text || '').join('');

const tokenLines = (tokens) => {
  const lines = [[]];
  tokens.forEach((token) => {
    if (token.type === 'lineBreak') lines.push([]);
    else lines[lines.length - 1].push(token);
  });
  return lines;
};

const tabCells = (line) => {
  const cells = [[]];
  line.forEach((token) => {
    if (token.type === 'tab') cells.push([]);
    else cells[cells.length - 1].push(token);
  });
  return cells;
};

const tabbedContent = (tokens, pPrSources, defaultTabPx) => {
  if (!tokens.some((token) => token.type === 'tab')) {
    return { html: tokensHtml(tokens), isTabbed: false };
  }

  const cellsByLine = tokenLines(tokens).map(tabCells);
  const tabCount = Math.max(...cellsByLine.map((cells) => cells.length - 1));
  const explicitStops = paragraphTabStops(pPrSources);
  const stops = [];

  for (let index = 0; index < tabCount; index += 1) {
    const explicitStop = explicitStops[index]?.pos;
    if (Number.isFinite(explicitStop)) {
      stops[index] = Math.max(explicitStop, (stops[index - 1] || 0) + 12);
      continue;
    }

    let widestStop = (stops[index - 1] || 0) + defaultTabPx;
    cellsByLine.forEach((cells) => {
      if (cells.length <= index + 1) return;
      let cursor = 0;
      for (let cellIndex = 0; cellIndex <= index; cellIndex += 1) {
        if (cellIndex > 0) cursor = stops[cellIndex - 1] || nextDefaultTabStop(cursor, defaultTabPx);
        cursor += textWidthEstimate(tokensText(cells[cellIndex]));
      }
      widestStop = Math.max(widestStop, nextDefaultTabStop(cursor, defaultTabPx));
    });
    stops[index] = Math.max(widestStop, (stops[index - 1] || 0) + 12);
  }

  const columns = [];
  let previous = 0;
  stops.forEach((stop) => {
    columns.push(`${Number(Math.max(12, stop - previous).toFixed(2))}px`);
    previous = stop;
  });
  columns.push('minmax(0, 1fr)');
  const template = columns.join(' ');

  const rows = cellsByLine.map((cells) => {
    const renderedCells = cells.map((cell, index) => {
      const body = tokensHtml(cell) || '&nbsp;';
      const leader = index < cells.length - 1 ? explicitStops[index]?.leader : '';
      const leaderClass = leader && leader !== 'none'
        ? ` docx-tab-cell--leader docx-tab-cell--leader-${String(leader).replace(/[^a-z0-9-]/gi, '').toLowerCase()}`
        : '';
      const bodyHtml = leaderClass
        ? `<span class="docx-tab-cell-content">${body}</span><span class="docx-tab-leader" aria-hidden="true"></span>`
        : body;
      const spanCss = cells.length === 1 && index === 0 ? ['grid-column:1 / -1'] : [];
      return `<span class="docx-tab-cell${leaderClass}"${styleAttr(spanCss)}>${bodyHtml}</span>`;
    }).join('');
    return `<span class="docx-tab-row" style="grid-template-columns:${template}">${renderedCells}</span>`;
  }).join('');

  return {
    html: `<span class="docx-tabbed">${rows}</span>`,
    isTabbed: true,
  };
};

const paragraphRuns = (para) =>
  Array.from(para?.childNodes || []).flatMap(function collect(node) {
    const tag = local(node);
    if (tag === 'pPr') return [];
    if (tag === 'r') return [node];
    if (['hyperlink', 'ins', 'sdt', 'smartTag'].includes(tag)) {
      return Array.from(node.childNodes || []).flatMap(collect);
    }
    return [];
  });

const renderRun = (run, context) => {
  const parts = [];
  let hasPageBreak = false;
  for (const c of Array.from(run.childNodes || [])) {
    const tag = local(c);
    if (tag === 't')   parts.push({ type: 'html', html: preservedText(c.textContent), text: c.textContent });
    if (tag === 'tab') parts.push({
      type: 'tab',
      html: `<span class="docx-tab" style="width:${context.defaultTabPx}px"></span>`,
    });
    if (tag === 'br') {
      if (attr(c, 'type') === 'page') hasPageBreak = true;
      else parts.push({ type: 'lineBreak', html: '<br />' });
    }
    if (tag === 'cr') parts.push({ type: 'lineBreak', html: '<br />' });
    if (tag === 'noBreakHyphen') parts.push({ type: 'html', html: '&#8209;', text: '-' });
    if (tag === 'softHyphen') parts.push({ type: 'html', html: '&shy;', text: '' });
    if (tag === 'drawing' || tag === 'pict') {
      parts.push({ type: 'html', html: renderEmbeddedImage(c, context.imageMap), text: '' });
    }
  }
  if (!parts.length) return { html: '', tokens: [], hasPageBreak };

  const rPr = first(run, 'rPr');
  const runStyleId = attr(first(rPr, 'rStyle'), 'val');
  const charChain = styleChain(context.styles.styles, runStyleId || context.styles.defaultCharacterStyleId, 'character');
  const css = rStyleToCss(mergeRPr([
    ...context.baseRunSources,
    ...charChain.map((style) => style.rPr),
    rPr,
  ], context.theme));

  const tokens = parts.map((part) => {
    if (part.type !== 'html') return part;
    return {
      ...part,
      html: part.html ? `<span${styleAttr(css)}>${part.html}</span>` : '',
    };
  });

  return { html: tokensHtml(tokens), tokens, hasPageBreak };
};

// ── Paragraph rendering ───────────────────────────────────────────────────

const HEADING_RE = /^heading\s*(\d+)$/i;
const PAGE_BREAK_HTML = '<div class="docx-page-break" data-docx-page-break="true"></div>';

const widthCssFromNode = (node) => {
  const rawWidth = Number(attr(node, 'w'));
  const type = attr(node, 'type');
  if (!Number.isFinite(rawWidth) || rawWidth <= 0) return '';
  if (type === 'pct') return `${rawWidth / 50}%`;
  if (!type || type === 'dxa') return `${twipsToCssPx(rawWidth)}px`;
  return '';
};

const hasVisibleBorder = (borderNode) =>
  Array.from(borderNode?.childNodes || [])
    .some((node) => {
      const value = (attr(node, 'val') || 'single').toLowerCase();
      return value !== 'nil' && value !== 'none';
    });

const tableStylePartNodes = (chain, key) =>
  chain.flatMap((style) =>
    (style.tblStylePr || [])
      .map((stylePr) => stylePr[key])
      .filter(Boolean));

const preferredSectionReference = (sectPr, tag) => {
  const refs = children(sectPr, tag);
  return refs.find((ref) => attr(ref, 'type') === 'default')
    || refs.find((ref) => attr(ref, 'type') === 'first')
    || refs[0]
    || null;
};

const partXmlForReference = async (arrayBuffer, rels, ref) => {
  const relId = attr(ref, 'id');
  const target = rels[relId];
  const path = targetToWordPath(target);
  return path ? fileFromZip(arrayBuffer, path) : '';
};

const renderDocumentPart = (xml, renderer) => {
  if (!xml) return '';
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = desc(doc, 'hdr')[0] || desc(doc, 'ftr')[0] || doc.documentElement;
  return renderBlocks(root, renderer).map((block) => block.html).join('');
};

const renderBlocks = (root, renderer) =>
  Array.from(root?.childNodes || []).flatMap(function collect(child) {
    const tag = local(child);
    if (tag === 'p') return [renderer.renderParagraph(child)];
    if (tag === 'tbl') {
      return [{
        html: renderer.renderTable(child),
        pageBreakBefore: false,
        pageBreakAfter: false,
      }];
    }
    if (['sdt', 'customXml', 'ins', 'smartTag'].includes(tag)) {
      return Array.from(child.childNodes || []).flatMap(collect);
    }
    return [];
  });

const makeRenderer = (nb, counters, styles, theme, settings) => {
  const paragraphContext = (pPr) => {
    const styleId = attr(first(pPr, 'pStyle'), 'val') || styles.defaultParagraphStyleId;
    const chain = styleChain(styles.styles, styleId, 'paragraph');
    return {
      styleId,
      styleName: chain.at(-1)?.name || styleId,
      pPrSources: [styles.defaults.pPr, ...chain.map((style) => style.pPr), pPr],
      baseRunSources: [styles.defaults.rPr, ...chain.map((style) => style.rPr)],
    };
  };

  const renderParagraph = (para) => {
    const pPr = first(para, 'pPr');
    const context = paragraphContext(pPr);
    const { styleId, styleName, pPrSources, baseRunSources } = context;

    // ── Heading level ──
    const htMatch  = HEADING_RE.exec(styleId || '') || HEADING_RE.exec(styleName || '');
    const isTitle  = /^title$/i.test(styleId || '') || /^title$/i.test(styleName || '');
    const hLevel   = isTitle ? 1 : htMatch ? Math.min(6, Number(htMatch[1])) : 0;

    // ── Alignment ──
    const rawAlign = prAttr(pPrSources, 'jc', 'val');
    const align    = ['center', 'right', 'both', 'distribute'].includes(rawAlign)
      ? (rawAlign === 'distribute' ? 'both' : rawAlign)
      : '';

    // ── Numbering ──
    const numPr    = prNode(pPrSources, 'numPr');
    const numId    = numPr ? attr(first(numPr, 'numId'),  'val') : '';
    const ilvl     = numPr ? Number(attr(first(numPr, 'ilvl'), 'val') || '0') : 0;

    let listLabel = '';
    let levelDef  = null;

    if (numId && numId !== '0') {
      const absId  = nb.nums[numId];
      levelDef     = nb.abs[absId]?.[ilvl] ?? null;

      if (levelDef) {
        if (levelDef.numFmt === 'bullet') {
          listLabel = normBullet(levelDef.lvlText);
        } else {
          counters.next(numId, ilvl, levelDef.start);
          listLabel = buildLabel(levelDef.lvlText || '%1.', numId, ilvl, counters, nb);
        }
      } else {
        listLabel = '•';
      }
    }

    // ── Indentation ──
    let indLeft    = twipsToCssPx(prAttr(pPrSources, 'ind', 'left'), null);
    let indHanging = twipsToCssPx(prAttr(pPrSources, 'ind', 'hanging'), null);
    let indFirst   = twipsToCssPx(prAttr(pPrSources, 'ind', 'firstLine'), null);
    const indRight = twipsToCssPx(prAttr(pPrSources, 'ind', 'right'), null);

    // Fall back to level-definition indent for list items
    if (listLabel && levelDef) {
      if (indLeft    === null) indLeft    = levelDef.indLeft    ?? null;
      if (indHanging === null) indHanging = levelDef.indHanging ?? null;
    }

    // ── Spacing ──
    const spaceBefore = twipsToCssPx(prAttr(pPrSources, 'spacing', 'before'), null);
    const spaceAfter  = twipsToCssPx(prAttr(pPrSources, 'spacing', 'after'), null);
    const lineVal     = Number(prAttr(pPrSources, 'spacing', 'line'));
    const lineRule    = prAttr(pPrSources, 'spacing', 'lineRule');
    let lineHeight = '';
    if (lineVal > 0) {
      lineHeight = lineRule === 'exact' || lineRule === 'atLeast'
        ? `${twipsToCssPx(lineVal)}px`
        : (lineVal / 240).toFixed(2);
    }

    const pageBreakBeforeNode = prNode(pPrSources, 'pageBreakBefore');
    const pageBreakBefore = Boolean(pageBreakBeforeNode) && !isOff(attr(pageBreakBeforeNode, 'val'));
    const sectPr = first(pPr, 'sectPr');
    const sectionType = attr(first(sectPr, 'type'), 'val') || 'nextPage';
    const sectionBreakAfter = Boolean(sectPr) && sectionType !== 'continuous';

    // ── Runs ──
    const runResults = paragraphRuns(para).map((run) => renderRun(run, {
      styles,
      theme,
      baseRunSources,
      defaultTabPx: settings.defaultTabPx,
      imageMap: settings.imageMap,
    }));
    const runTokens = runResults.flatMap(r => r.tokens || []);
    const tabbed = tabbedContent(runTokens, pPrSources, settings.defaultTabPx);
    const content    = tabbed.html || runResults.map(r => r.html).join('');
    const pageBreakAfter  = runResults.some(r => r.hasPageBreak) || sectionBreakAfter;
    const hasContent = content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

    // ── Build inline style ──
    const css = [
      ...rStyleToCss(mergeRPr(baseRunSources, theme), { includeVertical: false }),
    ];
    const paraShade = hexColor(prAttr(pPrSources, 'shd', 'fill'));
    if (paraShade) css.push(`background:${paraShade}`);
    if (spaceBefore != null) css.push(`margin-top:${spaceBefore}px`);
    if (spaceAfter  != null) css.push(`margin-bottom:${spaceAfter}px`);
    else css.push('margin-bottom:0');
    if (lineHeight)          css.push(`line-height:${lineHeight}`);
    if (indRight != null)    css.push(`padding-right:${indRight}px`);

    if (!hasContent && !pageBreakAfter && !listLabel) {
      return {
        html: `<p class="docx-p docx-p--empty"${styleAttr(css)}>&nbsp;</p>`,
        pageBreakBefore,
        pageBreakAfter: false,
      };
    }

    if (listLabel) {
      const totalLeft = indLeft    ?? (ilvl + 1) * 36;
      const hanging   = indHanging ?? 18;
      css.push(`padding-left:${totalLeft}px`, `text-indent:-${hanging}px`);
    } else {
      if (indLeft    != null) css.push(`padding-left:${indLeft}px`);
      if (indFirst   != null) css.push(`text-indent:${indFirst}px`);
      if (indHanging != null) css.push(`text-indent:-${indHanging}px`);
    }

    // ── Element & classes ──
    const tag     = hLevel ? `h${hLevel}` : 'p';
    const classes = ['docx-p'];
    if (hLevel)   classes.push(`docx-h${hLevel}`);
    if (align)    classes.push(`docx-align-${align}`);
    if (tabbed.isTabbed) classes.push('docx-p--tabbed');

    const labelHtml = listLabel
      ? `<span class="docx-list-label">${escapeHtml(listLabel)}&nbsp;</span>`
      : '';

    return {
      html: `<${tag} class="${classes.join(' ')}"${styleAttr(css)}>${labelHtml}${content || '&nbsp;'}</${tag}>`,
      pageBreakBefore,
      pageBreakAfter,
    };
  };

  const renderTable = (tbl) => {
    const tblPr = first(tbl, 'tblPr');
    const tblStyleId = attr(first(tblPr, 'tblStyle'), 'val');
    const tblChain = styleChain(styles.styles, tblStyleId, 'table');
    const tblPrSources = [
      ...tableStylePartNodes(tblChain, 'tblPr'),
      ...tblChain.map((style) => style.tblPr),
      tblPr,
    ];
    const tcPrDefaults = [
      ...tableStylePartNodes(tblChain, 'tcPr'),
      ...tblChain.map((style) => style.tcPr),
    ];
    const borders = prNode(tblPrSources, 'tblBorders');
    let hasCellBorders = tcPrDefaults.some((tcPr) => hasVisibleBorder(first(tcPr, 'tcBorders')));

    // Read column widths from tblGrid
    const tblGrid  = first(tbl, 'tblGrid');
    const gridCols = tblGrid ? children(tblGrid, 'gridCol').map(c => twipsToCssPx(attr(c, 'w'), null)) : [];

    const tableCss = [];
    const tableWidth = widthCssFromNode(prNode(tblPrSources, 'tblW'));
    const tableIndent = twipsToCssPx(prAttr(tblPrSources, 'tblInd', 'w'), null);
    if (tableWidth) tableCss.push(`width:${tableWidth}`);
    if (tableIndent != null) tableCss.push(`margin-left:${tableIndent}px`);

    const rows = children(tbl, 'tr').map((row) => {
      let colIdx = 0;
      const cells = children(row, 'tc').map((cell) => {
        const tcPr    = first(cell, 'tcPr');
        const tcPrSources = [...tcPrDefaults, tcPr];
        const cellBorders = prNode(tcPrSources, 'tcBorders');
        if (hasVisibleBorder(cellBorders)) hasCellBorders = true;
        const gridSpan = Number(attr(first(tcPr, 'gridSpan'), 'val') || '1');
        const colspanAttr = gridSpan > 1 ? ` colspan="${gridSpan}"` : '';

        // Cell width from gridCols
        let cellPx = null;
        if (gridCols.length) {
          let w = 0;
          for (let i = 0; i < gridSpan; i++) w += gridCols[colIdx + i] ?? 0;
          if (w) cellPx = w;
        }
        const css = [];
        const tcWidth = widthCssFromNode(prNode(tcPrSources, 'tcW'));
        if (cellPx) css.push(`width:${cellPx}px`);
        else if (tcWidth) css.push(`width:${tcWidth}`);

        const vAlign = prAttr(tcPrSources, 'vAlign', 'val');
        if (vAlign) css.push(`vertical-align:${vAlign === 'center' ? 'middle' : vAlign}`);

        const shade = hexColor(prAttr(tcPrSources, 'shd', 'fill'));
        if (shade) css.push(`background:${shade}`);

        colIdx += gridSpan;

        // Vertical merge
        const vMerge = first(tcPr, 'vMerge');
        if (vMerge && attr(vMerge, 'val') !== 'restart') return null; // spanned cell

        const body = Array.from(cell.childNodes || []).map(c => {
          if (local(c) === 'p')   return renderParagraph(c).html;
          if (local(c) === 'tbl') return renderTable(c);
          return '';
        }).join('');
        return `<td${colspanAttr}${styleAttr(css)}>${body || '&nbsp;'}</td>`;
      }).filter(Boolean);

      return `<tr>${cells.join('')}</tr>`;
    });
    const classes = ['docx-table'];
    const hasGrid = /tablegrid/i.test(tblStyleId || '')
      || hasVisibleBorder(borders)
      || hasCellBorders;
    if (hasGrid) classes.push('docx-table--grid');
    return `<table class="${classes.join(' ')}"${styleAttr(tableCss)}><tbody>${rows.join('')}</tbody></table>`;
  };

  return { renderParagraph, renderTable };
};

// ── Page metrics ──────────────────────────────────────────────────────────

const pageMetrics = (body, defaultFont) => {
  const sectPr = desc(body, 'sectPr').at(-1);
  const pgSz   = first(sectPr, 'pgSz');
  const pgMar  = first(sectPr, 'pgMar');
  let width = twipsToPx(attr(pgSz,  'w'), 794);
  let height = twipsToPx(attr(pgSz,  'h'), 1123);

  if (attr(pgSz, 'orient') === 'landscape' && height > width) {
    [width, height] = [height, width];
  }

  return {
    width,
    height,
    minHeight: height,
    marginTop:   twipsToPx(attr(pgMar, 'top'),    96),
    marginRight: twipsToPx(attr(pgMar, 'right'),  96),
    marginBottom:twipsToPx(attr(pgMar, 'bottom'), 96),
    marginLeft:  twipsToPx(attr(pgMar, 'left'),   96),
    fontFamily: fontStack(defaultFont || 'Calibri'),
  };
};

// ── Main export ───────────────────────────────────────────────────────────

export const renderDocxPreview = async (blob) => {
  const arrayBuffer = await blob.arrayBuffer();

  const [documentXml, numberingXml, stylesXml, themeXml, settingsXml, documentRelsXml] = await Promise.all([
    fileFromZip(arrayBuffer, 'word/document.xml'),
    fileFromZip(arrayBuffer, 'word/numbering.xml'),
    fileFromZip(arrayBuffer, 'word/styles.xml'),
    fileFromZip(arrayBuffer, 'word/theme/theme1.xml'),
    fileFromZip(arrayBuffer, 'word/settings.xml'),
    fileFromZip(arrayBuffer, 'word/_rels/document.xml.rels'),
  ]);

  if (!documentXml) throw new Error('This Word document could not be previewed.');

  const xml  = new DOMParser().parseFromString(documentXml, 'application/xml');
  const body = desc(xml, 'body')[0];
  if (!body) throw new Error('This Word document is missing document content.');

  const nb       = parseNumbering(numberingXml);
  const theme    = parseTheme(themeXml);
  const rels     = parseRelationships(documentRelsXml);
  const settings = {
    ...parseSettings(settingsXml),
    imageMap: await buildImageMap(arrayBuffer, documentRelsXml),
  };
  const styles   = parseStyles(stylesXml);
  const counters = makeCounters();
  const defaultFont = fontFromRPr(styles.defaults.rPr, theme) || theme.minorLatin;
  const { renderParagraph, renderTable } = makeRenderer(nb, counters, styles, theme, settings);
  const metrics  = pageMetrics(body, defaultFont);
  const sectPr   = desc(body, 'sectPr').at(-1);
  const chromeRenderer = makeRenderer(nb, makeCounters(), styles, theme, settings);
  const [headerXml, footerXml] = await Promise.all([
    partXmlForReference(arrayBuffer, rels, preferredSectionReference(sectPr, 'headerReference')),
    partXmlForReference(arrayBuffer, rels, preferredSectionReference(sectPr, 'footerReference')),
  ]);
  const chrome = {
    headerHtml: renderDocumentPart(headerXml, chromeRenderer),
    footerHtml: renderDocumentPart(footerXml, chromeRenderer),
  };
  const renderedBlocks = renderBlocks(body, { renderParagraph, renderTable });
  const pages    = [[]];

  for (const result of renderedBlocks) {
    if (result.pageBreakBefore && pages[pages.length - 1].length > 0) {
      pages[pages.length - 1].push(PAGE_BREAK_HTML);
      pages.push([]);
    }
    pages[pages.length - 1].push(result.html);
    if (result.pageBreakAfter) {
      pages[pages.length - 1].push(PAGE_BREAK_HTML);
      pages.push([]);
    }
  }

  const sourcePages = pages.filter((p, index) => index === 0 || p.length > 0);
  const html = sourcePages
    .map(p => `<article class="docx-page">${p.join('')}</article>`)
    .join('');
  const diagnostics = {
    documentXmlLength: documentXml.length,
    bodyChildCount: Array.from(body.childNodes || []).filter((node) => local(node) !== 'sectPr').length,
    renderedBlockCount: renderedBlocks.length,
    paragraphCount: renderedBlocks.filter((block) => /^<h\d|^<p/.test(block.html)).length,
    tableCount: renderedBlocks.filter((block) => /^<table/.test(block.html)).length,
    explicitPageBreaks: renderedBlocks.filter((block) => block.pageBreakAfter).length,
    sourcePageCount: sourcePages.length,
    htmlLength: html.length,
    hasHeader: Boolean(chrome.headerHtml),
    hasFooter: Boolean(chrome.footerHtml),
  };

  return {
    html,
    metrics,
    chrome,
    diagnostics,
  };
};
