"use strict";

const MAX_CANDIDATES_TO_VALIDATE = 24;
const FETCH_TIMEOUT_MS = 7000;

const FEED_MIME_PATTERN =
  /\b(application\/(rss\+xml|atom\+xml|feed\+json)|text\/(rss\+xml|atom\+xml|xml)|application\/xml)\b/i;
const FEED_XML_PATTERN = /<(rss|feed|rdf:RDF)\b/i;
const FEED_XML_NAMESPACE_PATTERN =
  /(http:\/\/www\.w3\.org\/2005\/Atom|http:\/\/purl\.org\/rss\/1\.0\/|http:\/\/purl\.org\/dc\/elements\/1\.1\/)/i;
const JSON_FEED_PATTERN = /"version"\s*:\s*"https:\/\/jsonfeed\.org\/version\//i;
const FEED_ICON_PATHS = {
  16: "icons/rss.svg",
  32: "icons/rss.svg",
  48: "icons/rss.svg"
};
const NO_FEED_ICON_PATHS = {
  16: "icons/no-rss.svg",
  32: "icons/no-rss.svg",
  48: "icons/no-rss.svg"
};

const tabState = new Map();

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "rssspy:scanResult") {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== "number") {
      return undefined;
    }

    const payload = message.payload || {};
    void ingestScanResult(tabId, payload);
    return undefined;
  }

  if (message.type === "rssspy:getFeeds") {
    const tabId = message.tabId;
    if (typeof tabId !== "number") {
      return Promise.resolve({
        status: "error",
        feeds: [],
        error: "Missing tab id."
      });
    }

    return Promise.resolve(readStateForTab(tabId));
  }

  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabState.delete(tabId);
    void clearBadge(tabId);
  }
});

async function ingestScanResult(tabId, payload) {
  const pageUrl = typeof payload.pageUrl === "string" ? payload.pageUrl : "";
  const rawCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const currentState = tabState.get(tabId);

  const nextScanId = (currentState && currentState.scanId ? currentState.scanId : 0) + 1;

  tabState.set(tabId, {
    status: "scanning",
    pageUrl,
    feeds: [],
    scanId: nextScanId
  });
  await setScanningBadge(tabId);

  try {
    const candidates = normalizeCandidates(rawCandidates, pageUrl);
    const feeds = await verifyCandidates(candidates);

    const latest = tabState.get(tabId);
    if (!latest || latest.scanId !== nextScanId) {
      return;
    }

    tabState.set(tabId, {
      status: "ready",
      pageUrl,
      feeds,
      scanId: nextScanId,
      scannedAt: Date.now()
    });

    await updateBadge(tabId, feeds.length);
  } catch (error) {
    const latest = tabState.get(tabId);
    if (!latest || latest.scanId !== nextScanId) {
      return;
    }

    tabState.set(tabId, {
      status: "error",
      pageUrl,
      feeds: [],
      error: "Feed scan failed for this tab.",
      scanId: nextScanId
    });

    await clearBadge(tabId);
    console.error("RSS Spy failed to process scan", error);
  }
}

function readStateForTab(tabId) {
  const state = tabState.get(tabId);
  if (!state) {
    return {
      status: "idle",
      feeds: [],
      pageUrl: ""
    };
  }

  return {
    status: state.status,
    feeds: Array.isArray(state.feeds) ? state.feeds : [],
    pageUrl: state.pageUrl || "",
    scannedAt: state.scannedAt || null,
    error: state.error || ""
  };
}

function normalizeCandidates(rawCandidates, pageUrl) {
  const byUrl = new Map();

  for (const rawCandidate of rawCandidates) {
    const normalized = normalizeCandidate(rawCandidate, pageUrl);
    if (!normalized) {
      continue;
    }

    const existing = byUrl.get(normalized.url);
    if (!existing || normalized.confidence > existing.confidence) {
      byUrl.set(normalized.url, normalized);
      continue;
    }

    if (!existing.title && normalized.title) {
      existing.title = normalized.title;
    }
  }

  return Array.from(byUrl.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_CANDIDATES_TO_VALIDATE);
}

function normalizeCandidate(rawCandidate, pageUrl) {
  let rawUrl = "";
  let source = "unknown";
  let confidence = 50;
  let title = "";

  if (typeof rawCandidate === "string") {
    rawUrl = rawCandidate;
  } else if (rawCandidate && typeof rawCandidate === "object") {
    rawUrl = stringify(rawCandidate.url || rawCandidate.href);
    source = stringify(rawCandidate.source) || "unknown";
    confidence = clampConfidence(rawCandidate.confidence);
    title = cleanTitle(rawCandidate.title);
  }

  const url = toHttpUrl(rawUrl, pageUrl);
  if (!url) {
    return null;
  }

  return {
    url,
    source,
    confidence,
    title: title || titleFromUrl(url)
  };
}

async function verifyCandidates(candidates) {
  const verifiedByUrl = new Map();

  for (const candidate of candidates) {
    const feed = await verifyCandidate(candidate);
    if (!feed) {
      continue;
    }

    const existing = verifiedByUrl.get(feed.url);
    if (!existing || feed.confidence > existing.confidence) {
      verifiedByUrl.set(feed.url, feed);
    }
  }

  return Array.from(verifiedByUrl.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
}

async function verifyCandidate(candidate) {
  try {
    const response = await fetchWithTimeout(candidate.url, FETCH_TIMEOUT_MS);
    if (!response.ok) {
      return null;
    }

    const contentType = stringify(response.headers.get("content-type")).toLowerCase();
    const finalUrl = toHttpUrl(response.url, candidate.url) || candidate.url;

    if (contentType.includes("feed+json")) {
      return {
        url: finalUrl,
        title: candidate.title || titleFromUrl(finalUrl),
        source: candidate.source,
        confidence: candidate.confidence,
        contentType: contentType || "unknown"
      };
    }

    if (FEED_MIME_PATTERN.test(contentType) && !contentType.includes("json")) {
      return {
        url: finalUrl,
        title: candidate.title || titleFromUrl(finalUrl),
        source: candidate.source,
        confidence: candidate.confidence,
        contentType: contentType || "unknown"
      };
    }

    const sample = (await response.text()).slice(0, 12000);
    if (!looksLikeFeed(sample, contentType, finalUrl)) {
      return null;
    }

    return {
      url: finalUrl,
      title: candidate.title || titleFromUrl(finalUrl),
      source: candidate.source,
      confidence: candidate.confidence,
      contentType: contentType || "unknown"
    };
  } catch (_error) {
    return null;
  }
}

function looksLikeFeed(sample, contentType, url) {
  const text = stringify(sample).trimStart();
  const lowerType = stringify(contentType).toLowerCase();

  if (lowerType.includes("feed+json")) {
    return true;
  }

  if (JSON_FEED_PATTERN.test(text)) {
    return true;
  }

  if (FEED_MIME_PATTERN.test(lowerType) && (FEED_XML_PATTERN.test(text) || text.startsWith("<?xml"))) {
    return true;
  }

  if (FEED_XML_PATTERN.test(text)) {
    return true;
  }

  if (FEED_XML_NAMESPACE_PATTERN.test(text) && /<(item|entry|channel)\b/i.test(text)) {
    return true;
  }

  return looksLikeFeedPath(url) && FEED_XML_PATTERN.test(text);
}

function looksLikeFeedPath(url) {
  return /(\/feed(?:\/|$|\?)|\/rss(?:\/|$|\?)|\/atom(?:\.xml)?$|\.rss($|\?)|\.atom($|\?)|\.xml($|\?))/i.test(
    stringify(url)
  );
}

function toHttpUrl(rawUrl, baseUrl) {
  const value = stringify(rawUrl).trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, stringify(baseUrl) || undefined);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch (_error) {
    return null;
  }
}

function titleFromUrl(rawUrl) {
  const url = toHttpUrl(rawUrl);
  if (!url) {
    return "Feed";
  }

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const pathPart = parts.length ? parts[parts.length - 1] : parsed.hostname;
    const pretty = pathPart.replace(/[\._-]+/g, " ").trim();
    return cleanTitle(pretty || parsed.hostname) || "Feed";
  } catch (_error) {
    return "Feed";
  }
}

function cleanTitle(value) {
  return stringify(value).replace(/\s+/g, " ").trim().slice(0, 90);
}

function stringify(value) {
  return typeof value === "string" ? value : "";
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 50;
  }
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function setScanningBadge(tabId) {
  try {
    await setActionIcon(tabId, false);
    await browser.action.setBadgeBackgroundColor({
      tabId,
      color: "#5b7386"
    });
    await browser.action.setBadgeText({
      tabId,
      text: "..."
    });
    await browser.action.setTitle({
      tabId,
      title: "RSS Spy: scanning for feeds"
    });
  } catch (_error) {
    // Tab may no longer exist.
  }
}

async function updateBadge(tabId, feedCount) {
  if (feedCount > 0) {
    try {
      await setActionIcon(tabId, true);
      await browser.action.setBadgeBackgroundColor({
        tabId,
        color: "#d97706"
      });
      await browser.action.setBadgeText({
        tabId,
        text: feedCount > 99 ? "99+" : String(feedCount)
      });
      await browser.action.setTitle({
        tabId,
        title: `RSS Spy: ${feedCount} feed${feedCount === 1 ? "" : "s"} found`
      });
    } catch (_error) {
      // Tab may no longer exist.
    }
    return;
  }

  await clearBadge(tabId);
}

async function clearBadge(tabId) {
  try {
    await setActionIcon(tabId, false);
    await browser.action.setBadgeText({
      tabId,
      text: ""
    });
    await browser.action.setTitle({
      tabId,
      title: "RSS Spy"
    });
  } catch (_error) {
    // Tab may no longer exist.
  }
}

async function setActionIcon(tabId, hasFeed) {
  const path = hasFeed ? FEED_ICON_PATHS : NO_FEED_ICON_PATHS;
  try {
    await browser.action.setIcon({
      tabId,
      path
    });
  } catch (_error) {
    // Tab may no longer exist.
  }
}
