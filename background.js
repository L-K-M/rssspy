"use strict";

const MAX_CANDIDATES_TO_VALIDATE = 24;
const FETCH_TIMEOUT_MS = 7000;
const MAX_REDIRECTS = 5;

const NON_PUBLIC_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain"
]);
const NON_PUBLIC_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".home.arpa",
  ".arpa",
  ".alt",
  ".internal",
  ".invalid",
  ".test",
  ".example",
  ".lan",
  ".home",
  ".corp",
  ".onion"
];

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
    const feeds = await verifyCandidates(candidates, pageUrl);

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

  if (!canValidateCandidateUrl(url, pageUrl)) {
    return null;
  }

  return {
    url,
    source,
    confidence,
    title: title || titleFromUrl(url)
  };
}

async function verifyCandidates(candidates, pageUrl) {
  const verifiedByUrl = new Map();

  for (const candidate of candidates) {
    const feed = await verifyCandidate(candidate, pageUrl);
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

async function verifyCandidate(candidate, pageUrl) {
  try {
    const result = await fetchWithTimeout(candidate.url, pageUrl, FETCH_TIMEOUT_MS);
    const response = result.response;
    if (!response.ok) {
      return null;
    }

    const contentType = stringify(response.headers.get("content-type")).toLowerCase();
    const finalUrl = result.finalUrl;

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

function parseHttpUrl(rawUrl, baseUrl) {
  const url = toHttpUrl(rawUrl, baseUrl);
  if (!url) {
    return null;
  }

  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

function canValidateCandidateUrl(rawUrl, pageUrl) {
  const candidateUrl = parseHttpUrl(rawUrl);
  const sourcePageUrl = parseHttpUrl(pageUrl);

  if (!candidateUrl || !sourcePageUrl) {
    return false;
  }

  return (
    isPublicHostname(candidateUrl.hostname) &&
    isPublicHostname(sourcePageUrl.hostname) &&
    isSameOriginOrSite(candidateUrl, sourcePageUrl)
  );
}

async function canFetchCandidateUrl(rawUrl, pageUrl) {
  const candidateUrl = parseHttpUrl(rawUrl);
  if (!candidateUrl || !canValidateCandidateUrl(candidateUrl.href, pageUrl)) {
    return false;
  }

  return resolvesToPublicAddresses(candidateUrl.hostname);
}

function isSameOriginOrSite(candidateUrl, sourcePageUrl) {
  if (candidateUrl.origin === sourcePageUrl.origin) {
    return true;
  }

  const candidateHost = normalizeHostname(candidateUrl.hostname);
  const sourceHost = normalizeHostname(sourcePageUrl.hostname);

  if (!candidateHost || !sourceHost) {
    return false;
  }

  if (candidateHost === sourceHost) {
    return true;
  }

  if (isIpAddress(candidateHost) || isIpAddress(sourceHost)) {
    return false;
  }

  return candidateHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${candidateHost}`);
}

function isPublicHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host || host.includes("%")) {
    return false;
  }

  const ipv4 = parseIpv4Address(host);
  if (ipv4) {
    return !isNonPublicIpv4Address(ipv4);
  }

  const ipv6 = parseIpv6Address(host);
  if (ipv6) {
    return !isNonPublicIpv6Address(ipv6);
  }

  if (host.includes(":")) {
    return false;
  }

  if (NON_PUBLIC_HOSTNAMES.has(host)) {
    return false;
  }

  if (NON_PUBLIC_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false;
  }

  return host.includes(".");
}

function isIpAddress(hostname) {
  return Boolean(parseIpv4Address(hostname) || parseIpv6Address(hostname));
}

function normalizeHostname(hostname) {
  let host = stringify(hostname).trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  while (host.endsWith(".")) {
    host = host.slice(0, -1);
  }

  return host;
}

function parseIpv4Address(hostname) {
  const parts = normalizeHostname(hostname).split(".");
  if (parts.length !== 4) {
    return null;
  }

  const bytes = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      return null;
    }

    bytes.push(byte);
  }

  return bytes;
}

function isNonPublicIpv4Address(bytes) {
  const [first, second, third] = bytes;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6Address(hostname) {
  let value = normalizeHostname(hostname);
  if (!value.includes(":") || value.includes("%")) {
    return null;
  }

  value = expandEmbeddedIpv4Address(value);
  if (!value) {
    return null;
  }

  const halves = value.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = parseIpv6Groups(halves[0]);
  const right = halves.length === 2 ? parseIpv6Groups(halves[1]) : [];
  if (!left || !right) {
    return null;
  }

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  return left.concat(new Array(missing).fill(0), right);
}

function expandEmbeddedIpv4Address(value) {
  const lastPart = value.slice(value.lastIndexOf(":") + 1);
  if (!lastPart.includes(".")) {
    return value;
  }

  const bytes = parseIpv4Address(lastPart);
  if (!bytes) {
    return null;
  }

  const high = ((bytes[0] << 8) | bytes[1]).toString(16);
  const low = ((bytes[2] << 8) | bytes[3]).toString(16);
  return `${value.slice(0, -lastPart.length)}${high}:${low}`;
}

function parseIpv6Groups(value) {
  if (!value) {
    return [];
  }

  const parts = value.split(":");
  if (parts.some((part) => !/^[\da-f]{1,4}$/i.test(part))) {
    return null;
  }

  return parts.map((part) => parseInt(part, 16));
}

function isNonPublicIpv6Address(groups) {
  const [first, second, third, fourth, , , , eighth] = groups;
  const mappedIpv4 = extractMappedIpv4Address(groups);

  return (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && eighth === 1) ||
    Boolean(mappedIpv4 && isNonPublicIpv4Address(mappedIpv4)) ||
    groups.slice(0, 6).every((group) => group === 0) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x0100 && second === 0 && third === 0 && fourth === 0) ||
    (first === 0x0064 && second === 0xff9b && third === 0x0001) ||
    (first === 0x2001 && second === 0) ||
    (first === 0x2001 && second === 0x0002 && third === 0) ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) ||
    first === 0x2002 ||
    isPrivateNat64Address(groups)
  );
}

function extractMappedIpv4Address(groups) {
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) {
    return null;
  }

  return [(groups[6] >> 8) & 255, groups[6] & 255, (groups[7] >> 8) & 255, groups[7] & 255];
}

function isPrivateNat64Address(groups) {
  const usesKnownPrefix =
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;

  if (!usesKnownPrefix) {
    return false;
  }

  return isNonPublicIpv4Address([
    (groups[6] >> 8) & 255,
    groups[6] & 255,
    (groups[7] >> 8) & 255,
    groups[7] & 255
  ]);
}

async function resolvesToPublicAddresses(hostname) {
  const host = normalizeHostname(hostname);

  if (!isPublicHostname(host)) {
    return false;
  }

  if (isIpAddress(host)) {
    return true;
  }

  if (!browser.dns || typeof browser.dns.resolve !== "function") {
    return false;
  }

  try {
    const record = await browser.dns.resolve(host);
    const addresses = record && Array.isArray(record.addresses) ? record.addresses : [];

    return addresses.length > 0 && addresses.every((address) => isPublicHostname(address));
  } catch (_error) {
    return false;
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

async function fetchWithTimeout(url, pageUrl, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchFollowingSafeRedirects(url, pageUrl, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchFollowingSafeRedirects(url, pageUrl, signal) {
  let currentUrl = toHttpUrl(url);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!currentUrl || !(await canFetchCandidateUrl(currentUrl, pageUrl))) {
      throw new Error("Unsafe feed validation URL.");
    }

    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal
    });

    const responseUrl = toHttpUrl(response.url, currentUrl) || currentUrl;
    if (!(await canFetchCandidateUrl(responseUrl, pageUrl))) {
      throw new Error("Unsafe feed validation response URL.");
    }

    if (response.type === "opaqueredirect") {
      throw new Error("Hidden feed validation redirect.");
    }

    if (!isRedirectResponse(response)) {
      return {
        response,
        finalUrl: responseUrl
      };
    }

    if (redirectCount === MAX_REDIRECTS) {
      throw new Error("Too many feed validation redirects.");
    }

    const nextUrl = toHttpUrl(response.headers.get("location"), responseUrl);
    if (!nextUrl || !(await canFetchCandidateUrl(nextUrl, pageUrl))) {
      throw new Error("Unsafe feed validation redirect.");
    }

    currentUrl = nextUrl;
  }

  throw new Error("Too many feed validation redirects.");
}

function isRedirectResponse(response) {
  return response.status >= 300 && response.status < 400;
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
