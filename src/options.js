"use strict";

import { loadConfig, saveConfig, clearProviderQuotaCache } from "./storage.js";

const form = document.querySelector("#settingsForm");
const status = document.querySelector("#status");
const clearButton = document.querySelector("#clearButton");
const versionTag = document.querySelector("#versionTag");

if (versionTag && chrome.runtime?.getManifest) {
  const manifest = chrome.runtime.getManifest();
  versionTag.textContent = `v${manifest.version}`;
  versionTag.title = `${manifest.name} v${manifest.version}`;
}

const controls = {
  claudeEnabled: document.querySelector("#claudeEnabled"),
  codexEnabled: document.querySelector("#codexEnabled"),
  refreshMinutes: document.querySelector("#refreshMinutes")
};

form.addEventListener("submit", saveSettings);
clearButton.addEventListener("click", clearCache);

init();

async function init() {
  const config = await loadConfig();
  controls.claudeEnabled.checked = config.providers.claude;
  controls.codexEnabled.checked = config.providers.codex;
  controls.refreshMinutes.value = config.refreshMinutes;
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await saveConfig({
      refreshMinutes: Number(controls.refreshMinutes.value),
      providers: {
        claude: controls.claudeEnabled.checked,
        codex: controls.codexEnabled.checked
      }
    });
    showStatus("Saved.");
  } catch (error) {
    showStatus(error.message ?? String(error), true);
  }
}

async function clearCache() {
  try {
    await clearProviderQuotaCache();
    showStatus("Cache cleared.");
  } catch (error) {
    showStatus(error.message ?? String(error), true);
  }
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "var(--critical)" : "var(--text-soft)";
}
