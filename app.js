(() => {
  const meta = window.G6_META || {};
  const rawBooks = Array.isArray(window.G6_BOOKS) ? window.G6_BOOKS : [];
  const ddc = window.G6_DDC || { classes: {}, divisions: {}, sections: {} };
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const ddcClassNames = {
    "000": "Computing & info",
    "100": "Philosophy",
    "200": "Religion",
    "300": "Social sciences",
    "400": "Language",
    "500": "Science",
    "600": "Technology",
    "700": "Arts",
    "800": "Literature",
    "900": "History",
  };
  const collectionOrder = [
    "Juvenile",
    "Teen",
    "Fiction",
    "Nonfiction",
    "Graphic novels",
    "Romance",
    "Biography",
    "Spanish",
    "Chinese",
    "Other",
  ];

  const state = {
    query: "",
    collection: "all",
    ddcClass: "all",
    ddcDivision: "all",
    ddcSection: "all",
    expandedGroups: new Set(),
    sort: "call",
    page: 1,
    perPage: 100,
  };

  const elements = {
    stats: document.getElementById("stats"),
    snapshotDate: document.getElementById("snapshot-date"),
    search: document.getElementById("search"),
    searchClear: document.getElementById("search-clear"),
    collectionChips: document.getElementById("collection-chips"),
    ddcBar: document.getElementById("ddc-bar"),
    ddcClasses: document.getElementById("ddc-classes"),
    ddcDivisions: document.getElementById("ddc-divisions"),
    sort: document.getElementById("sort"),
    perPage: document.getElementById("per-page"),
    reset: document.getElementById("reset"),
    share: document.getElementById("share"),
    exportButton: document.getElementById("export"),
    resultCount: document.getElementById("result-count"),
    activeFilters: document.getElementById("active-filters"),
    rows: document.getElementById("rows"),
    empty: document.getElementById("empty"),
    pagination: document.getElementById("pagination"),
    tableScroll: document.querySelector(".table-scroll"),
    aboutGenerated: document.getElementById("about-generated"),
    toTop: document.getElementById("to-top"),
    toast: document.getElementById("toast"),
  };

  let books = [];
  let filtered = [];

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }

  function collectionOf(call) {
    const value = String(call || "").trim().toUpperCase();
    if (value.startsWith("TEEN")) return "Teen";
    if (value.startsWith("J")) return "Juvenile";
    if (value.startsWith("GN")) return "Graphic novels";
    if (value.startsWith("RO ")) return "Romance";
    if (value.startsWith("SPANISH")) return "Spanish";
    if (value.startsWith("CHINESE")) return "Chinese";
    if (value.startsWith("F ")) return "Fiction";
    if (/^\d/.test(value)) return "Nonfiction";
    if (value.startsWith("B ")) return "Biography";
    return "Other";
  }

  function collectionClass(collection) {
    return "pill-" + collection.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function titleSortKey(value) {
    return String(value || "").replace(/^(the|a|an)\s+/i, "");
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value + "T12:00:00");
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function ddcCodeOf(call) {
    let value = String(call || "").trim();
    for (let i = 0; i < 4; i += 1) {
      const before = value;
      value = value.replace(
        /^(?:SPANISH|CHINESE|TEEN|JUV|REF|YA|GN|RO|FRENCH|ARABIC|RUSSIAN|VIETNAMESE|KOREAN|JAPANESE|PORTUGUESE|ITALIAN|GERMAN|HINDI|TAGALOG|BENGALI|URDU|PERSIAN|HEBREW|POLISH|SOMALI|AMHARIC|TURKISH|GREEK)\s+/i,
        ""
      );
      value = value.replace(/^Hi-Lo\s+/i, "");
      value = value.replace(
        /^J\s+(?=(?:REF|SPANISH|CHINESE|TEEN|JUV|YA)\b)/i,
        ""
      );
      value = value.replace(/^J\s*(?=\d)/i, "");
      value = value.replace(/^j?GN\s*(?=\d)/i, "");
      if (value === before) break;
    }
    const match = value.match(/^(\d{3})(?:\.\d+)?/);
    if (!match || !ddc.sections[match[1]]) return "";
    return match[1];
  }

  function ddcForCall(call) {
    const code = ddcCodeOf(call);
    if (!code) return null;
    const classCode = code[0] + "00";
    const divisionCode = code.slice(0, 2) + "0";
    const classLabel = ddc.classes[classCode] || "";
    const divisionLabel = ddc.divisions[divisionCode] || "";
    const rawSection = ddc.sections[code] || "";
    const unassigned = !rawSection || rawSection === "[Unassigned]";
    const sectionLabel = unassigned
      ? (divisionLabel || classLabel || "Unassigned") + " (unassigned number)"
      : rawSection;
    return {
      code,
      classCode,
      divisionCode,
      classLabel,
      divisionLabel,
      sectionLabel,
      unassigned,
    };
  }

  function prepareBooks() {
    return rawBooks.map((book) => {
      const collection = collectionOf(book.call);
      const ddcInfo = ddcForCall(book.call);
      const searchText = normalize(
        [
          book.title,
          book.author,
          book.call,
          book.catalogCall,
          book.year,
          collection,
          ddcInfo ? ddcInfo.code : "",
          ddcInfo ? ddcInfo.classLabel : "",
          ddcInfo ? ddcInfo.divisionLabel : "",
          ddcInfo ? ddcInfo.sectionLabel : "",
        ].join(" ")
      );
      return {
        ...book,
        collection,
        ddc: ddcInfo,
        ddcCode: ddcInfo ? ddcInfo.code : "",
        ddcClass: ddcInfo ? ddcInfo.classCode : "",
        ddcDivision: ddcInfo ? ddcInfo.divisionCode : "",
        searchText,
        yearNumber: Number(book.year) || 0,
        copiesNumber: Number(book.copies) || 0,
      };
    });
  }

  function statCard(value, label) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const strong = document.createElement("span");
    strong.className = "stat-value";
    strong.textContent = Number(value || 0).toLocaleString();
    const small = document.createElement("span");
    small.className = "stat-label";
    small.textContent = label;
    card.append(strong, small);
    return card;
  }

  function renderMeta() {
    elements.snapshotDate.textContent = formatDate(meta.generated);
    const collectionCount = Object.keys(meta.collections || {}).length;
    const values = [
      [meta.total || books.length, "titles"],
      [collectionCount, "collections"],
      [meta.uniqueCalls || new Set(books.map((book) => book.call)).size, "call numbers"],
      [meta.withAuthor || books.filter((book) => book.author).length, "with author"],
    ];
    const fragment = document.createDocumentFragment();
    values.forEach(([value, label]) => fragment.append(statCard(value, label)));
    elements.stats.replaceChildren(fragment);
    elements.aboutGenerated.textContent =
      "Snapshot generated " + formatDate(meta.generated) + " from the public SFPL catalog.";
  }

  function renderCollectionChips(counts) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const known = Array.from(new Set([...collectionOrder, ...Object.keys(counts)]));
    const names = known.filter(
      (name) => counts[name] > 0 || name === state.collection
    );
    const items = [{ value: "all", label: "All", count: total }].concat(
      names.map((name) => ({ value: name, label: name, count: counts[name] || 0 }))
    );
    elements.collectionChips.innerHTML = items
      .map((item) => {
        const active = item.value === state.collection;
        return `<button class="filter-chip${active ? " is-active" : ""}" type="button" data-collection="${escapeHTML(item.value)}" aria-pressed="${active}">${escapeHTML(item.label)}<span class="count">${item.count.toLocaleString()}</span></button>`;
      })
      .join("");
  }

  function renderDdcChips(source) {
    const classCounts = {};
    let total = 0;
    source.forEach((book) => {
      if (!book.ddc) return;
      total += 1;
      classCounts[book.ddc.classCode] = (classCounts[book.ddc.classCode] || 0) + 1;
    });
    const hasDdcFilter =
      state.ddcClass !== "all" ||
      state.ddcDivision !== "all" ||
      state.ddcSection !== "all";
    elements.ddcBar.hidden = total === 0 && !hasDdcFilter;
    if (elements.ddcBar.hidden) return;

    const classItems = [{ value: "all", label: "All Dewey", count: total }].concat(
      Object.keys(ddc.classes).map((code) => ({
        value: code,
        label: code + " " + (ddcClassNames[code] || ddc.classes[code]),
        title: ddc.classes[code],
        count: classCounts[code] || 0,
      }))
    );
    elements.ddcClasses.innerHTML = classItems
      .map((item) => {
        const active = item.value === state.ddcClass;
        return `<button class="filter-chip${active ? " is-active" : ""}" type="button" data-ddc-class="${escapeHTML(item.value)}" aria-pressed="${active}"${item.title ? ` title="${escapeHTML(item.title)}"` : ""}>${escapeHTML(item.label)}<span class="count">${item.count.toLocaleString()}</span></button>`;
      })
      .join("");

    if (state.ddcClass === "all") {
      elements.ddcDivisions.hidden = true;
      elements.ddcDivisions.replaceChildren();
      return;
    }

    const divisionCounts = {};
    source.forEach((book) => {
      if (!book.ddc || book.ddc.classCode !== state.ddcClass) return;
      divisionCounts[book.ddc.divisionCode] =
        (divisionCounts[book.ddc.divisionCode] || 0) + 1;
    });
    const classCount = classCounts[state.ddcClass] || 0;
    const divisionItems = [
      {
        value: "all",
        label: "All " + (ddcClassNames[state.ddcClass] || state.ddcClass),
        count: classCount,
      },
    ];
    Object.keys(ddc.divisions)
      .filter((code) => code[0] === state.ddcClass[0])
      .forEach((code) => {
        const count = divisionCounts[code] || 0;
        if (count === 0 && state.ddcDivision !== code) return;
        divisionItems.push({
          value: code,
          label: code + " " + ddc.divisions[code],
          title: ddc.divisions[code],
          count,
        });
      });
    elements.ddcDivisions.hidden = false;
    elements.ddcDivisions.innerHTML = divisionItems
      .map((item) => {
        const active = item.value === state.ddcDivision;
        return `<button class="filter-chip${active ? " is-active" : ""}" type="button" data-ddc-division="${escapeHTML(item.value)}" aria-pressed="${active}"${item.title ? ` title="${escapeHTML(item.title)}"` : ""}>${escapeHTML(item.label)}<span class="count">${item.count.toLocaleString()}</span></button>`;
      })
      .join("");
  }

  function compareBooks(a, b) {
    switch (state.sort) {
      case "title":
        return (
          collator.compare(titleSortKey(a.title), titleSortKey(b.title)) ||
          collator.compare(a.call, b.call)
        );
      case "ddc":
        if (!a.ddcCode && !b.ddcCode) {
          return (
            collator.compare(a.call, b.call) ||
            collator.compare(a.title, b.title)
          );
        }
        if (!a.ddcCode) return 1;
        if (!b.ddcCode) return -1;
        return (
          collator.compare(a.ddcCode, b.ddcCode) ||
          collator.compare(a.call, b.call) ||
          collator.compare(a.title, b.title)
        );
      case "author":
        if (!a.author && !b.author) return collator.compare(a.call, b.call);
        if (!a.author) return 1;
        if (!b.author) return -1;
        return collator.compare(a.author, b.author) || collator.compare(a.call, b.call);
      case "year-desc":
        if (!a.yearNumber && !b.yearNumber) return collator.compare(a.call, b.call);
        if (!a.yearNumber) return 1;
        if (!b.yearNumber) return -1;
        return b.yearNumber - a.yearNumber || collator.compare(a.call, b.call);
      case "year-asc":
        if (!a.yearNumber && !b.yearNumber) return collator.compare(a.call, b.call);
        if (!a.yearNumber) return 1;
        if (!b.yearNumber) return -1;
        return a.yearNumber - b.yearNumber || collator.compare(a.call, b.call);
      case "copies":
        return (
          b.copiesNumber - a.copiesNumber ||
          collator.compare(a.call, b.call) ||
          collator.compare(a.title, b.title)
        );
      default:
        return collator.compare(a.call, b.call) || collator.compare(a.title, b.title);
    }
  }

  function totalPages() {
    return Math.max(1, Math.ceil(filtered.length / state.perPage));
  }

  function pageItems(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }
    const pages = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 3) {
      [2, 3, 4].forEach((page) => pages.add(page));
    }
    if (current >= total - 2) {
      [total - 3, total - 2, total - 1].forEach((page) => pages.add(page));
    }
    const sorted = Array.from(pages)
      .filter((page) => page >= 1 && page <= total)
      .sort((a, b) => a - b);
    const output = [];
    let previous = 0;
    sorted.forEach((page) => {
      if (page - previous > 1) output.push("…");
      output.push(page);
      previous = page;
    });
    return output;
  }

  function catalogURL(book) {
    const query = [book.title, book.author].filter(Boolean).join(" ");
    return (
      "https://sfpl.bibliocommons.com/v2/search?query=" +
      encodeURIComponent(query) +
      "&searchType=keyword"
    );
  }

  function rowHTML(book, groupKey = "", expanded = true) {
    const author = book.author
      ? escapeHTML(book.author)
      : '<span class="author-empty">No author listed</span>';
    const year = book.year ? escapeHTML(book.year) : "—";
    const copiesLabel = book.copiesNumber === 1 ? "copy" : "copies";
    const catalogCall =
      book.catalogCall && book.catalogCall.toLowerCase() !== book.call.toLowerCase()
        ? '<span class="catalog-call">Catalog: ' + escapeHTML(book.catalogCall) + "</span>"
        : "";
    const ddcLabel = book.ddc
      ? `<button class="ddc-link" type="button" data-ddc="${escapeHTML(book.ddc.code)}" title="Dewey ${escapeHTML(book.ddc.code)}: ${escapeHTML(book.ddc.sectionLabel)}. Filter to this number."><span class="ddc-code">${escapeHTML(book.ddc.code)}</span> · ${escapeHTML(book.ddc.sectionLabel)}</button>`
      : "";
    return `
      <tr class="book-row"${groupKey ? ` data-ddc-group="${escapeHTML(groupKey)}"` : ""}${groupKey && !expanded ? " hidden" : ""}>
        <td class="cell-call" data-label="Call number">
          <div class="call-wrap">
            <span class="call-text">${escapeHTML(book.call)}</span>
            <button class="copy-btn" type="button" data-copy="${escapeHTML(book.call)}" aria-label="Copy call number ${escapeHTML(book.call)}" title="Copy call number">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>
            </button>
          </div>
          ${ddcLabel}
          ${catalogCall}
        </td>
        <td class="cell-title" data-label="Title"><a class="title-link" href="${escapeHTML(catalogURL(book))}" target="_blank" rel="noopener" aria-label="Open catalog search for ${escapeHTML(book.title)}">${escapeHTML(book.title)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"></path><path d="m20 4-9 9"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg></a></td>
        <td class="cell-author" data-label="Author">${author}</td>
        <td class="cell-year" data-label="Year">${year}</td>
        <td class="cell-collection" data-label="Collection"><span class="pill ${collectionClass(book.collection)}">${escapeHTML(book.collection)}</span></td>
        <td class="cell-copies" data-label="Copies listed"><span class="copies" title="All copy rows shown for this title, including copies that may be checked out"><strong>${book.copiesNumber}</strong> ${copiesLabel}</span></td>
      </tr>`;
  }

  function ddcGroupRowHTML(book, count, expanded) {
    const isOther = !book.ddc;
    const key = book.ddcCode || "other";
    const label = isOther
      ? "Other call numbers"
      : `${book.ddc.code} · ${book.ddc.sectionLabel}`;
    const kicker = isOther ? "Non-Dewey" : "Dewey section";
    const countLabel = count === 1 ? "title" : "titles";
    return `<tr class="group-row"><th colspan="6" scope="colgroup"><button class="group-toggle" type="button" data-group-toggle="${escapeHTML(key)}" aria-expanded="${expanded}"><span class="group-caret" aria-hidden="true"></span><span class="group-kicker">${kicker}</span><span class="group-title">${escapeHTML(label)}</span><span class="group-count">${count.toLocaleString()} ${countLabel}</span></button></th></tr>`;
  }

  function renderRows() {
    const pages = totalPages();
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * state.perPage;
    const end = Math.min(start + state.perPage, filtered.length);
    const current = filtered.slice(start, end);
    const grouped = state.sort === "ddc";
    let groupCounts = null;
    if (grouped) {
      groupCounts = new Map();
      filtered.forEach((book) => {
        const key = book.ddcCode || "other";
        groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
      });
    }
    let lastGroup = null;
    elements.rows.innerHTML = current
      .map((book) => {
        const groupKey = grouped ? book.ddcCode || "other" : "";
        const expanded = grouped ? state.expandedGroups.has(groupKey) : true;
        const groupRow =
          grouped && groupKey !== lastGroup
            ? ddcGroupRowHTML(book, groupCounts.get(groupKey), expanded)
            : "";
        lastGroup = groupKey;
        return groupRow + rowHTML(book, groupKey, expanded);
      })
      .join("");
    elements.resultCount.innerHTML = filtered.length
      ? `Showing <strong>${(start + 1).toLocaleString()}–${end.toLocaleString()}</strong> of <strong>${filtered.length.toLocaleString()}</strong> titles`
      : "No titles match the current filters.";
    elements.empty.hidden = filtered.length > 0;
    elements.tableScroll.hidden = filtered.length === 0;
    elements.pagination.hidden = filtered.length === 0;
  }

  function renderPagination() {
    const pages = totalPages();
    if (filtered.length === 0) {
      elements.pagination.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    const previous = document.createElement("button");
    previous.className = "page-btn";
    previous.type = "button";
    previous.textContent = "‹";
    previous.dataset.page = String(state.page - 1);
    previous.setAttribute("aria-label", "Previous page");
    previous.disabled = state.page === 1;
    fragment.append(previous);

    pageItems(state.page, pages).forEach((item) => {
      if (item === "…") {
        const span = document.createElement("span");
        span.className = "page-ellipsis";
        span.textContent = "…";
        fragment.append(span);
        return;
      }
      const button = document.createElement("button");
      button.className = "page-btn" + (item === state.page ? " is-current" : "");
      button.type = "button";
      button.textContent = String(item);
      button.dataset.page = String(item);
      button.setAttribute("aria-label", "Page " + item);
      if (item === state.page) button.setAttribute("aria-current", "page");
      fragment.append(button);
    });

    const next = document.createElement("button");
    next.className = "page-btn";
    next.type = "button";
    next.textContent = "›";
    next.dataset.page = String(state.page + 1);
    next.setAttribute("aria-label", "Next page");
    next.disabled = state.page === pages;
    fragment.append(next);
    elements.pagination.replaceChildren(fragment);
  }

  function ddcFilterChip() {
    if (state.ddcSection !== "all") {
      const code = state.ddcSection;
      const section = ddc.sections[code] || "";
      const division = ddc.divisions[code.slice(0, 2) + "0"] || "";
      const label =
        section && section !== "[Unassigned]"
          ? section
          : division + " (unassigned number)";
      return { key: "ddc", label: "Dewey", value: code + " · " + label };
    }
    if (state.ddcDivision !== "all") {
      return {
        key: "ddc",
        label: "Dewey",
        value: state.ddcDivision + " · " + (ddc.divisions[state.ddcDivision] || ""),
      };
    }
    if (state.ddcClass !== "all") {
      return {
        key: "ddc",
        label: "Dewey",
        value: state.ddcClass + " · " + (ddc.classes[state.ddcClass] || ""),
      };
    }
    return null;
  }

  function renderActiveFilters() {
    const chips = [];
    if (state.query.trim()) {
      chips.push({ key: "query", label: "Search", value: state.query.trim() });
    }
    if (state.collection !== "all") {
      chips.push({ key: "collection", label: "Collection", value: state.collection });
    }
    const ddcChip = ddcFilterChip();
    if (ddcChip) chips.push(ddcChip);
    if (!chips.length) {
      elements.activeFilters.replaceChildren();
      return;
    }
    elements.activeFilters.innerHTML = chips
      .map(
        (chip) =>
          `<span class="chip"><span>${escapeHTML(chip.label)}:</span> <strong>${escapeHTML(chip.value)}</strong><button type="button" data-clear="${chip.key}" aria-label="Remove ${escapeHTML(chip.label)} filter">×</button></span>`
      )
      .join("");
  }

  function render() {
    renderRows();
    renderPagination();
    renderActiveFilters();
  }

  function apply(resetPage = true) {
    const tokens = normalize(state.query).split(/\s+/).filter(Boolean);
    const queryFiltered = books.filter((book) =>
      tokens.every((token) => book.searchText.includes(token))
    );
    const counts = {};
    queryFiltered.forEach((book) => {
      counts[book.collection] = (counts[book.collection] || 0) + 1;
    });
    renderCollectionChips(counts);
    const base =
      state.collection === "all"
        ? queryFiltered
        : queryFiltered.filter((book) => book.collection === state.collection);
    renderDdcChips(base);
    filtered = base.filter((book) => {
      if (state.ddcClass !== "all" && book.ddcClass !== state.ddcClass) return false;
      if (state.ddcDivision !== "all" && book.ddcDivision !== state.ddcDivision) {
        return false;
      }
      if (state.ddcSection !== "all" && book.ddcCode !== state.ddcSection) {
        return false;
      }
      return true;
    });
    filtered.sort(compareBooks);
    if (resetPage) state.page = 1;
    render();
    syncURL();
  }

  function syncURL() {
    const params = new URLSearchParams();
    if (state.query.trim()) params.set("q", state.query.trim());
    if (state.collection !== "all") params.set("c", state.collection);
    if (state.ddcClass !== "all") params.set("dc", state.ddcClass);
    if (state.ddcDivision !== "all") params.set("dd", state.ddcDivision);
    if (state.ddcSection !== "all") params.set("ds", state.ddcSection);
    if (state.sort !== "call") params.set("sort", state.sort);
    if (state.perPage !== 100) params.set("n", String(state.perPage));
    if (state.page > 1) params.set("p", String(state.page));
    const query = params.toString();
    const base = location.href.split("#")[0].split("?")[0];
    try {
      history.replaceState(null, "", query ? base + "?" + query : base);
    } catch (error) {
      return;
    }
  }

  function readURL() {
    const params = new URLSearchParams(location.search);
    const query = params.get("q");
    const collection = params.get("c");
    const ddcClass = params.get("dc");
    const ddcDivision = params.get("dd");
    const ddcSection = params.get("ds");
    const sort = params.get("sort");
    const perPage = params.get("n");
    const page = params.get("p");
    if (query) state.query = query;
    if (collection && (collection === "all" || meta.collections?.[collection])) {
      state.collection = collection;
    }
    if (ddcSection && ddc.sections[ddcSection]) {
      state.ddcSection = ddcSection;
      state.ddcClass = ddcSection[0] + "00";
      state.ddcDivision = ddcSection.slice(0, 2) + "0";
    } else {
      if (ddcClass && ddc.classes[ddcClass]) state.ddcClass = ddcClass;
      if (ddcDivision && ddc.divisions[ddcDivision]) {
        if (state.ddcClass === "all") state.ddcClass = ddcDivision[0] + "00";
        if (ddcDivision[0] === state.ddcClass[0]) state.ddcDivision = ddcDivision;
      }
    }
    if (["call", "ddc", "title", "author", "year-desc", "year-asc", "copies"].includes(sort)) {
      state.sort = sort;
    }
    if (["50", "100", "200"].includes(perPage)) {
      state.perPage = Number(perPage);
    }
    if (page && Number(page) > 0) {
      state.page = Number(page);
    }
    elements.search.value = state.query;
    elements.sort.value = state.sort;
    elements.perPage.value = String(state.perPage);
    updateSearchClear();
  }

  function resetFilters() {
    state.query = "";
    state.collection = "all";
    state.ddcClass = "all";
    state.ddcDivision = "all";
    state.ddcSection = "all";
    state.expandedGroups.clear();
    state.sort = "call";
    state.page = 1;
    state.perPage = 100;
    elements.search.value = "";
    elements.sort.value = "call";
    elements.perPage.value = "100";
    updateSearchClear();
    apply();
    elements.search.focus();
  }

  function updateSearchClear() {
    elements.searchClear.hidden = !elements.search.value;
  }

  function toast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    window.clearTimeout(toast.timeout);
    toast.timeout = window.setTimeout(() => {
      elements.toast.classList.remove("is-visible");
    }, 1800);
  }

  async function copyText(text, successMessage) {
    const message = successMessage || "Copied “" + text + "”";
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
        toast(message);
      } catch (fallbackError) {
        toast("Could not copy");
      }
      area.remove();
    }
  }

  function csvCell(value) {
    const text = String(value == null ? "" : value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function exportCSV() {
    const header = [
      "title",
      "author",
      "call_number",
      "catalog_call_number",
      "ddc_code",
      "ddc_class",
      "ddc_division",
      "ddc_section",
      "format",
      "availability",
      "copies_listed_at_branch",
      "branch",
      "year",
      "metadata_source",
    ];
    const lines = [header.map(csvCell).join(",")];
    filtered.forEach((book) => {
      lines.push(
        [
          book.title,
          book.author,
          book.call,
          book.catalogCall,
          book.ddcCode,
          book.ddc ? book.ddc.classLabel : "",
          book.ddc ? book.ddc.divisionLabel : "",
          book.ddc ? book.ddc.sectionLabel : "",
          book.format,
          "AT_LEAST_ONE_COPY_AVAILABLE_AT_BRANCH",
          book.copies,
          meta.branch || "Golden Gate Valley",
          book.year,
          book.source,
        ]
          .map(csvCell)
          .join(",")
      );
    });
    const blob = new Blob([lines.join("\r\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "sfpl-g6-filtered-" + (meta.generated || "snapshot") + ".csv";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("Downloaded " + filtered.length.toLocaleString() + " rows");
  }

  function scrollToTable() {
    elements.tableScroll.scrollTop = 0;
    document.querySelector(".table-card")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function bindEvents() {
    let searchTimer;
    elements.search.addEventListener("input", () => {
      updateSearchClear();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.query = elements.search.value;
        apply();
      }, 120);
    });

    elements.searchClear.addEventListener("click", () => {
      elements.search.value = "";
      state.query = "";
      updateSearchClear();
      apply();
      elements.search.focus();
    });

    elements.collectionChips.addEventListener("click", (event) => {
      const button = event.target.closest("[data-collection]");
      if (!button) return;
      state.collection = button.dataset.collection;
      apply();
      const next = Array.from(
        elements.collectionChips.querySelectorAll("[data-collection]")
      ).find((chip) => chip.dataset.collection === state.collection);
      if (next) next.focus({ preventScroll: true });
    });

    elements.ddcClasses.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ddc-class]");
      if (!button) return;
      state.ddcClass = button.dataset.ddcClass;
      state.ddcDivision = "all";
      state.ddcSection = "all";
      apply();
      const next = Array.from(
        elements.ddcClasses.querySelectorAll("[data-ddc-class]")
      ).find((chip) => chip.dataset.ddcClass === state.ddcClass);
      if (next) next.focus({ preventScroll: true });
    });

    elements.ddcDivisions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ddc-division]");
      if (!button) return;
      state.ddcDivision = button.dataset.ddcDivision;
      state.ddcSection = "all";
      apply();
      const next = Array.from(
        elements.ddcDivisions.querySelectorAll("[data-ddc-division]")
      ).find((chip) => chip.dataset.ddcDivision === state.ddcDivision);
      if (next) next.focus({ preventScroll: true });
    });

    elements.sort.addEventListener("change", () => {
      state.sort = elements.sort.value;
      apply();
    });

    elements.perPage.addEventListener("change", () => {
      state.perPage = Number(elements.perPage.value);
      apply();
    });

    elements.reset.addEventListener("click", resetFilters);
    elements.empty.addEventListener("click", (event) => {
      if (event.target.closest("[data-reset]")) resetFilters();
    });
    elements.share.addEventListener("click", () =>
      copyText(location.href, "Filtered view link copied")
    );
    elements.exportButton.addEventListener("click", exportCSV);
    elements.toTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    window.addEventListener(
      "scroll",
      () => {
        elements.toTop.hidden = window.scrollY < 700;
      },
      { passive: true }
    );
    elements.toTop.hidden = window.scrollY < 700;

    elements.activeFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-clear]");
      if (!button) return;
      const key = button.dataset.clear;
      if (key === "query") {
        state.query = "";
        elements.search.value = "";
        updateSearchClear();
      }
      if (key === "collection") {
        state.collection = "all";
      }
      if (key === "ddc") {
        state.ddcClass = "all";
        state.ddcDivision = "all";
        state.ddcSection = "all";
      }
      apply();
      if (key === "ddc") {
        const next = elements.ddcClasses.querySelector("[data-ddc-class]");
        if (next) next.focus();
      } else {
        elements.search.focus();
      }
    });

    elements.rows.addEventListener("click", (event) => {
      const groupToggle = event.target.closest("[data-group-toggle]");
      if (groupToggle) {
        const key = groupToggle.dataset.groupToggle;
        const expanded = groupToggle.getAttribute("aria-expanded") === "true";
        if (expanded) {
          state.expandedGroups.delete(key);
        } else {
          state.expandedGroups.add(key);
        }
        groupToggle.setAttribute("aria-expanded", String(!expanded));
        elements.rows
          .querySelectorAll(`[data-ddc-group="${key}"]`)
          .forEach((row) => {
            row.hidden = expanded;
          });
        return;
      }
      const ddcButton = event.target.closest("[data-ddc]");
      if (ddcButton) {
        const code = ddcButton.dataset.ddc;
        state.ddcClass = code[0] + "00";
        state.ddcDivision = code.slice(0, 2) + "0";
        state.ddcSection = code;
        apply();
        scrollToTable();
        return;
      }
      const button = event.target.closest("[data-copy]");
      if (button) copyText(button.dataset.copy);
    });

    elements.pagination.addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      const page = Number(button.dataset.page);
      if (page < 1 || page > totalPages() || page === state.page) return;
      state.page = page;
      render();
      syncURL();
      scrollToTable();
    });

    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        elements.search.focus();
        elements.search.select();
      }
      if (event.key === "Escape" && target === elements.search) {
        if (elements.search.value) {
          event.preventDefault();
          elements.search.value = "";
          state.query = "";
          updateSearchClear();
          apply();
        } else {
          elements.search.blur();
        }
      }
    });
  }

  function showLoadError() {
    elements.resultCount.textContent = "Could not load the shelf data.";
    elements.empty.hidden = false;
    elements.tableScroll.hidden = true;
    elements.pagination.hidden = true;
    elements.empty.querySelector(".empty-title").textContent = "Data file not found.";
    elements.empty.querySelector("p:not(.empty-title)").textContent =
      "Make sure data.js is next to index.html, then rebuild it with build_data.py.";
  }

  function init() {
    if (!rawBooks.length) {
      showLoadError();
      return;
    }
    books = prepareBooks();
    renderMeta();
    readURL();
    bindEvents();
    apply(false);
  }

  init();
})();
