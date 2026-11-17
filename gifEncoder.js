// gifEncoder.js - Round 28: pure-JS GIF89a encoder for the Terrabyte share GIF.
//
// No dependencies, no bundler. Node: const G = require('./gifEncoder.js');
// Browser/webview: <script src="gifEncoder.js"></script> gives window.TerrabyteGif.
//
// The share GIF is 72 frames of a settled planet (t = 10) at 80ms per
// frame, with a baked-in caption strip at the bottom. The art is drawn
// with REAL ASCII glyphs, exactly like the share-GIF PoC: each grid
// cell is drawn with ctx.fillText in 13px monospace (8px wide,
// 14.4px tall per cell), so the letterforms are the texture. The
// caption strip is 120px tall.
//
// Palette rule: index 0 is RESERVED as the transparent index. The
// caller's palette[0] is a placeholder, never a real color; real colors
// live at indices 1..N. Frame 0 is written fully opaque. Frames 1+
// write only changed pixels: unchanged pixels are written as index 0,
// so the LZW compressor collapses the long transparent runs and the
// file stays small. The decoder composites each frame over the last
// (disposal = do not dispose), so a transparent pixel keeps the pixel
// from the frame before it.

'use strict';

// GIF pixel size of one grid cell (see header comment).
var CELL_PX_W = 8;
var CELL_PX_H = 14.4;
// Height of the baked-in caption strip, in pixels.
var CAPTION_H = 120;
// The caption canvas background, also the background behind empty cells.
var BG_RGB = [5, 5, 5];

// ---------------------------------------------------------------------------
// LZW compression (GIF variant): clear code, variable code size growth,
// dictionary reset at 4096 entries. Returns an array of bytes, the raw
// code stream before sub-block chunking.
// ---------------------------------------------------------------------------
function lzwCompress(indices, minCodeSize) {
  var clearCode = 1 << minCodeSize;
  var eoiCode = clearCode + 1;
  var out = [];
  // Bit packing uses plain arithmetic (not bitwise ops) so codes up to
  // 12 bits never overflow a signed 32-bit shift.
  var bitBuf = 0;
  var bitCnt = 0;
  var codeSize = minCodeSize + 1;
  function emit(code) {
    bitBuf += code * Math.pow(2, bitCnt);
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      out.push(bitBuf % 256);
      bitBuf = Math.floor(bitBuf / 256);
      bitCnt -= 8;
    }
  }
  var dict = new Map();
  var nextCode = eoiCode + 1;
  function resetDict() {
    dict = new Map();
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  }
  emit(clearCode);
  if (indices.length === 0) {
    emit(eoiCode);
    if (bitCnt > 0) out.push(bitBuf % 256);
    return out;
  }
  var prefix = indices[0];
  for (var i = 1; i < indices.length; i++) {
    var k = indices[i];
    var key = prefix * 256 + k;
    var found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode);
      nextCode++;
      // The decoder grows its table (and its code size) one code
      // BEHIND the encoder: it adds an entry when it READS a code,
      // while the encoder adds one when it EMITS a code. So the
      // encoder must defer the size increase by one code: bump only
      // once nextCode has PASSED 2^codeSize, not when it reaches it.
      // Bumping at equality writes the next code one bit-size too
      // wide and the decoder desyncs (verified against PIL).
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      resetDict();
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCnt > 0) out.push(bitBuf % 256);
  return out;
}

// ---------------------------------------------------------------------------
// encodeGif({ width, height, frames, palette, delayCs }) -> Uint8Array
//
// frames: array of Uint8Array, each width*height palette indices.
// palette: array of [r, g, b], max 256 entries. Index 0 is the reserved
// transparent placeholder; real colors are indices 1..N.
// delayCs: frame delay in hundredths of a second (80ms -> 8).
//
// Writes: GIF89a header, logical screen descriptor, global color table
// (padded to a power of 2), NETSCAPE2.0 extension with loop count 0
// (infinite), one Graphic Control Extension per frame (frame 0 opaque,
// frames 1+ with the transparent-color flag set and transparent index
// 0), LZW-compressed image data per frame, trailer 0x3B.
// ---------------------------------------------------------------------------
function encodeGif(opts) {
  var width = opts.width;
  var height = opts.height;
  var frames = opts.frames;
  var palette = opts.palette || [];
  var delayCs = (opts.delayCs === undefined) ? 8 : opts.delayCs;
  if (!width || !height || !frames || frames.length === 0) {
    throw new Error('encodeGif needs width, height and at least one frame');
  }
  if (palette.length > 256) {
    throw new Error('encodeGif palette holds at most 256 entries');
  }
  // Global color table size: smallest power of 2 that holds the palette.
  var gctSize = 2;
  while (gctSize < palette.length) gctSize *= 2;
  var gctBits = 0;
  var t = gctSize;
  while (t > 1) { t >>= 1; gctBits++; }
  var minCodeSize = Math.max(2, gctBits);

  var out = [];
  function pushByte(b) { out.push(b & 0xFF); }
  function pushShort(v) { pushByte(v & 0xFF); pushByte((v >> 8) & 0xFF); }
  function pushStr(s) { for (var i = 0; i < s.length; i++) pushByte(s.charCodeAt(i)); }

  // Header.
  pushStr('GIF89a');
  // Logical screen descriptor.
  pushShort(width);
  pushShort(height);
  // Packed: GCT present, 8-bit color resolution, GCT size (log2 - 1).
  pushByte(0x80 | 0x70 | (gctBits - 1));
  pushByte(0); // background color index (index 0, the transparent slot)
  pushByte(0); // pixel aspect ratio (none)
  // Global color table, padded with black to the power-of-2 size.
  for (var i = 0; i < gctSize; i++) {
    var c = palette[i] || [0, 0, 0];
    pushByte(c[0]);
    pushByte(c[1]);
    pushByte(c[2]);
  }
  // NETSCAPE2.0 application extension: loop count 0 = loop forever.
  pushByte(0x21); // extension introducer
  pushByte(0xFF); // application extension label
  pushByte(11);
  pushStr('NETSCAPE2.0');
  pushByte(3); // sub-block size
  pushByte(1); // loop sub-block id
  pushShort(0); // loop count: 0 = infinite
  pushByte(0); // block terminator

  for (var f = 0; f < frames.length; f++) {
    var transparent = f > 0;
    // Graphic Control Extension. Disposal 1 (do not dispose) for every
    // frame, so a transparent pixel keeps the pixel from the frame
    // before it. Frame 0 is opaque; frames 1+ set the transparent flag.
    pushByte(0x21);
    pushByte(0xF9);
    pushByte(4);
    pushByte(transparent ? 0x05 : 0x04);
    pushShort(delayCs);
    pushByte(0); // transparent color index
    pushByte(0); // block terminator
    // Image descriptor: full frame, no local color table.
    pushByte(0x2C);
    pushShort(0); // left
    pushShort(0); // top
    pushShort(width);
    pushShort(height);
    pushByte(0);
    // LZW image data: minimum code size byte, then <=255-byte
    // sub-blocks, then the zero-length terminator.
    var lzw = lzwCompress(frames[f], minCodeSize);
    pushByte(minCodeSize);
    for (var o = 0; o < lzw.length; o += 255) {
      var chunk = Math.min(255, lzw.length - o);
      pushByte(chunk);
      for (var j = 0; j < chunk; j++) pushByte(lzw[o + j]);
    }
    pushByte(0);
  }
  // Trailer.
  pushByte(0x3B);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// gridToIndices(grid, box, indexForAnsi, bgIndex) -> Uint8Array
//
// Maps each cropped grid cell to a palette index via indexForAnsi(ansi
// code); cells with a null color map to bgIndex. The grid is normally
// already cropped (from P.cropGrid), in which case box gives the
// dimensions; a full 136x76 grid works too, and box.x0/box.y0 then
// pick out the crop region. Length is always box.cols * box.rows.
// ---------------------------------------------------------------------------
function gridToIndices(grid, box, indexForAnsi, bgIndex) {
  var cols = box.cols;
  var rows = box.rows;
  var ox = (grid[0] && grid[0].length === cols) ? 0 : (box.x0 || 0);
  var oy = (grid.length === rows) ? 0 : (box.y0 || 0);
  var out = new Uint8Array(cols * rows);
  for (var y = 0; y < rows; y++) {
    var grow = grid[oy + y];
    for (var x = 0; x < cols; x++) {
      var cell = grow[ox + x];
      out[y * cols + x] = (!cell || cell[1] === null || cell[1] === undefined)
        ? bgIndex
        : indexForAnsi(cell[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildShareGif(P, planet, stageIdx, geometry, caption, onProgress)
//   -> Promise<Uint8Array>
//
// Browser-only: renders each frame on an offscreen canvas with REAL
// ASCII glyphs (ctx.fillText per cell, exactly like the share-GIF PoC),
// then converts canvas pixels to palette indices.
// geometry = { zoom, box, cols, rows, width, height, frameCount,
//   secStep, delayCs }. caption = { name, seedLine, stageLine }.
// onProgress(done, total) is called as frames are built, over
// 2 * frameCount steps (both passes count).
//
// Two passes, because the GIF needs ONE global palette finalized
// before any frame is mapped:
//   Pass 1: render every frame's canvas, count color frequencies
//     from getImageData (only the frequency map is kept, never the
//     pixel data). Build the palette as [[0,0,0] transparent
//     placeholder, ...the 255 most frequent colors].
//   Pass 2: re-render every frame, map its pixels to indices
//     (memoized rgb -> index lookup; colors outside the palette snap
//     to the nearest kept color by RGB distance), diff frames 1+
//     against the previous full frame (unchanged pixels become
//     transparent index 0), and collect the index arrays.
// Then one encodeGif call. Work is chunked with setTimeout(0)
// between batches of a few frames so the caller can show progress.
// ---------------------------------------------------------------------------
function buildShareGif(P, planet, stageIdx, geometry, caption, onProgress) {
  return (async function () {
    var frameCount = geometry.frameCount || 72;
    var delayCs = (geometry.delayCs === undefined) ? 8 : geometry.delayCs;
    var secStep = geometry.secStep;
    if (secStep === undefined || secStep === null) {
      secStep = (2 * Math.PI * 2 / 2.2) / frameCount;
    }
    var zoom = geometry.zoom;
    var box = geometry.box;
    var width = geometry.width;
    var height = geometry.height;
    var rows = box.rows;
    var artH = Math.round(rows * CELL_PX_H);
    var BATCH = 4;
    var totalSteps = 2 * frameCount;

    function tick() {
      return new Promise(function (res) { setTimeout(res, 0); });
    }
    function report(done) {
      if (typeof onProgress === 'function') {
        try { onProgress(done, totalSteps); } catch (e) { /* progress is best-effort */ }
      }
    }

    // Render one frame exactly like the PoC's frameHtml: fill #050505,
    // draw the cropped grid with ctx.fillText per cell (13px monospace,
    // centered in each 8 x 14.4px cell, fillStyle from
    // P.ansi256ToRgb), then the caption on the same canvas: thin gold
    // rule, name, seed line, stage line. t = 10 (settled planet),
    // stars on (no noStars arg).
    function renderFrameCanvas(sec) {
      var grid = P.cropGrid(P.render(planet, stageIdx, 10, sec, zoom), box);
      var cv = document.createElement('canvas');
      cv.width = width;
      cv.height = height;
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, width, height);
      ctx.font = '13px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var y = 0; y < grid.length; y++) {
        var grow = grid[y];
        for (var x = 0; x < grow.length; x++) {
          var cell = grow[x];
          if (!cell || cell[1] === null || cell[1] === undefined) continue;
          var rgb = P.ansi256ToRgb(cell[1]);
          ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
          ctx.fillText(cell[0], (x + 0.5) * CELL_PX_W, (y + 0.5) * CELL_PX_H);
        }
      }
      var cx = width / 2;
      ctx.strokeStyle = 'rgba(232,182,76,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 200, artH + 22);
      ctx.lineTo(cx + 200, artH + 22);
      ctx.stroke();
      ctx.fillStyle = '#e8b64c';
      ctx.font = 'bold 28px monospace';
      ctx.fillText(caption.name, cx, artH + 56);
      ctx.fillStyle = '#999999';
      ctx.font = '16px monospace';
      ctx.fillText(caption.seedLine, cx, artH + 84);
      ctx.fillStyle = '#666666';
      ctx.font = '14px monospace';
      ctx.fillText(caption.stageLine, cx, artH + 106);
      return cv;
    }

    // Pass 1: render every frame, count color frequencies from
    // getImageData. Pixels are read as a Uint32 view (one int per
    // pixel, little-endian ABGR on this platform; the canvas is
    // opaque, so alpha is always 255) and only the frequency map is
    // kept - no pixel data is held between frames.
    var counts = new Map(); // uint32 pixel value -> count
    for (var s = 0; s < frameCount; s += BATCH) {
      var end = Math.min(frameCount, s + BATCH);
      for (var i = s; i < end; i++) {
        var cv1 = renderFrameCanvas(i * secStep);
        var data1 = cv1.getContext('2d').getImageData(0, 0, width, height).data;
        var px1 = new Uint32Array(data1.buffer, data1.byteOffset, data1.length / 4);
        for (var p = 0; p < px1.length; p++) {
          var key = px1[p];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      report(end);
      await tick();
    }

    // Build the global palette: index 0 is the reserved transparent
    // placeholder, then the 255 most frequent colors.
    var ranked = Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 255);
    var palette = [[0, 0, 0]];
    var exact = new Map(); // uint32 pixel value -> palette index
    ranked.forEach(function (entry) {
      var v = entry[0];
      // Little-endian uint32 from getImageData is ABGR: low byte is red.
      palette.push([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF]);
      exact.set(v, palette.length - 1);
    });
    // Nearest kept color by RGB distance, memoized per pixel value.
    var snapMemo = new Map();
    function rgbToIndex(v) {
      var hit = exact.get(v);
      if (hit !== undefined) return hit;
      var snap = snapMemo.get(v);
      if (snap !== undefined) return snap;
      var r = v & 0xFF;
      var g = (v >> 8) & 0xFF;
      var b = (v >> 16) & 0xFF;
      var best = 1;
      var bestD = Infinity;
      for (var pi = 1; pi < palette.length; pi++) {
        var c = palette[pi];
        var d = (c[0] - r) * (c[0] - r)
          + (c[1] - g) * (c[1] - g)
          + (c[2] - b) * (c[2] - b);
        if (d < bestD) { bestD = d; best = pi; }
      }
      snapMemo.set(v, best);
      return best;
    }

    // Pass 2: re-render every frame, map pixels to indices, diff
    // frames 1+ against the previous full frame (unchanged pixels
    // become transparent index 0), collect the index arrays.
    var frames = [];
    var prev = null;
    for (var f = 0; f < frameCount; f += BATCH) {
      var fend = Math.min(frameCount, f + BATCH);
      for (var fi = f; fi < fend; fi++) {
        var cv2 = renderFrameCanvas(fi * secStep);
        var data2 = cv2.getContext('2d').getImageData(0, 0, width, height).data;
        var px2 = new Uint32Array(data2.buffer, data2.byteOffset, data2.length / 4);
        var frame = new Uint8Array(px2.length);
        for (var q = 0; q < px2.length; q++) {
          frame[q] = rgbToIndex(px2[q]);
        }
        var full = frame.slice();
        if (prev) {
          for (var d = 0; d < frame.length; d++) {
            if (frame[d] === prev[d]) frame[d] = 0;
          }
        }
        frames.push(frame);
        prev = full;
      }
      report(frameCount + fend);
      await tick();
    }

    // Encode: one synchronous call at the end.
    return encodeGif({ width: width, height: height, frames: frames, palette: palette, delayCs: delayCs });
  })();
}

var GifAPI = {
  encodeGif: encodeGif,
  gridToIndices: gridToIndices,
  buildShareGif: buildShareGif,
  CELL_PX_W: CELL_PX_W,
  CELL_PX_H: CELL_PX_H,
  CAPTION_H: CAPTION_H,
};
if (typeof module !== 'undefined' && module.exports) module.exports = GifAPI;
if (typeof window !== 'undefined') window.TerrabyteGif = GifAPI;
