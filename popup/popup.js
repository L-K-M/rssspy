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

    const result = await fetchStateWithRetries(tab.id, 10, 300);

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

  setState(`Found ${feeds.length} feed${feeds.length === 1 ? "" : "s"}. Click to copy.`);
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
  meta.className = "feed-meta";
  meta.textContent = cleanLabel(feed.source) || "validated";

  button.appendChild(title);
  button.appendChild(url);
  button.appendChild(meta);

  button.addEventListener("click", () => {
    void copyFeedUrl(stringify(feed.url));
  });

  item.appendChild(button);
  return item;
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
