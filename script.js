(function () {
  "use strict";

  // Start with the catppuccin mocha accents. Once every one is handed out we
  // synthesize more, so the tag list is not limited by the palette size.
  var PALETTE = [
    "#f5e0dc", "#f2cdcd", "#f5c2e7", "#cba6f7", "#f38ba8", "#eba0ac",
    "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#74c7ec",
    "#89b4fa", "#b4befe",
  ];

  var tagColors = Object.create(null);
  var tagCount = 0;

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Same tag name always maps to the same color. New tags take the next free
  // palette slot in first-seen order; past the end we hash the name to a hue.
  function tagColor(name) {
    var key = name.trim().toLowerCase();
    if (!key) return "";
    if (tagColors[key]) return tagColors[key];
    var color;
    if (tagCount < PALETTE.length) {
      color = PALETTE[tagCount];
    } else {
      color = "hsl(" + (hash(key) % 360) + ", 65%, 75%)";
    }
    tagCount++;
    tagColors[key] = color;
    return color;
  }

  function colorizeTags(root) {
    var tags = (root || document).querySelectorAll(".project-tag");
    for (var i = 0; i < tags.length; i++) {
      var color = tagColor(tags[i].textContent);
      if (color) tags[i].style.setProperty("--tag-color", color);
    }
  }

  // Colorize any tag chips on the page. Runs in DOM order, which is also how
  // the palette gets allocated.
  colorizeTags(document);

  var REDUCED_MOTION = !!(window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Counter API. Keys get a "-dev" suffix on localhost so local testing does
  // not bump the live totals.
  var COUNTER_API = "https://countapi.mileshilliard.com/api/v1/";
  var IS_LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname) ||
    /\.local$/.test(location.hostname) ||
    location.protocol === "file:";

  function counterKey(base) {
    return IS_LOCAL ? base + "-dev" : base;
  }

  // Pet the fox. Clicking it makes it turn (a different APNG), bumps a
  // per-visitor pet counter, and adds one to the global count.
  var fox = document.getElementById("fox");
  var foxArt = document.getElementById("intro-art");
  if (fox && foxArt) {
    var foxFiles = ["yaw.png", "pitch.png", "roll.png"];
    var foxBase = foxArt.dataset.base || "/";
    var foxCurrent = 0;
    if (REDUCED_MOTION) {
      foxArt.src = foxBase + "fox-static.png";
    } else {
      foxCurrent = Math.floor(Math.random() * foxFiles.length);
      foxArt.src = foxBase + foxFiles[foxCurrent];
    }

    var FOX_KEY = counterKey("jitterdev-fox-pets");

    var foxPetsEl = document.getElementById("fox-pets");
    var foxPets = 0;
    var foxTotal = null;
    try { foxPets = parseInt(localStorage.getItem("fox-pets"), 10) || 0; } catch (err) { /* private mode */ }

    var renderFoxPets = function () {
      if (!foxPetsEl) return;
      var mine = foxPets === 1 ? "1 pet" : foxPets + " pets";
      foxPetsEl.textContent = mine;
      if (foxTotal !== null) {
        var sep = document.createElement("span");
        sep.className = "sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "/";
        foxPetsEl.append(" ", sep, " " + foxTotal.toLocaleString() + " total");
      }
    };
    renderFoxPets();

    var readFoxTotal = function () {
      fetch(COUNTER_API + "get/" + encodeURIComponent(FOX_KEY))
        .then(function (response) {
          if (response.status === 404) return { value: 0 };
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          if (data && typeof data.value === "number") {
            foxTotal = data.value;
            renderFoxPets();
          }
        })
        .catch(function () { /* offline: just show the local count */ });
    };
    readFoxTotal();

    fox.addEventListener("click", function () {
      if (!REDUCED_MOTION) {
        var next = foxCurrent;
        while (foxFiles.length > 1 && next === foxCurrent) {
          next = Math.floor(Math.random() * foxFiles.length);
        }
        foxCurrent = next;
        foxArt.src = foxBase + foxFiles[foxCurrent];
      }

      foxPets += 1;
      try { localStorage.setItem("fox-pets", foxPets); } catch (err) { /* private mode */ }
      renderFoxPets();

      fox.classList.remove("fox-petted");
      void fox.offsetWidth;
      fox.classList.add("fox-petted");

      fetch(COUNTER_API + "hit/" + encodeURIComponent(FOX_KEY))
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (data && typeof data.value === "number") {
            foxTotal = data.value;
            renderFoxPets();
          }
        })
        .catch(function () { /* offline: keep the local count */ });
    });
  }

  // Doodle. Hovering the name in the intro draws a hand drawn arrow over to the
  // fox. The route is planned on a coarse grid so it bends around text, badges
  // and anything else sitting in the way rather than straight through it, then
  // the whole line is swayed so it reads as sketched instead of plotted.
  var introName = document.getElementById("intro-name");
  var canDoodle = !!(window.matchMedia &&
    window.matchMedia("(hover: hover) and (min-width: 601px)").matches);

  if (introName && fox && foxArt && canDoodle) {
    var DOODLE_SPACING = 14;
    var DOODLE_CELL = 6;
    var DOODLE_PADS = [11, 7, 3];
    var DOODLE_MARGIN = 48;
    // Cells of open space the route aims for, and how much more a step costs
    // when it hugs a wall than when it takes the long way round.
    var DOODLE_CLEARANCE = 7;
    var DOODLE_STEP = 10;
    var DOODLE_HUG = 26;
    // Spacing of the route before it is eased, and how hard it is eased.
    var DOODLE_SKELETON = 20;
    var DOODLE_RELAX = 40;
    // Room is measured this far clear of the text, which leaves the blur in
    // handDraw something to spend without the line ending up on the words.
    var DOODLE_SWAY_PAD = 6;
    // Where the loop lands, measured back from the arrow tip. Spread over a
    // range so it is not always the same distance short of the arrow.
    var DOODLE_LOOP_BACK = [26, 62];
    var DOODLE_LOOP_LEAD = 24;
    // Sizes to try, biggest first, when something is in the way.
    var DOODLE_LOOP_SIZES = [1, 0.75, 0.55];
    // Half-width and half-height of the loop at full size, in px, and how far
    // the pen keeps travelling forward while it circles, as a share of the
    // half-width. Less drift makes a rounder loop, more makes it a thin teardrop.
    var DOODLE_LOOP_WIDE = 14;
    var DOODLE_LOOP_TALL = 12;
    var DOODLE_LOOP_DRIFT = 0.22;
    var DOODLE_LOOP_STEPS = 28;
    var SVG_NS = "http://www.w3.org/2000/svg";

    var doodleSvg = document.createElementNS(SVG_NS, "svg");
    doodleSvg.setAttribute("class", "doodle");
    doodleSvg.setAttribute("aria-hidden", "true");
    var doodlePath = document.createElementNS(SVG_NS, "path");
    doodlePath.setAttribute("class", "doodle-path");
    doodleSvg.appendChild(doodlePath);
    document.body.appendChild(doodleSvg);

    // Text is measured per line box instead of per paragraph, so the line can
    // thread the gaps between words. The heading above the intro is in there
    // too, since a wide swoop can reach it. Badge art is an obstacle as well.
    function introRects() {
      var intro = document.querySelector(".intro");
      var rects = [];
      if (!intro) return rects;

      function addText(root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue.trim() || introName.contains(node)) continue;
          var range = document.createRange();
          range.selectNodeContents(node);
          var parts = range.getClientRects();
          for (var i = 0; i < parts.length; i++) {
            if (parts[i].width > 0 && parts[i].height > 0) rects.push(parts[i]);
          }
        }
      }

      addText(intro);
      var heading = document.getElementById("about");
      if (heading) addText(heading);

      var images = intro.querySelectorAll("img");
      for (var j = 0; j < images.length; j++) {
        if (images[j] === foxArt) continue;
        rects.push(images[j].getBoundingClientRect());
      }

      // The topbar counts as something to avoid as well, so a wide sweep never
      // ends up drawn across it.
      var bar = document.querySelector(".navbar");
      if (bar) rects.push(bar.getBoundingClientRect());
      return rects;
    }

    function inflated(rect, pad) {
      return {
        left: rect.left - pad,
        top: rect.top - pad,
        right: rect.right + pad,
        bottom: rect.bottom + pad,
      };
    }

    function inflateAll(rects, pad) {
      var out = [];
      for (var i = 0; i < rects.length; i++) out.push(inflated(rects[i], pad));
      return out;
    }

    // Breadth-first search over a grid of free space. Cells covered by an
    // obstacle are walls; a small patch around each end is cleared so the path
    // can always leave the name and reach the fox. Returns null if the gap is
    // too tight to squeeze through at this padding.
    function planRoute(a, b, rects, pad) {
      var left = Math.min(a.x, b.x) - DOODLE_MARGIN;
      var right = Math.max(a.x, b.x) + DOODLE_MARGIN;
      var top = Math.min(a.y, b.y) - DOODLE_MARGIN;
      var bottom = Math.max(a.y, b.y) + DOODLE_MARGIN;

      var cols = Math.ceil((right - left) / DOODLE_CELL) + 1;
      var rows = Math.ceil((bottom - top) / DOODLE_CELL) + 1;
      if (!(cols > 2) || !(rows > 2)) return null;
      var grid = [];
      for (var i = 0; i < cols * rows; i++) grid.push(0);

      rects.forEach(function (rect) {
        var box = inflated(rect, pad);
        if (box.right < left || box.left > right || box.bottom < top || box.top > bottom) return;
        var c0 = Math.max(0, Math.floor((box.left - left) / DOODLE_CELL));
        var c1 = Math.min(cols - 1, Math.ceil((box.right - left) / DOODLE_CELL));
        var r0 = Math.max(0, Math.floor((box.top - top) / DOODLE_CELL));
        var r1 = Math.min(rows - 1, Math.ceil((box.bottom - top) / DOODLE_CELL));
        for (var r = r0; r <= r1; r++) {
          for (var c = c0; c <= c1; c++) grid[r * cols + c] = 1;
        }
      });

      function cell(point) {
        return {
          c: Math.min(cols - 1, Math.max(0, Math.round((point.x - left) / DOODLE_CELL))),
          r: Math.min(rows - 1, Math.max(0, Math.round((point.y - top) / DOODLE_CELL))),
        };
      }

      function clear(centre) {
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            var r = centre.r + dr;
            var c = centre.c + dc;
            if (r >= 0 && c >= 0 && r < rows && c < cols) grid[r * cols + c] = 0;
          }
        }
      }

      var from = cell(a);
      var to = cell(b);
      clear(from);
      clear(to);

      var boxes = inflateAll(rects, pad);
      var prev = [];
      for (var p = 0; p < cols * rows; p++) prev.push(-1);
      var start = from.r * cols + from.c;
      var goal = to.r * cols + to.c;
      var found = false;

      // Distance from every cell to the nearest wall, in cells, capped at the
      // elbow room the route wants. Sweeping through open space looks drawn;
      // threading along the edge of a paragraph looks plotted.
      var clearance = [];
      for (var m = 0; m < cols * rows; m++) clearance.push(grid[m] ? 0 : -1);
      var flood = [];
      for (var f = 0; f < cols * rows; f++) {
        if (grid[f]) flood.push(f);
      }
      for (var q = 0; q < flood.length; q++) {
        var here = flood[q];
        var far = clearance[here];
        if (far >= DOODLE_CLEARANCE) continue;
        var fr = Math.floor(here / cols);
        var fc = here % cols;
        if (fr > 0 && clearance[here - cols] === -1) { clearance[here - cols] = far + 1; flood.push(here - cols); }
        if (fr < rows - 1 && clearance[here + cols] === -1) { clearance[here + cols] = far + 1; flood.push(here + cols); }
        if (fc > 0 && clearance[here - 1] === -1) { clearance[here - 1] = far + 1; flood.push(here - 1); }
        if (fc < cols - 1 && clearance[here + 1] === -1) { clearance[here + 1] = far + 1; flood.push(here + 1); }
      }
      for (var w = 0; w < cols * rows; w++) {
        if (clearance[w] === -1) clearance[w] = DOODLE_CLEARANCE;
      }

      var stepCost = [];
      for (var cost = 0; cost <= DOODLE_CLEARANCE; cost++) {
        var share = 1 - cost / DOODLE_CLEARANCE;
        stepCost.push(DOODLE_STEP + Math.round(DOODLE_HUG * share * share));
      }

      // Dijkstra over that cost. The open set only runs to a few thousand
      // cells, so a plain binary heap is plenty.
      var heap = [];
      var rank = [];

      function swap(a, b) {
        var cell = heap[a];
        heap[a] = heap[b];
        heap[b] = cell;
        var key = rank[a];
        rank[a] = rank[b];
        rank[b] = key;
      }

      function raise(cell, value) {
        heap.push(cell);
        rank.push(value);
        var i = heap.length - 1;
        while (i > 0) {
          var up = (i - 1) >> 1;
          if (rank[up] <= rank[i]) break;
          swap(i, up);
          i = up;
        }
      }

      function lower() {
        var top = heap[0];
        var cell = heap.pop();
        var key = rank.pop();
        if (heap.length) {
          heap[0] = cell;
          rank[0] = key;
          var i = 0;
          for (;;) {
            var left = i * 2 + 1;
            var right = left + 1;
            var small = i;
            if (left < heap.length && rank[left] < rank[small]) small = left;
            if (right < heap.length && rank[right] < rank[small]) small = right;
            if (small === i) break;
            swap(i, small);
            i = small;
          }
        }
        return top;
      }

      var best = [];
      for (var b2 = 0; b2 < cols * rows; b2++) best.push(-1);
      best[start] = 0;
      prev[start] = start;
      raise(start, 0);

      while (heap.length) {
        var current = lower();
        if (current === goal) { found = true; break; }
        var cr = Math.floor(current / cols);
        var cc = current % cols;
        var here2 = best[current];
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            var nr = cr + dr;
            var nc = cc + dc;
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
            var next = nr * cols + nc;
            if (grid[next]) continue;
            var trip = here2 + stepCost[clearance[next]];
            if (best[next] !== -1 && best[next] <= trip) continue;
            best[next] = trip;
            prev[next] = current;
            raise(next, trip);
          }
        }
      }

      if (!found) return null;

      var points = [];
      var cursor = goal;
      while (cursor !== start && points.length <= cols * rows) {
        points.push({
          x: left + (cursor % cols) * DOODLE_CELL,
          y: top + Math.floor(cursor / cols) * DOODLE_CELL,
        });
        cursor = prev[cursor];
      }
      points.push(a);
      points.reverse();
      points.push(b);

      // The grid works in whole cells, so its first and last hops land up to
      // half a cell off the name and the fox, which reads as a kink at the tip.
      // Drop those leftovers when the hop straight to the endpoint is clear.
      for (var e = 0; e < 2; e++) {
        var near = e ? points.length - 2 : 1;
        var tip = e ? points.length - 1 : 0;
        var back = e ? points.length - 3 : 2;
        if (points.length > 2 && span(points[near], points[tip]) <= DOODLE_CELL * 1.5 &&
          !segmentHits(points[back], points[tip], boxes)) {
          points.splice(near, 1);
        }
      }
      return points;
    }

    function insideAny(x, y, boxes) {
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        if (x > box.left && x < box.right && y > box.top && y < box.bottom) return true;
      }
      return false;
    }

    function segmentHits(from, to, boxes) {
      var steps = Math.ceil(span(from, to) / 3) + 1;
      for (var s = 1; s < steps; s++) {
        var t = s / steps;
        if (insideAny(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, boxes)) {
          return true;
        }
      }
      return false;
    }

    // Corner cutting rounds off the staircase the grid search leaves behind.
    function chaikin(points) {
      if (points.length < 3) return points;
      var out = [points[0]];
      for (var i = 1; i < points.length; i++) {
        var p = points[i - 1];
        var q = points[i];
        out.push({ x: p.x + (q.x - p.x) * 0.25, y: p.y + (q.y - p.y) * 0.25 });
        out.push({ x: p.x + (q.x - p.x) * 0.75, y: p.y + (q.y - p.y) * 0.75 });
        out.push(q);
      }
      return out;
    }

    function span(a, b) {
      return Math.hypot(b.x - a.x, b.y - a.y);
    }

    function pointsLength(points) {
      var total = 0;
      for (var i = 1; i < points.length; i++) total += span(points[i - 1], points[i]);
      return total;
    }

    // Space the corners out before the curve is drawn through them, otherwise
    // the curve inherits the grid's stair steps.
    function resample(points, spacing) {
      var out = [points[0]];
      var carry = spacing;
      for (var i = 1; i < points.length; i++) {
        var p = points[i - 1];
        var q = points[i];
        var length = span(p, q);
        if (length < 0.001) continue;
        var pos = carry;
        while (pos < length) {
          var t = pos / length;
          out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
          pos += spacing;
        }
        carry = pos - length;
      }
      // Land exactly on the endpoint instead of a sample width short of it,
      // without adding a stub segment that the curve would bend around.
      var last = points[points.length - 1];
      if (out.length > 1) out[out.length - 1] = last;
      else out.push(last);
      return out;
    }

    // Perpendicular of the line at each sample, so the sway can be applied
    // sideways no matter which way the line happens to be travelling.
    function normals(points) {
      var out = [];
      for (var i = 0; i < points.length; i++) {
        var prev = points[i - 1] || points[i];
        var next = points[i + 1] || points[i];
        var dx = next.x - prev.x;
        var dy = next.y - prev.y;
        var length = Math.hypot(dx, dy) || 1;
        out.push({ x: -dy / length, y: dx / length });
      }
      return out;
    }

    // How far the line can drift this way from here before it runs into
    // something. The sway gets whatever room is going, and no more.
    function roomAt(point, normal, side, limit, boxes) {
      for (var travelled = 3; travelled <= limit; travelled += 3) {
        if (insideAny(point.x + normal.x * side * travelled,
          point.y + normal.y * side * travelled, boxes)) {
          return travelled - 3;
        }
      }
      return limit;
    }

    // The side of the line with more space to sweep into.
    function pickSide(points, dirs, boxes, probe) {
      var score = 0;
      for (var i = 0; i < points.length; i++) {
        score += roomAt(points[i], dirs[i], -1, probe, boxes);
        score -= roomAt(points[i], dirs[i], 1, probe, boxes);
      }
      return score >= 0 ? -1 : 1;
    }

    // Smooth value noise in -1..1. The same seed and position always agree, so
    // one phase per draw is enough to make the whole line reproducible.
    function noiseAt(seed, x) {
      var whole = Math.floor(x);
      var part = x - whole;
      var eased = part * part * (3 - 2 * part);
      var from = noiseRandom(seed, whole);
      var to = noiseRandom(seed, whole + 1);
      return from + (to - from) * eased;
    }

    function noiseRandom(seed, index) {
      // Plain FNV leaves keys that differ in their last byte a single prime
      // apart, which is far too smooth to look random here, so mix the result.
      var value = hash(seed + ":" + index);
      value ^= value >>> 15;
      value = Math.imul(value, 2246822507);
      value ^= value >>> 13;
      value = Math.imul(value, 3266489909);
      value ^= value >>> 16;
      return (value >>> 0) / 2147483648 - 1;
    }

    // Three point blur, ends pinned. Used on the sideways offsets and again on
    // the room they have to live in, because a hard clamp against the edge of a
    // paragraph is exactly what leaves a jolt in the line.
    function blurValues(values, passes) {
      var out = values.slice();
      var last = out.length - 1;
      for (var pass = 0; pass < passes; pass++) {
        var source = out.slice();
        for (var i = 1; i < last; i++) {
          out[i] = (source[i - 1] + source[i] * 2 + source[i + 1]) / 4;
        }
      }
      return out;
    }

    // Smallest value in a three wide window. Room gets eroded before it is
    // relaxed, so a sample squeezed between two tight neighbours is treated as
    // tight as well instead of poking into the gap between them.
    function erodeValues(values) {
      var out = [];
      for (var i = 0; i < values.length; i++) {
        var low = values[i];
        if (i > 0 && values[i - 1] < low) low = values[i - 1];
        if (i < values.length - 1 && values[i + 1] < low) low = values[i + 1];
        out.push(low);
      }
      return out;
    }

    // Sway the line sideways over one big arch plus two slow octaves of noise.
    // Noise rather than sine waves, so the swoops come out uneven and hard to
    // predict, but nothing faster than a long lazy bend, since a quick ripple
    // reads as a shaky hand. Offsets and the room available to them are both
    // relaxed before they meet, so the line sweeps wide where it can and eases
    // in beside the text instead of snapping against it.
    function handDraw(points, phase, boxes) {
      var total = pointsLength(points);
      var dirs = normals(points);
      var amp = Math.min(44, Math.max(14, total * 0.05));
      var bow = pickSide(points, dirs, boxes, amp) * amp * 0.4;
      var reach = amp * 2;
      var wanted = [];
      var roomUp = [];
      var roomDown = [];
      var along = 0;

      for (var i = 0; i < points.length; i++) {
        if (i) along += span(points[i - 1], points[i]);
        var fade = Math.min(1, along / 70, (total - along) / 70);
        wanted.push((bow * Math.sin((Math.PI * along) / total) +
          amp * 0.55 * noiseAt(phase, along / 210) +
          amp * 0.3 * noiseAt(phase + 7, along / 110)) * fade);
        roomUp.push(roomAt(points[i], dirs[i], -1, reach, boxes));
        roomDown.push(roomAt(points[i], dirs[i], 1, reach, boxes));
      }

      var up = blurValues(erodeValues(roomUp), 2);
      var down = blurValues(erodeValues(roomDown), 2);

      var swings = [];
      for (var j = 0; j < points.length; j++) {
        var value = wanted[j];
        swings.push(value < 0 ? Math.max(value, -up[j]) : Math.min(value, down[j]));
      }
      swings = blurValues(swings, 2);

      // The blur above can overshoot a tight corner by a pixel or two, so the
      // offsets get one last pass against the room exactly as measured.
      for (var k = 0; k < points.length; k++) {
        var offset = swings[k];
        swings[k] = offset < 0 ? Math.max(offset, -roomUp[k]) : Math.min(offset, roomDown[k]);
      }

      var out = [];
      for (var m = 0; m < points.length; m++) {
        out.push({
          x: points[m].x + dirs[m].x * swings[m],
          y: points[m].y + dirs[m].y * swings[m],
        });
      }
      return out;
    }

    // A drawn arrow usually loops once on the way in. A pen makes a loop by
    // travelling steadily forward while the hand circles, so the loop is that
    // sum: one full turn of a circle riding on a forward drift. Both ends leave
    // the line along its own direction, so the join is seamless. Stretching the
    // circle, leaning it forward and bending its sides unevenly gives the
    // teardrop handwriting makes instead of a perfect ring.
    function loopShape(theta, wide, tall, drift, lean, skew) {
      var rise = tall * (1 - Math.cos(theta));
      return {
        along: drift * theta + wide * Math.sin(theta) +
          skew * wide * Math.sin(2 * theta) + lean * rise,
        up: rise,
      };
    }

    // The point `along` units down the line, pushed `off` units to one side.
    // The side direction is blended between neighbouring samples, so the push
    // changes smoothly instead of jumping at every corner of the polyline.
    function placeOnLine(points, cumulative, dirs, along, off) {
      var last = points.length - 1;
      var at = Math.max(0, Math.min(cumulative[last], along));
      var i = 1;
      while (i < last && cumulative[i] < at) i++;
      var gap = cumulative[i] - cumulative[i - 1] || 1;
      var t = (at - cumulative[i - 1]) / gap;
      var nx = dirs[i - 1].x + (dirs[i].x - dirs[i - 1].x) * t;
      var ny = dirs[i - 1].y + (dirs[i].y - dirs[i - 1].y) * t;
      var norm = Math.hypot(nx, ny) || 1;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t + (nx / norm) * off,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t + (ny / norm) * off,
      };
    }

    // The loop is laid along the line itself, so it follows the line's bend and
    // starts and ends exactly on it. The line's own samples between the two
    // ends are dropped, since the loop replaces them.
    function addLoop(points, boxes, phase) {
      if (points.length < 5) return points;

      var cumulative = [0];
      for (var i = 1; i < points.length; i++) {
        cumulative.push(cumulative[i - 1] + span(points[i - 1], points[i]));
      }
      var length = cumulative[points.length - 1];
      var dirs = normals(points);

      // Seeded from the draw's phase, so a redraw while scrolling is identical.
      var wide = DOODLE_LOOP_WIDE * (1 + 0.22 * noiseRandom(phase, 21));
      var tall = DOODLE_LOOP_TALL * (1 + 0.4 * noiseRandom(phase, 22));
      var lean = 0.3 + 0.1 * noiseRandom(phase, 23);
      var skew = 0.08 + 0.05 * noiseRandom(phase, 24);
      var firstSide = noiseRandom(phase, 25) < 0 ? -1 : 1;
      // Where along the line it lands moves too, so the loop is not always the
      // same distance short of the arrow.
      var back = DOODLE_LOOP_BACK[0] +
        (DOODLE_LOOP_BACK[1] - DOODLE_LOOP_BACK[0]) * (0.5 + 0.5 * noiseRandom(phase, 26));

      for (var s = 0; s < DOODLE_LOOP_SIZES.length; s++) {
        var size = DOODLE_LOOP_SIZES[s];
        var drift = wide * DOODLE_LOOP_DRIFT * size;
        var reach = Math.PI * 2 * drift;
        var begin = length - back - reach;
        if (begin < DOODLE_LOOP_LEAD) continue;

        for (var k = 0; k < 2; k++) {
          var side = k ? -firstSide : firstSide;
          var ring = [];
          var clear = true;
          for (var step = 0; step <= DOODLE_LOOP_STEPS; step++) {
            var shape = loopShape(Math.PI * 2 * step / DOODLE_LOOP_STEPS,
              wide * size, tall * size, drift, lean, skew);
            var spot = placeOnLine(points, cumulative, dirs, begin + shape.along, side * shape.up);
            if (step > 0 && step < DOODLE_LOOP_STEPS && insideAny(spot.x, spot.y, boxes)) {
              clear = false;
              break;
            }
            ring.push(spot);
          }
          if (!clear) continue;

          var out = [];
          for (var m = 0; m < points.length; m++) {
            if (cumulative[m] < begin - 4) out.push(points[m]);
          }
          out = out.concat(ring);
          for (var n = 0; n < points.length; n++) {
            if (cumulative[n] > begin + reach + 4) out.push(points[n]);
          }
          return out;
        }
      }
      return points;
    }

    // The search hands back straight runs joined by corners. Thin those out and
    // let each point drift toward the middle of its neighbours, which melts the
    // runs into one continuous bend. A point that would drift into something
    // keeps its spot, so the easing never eats into the clearance.
    function relaxRoute(points, spacing, boxes) {
      if (points.length < 3) return points;

      var thinned = [points[0]];
      var walked = 0;
      for (var i = 1; i < points.length - 1; i++) {
        walked += span(points[i - 1], points[i]);
        if (walked >= spacing) {
          thinned.push(points[i]);
          walked = 0;
        }
      }
      thinned.push(points[points.length - 1]);

      for (var pass = 0; pass < DOODLE_RELAX; pass++) {
        var source = thinned.slice();
        for (var j = 1; j < thinned.length - 1; j++) {
          var midX = (source[j - 1].x + source[j + 1].x) / 2;
          var midY = (source[j - 1].y + source[j + 1].y) / 2;
          var movedX = source[j].x + (midX - source[j].x) * 0.5;
          var movedY = source[j].y + (midY - source[j].y) * 0.5;
          if (!insideAny(movedX, movedY, boxes)) {
            thinned[j] = { x: movedX, y: movedY };
          }
        }
      }
      return resample(thinned, spacing);
    }

    function round(value) {
      return Math.round(value * 10) / 10;
    }

    // Cubic beziers through the points, so the line bends through each one
    // instead of cornering at it. The tangent at a point runs between its
    // neighbours and is scaled by how far apart they are, which keeps the curve
    // smooth where the spacing changes (wide strides along the line, tight ones
    // round the loop) instead of kinking at the join.
    function curvePath(points) {
      var gaps = [];
      for (var i = 0; i < points.length - 1; i++) {
        gaps.push(span(points[i], points[i + 1]));
      }

      var tangents = [];
      for (var j = 0; j < points.length; j++) {
        var before = points[j - 1] || points[j];
        var after = points[j + 1] || points[j];
        var run = (j ? gaps[j - 1] : 0) + (j < gaps.length ? gaps[j] : 0) || 1;
        tangents.push({ x: (after.x - before.x) / run, y: (after.y - before.y) / run });
      }

      var d = "M" + round(points[0].x) + " " + round(points[0].y);
      for (var k = 0; k < gaps.length; k++) {
        var p = points[k];
        var q = points[k + 1];
        var reach = gaps[k] / 3;
        d += "C" + round(p.x + tangents[k].x * reach) + " " + round(p.y + tangents[k].y * reach) +
          " " + round(q.x - tangents[k + 1].x * reach) + " " + round(q.y - tangents[k + 1].y * reach) +
          " " + round(q.x) + " " + round(q.y);
      }
      return d;
    }

    // Two bowed strokes at the tip, drawn back along the curve's tangent.
    function arrowHead(points, phase) {
      var tip = points[points.length - 1];
      var tail = points[0];
      for (var i = points.length - 2; i >= 0; i--) {
        if (span(points[i], tip) >= 8) { tail = points[i]; break; }
      }
      var angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
      var size = Math.max(10, Math.min(16, pointsLength(points) * 0.09));
      var d = "";
      for (var side = -1; side <= 1; side += 2) {
        var spread = 0.4 + side * 0.03 + Math.sin(phase * 3 + side) * 0.05;
        var barb = angle + Math.PI - side * spread;
        var bx = tip.x + Math.cos(barb) * size;
        var by = tip.y + Math.sin(barb) * size;
        var cx = tip.x + Math.cos(barb) * size * 0.5 - Math.sin(barb) * side * 1.6;
        var cy = tip.y + Math.sin(barb) * size * 0.5 + Math.cos(barb) * side * 1.6;
        d += "M" + round(tip.x) + " " + round(tip.y) +
          "Q" + round(cx) + " " + round(cy) + " " + round(bx) + " " + round(by);
      }
      return d;
    }

    // The layout only moves as a whole when the page scrolls, so a draw whose
    // name, fox and obstacles have all shifted by the same offset is the same
    // line further down the screen. Reusing it keeps scroll redraws cheap.
    var lastDraw = null;

    function sameLayout(draw, a, b, rects) {
      if (!draw || draw.rects.length !== rects.length) return false;
      var dx = a.x - draw.a.x;
      var dy = a.y - draw.a.y;
      if (Math.abs(b.x - draw.b.x - dx) > 0.5 || Math.abs(b.y - draw.b.y - dy) > 0.5) return false;
      for (var i = 0; i < rects.length; i++) {
        if (Math.abs(rects[i].left - draw.rects[i].left - dx) > 0.5) return false;
        if (Math.abs(rects[i].top - draw.rects[i].top - dy) > 0.5) return false;
        if (Math.abs(rects[i].right - draw.rects[i].right - dx) > 0.5) return false;
        if (Math.abs(rects[i].bottom - draw.rects[i].bottom - dy) > 0.5) return false;
      }
      return true;
    }

    function doodlePoints(phase) {
      var nameRect = introName.getBoundingClientRect();
      var foxRect = foxArt.getBoundingClientRect();
      var a = { x: nameRect.right + 3, y: nameRect.top + nameRect.height / 2 };
      var b = { x: foxRect.left - 2, y: foxRect.top + foxRect.height * 0.45 };
      var rects = introRects();

      if (lastDraw && lastDraw.phase === phase && sameLayout(lastDraw, a, b, rects)) {
        var dx = a.x - lastDraw.a.x;
        var dy = a.y - lastDraw.a.y;
        return lastDraw.points.map(function (point) {
          return { x: point.x + dx, y: point.y + dy };
        });
      }

      // A tight layout can seal every gap. Try a narrower margin before
      // giving up and falling back to a straight line.
      var route = null;
      for (var i = 0; i < DOODLE_PADS.length && !route; i++) {
        route = planRoute(a, b, rects, DOODLE_PADS[i]);
      }
      var eased = relaxRoute(chaikin(chaikin(route || [a, b])), DOODLE_SKELETON, inflateAll(rects, 4));
      var points = addLoop(
        handDraw(resample(eased, DOODLE_SPACING), phase, inflateAll(rects, DOODLE_SWAY_PAD)),
        inflateAll(rects, 2),
        phase
      );
      lastDraw = { phase: phase, a: a, b: b, rects: rects, points: points };
      return points;
    }

    var doodlePhase = 0;
    var doodleOn = false;

    function drawDoodle() {
      var points = doodlePoints(doodlePhase);
      doodlePath.setAttribute("d", curvePath(points) + arrowHead(points, doodlePhase));
      doodlePath.style.transition = "none";
      doodlePath.style.opacity = "1";
    }

    introName.addEventListener("pointerenter", function () {
      doodlePhase = Math.random() * Math.PI * 2;
      doodleOn = true;
      drawDoodle();
    });

    introName.addEventListener("pointerleave", function () {
      doodleOn = false;
      doodlePath.style.transition = "opacity 140ms ease";
      doodlePath.style.opacity = "0";
    });

    // Keep the arrow stuck to both ends while the page moves under it.
    var doodleFrame = 0;
    function redrawDoodle() {
      if (!doodleOn || doodleFrame) return;
      doodleFrame = requestAnimationFrame(function () {
        doodleFrame = 0;
        drawDoodle();
      });
    }

    window.addEventListener("scroll", redrawDoodle, { passive: true });
    window.addEventListener("resize", redrawDoodle);
  }

  // Hit counter. Counts through a free CORS-enabled API, and falls back to a
  // per-browser tally if that request fails. Swap the URL to change provider.
  var hits = document.getElementById("hits");
  if (hits) {
    var renderHits = function (value) {
      var digits = String(Math.max(0, value | 0));
      while (digits.length < 6) digits = "0" + digits;
      hits.textContent = "";
      for (var i = 0; i < digits.length; i++) {
        var digit = document.createElement("span");
        digit.className = "hits-digit";
        digit.textContent = digits.charAt(i);
        hits.appendChild(digit);
      }
    };
    var hitsKey = counterKey(hits.dataset.counter || "jitterdev.github.io");
    fetch(COUNTER_API + "hit/" + encodeURIComponent(hitsKey))
      .then(function (response) { return response.json(); })
      .then(function (data) { renderHits(data && data.value); })
      .catch(function () {
        var local = 1;
        try {
          local = (parseInt(localStorage.getItem("hits:" + hitsKey), 10) || 0) + 1;
          localStorage.setItem("hits:" + hitsKey, local);
        } catch (err) { /* storage blocked; just show 1 */ }
        renderHits(local);
      });
  }

  // Accent moods. Swaps the primary/secondary colours and remembers the pick.
  var MOODS = [
    { name: "peach", primary: "#fab387", secondary: "#cba6f7" },
    { name: "mauve", primary: "#cba6f7", secondary: "#f5c2e7" },
    { name: "pink", primary: "#f5c2e7", secondary: "#cba6f7" },
    { name: "red", primary: "#f38ba8", secondary: "#fab387" },
    { name: "green", primary: "#a6e3a1", secondary: "#94e2d5" },
    { name: "teal", primary: "#94e2d5", secondary: "#89dceb" },
    { name: "blue", primary: "#89b4fa", secondary: "#b4befe" },
    { name: "yellow", primary: "#f9e2af", secondary: "#fab387" },
    { name: "lavender", primary: "#b4befe", secondary: "#89b4fa" }
  ];
  var moodButtons = [];

  function applyMood(name) {
    var mood = null;
    for (var i = 0; i < MOODS.length; i++) {
      if (MOODS[i].name === name) mood = MOODS[i];
    }
    if (!mood) return;
    var root = document.documentElement;
    root.style.setProperty("--primary-color", mood.primary);
    root.style.setProperty("--secondary-color", mood.secondary);
    root.setAttribute("data-mood", mood.name);
    try { localStorage.setItem("mood", mood.name); } catch (err) { /* private mode */ }
    moodButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", button.dataset.mood === mood.name ? "true" : "false");
    });
  }

  var moodsEl = document.getElementById("moods");
  if (moodsEl) {
    MOODS.forEach(function (mood) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "mood";
      button.dataset.mood = mood.name;
      button.style.setProperty("--swatch", mood.primary);
      button.setAttribute("aria-label", "mood: " + mood.name);
      button.title = mood.name;
      button.addEventListener("click", function () { applyMood(mood.name); });
      moodsEl.appendChild(button);
      moodButtons.push(button);
    });
  }

  var savedMood = null;
  try { savedMood = localStorage.getItem("mood"); } catch (err) { /* private mode */ }
  if (savedMood) applyMood(savedMood);

  // Command palette. Opened from the topbar "find" button or the / key.
  var siteIndex = null;
  try {
    var indexEl = document.getElementById("site-index");
    if (indexEl) siteIndex = JSON.parse(indexEl.textContent);
  } catch (err) { siteIndex = null; }

  // Old links used #project/<slug>; forward them to /work/<slug>/.
  if (siteIndex && siteIndex.projects) {
    var legacy = (location.hash || "").match(/^#project\/(.+)$/);
    if (legacy) {
      var wanted = decodeURIComponent(legacy[1]);
      siteIndex.projects.forEach(function (project) {
        var slug = project.url.replace(/\/+$/, "").split("/").pop();
        if (slug === wanted) window.location.replace(project.url);
      });
    }
  }

  // 404 page: show the path they tried, and offer a random project.
  var missing = document.getElementById("missing-path");
  if (missing) missing.textContent = location.pathname;

  var randomBtn = document.getElementById("random-project");
  if (randomBtn && siteIndex && siteIndex.projects && siteIndex.projects.length) {
    randomBtn.addEventListener("click", function () {
      var projects = siteIndex.projects;
      window.location.href = projects[Math.floor(Math.random() * projects.length)].url;
    });
  }

  // Back to top. Shows once you are about a screen down the page.
  var toTop = document.getElementById("to-top");
  if (toTop) {
    var syncToTop = function () {
      toTop.hidden = window.scrollY < window.innerHeight;
    };
    toTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? "auto" : "smooth" });
    });
    window.addEventListener("scroll", syncToTop, { passive: true });
    syncToTop();
  }

  var palette = document.createElement("div");
  palette.className = "palette";
  palette.hidden = true;
  palette.innerHTML =
    '<div class="palette-backdrop" data-palette-close></div>' +
    '<div class="palette-box" role="dialog" aria-modal="true" aria-label="Command palette">' +
    '<input class="palette-input" id="palette-input" type="text" placeholder="jump to..." autocomplete="off" spellcheck="false" />' +
    '<ul class="palette-list" id="palette-list"></ul>' +
    "</div>";
  document.body.appendChild(palette);

  var paletteInput = document.getElementById("palette-input");
  var paletteList = document.getElementById("palette-list");
  var paletteItems = [];
  var paletteCommands = [];
  var paletteFiltered = [];
  var paletteSelected = 0;

  function paletteAdd(label, run) {
    paletteCommands.push({ label: label, run: run });
  }

  if (siteIndex) {
    (siteIndex.menu || []).forEach(function (item) {
      paletteAdd("go to " + item.label, function () { window.location.href = item.url; });
    });
    (siteIndex.toys || []).forEach(function (toy) {
      paletteAdd("toy: " + toy.name, function () { window.location.href = toy.url; });
    });
    (siteIndex.projects || []).forEach(function (project) {
      paletteAdd("project: " + project.title, function () { window.location.href = project.url; });
    });
  }
  MOODS.forEach(function (mood) {
    paletteAdd("mood: " + mood.name, function () { applyMood(mood.name); });
  });
  paletteAdd("top", function () { window.scrollTo(0, 0); });
  paletteAdd("random project", function () {
    var projects = (siteIndex && siteIndex.projects) || [];
    if (!projects.length) return;
    window.location.href = projects[Math.floor(Math.random() * projects.length)].url;
  });

  function selectPalette(index) {
    paletteSelected = index;
    paletteItems.forEach(function (item, i) {
      if (i === index) {
        item.setAttribute("aria-selected", "true");
        if (item.scrollIntoView) item.scrollIntoView({ block: "nearest" });
      } else {
        item.removeAttribute("aria-selected");
      }
    });
  }

  function renderPalette() {
    paletteList.textContent = "";
    paletteItems = [];
    if (!paletteFiltered.length) {
      var empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = "no matches";
      paletteList.appendChild(empty);
      return;
    }
    paletteFiltered.forEach(function (command, i) {
      var item = document.createElement("li");
      item.textContent = command.label;
      item.addEventListener("click", function () { runPalette(command); });
      item.addEventListener("pointerenter", function () { selectPalette(i); });
      paletteList.appendChild(item);
      paletteItems.push(item);
    });
    selectPalette(paletteSelected);
  }

  function filterPalette(query) {
    var needle = query.trim().toLowerCase();
    paletteFiltered = paletteCommands.filter(function (command) {
      return !needle || command.label.toLowerCase().indexOf(needle) !== -1;
    });
    paletteSelected = 0;
    renderPalette();
  }

  function openPalette() {
    palette.hidden = false;
    paletteInput.value = "";
    filterPalette("");
    paletteInput.focus();
  }

  function closePalette() {
    palette.hidden = true;
  }

  function runPalette(command) {
    closePalette();
    command.run();
  }

  paletteInput.addEventListener("input", function () {
    filterPalette(paletteInput.value);
  });

  palette.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (paletteFiltered.length) selectPalette((paletteSelected + 1) % paletteFiltered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (paletteFiltered.length) {
        selectPalette((paletteSelected - 1 + paletteFiltered.length) % paletteFiltered.length);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (paletteFiltered[paletteSelected]) runPalette(paletteFiltered[paletteSelected]);
    }
  });

  palette.addEventListener("click", function (event) {
    if (event.target.hasAttribute("data-palette-close")) closePalette();
  });

  var paletteOpen = document.getElementById("palette-open");
  if (paletteOpen) paletteOpen.addEventListener("click", openPalette);

  document.addEventListener("keydown", function (event) {
    if (!palette.hidden) return;
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    var tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || event.target.isContentEditable) return;
    event.preventDefault();
    openPalette();
  });

  // Tooltips: one floating element, positioned so it never leaves the viewport.
  // Long text wraps instead of running off the edge.
  var tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  var tipTarget = null;

  function placeTip(target) {
    var pad = 8;
    var gap = 6;
    var rect = target.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;

    var left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, vw - tw - pad));

    var top = rect.top - th - gap;
    if (top < pad) top = rect.bottom + gap;
    top = Math.max(pad, Math.min(top, vh - th - pad));

    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  var tipMeasure = document.createElement("canvas").getContext("2d");

  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // How many lines greedy wrapping needs at this width.
  function wrapCount(widths, space, max) {
    var lines = 1;
    var current = 0;
    for (var i = 0; i < widths.length; i++) {
      var add = widths[i] + (current > 0 ? space : 0);
      if (current > 0 && current + add > max) {
        lines++;
        current = widths[i];
      } else {
        current += add;
      }
    }
    return lines;
  }

  // Split words into `count` lines minimising the longest line, so the lines
  // come out roughly equal and the box stays as small as possible.
  function balanceLines(widths, space, count) {
    var n = widths.length;
    var prefix = [0];
    for (var i = 0; i < n; i++) prefix.push(prefix[i] + widths[i]);
    function span(i, j) { return prefix[j] - prefix[i] + space * (j - i - 1); }

    var dp = [];
    for (var k = 0; k <= count; k++) {
      var row = [];
      for (var m = 0; m <= n; m++) row.push(Infinity);
      dp.push(row);
    }
    dp[0][0] = 0;
    for (var k = 1; k <= count; k++) {
      for (var i = 1; i <= n; i++) {
        for (var j = k - 1; j < i; j++) {
          var value = Math.max(dp[k - 1][j], span(j, i));
          if (value < dp[k][i]) dp[k][i] = value;
        }
      }
    }

    var ranges = [];
    var end = n;
    for (var k = count; k > 0; k--) {
      for (var j = k - 1; j < end; j++) {
        if (Math.max(dp[k - 1][j], span(j, end)) === dp[k][end]) {
          ranges.unshift([j, end]);
          end = j;
          break;
        }
      }
    }
    return ranges;
  }

  function layoutTip(text) {
    var style = getComputedStyle(tip);
    var padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    var borderX = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    var maxBox = Math.min(parseFloat(style.maxWidth) || 260, window.innerWidth - 16);
    var maxContent = maxBox - padX - borderX;

    tipMeasure.font = style.fontStyle + " " + style.fontWeight + " " +
      style.fontSize + " " + style.fontFamily;

    var words = text.split(/\s+/).filter(Boolean);
    var widths = words.map(function (w) { return tipMeasure.measureText(w).width; });
    var space = tipMeasure.measureText(" ").width;

    var total = 0;
    for (var i = 0; i < widths.length; i++) total += widths[i] + (i ? space : 0);
    if (words.length < 2 || total <= maxContent) {
      tip.textContent = text;
      return;
    }

    var count = wrapCount(widths, space, maxContent);
    var ranges = balanceLines(widths, space, count);
    tip.innerHTML = ranges.map(function (range) {
      return escapeHtml(words.slice(range[0], range[1]).join(" "));
    }).join("<br>");
  }

  function showTip(target) {
    var text = target.getAttribute("data-tip");
    if (!text) return;
    tipTarget = target;
    layoutTip(text);
    tip.style.visibility = "hidden";
    tip.classList.add("is-visible");
    placeTip(target);
    tip.style.visibility = "";
  }

  function hideTip() {
    tipTarget = null;
    tip.classList.remove("is-visible");
  }

  function tipFor(event) {
    return event.target && event.target.closest
      ? event.target.closest("[data-tip]")
      : null;
  }

  document.addEventListener("pointerover", function (event) {
    var target = tipFor(event);
    if (target) showTip(target);
  });

  document.addEventListener("pointerout", function (event) {
    var target = tipFor(event);
    if (target && target === tipTarget && !target.contains(event.relatedTarget)) hideTip();
  });

  document.addEventListener("focusin", function (event) {
    var target = tipFor(event);
    if (target) showTip(target);
  });

  document.addEventListener("focusout", hideTip);

  window.addEventListener("scroll", function () {
    if (tipTarget) placeTip(tipTarget);
  }, true);

  window.addEventListener("resize", hideTip);

  var list = document.getElementById("project-list");
  if (!list) return;

  var search = document.getElementById("project-search");
  var sortSelect = document.getElementById("project-sort");
  var suggestEl = document.getElementById("project-suggest");
  var none = document.getElementById("project-none");
  var count = document.getElementById("project-count");
  var cards = Array.prototype.slice.call(list.querySelectorAll(".project"));

  cards.forEach(function (card, index) {
    card.dataset.index = index;
  });

  function haystack(card) {
    // <template> content is inert, so textContent only covers what is visible.
    return [
      card.dataset.name,
      card.dataset.tags,
      card.dataset.years,
      card.textContent,
    ].join(" ").toLowerCase();
  }

  function cardTags(card) {
    return (card.dataset.tags || "").toLowerCase().split(",").map(function (tag) {
      return tag.trim();
    }).filter(Boolean);
  }

  // Query syntax: free text, `key:value`, and a leading `-` to negate.
  // Keys are tag, year and name. Quotes keep a phrase together.
  function parseQuery(raw) {
    var tokens = [];
    var pattern = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
    var match;
    while ((match = pattern.exec(raw)) !== null) {
      var value = match[3] !== undefined ? match[3] : (match[4] || "");
      if (!value) continue;
      tokens.push({
        negate: match[1] === "-",
        key: (match[2] || "").toLowerCase(),
        value: value.toLowerCase(),
      });
    }
    return tokens;
  }

  function matchesQuery(card, tokens) {
    var hay = haystack(card);
    var tags = cardTags(card);
    var years = (card.dataset.years || "").toLowerCase();
    var name = (card.dataset.name || "").toLowerCase();

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var hit;
      if (token.key === "tag") hit = tags.indexOf(token.value) !== -1;
      else if (token.key === "year") hit = years.indexOf(token.value) !== -1;
      else if (token.key === "name") hit = name.indexOf(token.value) !== -1;
      else hit = hay.indexOf(token.value) !== -1;
      if (token.negate ? hit : !hit) return false;
    }
    return true;
  }

  function yearOf(card) {
    var match = /(\d{4})/.exec(card.dataset.years || "");
    return match ? parseInt(match[1], 10) : 0;
  }

  function applySort(mode) {
    var sorted = cards.slice();
    if (mode === "name-asc" || mode === "name-desc") {
      var nameDir = mode === "name-asc" ? 1 : -1;
      sorted.sort(function (a, b) {
        return nameDir * (a.dataset.name || "").localeCompare(b.dataset.name || "");
      });
    } else if (mode === "newest" || mode === "oldest") {
      var yearDir = mode === "newest" ? -1 : 1;
      sorted.sort(function (a, b) {
        return yearDir * (yearOf(a) - yearOf(b));
      });
    } else {
      sorted.sort(function (a, b) {
        return (parseInt(a.dataset.index, 10) || 0) - (parseInt(b.dataset.index, 10) || 0);
      });
    }
    sorted.forEach(function (card) { list.appendChild(card); });
  }

  function applyFilter() {
    var tokens = parseQuery(search.value || "");
    var shown = 0;
    cards.forEach(function (card) {
      var match = matchesQuery(card, tokens);
      card.hidden = !match;
      if (match) shown++;
    });
    none.hidden = shown !== 0;
    count.textContent = tokens.length
      ? shown + " / " + cards.length + " shown"
      : cards.length + " projects";
  }

  // Autocomplete: suggestions are built from the tags, years and names on the page.
  var suggestions = [];
  (function buildSuggestions() {
    var seenTags = {};
    var seenYears = {};
    cards.forEach(function (card) {
      cardTags(card).forEach(function (tag) { seenTags[tag] = true; });
      if (card.dataset.years) seenYears[card.dataset.years] = true;
      if (card.dataset.name) suggestions.push({ value: card.dataset.name, kind: "name" });
    });
    Object.keys(seenTags).sort().forEach(function (tag) {
      suggestions.push({ value: "tag:" + tag, kind: "tag" });
    });
    Object.keys(seenYears).sort().forEach(function (year) {
      suggestions.push({ value: "year:" + year, kind: "year" });
    });
  })();

  var suggestMatches = [];
  var suggestSelected = 0;

  function currentToken() {
    var value = search.value || "";
    var cut = value.lastIndexOf(" ");
    return { start: cut + 1, text: value.slice(cut + 1) };
  }

  function hideSuggest() {
    suggestEl.hidden = true;
    search.setAttribute("aria-expanded", "false");
  }

  function selectSuggest(index) {
    suggestSelected = index;
    Array.prototype.forEach.call(suggestEl.children, function (item, i) {
      if (i === index) item.setAttribute("aria-selected", "true");
      else item.removeAttribute("aria-selected");
    });
  }

  function renderSuggest() {
    var token = currentToken().text.toLowerCase();
    if (!token) {
      hideSuggest();
      return;
    }

    suggestMatches = suggestions.filter(function (item) {
      return item.value.toLowerCase().indexOf(token) !== -1;
    }).slice(0, 8);

    suggestEl.textContent = "";
    if (!suggestMatches.length) {
      hideSuggest();
      return;
    }

    suggestMatches.forEach(function (item, i) {
      var row = document.createElement("li");
      row.setAttribute("role", "option");
      row.appendChild(document.createTextNode(item.value));
      var kind = document.createElement("span");
      kind.className = "project-suggest-kind";
      kind.textContent = item.kind;
      row.appendChild(kind);
      row.addEventListener("mousedown", function (event) {
        event.preventDefault();
        acceptSuggest(i);
      });
      row.addEventListener("pointerenter", function () { selectSuggest(i); });
      suggestEl.appendChild(row);
    });

    selectSuggest(0);
    suggestEl.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }

  function acceptSuggest(index) {
    var item = suggestMatches[index];
    if (!item) return;
    var token = currentToken();
    search.value = search.value.slice(0, token.start) + item.value + " ";
    hideSuggest();
    applyFilter();
    search.focus();
  }

  search.addEventListener("input", function () {
    applyFilter();
    renderSuggest();
  });

  search.addEventListener("focus", renderSuggest);

  search.addEventListener("blur", function () {
    // let a suggestion click land before closing
    setTimeout(hideSuggest, 120);
  });

  search.addEventListener("keydown", function (event) {
    if (suggestEl.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectSuggest((suggestSelected + 1) % suggestMatches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectSuggest((suggestSelected - 1 + suggestMatches.length) % suggestMatches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      acceptSuggest(suggestSelected);
    } else if (event.key === "Escape") {
      hideSuggest();
    }
  });

  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      applySort(sortSelect.value);
    });
  }

  applyFilter();
})();