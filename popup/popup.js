"use strict";

const stateElement = document.getElementById("state");
const feedListElement = document.getElementById("feed-list");
const versionElement = document.getElementById("version");

document.addEventListener("DOMContentLoaded", () => {
  void initPopup();
});

async function initPopup() {
  renderVersion();
  setState("Scanning this page...");

  try {
    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      setState("No active tab available.", "error");
      return;
    }

    // A full scan can take ~30s in the worst case (two batches of candidates,
    // 7s fetch timeout each), so keep polling for as long as the popup is open
    // instead of giving up after a few seconds.
    const result = await fetchStateWithRetries(tab.id, 80, 400);

    renderResult(result);
  } catch (error) {
    console.error("RSS Spy popup failed", error);
    setState("Unable to read feed data.", "error");
  }
}

function renderVersion() {
  if (!versionElement || !browser.runtime || typeof browser.runtime.getManifest !== "function") {
    return;
  }

  const manifest = browser.runtime.getManifest();
  versionElement.textContent = manifest.version ? `Version ${manifest.version}` : "";
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length ? tabs[0] : null;
}

async function fetchStateWithRetries(tabId, maxAttempts, delayMs) {
  let result = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    result = await browser.runtime.sendMessage({
      type: "rssspy:getFeeds",
      tabId
    });

    if (!result || result.status !== "scanning") {
      return result;
    }

    if (attempt === 2) {
      setState("Validating feed candidates...");
    }

    if (attempt < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }

  return result;
}

function renderResult(result) {
  clearFeedList();

  if (!result || typeof result !== "object") {
    setState("No feed data available.");
    renderEmptyState("No feeds were detected on this page.");
    return;
  }

  if (result.status === "scanning") {
    setState("Still scanning this page...");
    renderEmptyState("Feed detection is still running. Reopen popup in a second.");
    return;
  }

  if (result.status === "error") {
    setState(result.error || "Feed detection failed.", "error");
    renderEmptyState("Try refreshing the page and opening the popup again.");
    return;
  }

  const feeds = Array.isArray(result.feeds) ? result.feeds : [];
  if (!feeds.length) {
    setState("No feeds found.");
    renderEmptyState("No RSS/Atom/JSON feed URLs were validated for this page.");
    return;
  }

  setState(
    `Found ${feeds.length} feed${feeds.length === 1 ? "" : "s"}. Click to copy, Ctrl+click to open.`
  );
  for (const feed of feeds) {
    feedListElement.appendChild(createFeedItem(feed));
  }
}

function createFeedItem(feed) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "feed-item";

  const title = document.createElement("span");
  title.className = "feed-title";
  title.textContent = cleanLabel(feed.title) || "Feed";

  const url = document.createElement("span");
  url.className = "feed-url";
  url.textContent = stringify(feed.url);

  const meta = document.createElement("span");
  meta.className = "feed-meta-row";
  meta.appendChild(createChip(formatLabel(feed.format), "feed-format"));
  if (feed.explicit) {
    meta.appendChild(createChip("declared by page", "feed-declared"));
  } else {
    meta.appendChild(createChip(cleanLabel(feed.source) || "validated", "feed-source"));
  }

  button.appendChild(title);
  button.appendChild(url);
  button.appendChild(meta);

  button.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey) {
      void openFeedUrl(stringify(feed.url));
      return;
    }
    void copyFeedUrl(stringify(feed.url));
  });

  button.addEventListener("auxclick", (event) => {
    if (event.button === 1) {
      void openFeedUrl(stringify(feed.url));
    }
  });

  item.appendChild(button);
  return item;
}

function createChip(text, className) {
  const chip = document.createElement("span");
  chip.className = `feed-chip ${className}`;
  chip.textContent = text;
  return chip;
}

function formatLabel(format) {
  switch (stringify(format)) {
    case "rss":
      return "RSS";
    case "atom":
      return "Atom";
    case "json":
      return "JSON Feed";
    default:
      return "Feed";
  }
}

async function openFeedUrl(url) {
  if (!url) {
    setState("Feed URL is empty.", "error");
    return;
  }

  try {
    await browser.tabs.create({ url, active: false });
    setState("Opened feed in a new tab.", "success");
  } catch (_error) {
    setState("Could not open the feed in a new tab.", "error");
  }
}

async function copyFeedUrl(url) {
  if (!url) {
    setState("Feed URL is empty.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    setState(`Copied: ${truncate(url, 60)}`, "success");
    return;
  } catch (_error) {
    // Try fallback copy.
  }

  const copied = fallbackCopy(url);
  if (copied) {
    setState(`Copied: ${truncate(url, 60)}`, "success");
    return;
  }

  setState("Clipboard copy failed. Copy the URL manually.", "error");
}

function fallbackCopy(value) {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "absolute";
  textArea.style.left = "-9999px";

  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  let success = false;
  try {
    success = document.execCommand("copy");
  } catch (_error) {
    success = false;
  }

  document.body.removeChild(textArea);
  return success;
}

function renderEmptyState(text) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  feedListElement.appendChild(item);
}

function clearFeedList() {
  while (feedListElement.firstChild) {
    feedListElement.removeChild(feedListElement.firstChild);
  }
}

function setState(text, style) {
  stateElement.textContent = text;
  stateElement.classList.remove("success", "error");
  if (style === "success" || style === "error") {
    stateElement.classList.add(style);
  }
}

function cleanLabel(value) {
  return stringify(value).replace(/\s+/g, " ").trim().slice(0, 80);
}

function truncate(value, maxLength) {
  const text = stringify(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function stringify(value) {
  return typeof value === "string" ? value : "";
}
