async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function findFeedsInPage() {
  const selectors = [
    'link[rel~="alternate"][type="application/rss+xml"]',
    'link[rel~="alternate"][type="application/atom+xml"]',
    'link[type="application/rdf+xml"]'
  ];
  const links = Array.from(document.querySelectorAll(selectors.join(",")));
  return links
    .map((link) => ({
      title: link.title || link.getAttribute("href"),
      href: link.href
    }))
    .filter((feed) => Boolean(feed.href));
}

async function detectFeeds(tabId) {
  const [result] = await browser.tabs.executeScript(tabId, {
    code: `(${findFeedsInPage.toString()})();`
  });
  return result || [];
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function setStatus(message) {
  const status = document.getElementById("status");
  status.textContent = message;
}

function renderFeeds(feeds) {
  const list = document.getElementById("feed-list");
  list.textContent = "";

  feeds.forEach((feed) => {
    const item = document.createElement("li");
    item.className = "feed-item";

    const label = document.createElement("span");
    label.className = "feed-label";
    label.textContent = feed.title || feed.href;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", async () => {
      await copyText(feed.href);
      setStatus("Copied feed URL.");
    });

    item.append(label, copyButton);
    list.appendChild(item);
  });
}

async function init() {
  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus("No active tab found.");
      return;
    }

    const feeds = await detectFeeds(tab.id);
    if (!feeds.length) {
      setStatus("No RSS/Atom feed found on this page.");
      return;
    }

    setStatus(`Found ${feeds.length} feed${feeds.length > 1 ? "s" : ""}.`);
    renderFeeds(feeds);
  } catch (error) {
    setStatus("Unable to inspect this page (some browser/system pages are restricted).");
    console.error(error);
  }
}

init();
