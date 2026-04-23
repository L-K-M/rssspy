(function () {
  "use strict";

  if (window !== window.top) {
    return;
  }

  const MAX_CANDIDATES = 32;
  const FEED_MIME_PATTERN =
    /\b(application\/(rss\+xml|atom\+xml|feed\+json)|text\/(rss\+xml|atom\+xml|xml)|application\/xml)\b/i;
  const FEED_URL_PATTERN =
    /(\/feed(?:\/|$|\?)|\/rss(?:\/|$|\?)|\/atom(?:\.xml)?$|\.rss($|\?)|\.atom($|\?)|\.xml($|\?)|jsonfeed)/i;
  const FEED_TEXT_PATTERN = /\b(rss|atom|feed|subscribe)\b/i;

  const candidatesByUrl = new Map();

  collectFromLinkTags();
  collectFromMetaTags();
  collectFromAnchors();
  collectFromDocumentSignals();
  collectFromHeuristicPaths();
  sendScanResults();

  function collectFromLinkTags() {
    const links = document.querySelectorAll("link[href]");

    for (const link of links) {
      const href = stringify(link.getAttribute("href"));
      if (!href) {
        continue;
      }

      const rel = stringify(link.getAttribute("rel")).toLowerCase();
      const type = stringify(link.getAttribute("type")).toLowerCase();
      const title = cleanTitle(link.getAttribute("title"));

      const relLooksFeed = rel.includes("alternate") || rel.includes("feed") || rel.includes("service.feed");
      const typeLooksFeed = isFeedType(type);
      const urlLooksFeed = looksLikeFeedUrl(href);

      if (relLooksFeed && (typeLooksFeed || urlLooksFeed)) {
        addCandidate(href, "meta-link", 100, title);
        continue;
      }

      if (typeLooksFeed) {
        addCandidate(href, "meta-link", 90, title);
        continue;
      }

      if (urlLooksFeed && rel.includes("alternate")) {
        addCandidate(href, "meta-link", 80, title);
      }
    }
  }

  function collectFromMetaTags() {
    const metaTags = document.querySelectorAll("meta");

    for (const meta of metaTags) {
      const content = stringify(meta.getAttribute("content")).trim();
      if (!content) {
        continue;
      }

      const keySpace = [
        stringify(meta.getAttribute("name")),
        stringify(meta.getAttribute("property")),
        stringify(meta.getAttribute("itemprop")),
        stringify(meta.getAttribute("http-equiv"))
      ]
        .join(" ")
        .toLowerCase();

      const metaSuggestsFeed = /\b(rss|atom|feed)\b/.test(keySpace);
      const contentSuggestsFeed = looksLikeFeedUrl(content);

      if (metaSuggestsFeed && contentSuggestsFeed) {
        addCandidate(content, "meta-tag", 78, "Meta feed reference");
        continue;
      }

      if (metaSuggestsFeed) {
        addCandidate(content, "meta-tag", 64, "Meta feed hint");
        continue;
      }

      if (contentSuggestsFeed && /\b(url|link|alternate|see_also)\b/.test(keySpace)) {
        addCandidate(content, "meta-tag", 58, "Meta URL hint");
      }

      if (keySpace.includes("refresh")) {
        const refreshUrl = extractRefreshUrl(content);
        if (refreshUrl && looksLikeFeedUrl(refreshUrl)) {
          addCandidate(refreshUrl, "meta-tag", 52, "Refresh feed hint");
        }
      }
    }
  }

  function collectFromAnchors() {
    const anchors = document.querySelectorAll("a[href]");
    const limit = Math.min(anchors.length, 1500);

    for (let index = 0; index < limit; index += 1) {
      const anchor = anchors[index];
      const href = stringify(anchor.getAttribute("href"));
      if (!href) {
        continue;
      }

      const type = stringify(anchor.getAttribute("type")).toLowerCase();
      const linkText = cleanTitle(
        `${stringify(anchor.textContent)} ${stringify(anchor.getAttribute("title"))}`
      );

      const textSuggestsFeed = FEED_TEXT_PATTERN.test(linkText);
      const urlSuggestsFeed = looksLikeFeedUrl(href);

      if (isFeedType(type)) {
        addCandidate(href, "page-link", 82, linkText);
        continue;
      }

      if (urlSuggestsFeed && textSuggestsFeed) {
        addCandidate(href, "page-link", 76, linkText);
        continue;
      }

      if (urlSuggestsFeed) {
        addCandidate(href, "page-link", 66, linkText);
        continue;
      }

      if (textSuggestsFeed && /xml|rss|atom|feed/i.test(href)) {
        addCandidate(href, "page-link", 60, linkText);
      }
    }
  }

  function collectFromDocumentSignals() {
    const contentType = stringify(document.contentType).toLowerCase();
    if (isFeedType(contentType)) {
      addCandidate(window.location.href, "document-content", 100, cleanTitle(document.title));
    }

    const rootName = document.documentElement
      ? stringify(document.documentElement.nodeName).toLowerCase()
      : "";
    if (rootName === "rss" || rootName === "feed" || rootName === "rdf:rdf") {
      addCandidate(window.location.href, "document-content", 100, cleanTitle(document.title));
    }

    const sample = document.documentElement
      ? stringify(document.documentElement.outerHTML).slice(0, 9000).toLowerCase()
      : "";

    if (sample.includes("<rss") || sample.includes("<feed") || sample.includes("jsonfeed.org/version/")) {
      addCandidate(window.location.href, "document-content", 90, cleanTitle(document.title));
    }

    if (hasWordPressGeneratorMeta()) {
      addCandidate("/feed", "heuristic", 54, "WordPress default feed");
    }
  }

  function collectFromHeuristicPaths() {
    const rootHeuristics = ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];
    for (const path of rootHeuristics) {
      addCandidate(path, "heuristic", 44, `Common feed path (${path})`);
    }

    const trimmedPath = window.location.pathname.replace(/\/+$/, "");
    if (!trimmedPath || trimmedPath === "/") {
      return;
    }

    const localHeuristics = [
      `${trimmedPath}/feed`,
      `${trimmedPath}/rss`,
      `${trimmedPath}/feed.xml`,
      `${trimmedPath}/atom.xml`
    ];

    for (const path of localHeuristics) {
      addCandidate(path, "heuristic", 36, `Local feed path (${path})`);
    }
  }

  function addCandidate(rawUrl, source, confidence, title) {
    const normalizedUrl = toHttpUrl(rawUrl, window.location.href);
    if (!normalizedUrl) {
      return;
    }

    const candidate = {
      url: normalizedUrl,
      source,
      confidence: clampConfidence(confidence),
      title: cleanTitle(title)
    };

    const existing = candidatesByUrl.get(candidate.url);
    if (!existing || candidate.confidence > existing.confidence) {
      candidatesByUrl.set(candidate.url, candidate);
      return;
    }

    if (!existing.title && candidate.title) {
      existing.title = candidate.title;
    }
  }

  function sendScanResults() {
    const candidates = Array.from(candidatesByUrl.values())
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, MAX_CANDIDATES);

    browser.runtime
      .sendMessage({
        type: "rssspy:scanResult",
        payload: {
          pageUrl: window.location.href,
          candidates
        }
      })
      .catch(() => {
        // Background may be unavailable during extension reload.
      });
  }

  function looksLikeFeedUrl(value) {
    return FEED_URL_PATTERN.test(stringify(value));
  }

  function isFeedType(value) {
    return FEED_MIME_PATTERN.test(stringify(value));
  }

  function hasWordPressGeneratorMeta() {
    const generator = document.querySelector("meta[name='generator']");
    if (!generator) {
      return false;
    }

    return stringify(generator.getAttribute("content")).toLowerCase().includes("wordpress");
  }

  function extractRefreshUrl(refreshContent) {
    const match = /url\s*=\s*([^;]+)/i.exec(stringify(refreshContent));
    return match ? match[1].trim() : "";
  }

  function toHttpUrl(rawUrl, baseUrl) {
    const value = stringify(rawUrl).trim();
    if (!value || value.startsWith("#")) {
      return null;
    }
    if (/^(mailto|javascript|tel):/i.test(value)) {
      return null;
    }

    try {
      const url = new URL(value, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
      url.hash = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function clampConfidence(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 50;
    }
    return Math.min(100, Math.max(0, Math.round(numeric)));
  }

  function cleanTitle(value) {
    return stringify(value).replace(/\s+/g, " ").trim().slice(0, 90);
  }

  function stringify(value) {
    return typeof value === "string" ? value : "";
  }
})();
