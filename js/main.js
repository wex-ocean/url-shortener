/* Modern URL Shortener (Frontend-only)
   - Tailwind + jQuery + localStorage
   - Simulated auth (session)
   - Link CRUD, custom slugs, click tracking, expiry, enable/disable
   - Copy-to-clipboard + toast feedback
*/

(function ($) {
  "use strict";

  const LS_KEYS = {
    users: "shortly_users_v1",
    session: "shortly_session_v1",
    links: "shortly_links_v1",
    theme: "shortly_theme_v1",
  };

  const BASE_SHORT_DOMAIN = "https://sho.rt/"; // mock domain for display
  const RESERVED_SLUGS = new Set(["login", "dashboard", "shorten", "api", "admin", "settings"]);

  const state = {
    users: [],
    session: null, // { userId, email }
    links: [],
    filter: { query: "", status: "all" },
    activeModal: null,
    lastFocusEl: null,
    analyticsLinkId: null,
  };

  // ---------- Utilities ----------
  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  function readLS(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return safeJsonParse(raw, fallback);
  }

  function writeLS(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uid(prefix = "id") {
    // plenty for local usage
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function debounce(fn, waitMs) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), waitMs);
    };
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function toDatetimeLocalValue(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    // format: YYYY-MM-DDTHH:MM (local)
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function looksLikeScheme(url) {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url);
  }

  function normalizeUrl(input) {
    const raw = String(input || "").trim();
    if (!raw) return { ok: false, value: "", error: "Please enter a URL." };

    const withScheme = looksLikeScheme(raw) ? raw : `https://${raw}`;

    let u;
    try {
      u = new URL(withScheme);
    } catch {
      return { ok: false, value: "", error: "That doesn’t look like a valid URL." };
    }

    if (!["http:", "https:"].includes(u.protocol)) {
      return { ok: false, value: "", error: "Only http/https URLs are supported." };
    }

    return { ok: true, value: u.toString(), error: "" };
  }

  function sanitizeSlug(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw) return "";

    // allow a-z 0-9 - _
    let s = raw.replaceAll(" ", "-").replace(/[^a-z0-9\-_]/g, "");
    // collapse dashes
    s = s.replace(/-+/g, "-").replace(/_+/g, "_");
    // trim separators
    s = s.replace(/^[-_]+|[-_]+$/g, "");
    return s;
  }

  function isSlugValid(slug) {
    if (!slug) return { ok: false, error: "Slug is required." };
    if (slug.length < 3 || slug.length > 32) return { ok: false, error: "Slug must be 3–32 characters." };
    if (!/^[a-z0-9][a-z0-9\-_]*[a-z0-9]$/.test(slug) && slug.length > 1) {
      // enforce start/end alnum (helps avoid odd edges)
      return { ok: false, error: "Use letters, numbers, dashes, underscores." };
    }
    if (RESERVED_SLUGS.has(slug)) return { ok: false, error: "That slug is reserved." };
    return { ok: true, error: "" };
  }

  function randomSlug(len = 6) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < len; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  function isExpired(link) {
    if (!link.expiresAt) return false;
    const t = new Date(link.expiresAt).getTime();
    if (Number.isNaN(t)) return false;
    return Date.now() > t;
  }

  function computeStatus(link) {
    if (isExpired(link)) return "expired";
    if (!link.enabled) return "disabled";
    return "active";
  }

  function statusPill(status) {
    if (status === "active") {
      return { text: "Active", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200" };
    }
    if (status === "expired") {
      return { text: "Expired", cls: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" };
    }
    return { text: "Disabled", cls: "bg-slate-200 text-slate-800 dark:bg-slate-500/20 dark:text-slate-200" };
  }

  function getCurrentUserId() {
    return state.session?.userId || null;
  }

  function getShortUrl(slug) {
    return `${BASE_SHORT_DOMAIN}${slug}`;
  }

  function slugExists(slug, excludeLinkId = null) {
    const s = String(slug || "").toLowerCase();
    return state.links.some((l) => l.slug === s && l.id !== excludeLinkId);
  }

  function ensureAutoDisableExpired() {
    // Auto-disable expired links (persist)
    let changed = false;
    for (const l of state.links) {
      if (l.enabled && isExpired(l)) {
        l.enabled = false;
        changed = true;
      }
    }
    if (changed) persistLinks();
  }

  // ---------- Toast ----------
  function toast({ title, message = "", type = "info" }) {
    const host = $("#toastHost");
    const id = uid("toast");

    const colors = {
      info: "border-slate-200 dark:border-slate-800",
      success: "border-emerald-200 dark:border-emerald-900/50",
      error: "border-rose-200 dark:border-rose-900/50",
      warn: "border-amber-200 dark:border-amber-900/50",
    };

    const icon = {
      info: `<svg class="h-4 w-4 text-slate-600 dark:text-slate-300" viewBox="0 0 24 24" fill="none" aria-hidden="true">
               <path d="M12 22a10 10 0 110-20 10 10 0 010 20z" stroke="currentColor" stroke-width="2"/>
               <path d="M12 16v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
               <path d="M12 8h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
             </svg>`,
      success: `<svg class="h-4 w-4 text-emerald-700 dark:text-emerald-200" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>`,
      error: `<svg class="h-4 w-4 text-rose-700 dark:text-rose-200" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 9v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <path d="M12 17h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                <path d="M10.3 4.6h3.4L21 17.9a2 2 0 01-1.7 3.1H4.7A2 2 0 013 17.9L10.3 4.6z" stroke="currentColor" stroke-width="2"/>
              </svg>`,
      warn: `<svg class="h-4 w-4 text-amber-800 dark:text-amber-200" viewBox="0 0 24 24" fill="none" aria-hidden="true">
               <path d="M12 9v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
               <path d="M12 17h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
               <path d="M10.3 4.6h3.4L21 17.9a2 2 0 01-1.7 3.1H4.7A2 2 0 013 17.9L10.3 4.6z" stroke="currentColor" stroke-width="2"/>
             </svg>`,
    };

    const $el = $(`
      <div id="${id}" class="toast ${colors[type] || colors.info}">
        <div class="flex gap-3">
          <div class="mt-0.5 shrink-0">${icon[type] || icon.info}</div>
          <div class="min-w-0">
            <div class="toast-title">${escapeHtml(title)}</div>
            ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ""}
          </div>
          <button class="ml-auto shrink-0 rounded-xl border border-slate-200/60 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700/60 dark:text-slate-200 dark:hover:bg-slate-900/30" type="button" aria-label="Close toast">
            Close
          </button>
        </div>
      </div>
    `);

    $el.find("button").on("click", () => $el.remove());

    host.append($el);

    // auto-remove
    setTimeout(() => $el.fadeOut(150, () => $el.remove()), 3200);
  }

  // ---------- Theme ----------
  function loadTheme() {
    const t = readLS(LS_KEYS.theme, "system");
    applyTheme(t);
  }

  function applyTheme(mode) {
    const m = mode || "system";
    const root = document.documentElement;

    if (m === "dark") root.classList.add("dark");
    else if (m === "light") root.classList.remove("dark");
    else {
      // system
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.toggle("dark", prefersDark);
    }
    writeLS(LS_KEYS.theme, m);
  }

  function toggleTheme() {
    const root = document.documentElement;
    const currentlyDark = root.classList.contains("dark");
    applyTheme(currentlyDark ? "light" : "dark");
    toast({ title: "Theme updated", message: currentlyDark ? "Light mode enabled." : "Dark mode enabled.", type: "info" });
  }

  // ---------- Data ----------
  function loadData() {
    state.users = readLS(LS_KEYS.users, []);
    state.session = readLS(LS_KEYS.session, null);
    state.links = readLS(LS_KEYS.links, []);
    ensureAutoDisableExpired();
  }

  function persistUsers() {
    writeLS(LS_KEYS.users, state.users);
  }

  function persistSession() {
    writeLS(LS_KEYS.session, state.session);
  }

  function persistLinks() {
    writeLS(LS_KEYS.links, state.links);
  }

  // ---------- Session UI ----------
  function applySessionUI() {
    const $area = $("#sessionArea");
    const $pill = $("#userPill");
    const $email = $("#userEmail");

    const signedIn = !!state.session?.userId;

    if (!signedIn) {
      $area.empty().append(`<button id="openLogin" class="btn-primary" type="button">Sign in</button>`);
      $pill.addClass("hidden");
      $("#loginNudge").removeClass("hidden");
      $("#dashboardGate").removeClass("hidden");
      $("#linksWrap").addClass("opacity-50 pointer-events-none");
      return;
    }

    $area.empty().append(`
      <button id="logoutBtn" class="btn-secondary" type="button">Sign out</button>
    `);

    const emailText = state.session.email || "Signed in";
    $email.text(emailText);
    $pill.removeClass("hidden");
    $("#loginNudge").addClass("hidden");
    $("#dashboardGate").addClass("hidden");
    $("#linksWrap").removeClass("opacity-50 pointer-events-none");
  }

  function signIn(email, nameOptional) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return { ok: false, error: "Please enter a valid email address." };
    }

    let user = state.users.find((u) => u.email === normalized);
    if (!user) {
      user = { id: uid("usr"), email: normalized, name: String(nameOptional || "").trim(), createdAt: new Date().toISOString() };
      state.users.push(user);
      persistUsers();
    }

    state.session = { userId: user.id, email: user.email };
    persistSession();
    applySessionUI();
    renderLinks();
    toast({ title: "Signed in", message: `Session: ${user.email}`, type: "success" });
    return { ok: true, user };
  }

  function signOut() {
    state.session = null;
    persistSession();
    applySessionUI();
    renderLinks();
    toast({ title: "Signed out", message: "Your dashboard is now locked until you sign in again.", type: "info" });
  }

  // ---------- Modals ----------
  function openModal(modalId) {
    const $m = $(modalId);
    if (!$m.length) return;

    state.lastFocusEl = document.activeElement;
    state.activeModal = modalId;

    $m.removeClass("hidden");

    // focus first input/button
    const focusable = $m.find("input, button, select, textarea, a[href]").filter(":visible").get(0);
    if (focusable) focusable.focus();
  }

  function closeModal() {
    if (!state.activeModal) return;
    const $m = $(state.activeModal);
    $m.addClass("hidden");
    state.activeModal = null;

    if (state.lastFocusEl && typeof state.lastFocusEl.focus === "function") {
      state.lastFocusEl.focus();
    }
    state.lastFocusEl = null;
  }

  // ---------- Slug availability UI ----------
  function updateSlugAvailabilityUI(slugInput, $statusEl, excludeLinkId = null) {
    const slug = sanitizeSlug(slugInput);
    if (!slug) {
      $statusEl.text("").removeClass("text-emerald-600 text-rose-600 dark:text-emerald-300 dark:text-rose-300");
      return { ok: true, slug: "" };
    }

    const v = isSlugValid(slug);
    if (!v.ok) {
      $statusEl
        .text(v.error)
        .removeClass("text-emerald-600 dark:text-emerald-300")
        .addClass("text-rose-600 dark:text-rose-300");
      return { ok: false, slug };
    }

    if (slugExists(slug, excludeLinkId)) {
      $statusEl
        .text("Unavailable")
        .removeClass("text-emerald-600 dark:text-emerald-300")
        .addClass("text-rose-600 dark:text-rose-300");
      return { ok: false, slug };
    }

    $statusEl
      .text("Available")
      .removeClass("text-rose-600 dark:text-rose-300")
      .addClass("text-emerald-600 dark:text-emerald-300");

    return { ok: true, slug };
  }

  // ---------- Create link ----------
  function setShortenLoading(isLoading) {
    const $btn = $("#shortenBtn");
    $btn.prop("disabled", isLoading);
    $btn.find(".btn-text").text(isLoading ? "Shortening…" : "Shorten URL");
    $btn.find(".btn-spinner").toggleClass("hidden", !isLoading);
  }

  function createLink({ originalUrlRaw, customSlugRaw, enabled, expiresAtLocal }) {
    const userId = getCurrentUserId();
    if (!userId) {
      toast({ title: "Sign in required", message: "Sign in to create and manage links in the dashboard.", type: "warn" });
      return { ok: false, error: "Not signed in." };
    }

    const urlNorm = normalizeUrl(originalUrlRaw);
    if (!urlNorm.ok) return { ok: false, error: urlNorm.error };

    let expiresAt = null;
    if (expiresAtLocal) {
      const d = new Date(expiresAtLocal);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, error: "Invalid expiration date." };
      }
      expiresAt = d.toISOString();
    }

    let slug = sanitizeSlug(customSlugRaw);

    if (slug) {
      const v = isSlugValid(slug);
      if (!v.ok) return { ok: false, error: v.error };
      if (slugExists(slug)) return { ok: false, error: "That alias is already taken." };
    } else {
      // generate unique
      for (let i = 0; i < 30; i++) {
        const candidate = randomSlug(6);
        if (!slugExists(candidate) && !RESERVED_SLUGS.has(candidate)) {
          slug = candidate;
          break;
        }
      }
      if (!slug) return { ok: false, error: "Failed to generate a unique slug. Try again." };
    }

    const link = {
      id: uid("lnk"),
      userId,
      originalUrl: urlNorm.value,
      slug,
      createdAt: new Date().toISOString(),
      expiresAt, // ISO or null
      enabled: !!enabled,
      clicks: 0,
    };

    state.links.unshift(link);
    persistLinks();

    return { ok: true, link };
  }

  // ---------- Render ----------
  function getUserLinks() {
    const userId = getCurrentUserId();
    if (!userId) return [];
    return state.links.filter((l) => l.userId === userId);
  }

  function matchesFilter(link) {
    const q = state.filter.query.trim().toLowerCase();
    if (q) {
      const hay = `${link.slug} ${link.originalUrl}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }

    const status = computeStatus(link);
    if (state.filter.status === "all") return true;
    return status === state.filter.status;
  }

  function renderLinks() {
    ensureAutoDisableExpired();

    const userId = getCurrentUserId();
    const $tbody = $("#linksTbody");
    const $empty = $("#emptyState");

    $tbody.empty();

    if (!userId) {
      $empty.addClass("hidden");
      return;
    }

    const filtered = getUserLinks().filter(matchesFilter);

    if (filtered.length === 0) {
      $empty.removeClass("hidden");
      return;
    }

    $empty.addClass("hidden");

    const rows = filtered
      .map((l) => {
        const status = computeStatus(l);
        const pill = statusPill(status);
        const shortUrl = getShortUrl(l.slug);

        const enableLabel = l.enabled ? "Disable" : "Enable";
        const enableDisabled = isExpired(l) ? "disabled" : "";
        const enableTitle = isExpired(l) ? "Expired links must have expiry extended before enabling." : "";

        return `
          <tr class="bg-white/70 hover:bg-slate-50/80 dark:bg-slate-950/10 dark:hover:bg-slate-950/25 transition-colors">
            <td class="px-4 py-3">
              <a href="${escapeHtml(shortUrl)}" class="js-shortlink block max-w-[240px] truncate font-semibold text-indigo-700 underline decoration-indigo-300 underline-offset-4 hover:decoration-indigo-500 dark:text-indigo-300" data-id="${escapeHtml(l.id)}">
                ${escapeHtml(shortUrl)}
              </a>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">/${escapeHtml(l.slug)}</div>
            </td>
            <td class="px-4 py-3">
              <div class="max-w-[520px] truncate text-slate-700 dark:text-slate-200" title="${escapeHtml(l.originalUrl)}">
                ${escapeHtml(l.originalUrl)}
              </div>
            </td>
            <td class="px-4 py-3">
              <span class="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800/50 dark:text-slate-200">
                ${Number(l.clicks || 0)}
              </span>
            </td>
            <td class="px-4 py-3">
              <span class="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${pill.cls}">
                ${pill.text}
              </span>
            </td>
            <td class="px-4 py-3">
              <div class="flex items-center justify-end gap-2">
                <button class="js-copy btn-secondary" type="button" data-id="${escapeHtml(l.id)}">Copy</button>
                <button class="js-analytics btn-secondary" type="button" data-id="${escapeHtml(l.id)}">Analytics</button>
                <button class="js-edit btn-secondary" type="button" data-id="${escapeHtml(l.id)}">Edit</button>
                <button class="js-toggle btn-secondary" type="button" data-id="${escapeHtml(l.id)}" ${enableDisabled} title="${escapeHtml(enableTitle)}">
                  ${enableLabel}
                </button>
                <button class="js-delete btn-secondary" type="button" data-id="${escapeHtml(l.id)}">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    $tbody.append(rows);
  }

  function renderResult(link) {
    const shortUrl = getShortUrl(link.slug);

    $("#resultCard").removeClass("hidden");
    $("#resultShortUrl").text(shortUrl).attr("href", shortUrl).attr("data-id", link.id);
    $("#resultLongUrl").text(link.originalUrl);
    $("#copyResultBtn").prop("disabled", false).data("text", shortUrl);

    toast({ title: "Short link created", message: `/${link.slug} is ready to share.`, type: "success" });
  }

  // ---------- Clipboard ----------
  async function copyToClipboard(text) {
    const value = String(text || "");
    if (!value) return { ok: false, error: "Nothing to copy." };

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return { ok: true };
      }
    } catch {
      // fall through to legacy method
    }

    // legacy fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok ? { ok: true } : { ok: false, error: "Copy failed." };
    } catch {
      return { ok: false, error: "Copy failed." };
    }
  }

  function setCopyButtonFeedback($btn, copied) {
    const $text = $btn.find(".copy-text");
    const $icon = $btn.find(".copy-icon");

    if (!$text.length || !$icon.length) return;

    if (copied) {
      $text.text("Copied");
      $icon.replaceWith(`
        <svg class="copy-icon h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `);
      setTimeout(() => {
        $text.text("Copy");
        $btn.find(".copy-icon").replaceWith(`
          <svg class="copy-icon h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 8h10v12H8V8z" stroke="currentColor" stroke-width="2" />
            <path d="M6 16H5a1 1 0 01-1-1V5a1 1 0 011-1h10a1 1 0 011 1v1" stroke="currentColor" stroke-width="2" />
          </svg>
        `);
      }, 1000);
    }
  }

  // ---------- Actions ----------
  function findLinkById(id) {
    return state.links.find((l) => l.id === id) || null;
  }

  function updateLink(id, patch) {
    const idx = state.links.findIndex((l) => l.id === id);
    if (idx === -1) return false;
    state.links[idx] = { ...state.links[idx], ...patch };
    persistLinks();
    return true;
  }

  function deleteLink(id) {
    const before = state.links.length;
    state.links = state.links.filter((l) => l.id !== id);
    if (state.links.length === before) return false;
    persistLinks();
    return true;
  }

  function recordClickAndMaybeOpen(link) {
    const status = computeStatus(link);
    if (status !== "active") {
      toast({
        title: "Link not available",
        message: status === "expired" ? "This link has expired." : "This link is disabled.",
        type: "warn",
      });
      return;
    }

    const clicks = Number(link.clicks || 0) + 1;
    updateLink(link.id, { clicks });

    renderLinks(); // update table count

    // simulate access: open destination
    window.open(link.originalUrl, "_blank", "noopener,noreferrer");
  }

  // ---------- Analytics ----------
  function openAnalytics(linkId) {
    const link = findLinkById(linkId);
    if (!link) return;

    state.analyticsLinkId = linkId;

    const shortUrl = getShortUrl(link.slug);
    const status = computeStatus(link);
    const pill = statusPill(status);

    $("#amShortUrl").text(shortUrl).attr("href", shortUrl);
    $("#amOriginal").text(link.originalUrl);
    $("#amClicks").text(Number(link.clicks || 0));
    $("#amCreated").text(formatDateTime(link.createdAt));
    $("#amExpires").text(link.expiresAt ? formatDateTime(link.expiresAt) : "—");

    $("#amStatus")
      .text(pill.text)
      .removeClass()
      .addClass(`mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${pill.cls}`);

    $("#amCopyBtn").data("text", shortUrl);

    openModal("#analyticsModal");
  }

  // ---------- Edit ----------
  function openEdit(linkId) {
    const link = findLinkById(linkId);
    if (!link) return;

    $("#editId").val(link.id);
    $("#editLongUrl").val(link.originalUrl);
    $("#editSlug").val(link.slug);
    $("#editExpiresAt").val(toDatetimeLocalValue(link.expiresAt));
    $("#editEnabled").prop("checked", !!link.enabled);

    $("#editUrlError").addClass("hidden").text("");
    $("#editSlugStatus").text("").removeClass("text-emerald-600 text-rose-600 dark:text-emerald-300 dark:text-rose-300");

    openModal("#editModal");
    updateSlugAvailabilityUI(link.slug, $("#editSlugStatus"), link.id);
  }

  function saveEditFromForm() {
    const id = String($("#editId").val() || "");
    const link = findLinkById(id);
    if (!link) return { ok: false, error: "Link not found." };

    const urlNorm = normalizeUrl($("#editLongUrl").val());
    if (!urlNorm.ok) return { ok: false, field: "url", error: urlNorm.error };

    const slugSan = sanitizeSlug($("#editSlug").val());
    const valid = isSlugValid(slugSan);
    if (!valid.ok) return { ok: false, field: "slug", error: valid.error };

    if (slugExists(slugSan, id)) return { ok: false, field: "slug", error: "That slug is already taken." };

    let expiresAt = null;
    const localVal = String($("#editExpiresAt").val() || "").trim();
    if (localVal) {
      const d = new Date(localVal);
      if (Number.isNaN(d.getTime())) return { ok: false, field: "expires", error: "Invalid expiration date." };
      expiresAt = d.toISOString();
    }

    const enabled = $("#editEnabled").is(":checked");

    updateLink(id, {
      originalUrl: urlNorm.value,
      slug: slugSan,
      expiresAt,
      enabled,
    });

    ensureAutoDisableExpired();
    renderLinks();

    toast({ title: "Saved", message: "Link updated successfully.", type: "success" });
    closeModal();
    return { ok: true };
  }

    // Login submit
    $("#loginForm").on("submit", (e) => {
      e.preventDefault();
      const email = $("#loginEmail").val();
      const name = $("#loginName").val();

      const res = signIn(email, name);
      if (!res.ok) {
        $("#loginError").removeClass("hidden").text(res.error);
        return;
      }
      closeModal();
    });

    // Slug typing (landing)
    $("#customSlug").on(
      "input",
      debounce(() => {
        updateSlugAvailabilityUI($("#customSlug").val(), $("#slugStatus"));
      }, 150)
    );

    // Submit shorten
    $("#shortenForm").on("submit", (e) => {
      e.preventDefault();

      $("#urlError").addClass("hidden").text("");

      const longUrl = $("#longUrl").val();
      const customSlug = $("#customSlug").val();
      const enabled = $("#enabled").is(":checked");
      const expiresAtLocal = String($("#expiresAt").val() || "").trim();

      // immediate slug UI update
      if (customSlug.trim()) updateSlugAvailabilityUI(customSlug, $("#slugStatus"));

      setShortenLoading(true);

      // tiny simulated latency for “SaaS” feel
      setTimeout(() => {
        const res = createLink({ originalUrlRaw: longUrl, customSlugRaw: customSlug, enabled, expiresAtLocal });

        setShortenLoading(false);

        if (!res.ok) {
          $("#urlError").removeClass("hidden").text(res.error);
          toast({ title: "Couldn’t create link", message: res.error, type: "error" });
          return;
        }

        renderResult(res.link);
        renderLinks();

        // keep UX snappy: keep URL, clear slug
        $("#customSlug").val("");
        $("#slugStatus").text("").removeClass("text-emerald-600 text-rose-600 dark:text-emerald-300 dark:text-rose-300");
      }, 350);
    });

    // Copy from result card
    $("#copyResultBtn").on("click", async function () {
      const text = $(this).data("text");
      const res = await copyToClipboard(text);
      if (!res.ok) {
        toast({ title: "Copy failed", message: res.error || "Unable to copy.", type: "error" });
        return;
      }
      setCopyButtonFeedback($(this), true);
      toast({ title: "Copied", message: "Short URL copied to clipboard.", type: "success" });
    });

    // Dashboard search/filter
    $("#searchInput").on(
      "input",
      debounce(() => {
        state.filter.query = $("#searchInput").val();
        renderLinks();
      }, 120)
    );

    $("#statusFilter").on("change", () => {
      state.filter.status = $("#statusFilter").val();
      renderLinks();
    });

    // Table actions (event delegation)
    $("#linksTbody")
      .on("click", ".js-copy", async function () {
        const id = $(this).data("id");
        const link = findLinkById(id);
        if (!link) return;

        const shortUrl = getShortUrl(link.slug);
        const res = await copyToClipboard(shortUrl);
        if (!res.ok) {
          toast({ title: "Copy failed", message: res.error || "Unable to copy.", type: "error" });
          return;
        }
        toast({ title: "Copied", message: "Short URL copied to clipboard.", type: "success" });
      })
      .on("click", ".js-analytics", function () {
        const id = $(this).data("id");
        openAnalytics(id);
      })
      .on("click", ".js-edit", function () {
        const id = $(this).data("id");
        openEdit(id);
      })
      .on("click", ".js-toggle", function () {
        const id = $(this).data("id");
        const link = findLinkById(id);
        if (!link) return;

        if (isExpired(link)) {
          toast({ title: "Expired", message: "Extend the expiration date in Edit before enabling.", type: "warn" });
          return;
        }

        updateLink(id, { enabled: !link.enabled });
        renderLinks();
        toast({ title: link.enabled ? "Disabled" : "Enabled", message: `/${link.slug}`, type: "info" });
      })
      .on("click", ".js-delete", function () {
        const id = $(this).data("id");
        const link = findLinkById(id);
        if (!link) return;

        const ok = window.confirm(`Delete /${link.slug}? This cannot be undone.`);
        if (!ok) return;

        deleteLink(id);
        renderLinks();
        toast({ title: "Deleted", message: `/${link.slug} removed.`, type: "success" });
      })
      .on("click", ".js-shortlink", function (e) {
        e.preventDefault();
        const id = $(this).data("id");
        const link = findLinkById(id);
        if (!link) return;
        recordClickAndMaybeOpen(link);
      });

    // Result short URL click (also counts)
    $("#resultShortUrl").on("click", function (e) {
      e.preventDefault();
      const id = $(this).attr("data-id");
      const link = findLinkById(id);
      if (!link) return;
      recordClickAndMaybeOpen(link);
    });

    // Analytics modal copy
    $("#amCopyBtn").on("click", async function () {
      const text = $(this).data("text");
      const res = await copyToClipboard(text);
      if (!res.ok) {
        toast({ title: "Copy failed", message: res.error || "Unable to copy.", type: "error" });
        return;
      }
      toast({ title: "Copied", message: "Short URL copied to clipboard.", type: "success" });
    });

    // Edit slug availability
    $("#editSlug").on(
      "input",
      debounce(() => {
        const id = String($("#editId").val() || "");
        updateSlugAvailabilityUI($("#editSlug").val(), $("#editSlugStatus"), id);
      }, 150)
    );

    // Edit submit
    $("#editForm").on("submit", (e) => {
      e.preventDefault();

      $("#editUrlError").addClass("hidden").text("");

      const res = saveEditFromForm();
      if (!res.ok) {
        if (res.field === "url") $("#editUrlError").removeClass("hidden").text(res.error);
        toast({ title: "Couldn’t save changes", message: res.error, type: "error" });
      }
    });
  }

  // ---------- Init ----------
  function init() {
    loadTheme();
    loadData();
    bindUI();
    applySessionUI();

    // show sign-in nudge if not signed in
    if (!getCurrentUserId()) {
      $("#loginNudge").removeClass("hidden");
    }

    renderLinks();
    $("#copyResultBtn").prop("disabled", true);
  }

  $(init);
})(jQuery);