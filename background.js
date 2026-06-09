"use strict";

const MAX_CANDIDATES_TO_VALIDATE = 24;
const FETCH_TIMEOUT_MS = 7000;
const DNS_TIMEOUT_MS = 4000;
const MAX_FEED_SAMPLE_BYTES = 65536;
const VALIDATION_CONCURRENCY = 6;

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

// Specific feed content types that, on their own, identify a feed. Generic XML
// (text/xml, application/xml) is deliberately excluded: a matching content type
// is not enough, so those responses must still pass the body sniff below to
// avoid treating sitemaps or arbitrary XML/JSON as feeds.
const SPECIFIC_FEED_MIME_PATTERN =
  /\b(application\/(rss\+xml|atom\+xml|feed\+json)|text\/(rss\+xml|atom\+xml))\b/i;
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

const EXTENSION_ORIGIN = readExtensionOrigin();

// When the network guard is active we can safely let fetch follow redirects:
// every hop (initial request and each redirect target) is re-checked against
// the public-host policy by the webRequest listener below, so a redirect to an
// internal/private address is blocked before the connection is made. If the
// guard cannot be installed we fall back to refusing redirects entirely.
let networkGuardActive = false;
installNetworkGuard();

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

    // Validate page-provided candidates (declared feed links, content signals)
    // first. Only fall back to probing guessed/heuristic paths when the page
    // itself yielded no working feed, so feed-advertising sites are not hit with
    // a burst of speculative /feed, /rss, ... requests on every visit.
    const provided = candidates.filter((candidate) => candidate.source !== "heuristic");
    const guessed = candidates.filter((candidate) => candidate.source === "heuristic");

    let feeds = await verifyCandidates(provided, pageUrl);
    if (isStaleScan(tabId, nextScanId)) {
      return;
    }

    if (feeds.length === 0 && guessed.length > 0) {
      feeds = await verifyCandidates(guessed, pageUrl);
      if (isStaleScan(tabId, nextScanId)) {
        return;
      }
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
    if (isStaleScan(tabId, nextScanId)) {
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

function isStaleScan(tabId, scanId) {
  const latest = tabState.get(tabId);
  return !latest || latest.scanId !== scanId;
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
    if (!existing) {
      byUrl.set(normalized.url, normalized);
      continue;
    }

    if (normalized.confidence > existing.confidence) {
      normalized.explicit = normalized.explicit || existing.explicit;
      if (!normalized.title && existing.title) {
        normalized.title = existing.title;
      }
      byUrl.set(normalized.url, normalized);
      continue;
    }

    if (normalized.explicit) {
      existing.explicit = true;
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
  let explicit = false;

  if (typeof rawCandidate === "string") {
    rawUrl = rawCandidate;
  } else if (rawCandidate && typeof rawCandidate === "object") {
    rawUrl = stringify(rawCandidate.url || rawCandidate.href);
    source = stringify(rawCandidate.source) || "unknown";
    confidence = clampConfidence(rawCandidate.confidence);
    title = cleanTitle(rawCandidate.title);
    explicit = Boolean(rawCandidate.explicit);
  }

  const url = toHttpUrl(rawUrl, pageUrl);
  if (!url) {
    return null;
  }

  if (!canValidateCandidateUrl(url, pageUrl, explicit)) {
    return null;
  }

  return {
    url,
    source,
    confidence,
    explicit,
    title: title || titleFromUrl(url)
  };
}

async function verifyCandidates(candidates, pageUrl) {
  const results = await mapWithConcurrency(
    candidates,
    VALIDATION_CONCURRENCY,
    (candidate) => verifyCandidate(candidate, pageUrl)
  );

  const verifiedByUrl = new Map();
  for (const feed of results) {
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
    return await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
      const { response, finalUrl } = await fetchCandidate(
        candidate.url,
        pageUrl,
        candidate.explicit,
        signal
      );

      if (!response.ok) {
        cancelResponseBody(response);
        return null;
      }

      const contentType = stringify(response.headers.get("content-type")).toLowerCase();

      // Unambiguous feed content types are trusted without a body sniff, but the
      // sample is still read (best-effort) so the feed's own title and format can
      // be extracted for the popup.
      const trustedType = SPECIFIC_FEED_MIME_PATTERN.test(contentType);

      let sample = "";
      try {
        sample = await readResponseSample(response, MAX_FEED_SAMPLE_BYTES, signal);
      } catch (error) {
        // An unreadable/oversized body disqualifies untrusted candidates; trusted
        // content types still validate, just without extracted metadata.
        if (!trustedType) {
          throw error;
        }
        cancelResponseBody(response);
      }

      // Everything else (generic XML, JSON, HTML, unknown) must look like a feed.
      if (!trustedType && !looksLikeFeed(sample, contentType)) {
        return null;
      }

      return makeFeed(candidate, finalUrl, contentType, sample);
    });
  } catch (_error) {
    return null;
  }
}

function makeFeed(candidate, finalUrl, contentType, sample) {
  const format = detectFeedFormat(sample, contentType);

  return {
    url: finalUrl,
    // The feed's self-declared title beats anything derived from the linking page.
    title: extractFeedTitle(sample, format) || candidate.title || titleFromUrl(finalUrl),
    source: candidate.source,
    confidence: candidate.confidence,
    explicit: Boolean(candidate.explicit),
    format,
    contentType: contentType || "unknown"
  };
}

function detectFeedFormat(sample, contentType) {
  const type = stringify(contentType).toLowerCase();
  if (type.includes("atom+xml")) {
    return "atom";
  }
  if (type.includes("rss+xml")) {
    return "rss";
  }
  if (type.includes("feed+json")) {
    return "json";
  }

  const text = stringify(sample);
  if (JSON_FEED_PATTERN.test(text)) {
    return "json";
  }
  if (/<feed\b/i.test(text) || text.includes("http://www.w3.org/2005/Atom")) {
    return "atom";
  }
  if (/<(rss|rdf:RDF)\b/i.test(text) || FEED_XML_NAMESPACE_PATTERN.test(text)) {
    return "rss";
  }
  return "unknown";
}

// Pulls the feed's own title out of the body sample. For RSS the first <title>
// is the channel title and for Atom it is the feed title, so the first match in
// document order is the right one in both formats.
function extractFeedTitle(sample, format) {
  const text = stringify(sample);
  if (!text) {
    return "";
  }

  if (format === "json") {
    const match = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    return match ? cleanTitle(decodeJsonString(match[1])) : "";
  }

  const match = /<title[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i.exec(text);
  return match ? cleanTitle(decodeXmlEntities(match[1])) : "";
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch (_error) {
    return value;
  }
}

function decodeXmlEntities(value) {
  return stringify(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch (_error) {
    return "";
  }
}

async function readResponseSample(response, maxBytes, signal) {
  if (contentLengthExceeds(response, maxBytes)) {
    cancelResponseBody(response);
    throw new Error("Feed candidate body is too large.");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Feed candidate response body is not streamable.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  let reachedLimit = false;

  try {
    while (bytesRead < maxBytes) {
      if (signal && signal.aborted) {
        throw new Error("Feed candidate body read timed out.");
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || !value.byteLength) {
        continue;
      }

      const remainingBytes = maxBytes - bytesRead;
      if (value.byteLength > remainingBytes) {
        chunks.push(value.slice(0, remainingBytes));
        bytesRead += remainingBytes;
        reachedLimit = true;
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;

      if (bytesRead >= maxBytes) {
        reachedLimit = true;
      }
    }
  } finally {
    if (reachedLimit || (signal && signal.aborted)) {
      try {
        await reader.cancel();
      } catch (_error) {
        // Ignore stream cancellation failures; the fetch timeout still aborts the request.
      }
    }

    if (typeof reader.releaseLock === "function") {
      try {
        reader.releaseLock();
      } catch (_error) {
        // Ignore release failures for already-closed streams.
      }
    }
  }

  return decodeByteChunks(chunks, bytesRead);
}

function contentLengthExceeds(response, maxBytes) {
  const value = stringify(response.headers.get("content-length")).trim();
  return /^\d+$/.test(value) && Number(value) > maxBytes;
}

function decodeByteChunks(chunks, totalBytes) {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function cancelResponseBody(response) {
  if (!response.body || typeof response.body.cancel !== "function") {
    return;
  }

  try {
    const cancelResult = response.body.cancel();
    if (cancelResult && typeof cancelResult.catch === "function") {
      void cancelResult.catch(() => {});
    }
  } catch (_error) {
    // Best-effort cancellation only.
  }
}

function looksLikeFeed(sample, contentType) {
  const text = stringify(sample).trimStart();
  const lowerType = stringify(contentType).toLowerCase();

  if (lowerType.includes("feed+json")) {
    return true;
  }

  if (JSON_FEED_PATTERN.test(text)) {
    return true;
  }

  if (FEED_XML_PATTERN.test(text)) {
    return true;
  }

  return FEED_XML_NAMESPACE_PATTERN.test(text) && /<(item|entry|channel)\b/i.test(text);
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

function hostnameOf(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  return parsed ? parsed.hostname : "";
}

// Policy gate deciding whether a candidate URL is allowed to be requested at all.
// `explicit` candidates (feeds the page actually declares, e.g. a
// <link rel="alternate" type="application/rss+xml">) may live on another origin,
// so the same-site requirement is relaxed for them. Guessed/heuristic candidates
// remain same-site to avoid issuing speculative cross-site requests. SSRF
// protection (public hostnames only, plus DNS checks elsewhere) applies in both
// cases.
function canValidateCandidateUrl(rawUrl, pageUrl, explicit) {
  const candidateUrl = parseHttpUrl(rawUrl);
  const sourcePageUrl = parseHttpUrl(pageUrl);

  if (!candidateUrl || !sourcePageUrl) {
    return false;
  }

  if (!isPublicHostname(candidateUrl.hostname) || !isPublicHostname(sourcePageUrl.hostname)) {
    return false;
  }

  if (explicit) {
    return true;
  }

  return isSameOriginOrSite(candidateUrl, sourcePageUrl);
}

// Decides whether the very first request for a candidate may proceed. When the
// network guard is active it re-checks DNS for every hop, so we avoid resolving
// twice here; otherwise we must resolve the initial host ourselves.
async function isInitialCandidateAllowed(rawUrl, pageUrl, explicit) {
  if (!canValidateCandidateUrl(rawUrl, pageUrl, explicit)) {
    return false;
  }

  if (networkGuardActive) {
    return true;
  }

  return resolvesToPublicAddresses(hostnameOf(rawUrl));
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
    const record = await withDnsTimeout(browser.dns.resolve(host), DNS_TIMEOUT_MS);
    const addresses = record && Array.isArray(record.addresses) ? record.addresses : [];

    return addresses.length > 0 && addresses.every((address) => isPublicHostname(address));
  } catch (_error) {
    // Fail closed: an unresolved or slow host is treated as unsafe.
    return false;
  }
}

function withDnsTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("DNS resolution timed out.")), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
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

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function withTimeout(timeoutMs, run) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCandidate(url, pageUrl, explicit, signal) {
  const startUrl = toHttpUrl(url);
  if (!startUrl || !(await isInitialCandidateAllowed(startUrl, pageUrl, explicit))) {
    throw new Error("Unsafe feed validation URL.");
  }

  const response = await fetch(startUrl, {
    method: "GET",
    redirect: networkGuardActive ? "follow" : "manual",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal
  });

  // Without the network guard we cannot vet a redirect target before the
  // connection happens, so an opaque redirect is rejected rather than followed.
  if (response.type === "opaqueredirect") {
    throw new Error("Feed validation redirect could not be verified.");
  }

  const finalUrl = toHttpUrl(response.url, startUrl) || startUrl;
  if (!isPublicHostname(hostnameOf(finalUrl))) {
    throw new Error("Unsafe final feed validation URL.");
  }

  return { response, finalUrl };
}

function readExtensionOrigin() {
  try {
    if (browser.runtime && typeof browser.runtime.getURL === "function") {
      return new URL(browser.runtime.getURL("/")).origin;
    }
  } catch (_error) {
    // Fall through to the empty-origin guard below.
  }
  return "";
}

// Re-validates every network request the extension itself initiates, including
// each redirect hop, and cancels any that target a non-public host. This is what
// makes following redirects safe: a candidate that 30x-redirects toward an
// internal/private address never reaches the network.
function installNetworkGuard() {
  if (!EXTENSION_ORIGIN) {
    return;
  }

  if (!browser.webRequest || !browser.webRequest.onBeforeRequest) {
    console.warn(
      "RSS Spy: webRequest guard unavailable; redirects will not be followed during validation."
    );
    return;
  }

  try {
    browser.webRequest.onBeforeRequest.addListener(
      guardValidationRequest,
      { urls: ["http://*/*", "https://*/*"] },
      ["blocking"]
    );
    networkGuardActive = true;
  } catch (error) {
    networkGuardActive = false;
    console.warn(
      "RSS Spy: could not install webRequest guard; redirects will not be followed.",
      error
    );
  }
}

function guardValidationRequest(details) {
  // Only police the extension's own background validation requests; ordinary tab
  // traffic is returned synchronously so normal browsing is never delayed.
  if (!isOwnValidationRequest(details)) {
    return {};
  }

  return checkOwnRequest(details);
}

function isOwnValidationRequest(details) {
  if (!details) {
    return false;
  }

  // Match on the initiating origin only. A web page cannot forge a
  // moz-extension:// origin, and every request the extension issues carries it
  // (including redirect hops), so this both isolates our own requests and avoids
  // a fail-open gap if the request type/tabId were ever classified differently.
  const origin = stringify(details.originUrl) || stringify(details.documentUrl);
  return Boolean(origin) && origin.startsWith(EXTENSION_ORIGIN);
}

async function checkOwnRequest(details) {
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch (_error) {
    return { cancel: true };
  }

  const host = normalizeHostname(hostname);
  if (!isPublicHostname(host)) {
    return { cancel: true };
  }

  if (isIpAddress(host)) {
    return {};
  }

  const isPublic = await resolvesToPublicAddresses(host);
  return isPublic ? {} : { cancel: true };
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
