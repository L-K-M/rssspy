// Shared web-ext configuration, auto-discovered by every `web-ext` command
// (lint / build / sign / run). Keeps the packaged add-on to just its runtime
// files and writes artifacts to web-ext-artifacts/.
module.exports = {
  sourceDir: ".",
  artifactsDir: "web-ext-artifacts",
  // Everything that is NOT part of the shipped add-on. web-ext already ignores
  // dotfiles (.git, .github, .gitignore) and node_modules by default.
  ignoreFiles: [
    "scripts",
    "package.json",
    "package-lock.json",
    "web-ext-config.cjs",
    "CICD.md",
    "AGENTS.md",
    "media-sources",
    "web-ext-artifacts",
    "dist",
  ],
  build: {
    overwriteDest: true,
  },
};
