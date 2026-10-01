(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const NS = "http://www.w3.org/2000/svg";

  const RELATION_PRIORITY = [
    "P31", "P279", "P361", "P527", "P1269", "P921", "P2579", "P1889",
    "P17", "P131", "P276", "P159", "P19", "P20", "P27", "P106", "P101",
    "P69", "P463", "P1344", "P710", "P737", "P138", "P144", "P155", "P156",
    "P170", "P50", "P112", "P57", "P161", "P175", "P136", "P495", "P2283",
    "P1535", "P2868"
  ];

  const HISTORY_KEY = "knowledge-universe-v2-history";
  const DEGREE_VISIT_LIMIT = 320;
  const DEGREE_REQUEST_LIMIT = 22;
  const DEGREE_BRANCH_LIMIT = 8;

  const els = {
    modeTabs: $$('[data-mode]'),
    modeViews: $$('[data-view]'),
    universeForm: $("#universeForm"),
    universeInput: $("#universeInput"),
    overview: $("#overviewContent"),
    research: $("#researchContent"),
    books: $("#booksContent"),
    graph: $("#graphSvg"),
    entityDescription: $("#entityDescription"),
    entityId: $("#entityId"),
    relatedCount: $("#relatedCount"),
    paperCount: $("#paperCount"),
    bookCount: $("#bookCount"),
    elapsedTime: $("#elapsedTime"),
    recentSearches: $("#recentSearches"),
    rabbitForm: $("#rabbitForm"),
    rabbitInput: $("#rabbitInput"),
    rabbitReset: $("#rabbitReset"),
    rabbitTrail: $("#rabbitTrail"),
    rabbitCurrent: $("#rabbitCurrent"),
    rabbitChoices: $("#rabbitChoices"),
    rabbitSvg: $("#rabbitSvg"),
    rabbitCount: $("#rabbitCount"),
    degreesForm: $("#degreesForm"),
    degreesFrom: $("#degreesFrom"),
    degreesTo: $("#degreesTo"),
    degreesDepth: $("#degreesDepth"),
    degreesSubmit: $("#degreesSubmit"),
    degreesStatusBadge: $("#degreesStatusBadge"),
    degreeVisited: $("#degreeVisited"),
    degreeRequests: $("#degreeRequests"),
    degreeDepthMetric: $("#degreeDepthMetric"),
    degreeTime: $("#degreeTime"),
    degreeLog: $("#degreeLog"),
    degreesPath: $("#degreesPath")
  };

  const state = {
    mode: "universe",
    universeQuery: "",
    universeStartedAt: 0,
    rabbitTrail: [],
    rabbitCurrentId: null,
    rabbitStartQuery: "人工知能",
    degreeRunId: 0,
    degreeRequests: 0,
    degreeVisited: 0,
    degreeStartedAt: 0,
    degreeAdjCache: new Map()
  };

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    }[ch]));
  }

  function truncate(text = "", max = 360) {
    const s = String(text || "");
    return s.length > max ? `${s.slice(0, max).trim()}…` : s;
  }

  function compactNumber(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return "—";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
    return String(value);
  }

  function elapsedLabel(ms) {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 14000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("API応答がタイムアウトしました。");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function setSourceState(name, status) {
    const pill = document.querySelector(`[data-source-pill="${name}"]`);
    if (!pill) return;
    pill.classList.remove("is-loading", "is-ok", "is-error");
    if (status) pill.classList.add(`is-${status}`);
  }

  function renderError(target, message) {
    target.classList.remove("placeholder-block");
    target.innerHTML = `<div class="api-error"><strong>DATA SOURCE UNAVAILABLE</strong><p>${escapeHtml(message)}</p></div>`;
  }

  function pickLabel(entity) {
    return entity?.labels?.ja?.value || entity?.labels?.en?.value || "";
  }

  function pickDescription(entity) {
    return entity?.descriptions?.ja?.value || entity?.descriptions?.en?.value || "";
  }

  async function searchWikidata(query, limit = 5) {
    const params = new URLSearchParams({
      action: "wbsearchentities",
      search: query,
      language: "ja",
      uselang: "ja",
      type: "item",
      limit: String(limit),
      format: "json",
      origin: "*"
    });
    const data = await fetchJson(`https://www.wikidata.org/w/api.php?${params}`);
    return data?.search || [];
  }

  async function resolveWikidata(query) {
    const hits = await searchWikidata(query, 5);
    if (!hits.length) throw new Error(`「${query}」に対応するWikidata項目が見つかりません。`);
    return hits[0];
  }

  async function getWikidataEntities(ids, props = "claims|labels|descriptions", options = {}) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return {};
    const merged = {};
    for (let i = 0; i < unique.length; i += 40) {
      if (options.degreeRunId && options.degreeRunId !== state.degreeRunId) throw new Error("探索が更新されました。");
      if (options.countDegreeRequest) {
        state.degreeRequests += 1;
        updateDegreeMetrics();
        if (state.degreeRequests > DEGREE_REQUEST_LIMIT) throw new Error("APIリクエスト上限に達したため探索を停止しました。");
      }
      const params = new URLSearchParams({
        action: "wbgetentities",
        ids: unique.slice(i, i + 40).join("|"),
        props,
        languages: "ja|en",
        languagefallback: "1",
        format: "json",
        origin: "*"
      });
      const data = await fetchJson(`https://www.wikidata.org/w/api.php?${params}`, { timeout: 16000 });
      Object.assign(merged, data?.entities || {});
    }
    return merged;
  }

  function collectEntityRelations(entity, max = 14) {
    const claims = entity?.claims || {};
    const relations = [];
    const seen = new Set();
    for (const propertyId of RELATION_PRIORITY) {
      const claimList = claims[propertyId] || [];
      for (const claim of claimList) {
        const targetId = claim?.mainsnak?.datavalue?.value?.id;
        if (!targetId || !/^Q\d+$/.test(targetId) || seen.has(targetId)) continue;
        seen.add(targetId);
        relations.push({ propertyId, targetId });
        if (relations.length >= max) return relations;
      }
    }
    return relations;
  }

  async function enrichRelations(entity, max = 12) {
    const raw = collectEntityRelations(entity, max);
    const ids = [...new Set(raw.flatMap((r) => [r.propertyId, r.targetId]))];
    const labelEntities = ids.length ? await getWikidataEntities(ids, "labels|descriptions") : {};
    return raw.map((r) => ({
      ...r,
      propertyLabel: pickLabel(labelEntities[r.propertyId]) || r.propertyId,
      targetLabel: pickLabel(labelEntities[r.targetId]) || r.targetId,
      targetDescription: pickDescription(labelEntities[r.targetId]) || ""
    }));
  }

  function wrapSvgText(textEl, text, charsPerLine = 10) {
    const chunks = [];
    for (let i = 0; i < text.length; i += charsPerLine) chunks.push(text.slice(i, i + charsPerLine));
    chunks.slice(0, 2).forEach((chunk, index, arr) => {
      const tspan = document.createElementNS(NS, "tspan");
      tspan.setAttribute("x", "0");
      tspan.setAttribute("dy", index === 0 ? `${-(arr.length - 1) * 6}px` : "14px");
      tspan.textContent = chunk;
      textEl.appendChild(tspan);
    });
  }

  // ---------- Mode controller ----------
  function activateMode(mode, updateUrl = true) {
    if (!["universe", "rabbit", "degrees"].includes(mode)) mode = "universe";
    state.mode = mode;
    els.modeTabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.mode === mode));
    els.modeViews.forEach((view) => {
      const active = view.dataset.view === mode;
      view.classList.toggle("is-active", active);
      view.hidden = !active;
    });
    if (updateUrl) syncUrl();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function syncUrl(extra = {}) {
    const params = new URLSearchParams();
    params.set("mode", state.mode);
    if (state.mode === "universe" && (extra.q || state.universeQuery)) params.set("q", extra.q || state.universeQuery);
    if (state.mode === "rabbit" && state.rabbitTrail.length) params.set("rabbit", state.rabbitTrail[0].label);
    if (state.mode === "degrees") {
      if (els.degreesFrom.value.trim()) params.set("from", els.degreesFrom.value.trim());
      if (els.degreesTo.value.trim()) params.set("to", els.degreesTo.value.trim());
    }
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }

  els.modeTabs.forEach((tab) => tab.addEventListener("click", () => activateMode(tab.dataset.mode)));

  // ---------- Universe ----------
  function setUniverseLoading() {
    ["wikipedia", "wikidata", "openalex", "openlibrary"].forEach((s) => setSourceState(s, "loading"));
    els.relatedCount.textContent = "—";
    els.paperCount.textContent = "—";
    els.bookCount.textContent = "—";
    els.elapsedTime.textContent = "…";
    els.entityDescription.textContent = "関連項目を取得しています…";
    els.entityId.textContent = "—";
    els.overview.innerHTML = `<div class="skeleton skeleton-media"></div><div class="skeleton skeleton-title"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div>`;
    els.research.innerHTML = `<div class="skeleton card-sk"></div><div class="skeleton card-sk"></div><div class="skeleton card-sk"></div>`;
    els.books.innerHTML = `<div class="skeleton book-sk"></div><div class="skeleton book-sk"></div><div class="skeleton book-sk"></div><div class="skeleton book-sk"></div>`;
    drawUniverseGraph(state.universeQuery || "SEARCHING…", []);
  }

  async function loadWikipedia(query) {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrlimit: "1",
      gsrnamespace: "0",
      prop: "extracts|pageimages|info",
      exintro: "1",
      explaintext: "1",
      pithumbsize: "720",
      inprop: "url",
      format: "json",
      origin: "*"
    });
    const data = await fetchJson(`https://ja.wikipedia.org/w/api.php?${params}`);
    const pages = Object.values(data?.query?.pages || {});
    if (!pages.length) throw new Error("Wikipediaに該当する記事が見つかりませんでした。");
    renderWikipedia(pages[0]);
    setSourceState("wikipedia", "ok");
  }

  function renderWikipedia(page) {
    els.overview.classList.remove("placeholder-block");
    const thumb = page.thumbnail?.source
      ? `<img class="wiki-thumb" src="${escapeHtml(page.thumbnail.source)}" alt="${escapeHtml(page.title || "Wikipedia画像")}" />`
      : "";
    const url = page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title || "")}`;
    els.overview.innerHTML = `${thumb}
      <div class="overview-kicker"><span>ENCYCLOPEDIA</span><small>${escapeHtml(page.pageid || "")}</small></div>
      <h3>${escapeHtml(page.title || "Untitled")}</h3>
      <p>${escapeHtml(truncate(page.extract || "概要情報がありません。", 620))}</p>
      <a class="read-more" href="${escapeHtml(url)}" target="_blank" rel="noopener">READ ON WIKIPEDIA ↗</a>`;
  }

  async function loadUniverseWikidata(query) {
    const hit = await resolveWikidata(query);
    const entities = await getWikidataEntities([hit.id], "claims|labels|descriptions|sitelinks");
    const root = entities[hit.id];
    if (!root) throw new Error("Wikidataエンティティを取得できませんでした。");
    const relations = await enrichRelations(root, 12);
    const label = pickLabel(root) || hit.label || query;
    els.entityDescription.textContent = pickDescription(root) || hit.description || "説明情報なし";
    els.entityId.textContent = hit.id;
    els.relatedCount.textContent = String(relations.length);
    drawUniverseGraph(label, relations);
    setSourceState("wikidata", "ok");
  }

  function drawUniverseGraph(centerLabel, relations) {
    const svg = els.graph;
    svg.innerHTML = "";
    const cx = 380, cy = 260;
    const radius = relations.length > 8 ? 190 : 170;
    const orbit = document.createElementNS(NS, "circle");
    orbit.setAttribute("class", "graph-orbit");
    orbit.setAttribute("cx", cx); orbit.setAttribute("cy", cy); orbit.setAttribute("r", radius);
    svg.appendChild(orbit);

    relations.forEach((r, i) => {
      const angle = -Math.PI / 2 + (i / Math.max(relations.length, 1)) * Math.PI * 2;
      const wobble = i % 2 === 0 ? 0 : 24;
      const x = cx + Math.cos(angle) * (radius + wobble);
      const y = cy + Math.sin(angle) * (radius + wobble * .5);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("class", "graph-link");
      line.setAttribute("x1", cx); line.setAttribute("y1", cy); line.setAttribute("x2", x); line.setAttribute("y2", y);
      svg.appendChild(line);

      if (relations.length <= 9) {
        const relationLabel = document.createElementNS(NS, "text");
        relationLabel.setAttribute("class", "graph-link-label");
        relationLabel.setAttribute("x", (cx + x) / 2);
        relationLabel.setAttribute("y", (cy + y) / 2 - 4);
        relationLabel.textContent = truncate(r.propertyLabel, 16);
        svg.appendChild(relationLabel);
      }

      const node = document.createElementNS(NS, "g");
      node.setAttribute("class", "graph-node related");
      node.setAttribute("transform", `translate(${x} ${y})`);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `${r.targetLabel} を探索`);
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("r", relations.length > 9 ? 40 : 44);
      node.appendChild(circle);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("y", r.targetDescription ? "-2" : "4");
      wrapSvgText(text, truncate(r.targetLabel, 18), 10);
      node.appendChild(text);
      if (r.targetDescription) {
        const desc = document.createElementNS(NS, "text");
        desc.setAttribute("class", "node-description");
        desc.setAttribute("y", "18");
        desc.textContent = truncate(r.targetDescription, 14);
        node.appendChild(desc);
      }
      const rerun = () => runUniverse(r.targetLabel);
      node.addEventListener("click", rerun);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rerun(); }
      });
      svg.appendChild(node);
    });

    const center = document.createElementNS(NS, "g");
    center.setAttribute("class", "graph-node center");
    center.setAttribute("transform", `translate(${cx} ${cy})`);
    const centerCircle = document.createElementNS(NS, "circle");
    centerCircle.setAttribute("r", "69");
    center.appendChild(centerCircle);
    const centerText = document.createElementNS(NS, "text");
    centerText.setAttribute("y", "4");
    wrapSvgText(centerText, truncate(centerLabel, 24), 12);
    center.appendChild(centerText);
    svg.appendChild(center);

    if (!relations.length) {
      const msg = document.createElementNS(NS, "text");
      msg.setAttribute("x", "380"); msg.setAttribute("y", "372"); msg.setAttribute("text-anchor", "middle");
      msg.setAttribute("fill", "#717a77"); msg.setAttribute("font-size", "11");
      msg.textContent = "関連ノードを探索中、または関連データなし";
      svg.appendChild(msg);
    }
  }

  async function loadOpenAlex(query) {
    const params = new URLSearchParams({
      search: query,
      per_page: "5",
      select: "id,title,publication_year,cited_by_count,doi,authorships,primary_location"
    });
    const data = await fetchJson(`https://api.openalex.org/works?${params}`);
    const works = data?.results || [];
    renderResearch(works);
    els.paperCount.textContent = compactNumber(data?.meta?.count ?? works.length);
    setSourceState("openalex", "ok");
  }

  function renderResearch(works) {
    els.research.classList.remove("placeholder-block");
    if (!works.length) {
      els.research.innerHTML = `<div class="empty-state">関連する研究文献は見つかりませんでした。</div>`;
      return;
    }
    els.research.innerHTML = works.map((work) => {
      const authors = (work.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean).join(" · ");
      const source = work.primary_location?.source?.display_name || "Source unknown";
      const url = work.doi || work.id;
      return `<a class="research-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">
        <div class="paper-year">${escapeHtml(work.publication_year || "—")}</div>
        <div class="paper-copy"><h3>${escapeHtml(work.title || "Untitled")}</h3><p>${escapeHtml(authors || "Author unknown")}<br>${escapeHtml(source)}</p></div>
        <div class="paper-metric"><strong>${compactNumber(work.cited_by_count || 0)}</strong><span>CITED</span></div>
      </a>`;
    }).join("");
  }

  async function loadOpenLibrary(query) {
    const params = new URLSearchParams({
      q: query,
      limit: "4",
      fields: "key,title,author_name,first_publish_year,cover_i,edition_key"
    });
    const data = await fetchJson(`https://openlibrary.org/search.json?${params}`);
    const books = data?.docs || [];
    renderBooks(books);
    els.bookCount.textContent = compactNumber(data?.numFound ?? books.length);
    setSourceState("openlibrary", "ok");
  }

  function renderBooks(books) {
    els.books.classList.remove("placeholder-block");
    if (!books.length) {
      els.books.innerHTML = `<div class="empty-state">関連書籍は見つかりませんでした。</div>`;
      return;
    }
    els.books.innerHTML = books.map((book) => {
      const cover = book.cover_i ? `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg` : "";
      const url = `https://openlibrary.org${book.key || ""}`;
      const author = (book.author_name || []).slice(0, 2).join(" / ") || "Author unknown";
      return `<a class="book-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">
        ${cover ? `<img class="book-cover" src="${escapeHtml(cover)}" loading="lazy" alt="${escapeHtml(book.title || "書籍表紙")}">` : `<div class="book-cover-fallback">NO COVER<br>OPEN LIBRARY</div>`}
        <div class="book-copy"><strong>${escapeHtml(book.title || "Untitled")}</strong><small>${escapeHtml(author)} · ${escapeHtml(book.first_publish_year || "—")}</small></div>
      </a>`;
    }).join("");
  }

  async function guarded(sourceName, fn, onError) {
    try { return await fn(); }
    catch (error) {
      console.error(`[${sourceName}]`, error);
      setSourceState(sourceName, "error");
      onError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async function runUniverse(rawQuery) {
    const query = String(rawQuery || "").trim();
    if (!query) return;
    state.universeQuery = query;
    state.universeStartedAt = performance.now();
    els.universeInput.value = query;
    activateMode("universe", false);
    setUniverseLoading();
    addRecentSearch(query);
    syncUrl({ q: query });

    const tasks = [
      guarded("wikipedia", () => loadWikipedia(query), (m) => renderError(els.overview, m)),
      guarded("wikidata", () => loadUniverseWikidata(query), (m) => {
        els.entityDescription.textContent = m;
        els.entityId.textContent = "ERR";
        els.relatedCount.textContent = "—";
        drawUniverseGraph(query, []);
      }),
      guarded("openalex", () => loadOpenAlex(query), (m) => { renderError(els.research, m); els.paperCount.textContent = "—"; }),
      guarded("openlibrary", () => loadOpenLibrary(query), (m) => { renderError(els.books, m); els.bookCount.textContent = "—"; })
    ];

    await Promise.allSettled(tasks);
    els.elapsedTime.textContent = elapsedLabel(performance.now() - state.universeStartedAt);
  }

  // ---------- Recent searches ----------
  function readHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value.slice(0, 8) : [];
    } catch { return []; }
  }

  function addRecentSearch(query) {
    const next = [query, ...readHistory().filter((x) => x !== query)].slice(0, 8);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    renderRecentSearches();
  }

  function renderRecentSearches() {
    const history = readHistory();
    els.recentSearches.innerHTML = history.length
      ? history.map((q) => `<button type="button" data-history-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")
      : `<span>NO HISTORY YET</span>`;
    $$('[data-history-query]').forEach((button) => button.addEventListener("click", () => runUniverse(button.dataset.historyQuery)));
  }

  // ---------- Rabbit Hole ----------
  function setRabbitLoading(message = "Wikidataから関係を取得しています…") {
    setSourceState("wikidata", "loading");
    els.rabbitCurrent.innerHTML = `<div class="rabbit-loading">${escapeHtml(message)}</div>`;
    els.rabbitChoices.innerHTML = `<div class="rabbit-loading">関連ノードを探索中…</div>`;
    els.rabbitCount.textContent = "…";
    drawRabbitGraph("LOADING", []);
  }

  async function startRabbit(rawQuery) {
    const query = String(rawQuery || "").trim();
    if (!query) return;
    state.rabbitStartQuery = query;
    els.rabbitInput.value = query;
    activateMode("rabbit", false);
    setRabbitLoading(`「${query}」をWikidataで解決しています…`);
    try {
      const hit = await resolveWikidata(query);
      state.rabbitTrail = [];
      await visitRabbitEntity(hit.id, { push: true, fallbackLabel: hit.label || query, via: "START" });
      syncUrl();
    } catch (error) {
      setSourceState("wikidata", "error");
      els.rabbitCurrent.innerHTML = `<div class="api-error"><strong>RABBIT HOLE START FAILED</strong><p>${escapeHtml(error.message || String(error))}</p></div>`;
      els.rabbitChoices.innerHTML = "";
      drawRabbitGraph(query, []);
    }
  }

  async function visitRabbitEntity(id, options = {}) {
    if (!id) return;
    state.rabbitCurrentId = id;
    setRabbitLoading();
    try {
      const entities = await getWikidataEntities([id], "claims|labels|descriptions");
      const root = entities[id];
      if (!root) throw new Error(`${id} のデータを取得できませんでした。`);
      const relations = await enrichRelations(root, 12);
      const label = pickLabel(root) || options.fallbackLabel || id;
      const description = pickDescription(root) || "説明情報なし";

      if (options.trailIndex !== undefined) {
        state.rabbitTrail = state.rabbitTrail.slice(0, options.trailIndex + 1);
      } else if (options.push !== false) {
        const last = state.rabbitTrail[state.rabbitTrail.length - 1];
        if (!last || last.id !== id) {
          state.rabbitTrail.push({ id, label, description, via: options.via || "RELATED" });
        }
      }

      renderRabbitTrail();
      renderRabbitCurrent({ id, label, description });
      renderRabbitChoices(relations);
      drawRabbitGraph(label, relations);
      els.rabbitCount.textContent = String(relations.length);
      setSourceState("wikidata", "ok");
      syncUrl();
    } catch (error) {
      setSourceState("wikidata", "error");
      els.rabbitCurrent.innerHTML = `<div class="api-error"><strong>DATA SOURCE UNAVAILABLE</strong><p>${escapeHtml(error.message || String(error))}</p></div>`;
      els.rabbitChoices.innerHTML = "";
      els.rabbitCount.textContent = "ERR";
    }
  }

  function renderRabbitTrail() {
    els.rabbitTrail.innerHTML = state.rabbitTrail.length ? state.rabbitTrail.map((item, index) => `
      <button class="trail-item ${index === state.rabbitTrail.length - 1 ? "is-current" : ""}" type="button" data-trail-index="${index}">
        <span class="trail-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="trail-copy"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.id)} · ${escapeHtml(item.via || "")}</small></span>
      </button>`).join("") : `<div class="rabbit-loading">まだ探索履歴はありません。</div>`;
    $$('[data-trail-index]').forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.trailIndex);
      const item = state.rabbitTrail[index];
      if (item) visitRabbitEntity(item.id, { push: false, trailIndex: index, fallbackLabel: item.label });
    }));
  }

  function renderRabbitCurrent(item) {
    els.rabbitCurrent.innerHTML = `<div><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.description)}</p></div><span class="qid">${escapeHtml(item.id)}</span>`;
  }

  function renderRabbitChoices(relations) {
    if (!relations.length) {
      els.rabbitChoices.innerHTML = `<div class="empty-state">主要な関連ノードが見つかりませんでした。</div>`;
      return;
    }
    els.rabbitChoices.innerHTML = relations.map((r, i) => `
      <button type="button" class="rabbit-choice" data-rabbit-index="${i}">
        <span>${escapeHtml(r.propertyLabel)}</span>
        <strong>${escapeHtml(r.targetLabel)}</strong>
        <small>${escapeHtml(r.targetDescription || r.targetId)}</small>
      </button>`).join("");
    $$('[data-rabbit-index]').forEach((button) => button.addEventListener("click", () => {
      const r = relations[Number(button.dataset.rabbitIndex)];
      if (r) visitRabbitEntity(r.targetId, { push: true, fallbackLabel: r.targetLabel, via: r.propertyLabel });
    }));
  }

  function drawRabbitGraph(centerLabel, relations) {
    const svg = els.rabbitSvg;
    svg.innerHTML = "";
    const cx = 450, cy = 260;
    const usable = relations.slice(0, 10);
    const rings = [185, 220];

    usable.forEach((r, i) => {
      const angle = -Math.PI / 2 + (i / Math.max(usable.length, 1)) * Math.PI * 2;
      const radius = rings[i % 2];
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * (radius * .78);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("class", "graph-link");
      line.setAttribute("x1", cx); line.setAttribute("y1", cy); line.setAttribute("x2", x); line.setAttribute("y2", y);
      svg.appendChild(line);

      const prop = document.createElementNS(NS, "text");
      prop.setAttribute("class", "graph-link-label");
      prop.setAttribute("x", (cx + x) / 2);
      prop.setAttribute("y", (cy + y) / 2 - 4);
      prop.textContent = truncate(r.propertyLabel, 13);
      svg.appendChild(prop);

      const node = document.createElementNS(NS, "g");
      node.setAttribute("class", "graph-node related");
      node.setAttribute("transform", `translate(${x} ${y})`);
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("r", "42");
      node.appendChild(circle);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("y", "4");
      wrapSvgText(text, truncate(r.targetLabel, 18), 9);
      node.appendChild(text);
      const open = () => visitRabbitEntity(r.targetId, { push: true, fallbackLabel: r.targetLabel, via: r.propertyLabel });
      node.addEventListener("click", open);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      svg.appendChild(node);
    });

    const center = document.createElementNS(NS, "g");
    center.setAttribute("class", "graph-node center");
    center.setAttribute("transform", `translate(${cx} ${cy})`);
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("r", "74");
    center.appendChild(circle);
    const text = document.createElementNS(NS, "text");
    text.setAttribute("y", "4");
    wrapSvgText(text, truncate(centerLabel, 25), 12);
    center.appendChild(text);
    svg.appendChild(center);
  }

  // ---------- Six Degrees ----------
  function setDegreeStatus(status, text) {
    els.degreesStatusBadge.classList.remove("is-running", "is-found", "is-miss");
    if (status) els.degreesStatusBadge.classList.add(`is-${status}`);
    els.degreesStatusBadge.textContent = text;
  }

  function updateDegreeMetrics(extra = {}) {
    els.degreeVisited.textContent = String(extra.visited ?? state.degreeVisited);
    els.degreeRequests.textContent = String(state.degreeRequests);
    if (extra.depth !== undefined) els.degreeDepthMetric.textContent = String(extra.depth);
    if (state.degreeStartedAt) els.degreeTime.textContent = elapsedLabel(performance.now() - state.degreeStartedAt);
  }

  function degreeLog(lines) {
    els.degreeLog.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines);
  }

  function resetDegreeUi() {
    state.degreeRequests = 0;
    state.degreeVisited = 0;
    state.degreeStartedAt = performance.now();
    els.degreeDepthMetric.textContent = "0";
    els.degreeTime.textContent = "0ms";
    els.degreesPath.className = "degrees-path empty-path";
    els.degreesPath.innerHTML = `<div class="path-empty-mark">⌁</div><p>Wikidata上の接続を探索しています…</p>`;
    setDegreeStatus("running", "SEARCHING");
    updateDegreeMetrics();
  }

  async function getDegreeAdjacency(ids, runId) {
    const missing = ids.filter((id) => !state.degreeAdjCache.has(id));
    if (missing.length) {
      const entities = await getWikidataEntities(missing, "claims|labels|descriptions", {
        countDegreeRequest: true,
        degreeRunId: runId
      });
      for (const id of missing) {
        const entity = entities[id];
        const rels = entity ? collectEntityRelations(entity, DEGREE_BRANCH_LIMIT) : [];
        state.degreeAdjCache.set(id, rels);
      }
    }
    const map = new Map();
    ids.forEach((id) => map.set(id, state.degreeAdjCache.get(id) || []));
    return map;
  }

  async function expandDegreeFront({ frontier, visitedThis, parentThis, distThis, visitedOther, distOther, runId, maxDepth }) {
    if (!frontier.size) return { next: new Set(), meet: null };
    const ids = [...frontier];
    const adjacency = await getDegreeAdjacency(ids, runId);
    const next = new Set();
    let meet = null;

    for (const node of ids) {
      const baseDepth = distThis.get(node) || 0;
      if (baseDepth >= maxDepth) continue;
      for (const rel of adjacency.get(node) || []) {
        const neighbor = rel.targetId;
        const newDepth = baseDepth + 1;
        if (visitedThis.has(neighbor)) continue;
        visitedThis.add(neighbor);
        parentThis.set(neighbor, { prev: node, prop: rel.propertyId });
        distThis.set(neighbor, newDepth);
        next.add(neighbor);
        state.degreeVisited = new Set([...visitedThis, ...visitedOther]).size;
        if (state.degreeVisited > DEGREE_VISIT_LIMIT) throw new Error("訪問ノード上限に達したため探索を停止しました。");
        if (visitedOther.has(neighbor)) {
          const total = newDepth + (distOther.get(neighbor) || 0);
          if (total <= maxDepth) {
            meet = neighbor;
            return { next, meet };
          }
        }
      }
    }
    return { next, meet };
  }

  function reconstructDegreePath(meet, source, target, parentF, parentB) {
    const forward = [];
    let cur = meet;
    while (cur) {
      forward.push(cur);
      if (cur === source) break;
      cur = parentF.get(cur)?.prev || null;
    }
    forward.reverse();
    if (forward[0] !== source) return null;

    const nodes = [...forward];
    const edges = [];
    for (let i = 1; i < forward.length; i += 1) edges.push(parentF.get(forward[i])?.prop || "");

    cur = meet;
    while (cur !== target) {
      const rec = parentB.get(cur);
      if (!rec?.prev) return null;
      edges.push(rec.prop || "");
      cur = rec.prev;
      nodes.push(cur);
    }
    return { nodes, edges };
  }

  async function findDegreePath(source, target, maxDepth, runId) {
    if (source === target) return { nodes: [source], edges: [] };

    const visitedF = new Set([source]);
    const visitedB = new Set([target]);
    const parentF = new Map([[source, null]]);
    const parentB = new Map([[target, null]]);
    const distF = new Map([[source, 0]]);
    const distB = new Map([[target, 0]]);
    let frontF = new Set([source]);
    let frontB = new Set([target]);
    let layerF = 0;
    let layerB = 0;
    state.degreeVisited = 2;
    updateDegreeMetrics({ depth: 0 });

    for (let iteration = 0; iteration < maxDepth * 2 + 2; iteration += 1) {
      if (runId !== state.degreeRunId) throw new Error("探索が更新されました。");
      if (!frontF.size || !frontB.size) break;
      if (layerF + layerB >= maxDepth) break;

      const canF = layerF < maxDepth;
      const canB = layerB < maxDepth;
      const expandForward = canF && (!canB || frontF.size <= frontB.size);

      degreeLog([
        `FROM frontier : ${frontF.size} nodes / depth ${layerF}`,
        `TO frontier   : ${frontB.size} nodes / depth ${layerB}`,
        `Visited       : ${state.degreeVisited} / ${DEGREE_VISIT_LIMIT}`,
        `Expanding     : ${expandForward ? "START SIDE" : "TARGET SIDE"}`
      ]);

      if (expandForward) {
        const result = await expandDegreeFront({
          frontier: frontF, visitedThis: visitedF, parentThis: parentF, distThis: distF,
          visitedOther: visitedB, distOther: distB, runId, maxDepth
        });
        frontF = result.next;
        layerF += 1;
        updateDegreeMetrics({ depth: layerF + layerB });
        if (result.meet) return reconstructDegreePath(result.meet, source, target, parentF, parentB);
      } else {
        const result = await expandDegreeFront({
          frontier: frontB, visitedThis: visitedB, parentThis: parentB, distThis: distB,
          visitedOther: visitedF, distOther: distF, runId, maxDepth
        });
        frontB = result.next;
        layerB += 1;
        updateDegreeMetrics({ depth: layerF + layerB });
        if (result.meet) return reconstructDegreePath(result.meet, source, target, parentF, parentB);
      }
    }
    return null;
  }

  async function renderDegreePath(path, runId) {
    const allIds = [...path.nodes, ...path.edges.filter(Boolean)];
    const labels = await getWikidataEntities(allIds, "labels|descriptions", {
      countDegreeRequest: true,
      degreeRunId: runId
    });
    const pieces = [];
    path.nodes.forEach((id, i) => {
      const entity = labels[id];
      pieces.push(`<article class="path-node"><span class="path-qid">${escapeHtml(id)}</span><strong>${escapeHtml(pickLabel(entity) || id)}</strong><small>${escapeHtml(truncate(pickDescription(entity) || "Wikidata entity", 76))}</small></article>`);
      if (i < path.edges.length) {
        const prop = path.edges[i];
        pieces.push(`<div class="path-edge">${escapeHtml(pickLabel(labels[prop]) || prop || "RELATED")}</div>`);
      }
    });
    const cols = path.nodes.length + path.edges.length;
    els.degreesPath.className = "degrees-path";
    els.degreesPath.innerHTML = `<div class="path-chain" style="grid-template-columns:${Array.from({ length: cols }, (_, i) => i % 2 === 0 ? "minmax(150px,1fr)" : "110px").join(" ")}">${pieces.join("")}</div>`;
  }

  async function runDegrees(rawFrom, rawTo) {
    const from = String(rawFrom || "").trim();
    const to = String(rawTo || "").trim();
    const maxDepth = Math.min(5, Math.max(2, Number(els.degreesDepth.value) || 4));
    if (!from || !to) return;

    activateMode("degrees", false);
    const runId = ++state.degreeRunId;
    resetDegreeUi();
    els.degreesSubmit.disabled = true;
    setSourceState("wikidata", "loading");
    syncUrl();

    try {
      degreeLog([`Resolving: ${from}`, `Resolving: ${to}`]);
      state.degreeRequests += 2;
      updateDegreeMetrics();
      const [fromHit, toHit] = await Promise.all([resolveWikidata(from), resolveWikidata(to)]);
      if (runId !== state.degreeRunId) return;
      degreeLog([
        `START  ${fromHit.label || from} → ${fromHit.id}`,
        `TARGET ${toHit.label || to} → ${toHit.id}`,
        `Searching up to ${maxDepth} hops…`
      ]);
      const path = await findDegreePath(fromHit.id, toHit.id, maxDepth, runId);
      if (runId !== state.degreeRunId) return;
      if (!path) {
        setDegreeStatus("miss", "NO PATH");
        setSourceState("wikidata", "ok");
        degreeLog([
          `No connection found within ${maxDepth} hops and current safety limits.`,
          `Visited ${state.degreeVisited} entities / ${state.degreeRequests} API requests.`,
          `Try MAX DEPTH ${Math.min(5, maxDepth + 1)} or a more specific entity name.`
        ]);
        els.degreesPath.className = "degrees-path empty-path";
        els.degreesPath.innerHTML = `<div class="path-empty-mark">×</div><p>指定した探索範囲では接続経路を確認できませんでした。<br>「関係がない」という意味ではありません。</p>`;
      } else {
        await renderDegreePath(path, runId);
        const hops = Math.max(0, path.nodes.length - 1);
        setDegreeStatus("found", `${hops} HOPS`);
        setSourceState("wikidata", "ok");
        els.degreeDepthMetric.textContent = String(hops);
        degreeLog([
          `Connection found: ${hops} hops.`,
          `Visited ${state.degreeVisited} entities.`,
          `Path is based on Wikidata claims; connectors are displayed as neutral relationships.`
        ]);
      }
    } catch (error) {
      if (runId !== state.degreeRunId) return;
      console.error("[Six Degrees]", error);
      setDegreeStatus("miss", "STOPPED");
      setSourceState("wikidata", "error");
      degreeLog(error.message || String(error));
      els.degreesPath.className = "degrees-path empty-path";
      els.degreesPath.innerHTML = `<div class="path-empty-mark">!</div><p>${escapeHtml(error.message || String(error))}</p>`;
    } finally {
      if (runId === state.degreeRunId) {
        els.degreesSubmit.disabled = false;
        els.degreeTime.textContent = elapsedLabel(performance.now() - state.degreeStartedAt);
        updateDegreeMetrics();
      }
    }
  }

  // ---------- Events / boot ----------
  els.universeForm.addEventListener("submit", (e) => { e.preventDefault(); runUniverse(els.universeInput.value); });
  $$('[data-universe-example]').forEach((button) => button.addEventListener("click", () => runUniverse(button.dataset.universeExample)));
  els.rabbitForm.addEventListener("submit", (e) => { e.preventDefault(); startRabbit(els.rabbitInput.value); });
  els.rabbitReset.addEventListener("click", () => startRabbit(els.rabbitInput.value || state.rabbitStartQuery));
  els.degreesForm.addEventListener("submit", (e) => { e.preventDefault(); runDegrees(els.degreesFrom.value, els.degreesTo.value); });

  function boot() {
    renderRecentSearches();
    renderRabbitTrail();
    drawRabbitGraph("RABBIT HOLE", []);
    drawUniverseGraph("LOADING", []);

    const params = new URLSearchParams(location.search);
    const mode = params.get("mode") || "universe";
    const q = params.get("q") || els.universeInput.value || "ブラックホール";
    const rabbit = params.get("rabbit");
    const from = params.get("from");
    const to = params.get("to");
    if (from) els.degreesFrom.value = from;
    if (to) els.degreesTo.value = to;

    if (mode === "rabbit") {
      activateMode("rabbit", false);
      startRabbit(rabbit || els.rabbitInput.value);
    } else if (mode === "degrees") {
      activateMode("degrees", false);
      syncUrl();
    } else {
      activateMode("universe", false);
      runUniverse(q);
    }
  }

  boot();
})();
