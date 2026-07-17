// ThumbHash decoder (browser). Vendored from https://github.com/evanw/thumbhash
// (MIT, Evan Wallace) so the local gallery has no CDN dependency. Only the
// decode path is included; the server encodes via the npm `thumbhash` package.
// Exposes window.thumbHashToDataURL(base64) -> PNG data URL for an instant,
// recognisable placeholder decoded entirely on the client (no network request).
(function () {
  function thumbHashToApproximateAspectRatio(hash) {
    var header = hash[3];
    var hasAlpha = hash[2] & 0x80;
    var isLandscape = hash[4] & 0x80;
    var lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
    var ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
    return lx / ly;
  }

  function thumbHashToRGBA(hash) {
    var PI = Math.PI, min = Math.min, max = Math.max, cos = Math.cos, round = Math.round;
    var header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
    var header16 = hash[3] | (hash[4] << 8);
    var l_dc = (header24 & 63) / 63;
    var p_dc = ((header24 >> 6) & 63) / 31.5 - 1;
    var q_dc = ((header24 >> 12) & 63) / 31.5 - 1;
    var l_scale = ((header24 >> 18) & 31) / 31;
    var hasAlpha = header24 >> 23;
    var p_scale = ((header16 >> 3) & 63) / 63;
    var q_scale = ((header16 >> 9) & 63) / 63;
    var isLandscape = header16 >> 15;
    var lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
    var ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
    var a_dc = hasAlpha ? (hash[5] & 15) / 15 : 1;
    var a_scale = (hash[5] >> 4) / 15;

    var ac_start = hasAlpha ? 6 : 5;
    var ac_index = 0;
    var decodeChannel = function (nx, ny, scale) {
      var ac = [];
      for (var cy = 0; cy < ny; cy++)
        for (var cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++)
          ac.push((((hash[ac_start + (ac_index >> 1)] >> ((ac_index++ & 1) << 2)) & 15) / 7.5 - 1) * scale);
      return ac;
    };
    var l_ac = decodeChannel(lx, ly, l_scale);
    var p_ac = decodeChannel(3, 3, p_scale * 1.25);
    var q_ac = decodeChannel(3, 3, q_scale * 1.25);
    var a_ac = hasAlpha && decodeChannel(5, 5, a_scale);

    var ratio = thumbHashToApproximateAspectRatio(hash);
    var w = round(ratio > 1 ? 32 : 32 * ratio);
    var h = round(ratio > 1 ? 32 / ratio : 32);
    var rgba = new Uint8Array(w * h * 4), fx = [], fy = [];
    for (var y = 0, i = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i += 4) {
        var l = l_dc, p = p_dc, q = q_dc, a = a_dc;
        for (var cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++)
          fx[cx] = cos((PI / w) * (x + 0.5) * cx);
        for (var cy = 0, n2 = max(ly, hasAlpha ? 5 : 3); cy < n2; cy++)
          fy[cy] = cos((PI / h) * (y + 0.5) * cy);
        for (var cy2 = 0, j = 0; cy2 < ly; cy2++)
          for (var cx2 = cy2 ? 0 : 1, fy2 = fy[cy2] * 2; cx2 * ly < lx * (ly - cy2); cx2++, j++)
            l += l_ac[j] * fx[cx2] * fy2;
        for (var cy3 = 0, j2 = 0; cy3 < 3; cy3++) {
          for (var cx3 = cy3 ? 0 : 1, fy3 = fy[cy3] * 2; cx3 < 3 - cy3; cx3++, j2++) {
            var f = fx[cx3] * fy3;
            p += p_ac[j2] * f;
            q += q_ac[j2] * f;
          }
        }
        if (hasAlpha)
          for (var cy4 = 0, j3 = 0; cy4 < 5; cy4++)
            for (var cx4 = cy4 ? 0 : 1, fy4 = fy[cy4] * 2; cx4 < 5 - cy4; cx4++, j3++)
              a += a_ac[j3] * fx[cx4] * fy4;
        var b = l - (2 / 3) * p;
        var r = (3 * l - b + q) / 2;
        var g = r - q;
        rgba[i] = max(0, 255 * min(1, r));
        rgba[i + 1] = max(0, 255 * min(1, g));
        rgba[i + 2] = max(0, 255 * min(1, b));
        rgba[i + 3] = max(0, 255 * min(1, a));
      }
    }
    return { w: w, h: h, rgba: rgba };
  }

  function rgbaToDataURL(w, h, rgba) {
    var row = w * 4 + 1;
    var idat = 6 + h * (5 + row);
    var bytes = [
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
      w >> 8, w & 255, 0, 0, h >> 8, h & 255, 8, 6, 0, 0, 0, 0, 0, 0, 0,
      idat >>> 24, (idat >> 16) & 255, (idat >> 8) & 255, idat & 255,
      73, 68, 65, 84, 120, 1
    ];
    var table = [
      0, 498536548, 997073096, 651767980, 1994146192, 1802195444, 1303535960,
      1342533948, -306674912, -267414716, -690576408, -882789492, -1687895376,
      -2032938284, -1609899400, -1111625188
    ];
    var a = 1, b = 0;
    for (var y = 0, i = 0, end = row - 1; y < h; y++, end += row - 1) {
      bytes.push(y + 1 < h ? 0 : 1, row & 255, row >> 8, ~row & 255, (row >> 8) ^ 255, 0);
      for (b = (b + a) % 65521; i < end; i++) {
        var u = rgba[i] & 255;
        bytes.push(u);
        a = (a + u) % 65521;
        b = (b + a) % 65521;
      }
    }
    bytes.push(
      b >> 8, b & 255, a >> 8, a & 255, 0, 0, 0, 0,
      0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
    );
    for (var k = 0, ranges = [[12, 29], [37, 41 + idat]]; k < ranges.length; k++) {
      var start = ranges[k][0], e = ranges[k][1];
      var c = ~0;
      for (var m = start; m < e; m++) {
        c ^= bytes[m];
        c = (c >>> 4) ^ table[c & 15];
        c = (c >>> 4) ^ table[c & 15];
      }
      c = ~c;
      bytes[e++] = c >>> 24;
      bytes[e++] = (c >> 16) & 255;
      bytes[e++] = (c >> 8) & 255;
      bytes[e++] = c & 255;
    }
    var str = '';
    for (var q = 0; q < bytes.length; q++) str += String.fromCharCode(bytes[q] & 255);
    return 'data:image/png;base64,' + btoa(str);
  }

  window.thumbHashToDataURL = function (base64) {
    try {
      var bin = atob(base64);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var img = thumbHashToRGBA(arr);
      return rgbaToDataURL(img.w, img.h, img.rgba);
    } catch (e) {
      return null;
    }
  };
})();
