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
  // Well-known XML files that match the bare `.xml` rule above but are never
  // feeds; rejecting them up front saves candidate budget and probe requests.
  const NON_FEED_URL_PATTERN =
    /((^|\/)(sitemap[\w.-]*|wp-sitemap[\w.-]*|browserconfig|crossdomain|opensearch[\w.-]*)\.xml)($|\?)/i;
  const FEED_TEXT_PATTERN = /\b(rss|atom|feed|subscribe)\b/i;

  const candidatesByUrl = new Map();

  collectFromLinkTags();
  collectFromMetaTags();
  collectFromAnchors();
  collectFromDocumentSignals();
  collectFromSiteRecipes();
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
      // A feed MIME type or an explicit rel="feed" is an unambiguous declaration
      // by the page author; rel="alternate" alone (e.g. AMP/translations) is not.
      const declaresFeed = typeLooksFeed || rel.includes("feed");

      if (relLooksFeed && (typeLooksFeed || urlLooksFeed)) {
        addCandidate(href, "meta-link", 100, title, declaresFeed);
        continue;
      }

      if (typeLooksFeed) {
        addCandidate(href, "meta-link", 90, title, true);
        continue;
      }

      if (urlLooksFeed && rel.includes("alternate")) {
        addCandidate(href, "meta-link", 80, title, declaresFeed);
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

      // A feed-ish meta name alone is a weak signal; require the content to at
      // least look like a URL so values like "12" or "WordPress" don't resolve
      // into junk same-site candidates.
      if (metaSuggestsFeed && looksLikeUrlValue(content)) {
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
        addCandidate(href, "page-link", 82, linkText, true);
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
      addCandidate(window.location.href, "document-content", 100, cleanTitle(document.title), true);
    }

    const rootName = document.documentElement
      ? stringify(document.documentElement.nodeName).toLowerCase()
      : "";
    if (rootName === "rss" || rootName === "feed" || rootName === "rdf:rdf") {
      addCandidate(window.location.href, "document-content", 100, cleanTitle(document.title), true);
    }

    const sample = document.documentElement
      ? stringify(document.documentElement.outerHTML).slice(0, 9000).toLowerCase()
      : "";

    if (sample.includes("<rss") || sample.includes("<feed") || sample.includes("jsonfeed.org/version/")) {
      addCandidate(window.location.href, "document-content", 90, cleanTitle(document.title), true);
    }

    if (hasWordPressGeneratorMeta()) {
      addCandidate("/feed", "heuristic", 54, "WordPress default feed");
    }
  }

  // Recipes for well-known sites that have feeds but do not advertise them in
  // their markup. All recipe URLs stay on the current site (or a sibling
  // subdomain) so the background's same-site policy for non-explicit candidates
  // holds. The candidates are still validated like any other, so a recipe that
  // stops working simply yields nothing. Source is "site-recipe" (not
  // "heuristic") because these are near-certain hits that deserve validation in
  // the first batch.
  function collectFromSiteRecipes() {
    const host = window.location.hostname.toLowerCase();
    const path = window.location.pathname;

    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      const channelId = findYouTubeChannelId();
      if (channelId) {
        addCandidate(
          `${window.location.origin}/feeds/videos.xml?channel_id=${channelId}`,
          "site-recipe",
          88,
          "YouTube channel feed"
        );
      }

      const playlistMatch = /[?&]list=([\w-]{10,})/.exec(window.location.search);
      if (playlistMatch) {
        addCandidate(
          `${window.location.origin}/feeds/videos.xml?playlist_id=${playlistMatch[1]}`,
          "site-recipe",
          72,
          "YouTube playlist feed"
        );
      }
      return;
    }

    if (host === "github.com") {
      const reserved = new Set([
        "about", "collections", "contact", "customer-stories", "enterprise",
        "events", "explore", "features", "issues", "login", "marketplace",
        "new", "notifications", "orgs", "pricing", "pulls", "search",
        "settings", "sponsors", "topics", "trending"
      ]);
      const repoMatch = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/.exec(path);
      if (repoMatch && !reserved.has(repoMatch[1].toLowerCase())) {
        const repoBase = `/${repoMatch[1]}/${repoMatch[2]}`;
        addCandidate(`${repoBase}/commits.atom`, "site-recipe", 74, "GitHub commits feed");
        addCandidate(`${repoBase}/releases.atom`, "site-recipe", 72, "GitHub releases feed");
        addCandidate(`${repoBase}/tags.atom`, "site-recipe", 70, "GitHub tags feed");
      }
      return;
    }

    if (host === "reddit.com" || host.endsWith(".reddit.com")) {
      const redditMatch = /^\/(r|user|u)\/[\w-]+/.exec(path);
      if (redditMatch) {
        addCandidate(`${redditMatch[0]}/.rss`, "site-recipe", 78, "Reddit feed");
      }
    }
  }

  function findYouTubeChannelId() {
    const metaSelectors = ['meta[itemprop="identifier"]', 'meta[itemprop="channelId"]'];
    for (const selector of metaSelectors) {
      const meta = document.querySelector(selector);
      const value = meta ? stringify(meta.getAttribute("content")).trim() : "";
      if (/^UC[\w-]{16,}$/.test(value)) {
        return value;
      }
    }

    const urlSources = [
      window.location.href,
      readAttribute('link[rel="canonical"]', "href"),
      readAttribute('meta[property="og:url"]', "content")
    ];
    for (const urlSource of urlSources) {
      const match = /\/channel\/(UC[\w-]{16,})/.exec(stringify(urlSource));
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function readAttribute(selector, attribute) {
    const element = document.querySelector(selector);
    return element ? stringify(element.getAttribute(attribute)) : "";
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

  function addCandidate(rawUrl, source, confidence, title, explicit) {
    const normalizedUrl = toHttpUrl(rawUrl, window.location.href);
    if (!normalizedUrl) {
      return;
    }

    const candidate = {
      url: normalizedUrl,
      source,
      confidence: clampConfidence(confidence),
      title: cleanTitle(title),
      explicit: Boolean(explicit)
    };

    const existing = candidatesByUrl.get(candidate.url);
    if (!existing) {
      candidatesByUrl.set(candidate.url, candidate);
      return;
    }

    if (candidate.confidence > existing.confidence) {
      candidate.explicit = candidate.explicit || existing.explicit;
      if (!candidate.title && existing.title) {
        candidate.title = existing.title;
      }
      candidatesByUrl.set(candidate.url, candidate);
      return;
    }

    if (candidate.explicit) {
      existing.explicit = true;
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
    const text = stringify(value);
    if (NON_FEED_URL_PATTERN.test(text)) {
      return false;
    }
    return FEED_URL_PATTERN.test(text);
  }

  function isFeedType(value) {
    return FEED_MIME_PATTERN.test(stringify(value));
  }

  function looksLikeUrlValue(value) {
    const text = stringify(value).trim();
    return /^(https?:)?\/\//i.test(text) || text.startsWith("/") || text.startsWith("./");
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
