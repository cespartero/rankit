// Minimal QR code generator (byte mode, error correction level M, versions 1-20), no dependencies.
// Usage: QR.svg('https://example.com', {size: 220}) -> SVG markup string.
// Follows the QR Code specification (ISO/IEC 18004): Reed-Solomon error correction,
// interleaving, function patterns, format/version bits, and the lowest-penalty mask.
window.QR = (function(){
  // Error correction codewords per block and block counts for level M, versions 1..20
  const ECC_PER_BLOCK = [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26];
  const NUM_BLOCKS    = [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16];
  const MAX_VER = 20;

  function numRawModules(ver){
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  const numDataCodewords = ver => Math.floor(numRawModules(ver) / 8) - ECC_PER_BLOCK[ver - 1] * NUM_BLOCKS[ver - 1];

  // Galois field GF(256) with the QR polynomial 0x11D
  function gfMul(x, y){ let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function rsDivisor(deg){
    const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
    for (let i = 0; i < deg; i++) {
      for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, div){
    const r = div.map(() => 0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => r[i] ^= gfMul(c, f)); }
    return r;
  }

  function encode(text){
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    for (; ver <= MAX_VER; ver++) {
      const cap = numDataCodewords(ver) * 8;
      const used = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (used <= cap) break;
    }
    if (ver > MAX_VER) throw new Error('Text too long for QR code');

    // data bits: mode (byte), length, data, terminator, padding
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const capBits = numDataCodewords(ver) * 8;
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // split into blocks, add error correction, interleave
    const nb = NUM_BLOCKS[ver - 1], ecLen = ECC_PER_BLOCK[ver - 1];
    const rawCw = Math.floor(numRawModules(ver) / 8);
    const numShort = nb - rawCw % nb, shortLen = Math.floor(rawCw / nb);
    const div = rsDivisor(ecLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - ecLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecLen || j >= numShort) all.push(b[i]); });

    return draw(ver, all);
  }

  function draw(ver, codewords){
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, v) => { mod[y][x] = v; fn[y][x] = true; };

    // timing patterns
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // finder patterns
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    } };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    // alignment patterns
    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
      align.push(6); for (let p = size - 7; align.length < n; p -= step) align.splice(1, 0, p);
    }
    align.forEach((ax, i) => align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    // reserve format areas and dark module
    drawFormat(0);
    // version info (v7+)
    if (ver >= 7) {
      let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = ver << 12 | rem;
      for (let i = 0; i < 18; i++) { const b = ((bits >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
    }

    function drawFormat(mask){
      const data = (0 << 3) | mask; // level M = 0b00
      let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const b = i => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, b(i));
      set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
      set(8, size - 8, true);
    }

    // place data in the zigzag pattern
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) { mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }

    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
    ];
    const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };

    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const s = penalty(mod, size);
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return mod;
  }

  function penalty(mod, size){
    let score = 0;
    const lines = [];
    for (let y = 0; y < size; y++) lines.push(mod[y]);
    for (let x = 0; x < size; x++) lines.push(mod.map(r => r[x]));
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      const s = line.map(v => v ? 1 : 0).join('');
      for (const pat of ['10111010000', '00001011101']) { let k = s.indexOf(pat); while (k !== -1) { score += 40; k = s.indexOf(pat, k + 1); } }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
    }
    let dark = 0; mod.forEach(r => r.forEach(v => { if (v) dark++; }));
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  function svg(text, { size = 220, margin = 4, dark = '#000', light = '#fff' } = {}){
    const m = encode(text), n = m.length, total = n + margin * 2;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + margin) + ',' + (y + margin) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" width="' + size + '" height="' + size + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="100%" height="100%" fill="' + light + '"/><path d="' + d + '" fill="' + dark + '"/></svg>';
  }

  return { encode, svg };
})();
