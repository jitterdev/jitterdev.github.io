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
      foxPetsEl.textContent = foxTotal === null
        ? mine
        : mine + " \u00b7 " + foxTotal.toLocaleString() + " total";
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
