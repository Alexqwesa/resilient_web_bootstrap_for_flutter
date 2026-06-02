const LATEST_MANIFEST_URL = "/latest.json";
const LATEST_MANIFEST_NAME = "latest.json";
const LAST_GOOD_MANIFEST_KEY = "flutter.lastGoodManifest";
const NEXT_MANIFEST_KEY = "flutter.nextManifest";

function inferAppUpdateScriptSrc() {
  if (document.currentScript && document.currentScript.src) {
    return document.currentScript.src;
  }

  const scripts = document.getElementsByTagName("script");
  for (let i = scripts.length - 1; i >= 0; i -= 1) {
    const src = scripts[i] && scripts[i].src;
    if (src && /\/app_update\.js(?:\?|$)/.test(src)) {
      return src;
    }
  }

  return "";
}

function resolveSiblingAssetUrl(fileName) {
  const scriptSrc = inferAppUpdateScriptSrc();
  if (scriptSrc) {
    try {
      return new URL(fileName, scriptSrc).href;
    } catch (_) {
      // Fall back below.
    }
  }

  return `/${fileName}`;
}

const APP_UPDATE_BOOT_DOWNLOAD_HELPERS_URL = resolveSiblingAssetUrl("boot_download_helpers.js");

let appUpdateBootDownloadHelpersPromise = null;

function ensureBootDownloadHelpers() {
  if (window.BootDownloadHelpers) {
    return Promise.resolve(window.BootDownloadHelpers);
  }

  if (!appUpdateBootDownloadHelpersPromise) {
    appUpdateBootDownloadHelpersPromise = loadScript(APP_UPDATE_BOOT_DOWNLOAD_HELPERS_URL).then(() => {
      if (!window.BootDownloadHelpers) {
        throw new Error(`Cannot load ${APP_UPDATE_BOOT_DOWNLOAD_HELPERS_URL}`);
      }

      return window.BootDownloadHelpers;
    });
  }

  return appUpdateBootDownloadHelpersPromise;
}

function ensureUpdateBar() {
  let bar = document.getElementById("background-update-bar");

  if (!bar) {
    const style = document.createElement("style");
    style.textContent = `
      #background-update-bar {
        display: none;
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 100000;
        box-sizing: border-box;
        padding: 4px 8px;
        font-family: system-ui, sans-serif;
        font-size: 11px;
        color: #ffffff;
        background: #222222;
      }
      html.background-update-visible,
      body.background-update-visible {
        height: calc(100% - var(--background-update-bar-height, 0px)) !important;
      }
      body.background-update-visible {
        overflow: hidden;
      }
      #background-update-bar.visible { display: block; }
      #background-update-bar.done { background: #14532d; }
      #background-update-bar.error { background: #7f1d1d; }
      #background-update-top-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 2px;
      }
      #background-update-text {
        flex: 1 1 auto;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      #background-update-percent {
        flex: 0 0 auto;
        min-width: 42px;
        text-align: right;
      }
      #background-update-button,
      #background-update-hide-button {
        flex: 0 0 auto;
        border: 1px solid rgba(255, 255, 255, 0.35);
        border-radius: 6px;
        padding: 3px 10px;
        color: white;
        background: transparent;
        font: inherit;
        cursor: pointer;
      }
      #background-update-hide-button {
        display: none;
        width: 28px;
        padding-left: 0;
        padding-right: 0;
      }
      #background-update-hide-button.visible {
        display: inline-block;
      }
      #background-update-progress {
        display: block;
        width: 100%;
        height: 8px;
      }
    `;
    document.head.appendChild(style);

    bar = document.createElement("div");
    bar.id = "background-update-bar";
    bar.innerHTML = `
      <div id="background-update-top-row">
        <div id="background-update-text">New version is loading in background...</div>
        <div id="background-update-percent">0%</div>
        <button id="background-update-button" type="button">Pause</button>
        <button id="background-update-hide-button" type="button" title="Hide update bar">↓</button>
      </div>
      <progress id="background-update-progress" value="0" max="100"></progress>
    `;
    document.body.appendChild(bar);
  }
}

ensureUpdateBar();

const updateBar = document.getElementById("background-update-bar");
const updateText = document.getElementById("background-update-text");
const updatePercent = document.getElementById("background-update-percent");
const updateButton = document.getElementById("background-update-button");
const updateHideButton = document.getElementById("background-update-hide-button");
const updateProgress = document.getElementById("background-update-progress");

function reserveUpdateBarSpace() {
  const height = updateBar.offsetHeight;

  document.documentElement.style.setProperty(
    "--background-update-bar-height",
    `${height}px`,
  );
  document.documentElement.classList.add("background-update-visible");
  document.body.classList.add("background-update-visible");

  window.dispatchEvent(new Event("resize"));
}

function releaseUpdateBarSpace() {
  updateBar.classList.remove("visible");
  document.documentElement.classList.remove("background-update-visible");
  document.body.classList.remove("background-update-visible");
  document.documentElement.style.removeProperty("--background-update-bar-height");

  window.dispatchEvent(new Event("resize"));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FILE_READ_IDLE_MS = 25_000;
const FILE_RETRY_DELAY_MS = 2_000;
const FILE_MAX_ATTEMPTS = 200;


function waitForWindowLoad() {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    window.addEventListener("load", resolve, { once: true });
  });
}

function waitForFlutterRunning() {
  return new Promise(resolve => {
    window.addEventListener("flutter-first-frame", resolve, { once: true });
  });
}

function readManifestFromStorage(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readLastGoodManifest() {
  return readManifestFromStorage(LAST_GOOD_MANIFEST_KEY);
}

function readNextManifest() {
  return readManifestFromStorage(NEXT_MANIFEST_KEY);
}

function saveManifestToStorage(key, manifest) {
  localStorage.setItem(key, JSON.stringify(manifest));
}

function saveLastGoodManifest(manifest) {
  saveManifestToStorage(LAST_GOOD_MANIFEST_KEY, manifest);
}

function saveNextManifest(manifest) {
  saveManifestToStorage(NEXT_MANIFEST_KEY, manifest);
}

function removeNextManifest() {
  localStorage.removeItem(NEXT_MANIFEST_KEY);
}

function removeLastGoodManifest() {
  localStorage.removeItem(LAST_GOOD_MANIFEST_KEY);
}

function getBootstrapDownloadFile(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) {
    return null;
  }

  const bootstrapFile = manifest.files.find(file => file && file.path === "flutter_bootstrap.js");
  if (!bootstrapFile || !bootstrapFile.gzPath || !bootstrapFile.gzSize) {
    return null;
  }

  return bootstrapFile;
}

async function isManifestBootReady(helpers, manifest) {
  const bootstrapFile = getBootstrapDownloadFile(manifest);
  if (!bootstrapFile) {
    return true;
  }

  const transferUrl = `${manifest.base}${bootstrapFile.gzPath}`;
  if (typeof helpers.isPersistentBootDownloadReady === "function") {
    return await helpers.isPersistentBootDownloadReady(transferUrl, {
      label: bootstrapFile.gzPath,
      totalBytesHint: bootstrapFile.gzSize,
      expectedSha256: getTransferSha256(bootstrapFile),
    });
  }

  const cached = await helpers.readPersistentBootDownload(transferUrl);
  return !!(cached && cached.complete);
}

function isSameManifestVersion(left, right) {
  return !!left && !!right && String(left.version || '') === String(right.version || '');
}

function isHardUpdate(manifest) {
  return !!(manifest && manifest.hardUpdate === true);
}

async function discardLastGoodVersion(helpers, savedManifest, nextManifest) {
  removeLastGoodManifest();

  if (nextManifest) {
    await dismissStaleNextManifest(helpers, nextManifest);
  } else {
    removeNextManifest();
  }

  if (!savedManifest) {
    return;
  }

  const bootstrapFile = getBootstrapDownloadFile(savedManifest);
  if (!bootstrapFile || !bootstrapFile.gzPath) {
    return;
  }

  await helpers.deleteBootPersistentCacheNamespace(
    `${savedManifest.base}${bootstrapFile.gzPath}`,
  );
}

async function dismissStaleNextManifest(helpers, nextManifest) {
  removeNextManifest();
  if (nextManifest) {
    await helpers.deleteBootPersistentCacheNamespace(
      `${nextManifest.base}flutter_bootstrap.js.gz`,
    );
  }
}

function isVersionPinned() {
  return window.__resilientVersionPinned === true;
}

function resolveManifestUrl() {
  if (isVersionPinned()) {
    if (typeof window.resilientAssetUrl === "function") {
      return window.resilientAssetUrl(LATEST_MANIFEST_NAME);
    }

    const assetBase = window.__resilientAssetBase || "/";
    return new URL(LATEST_MANIFEST_NAME, window.location.origin + assetBase).toString();
  }

  return LATEST_MANIFEST_URL;
}

function resolveBootManifestUrl() {
  return resolveSiblingAssetUrl(LATEST_MANIFEST_NAME);
}

async function fetchManifestUrl(manifestUrl) {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Cannot load ${manifestUrl}`);
  }
  return await response.json();
}

async function fetchActiveManifest() {
  return await fetchManifestUrl(resolveManifestUrl());
}

async function fetchBootManifest() {
  return await fetchManifestUrl(resolveBootManifestUrl());
}

async function fetchLatestManifest() {
  return await fetchManifestUrl(LATEST_MANIFEST_URL);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Cannot load script: ${src}`));
    document.body.appendChild(script);
  });
}

function normalizeManifestFiles(manifest) {
  const useChromiumCanvasKit = window.crossOriginIsolated === true;

  return (manifest.files || [])
    .map(file => {
      if (typeof file === "string") {
        return { path: file, size: 0 };
      }

      return {
        path: file.path,
        size: Number(file.size || 0),
        sha256: file.sha256 || null,
        gzPath: file.gzPath || null,
        gzSize: Number(file.gzSize || 0),
        gzSha256: file.gzSha256 || null,
      };
    })
    .filter(file => {
      const isBootFile =
        file.path === "flutter_bootstrap.js" ||
        /^main\.dart\.(js|mjs)$/.test(file.path) ||
        file.path === "main_module.bootstrap.js" ||
        /^canvaskit\/(chromium\/)?canvaskit\.(js|wasm)$/.test(file.path) ||
        /^assets\/(AssetManifest|FontManifest)\.(bin|json)$/.test(file.path);

      if (!isBootFile) {
        return false;
      }

      if (file.path.startsWith("canvaskit/chromium/")) {
        return useChromiumCanvasKit;
      }

      if (file.path.startsWith("canvaskit/")) {
        return !useChromiumCanvasKit;
      }

      return true;
    });
}

function getTransferPath(file) {
  if (!file.gzPath) {
    throw new Error(`Missing gzip file for ${file.path}. Rebuild latest.json with gzPath/gzSize.`);
  }
  return file.gzPath;
}

function getTransferSize(file) {
  if (!file.gzPath || file.gzSize <= 0) {
    throw new Error(`Missing gzip size for ${file.path}. Rebuild latest.json with gzPath/gzSize.`);
  }
  return file.gzSize;
}

function getTransferSha256(file) {
  return file && file.gzPath
    ? (file.gzSha256 || file.gzHash || null)
    : (file && (file.sha256 || file.hash || null));
}

class BackgroundVersionDownloader {
  constructor(manifest) {
    this.manifest = manifest;
    this.files = normalizeManifestFiles(manifest);
    this.totalBytes = this.files.reduce((sum, file) => sum + getTransferSize(file), 0);
    this.fileIndex = 0;
    this.completedBytes = 0;
    this.currentFileLoadedBytes = 0;
    /** Never decreases for this download session — avoids % dipping on pause/resume / abort. */
    this.peakUiPercent = 0;
    this.running = false;
    this.paused = false;
    this.done = false;
    this.failed = false;
    this.abortController = null;
    this.resumeResolver = null;
  }

  updatePeakPercentUi() {
    const raw = this.getPercent();
    this.peakUiPercent = Math.max(this.peakUiPercent, raw);
    updateProgress.value = this.peakUiPercent;
    updatePercent.textContent = `${this.peakUiPercent}%`;
  }

  handleRunCatch(error) {
    this.running = false;

    if (this.paused) {
      this.renderPaused();
      return;
    }

    console.error("Background update failed:", error);
    this.renderError(error);
  }

  start() {
    if (this.running || this.done) return;
    this.running = true;
    this.failed = false;
    saveNextManifest(this.manifest);
    this.renderDownloading();

    this.run().catch(error => this.handleRunCatch(error));
  }

  retryAfterError() {
    if (!this.failed || this.done || this.running) return;
    this.failed = false;
    this.paused = false;
    this.running = true;
    updateBar.classList.remove("error");
    this.renderDownloading();
    this.run().catch(error => this.handleRunCatch(error));
  }

  pause() {
    if (this.done || !this.running) return;
    this.paused = true;
    if (this.abortController) this.abortController.abort();
    this.renderPaused();
  }

  resume() {
    if (this.done || !this.paused) return;
    this.paused = false;

    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }

    this.renderDownloading();
    if (!this.running) this.start();
  }

  async waitIfPaused() {
    while (this.paused) {
      await new Promise(resolve => {
        this.resumeResolver = resolve;
      });
    }
  }

  getPercent() {
    if (this.files.length === 0) return 100;

    if (this.totalBytes <= 0) {
      return Math.round((this.fileIndex / this.files.length) * 100);
    }

    const loaded = this.completedBytes + this.currentFileLoadedBytes;
    return Math.round(Math.max(0, Math.min(100, loaded / this.totalBytes * 100)));
  }

  setVisible() {
    updateBar.classList.add("visible");
    reserveUpdateBarSpace();
  }

  renderDownloading() {
    this.setVisible();
    updateBar.classList.remove("done");
    updateBar.classList.remove("error");

    const file = this.files[this.fileIndex];
    updateText.textContent = file
      ? `New version is loading in background: ${getTransferPath(file)}`
      : "New version is loading in background...";

    updateButton.disabled = false;
    updateButton.textContent = "Pause";
    updateHideButton.classList.remove("visible");

    this.updatePeakPercentUi();
  }

  renderPaused() {
    this.setVisible();
    updateBar.classList.remove("done");
    updateBar.classList.remove("error");
    updateButton.disabled = false;
    updateButton.textContent = "Resume";
    updateHideButton.classList.remove("visible");

    const file = this.files[this.fileIndex];
    const percent = this.peakUiPercent;
    updateText.textContent = file
      ? `Background update paused: ${getTransferPath(file)} (${percent}%)`
      : "Background update paused.";
    updateProgress.value = percent;
    updatePercent.textContent = `${percent}%`;
  }

  renderDone() {
    this.setVisible();
    updateBar.classList.add("done");
    updateBar.classList.remove("error");
    updateText.textContent = "New version is ready. Save your work or reload now.";
    updateButton.disabled = false;
    updateButton.textContent = "Reload now";
    updateHideButton.classList.add("visible");
    this.peakUiPercent = 100;
    updateProgress.value = 100;
    updatePercent.textContent = "100%";
  }

  renderError(error) {
    this.failed = true;
    this.setVisible();
    updateBar.classList.remove("done");
    updateBar.classList.add("error");
    updateText.textContent = `Background update failed: ${String(error.message || error)}`;
    updateButton.disabled = false;
    updateButton.textContent = "Resume";
    updateHideButton.classList.add("visible");
    updateProgress.value = this.peakUiPercent;
    updatePercent.textContent = `${this.peakUiPercent}%`;
  }

  async run() {
    while (this.fileIndex < this.files.length) {
      await this.waitIfPaused();

      const file = this.files[this.fileIndex];
      this.renderDownloading();

      try {
        const actualSize = await this.downloadFile(file);
        this.completedBytes += getTransferSize(file) || actualSize;
        this.currentFileLoadedBytes = 0;
        this.fileIndex += 1;
        this.renderDownloading();
        await delay(150);
      } catch (error) {
        if (this.paused || error.name === "AbortError") {
          // Keep partial progress so pause UI doesn't dip to a lower percent.
          this.renderPaused();
          await this.waitIfPaused();
          continue;
        }

        // downloadFile() owns transient retry/progress for the current file.
        // Do not reset progress here.
        throw error;
      }
    }

    this.selfTest();

    const latest = await fetchLatestManifest();
    if (!isSameManifestVersion(this.manifest, latest)) {
      console.warn("Downloaded next manifest is stale; dismissing it and restarting with latest manifest:", {
        downloaded: this.manifest.version,
        latest: latest.version,
      });
      removeNextManifest();
      if (!this.paused) {
        this.running = false;
        this.failed = false;
        this.done = false;
        activeDownloader = new BackgroundVersionDownloader(latest);
        activeDownloader.start();
      }
      return;
    }

    saveLastGoodManifest(this.manifest);
    removeNextManifest();
    await (await ensureBootDownloadHelpers()).cleanupStaleBootPersistentCacheNamespaces(
      `${this.manifest.base}flutter_bootstrap.js.gz`,
    );
    this.done = true;
    this.running = false;
    this.renderDone();
  }

  async downloadFile(file) {
    const transferPath = getTransferPath(file);
    const transferSize = getTransferSize(file);
    const url = `${this.manifest.base}${transferPath}`;
    const helpers = await ensureBootDownloadHelpers();
    const initialBytesLoaded = Number.isFinite(this.currentFileLoadedBytes) && this.currentFileLoadedBytes > 0
      ? this.currentFileLoadedBytes
      : 0;
    const expectedSha256 = getTransferSha256(file);
    let bestLoadedThisFile = initialBytesLoaded;

    this.abortController = new AbortController();

    try {
      const result = await helpers.downloadResumableBytes(
        url,
        {
          cache: "force-cache",
          priority: "low",
          signal: this.abortController.signal,
        },
        {
          label: transferPath,
          collectBytes: false,
          totalBytesHint: transferSize,
          // Hash validation requires the real previous bytes, not just the UI
          // progress counter. When a partial cache exists the helper resumes
          // from it; otherwise it must restart from byte 0.
          initialBytesLoaded: expectedSha256 ? 0 : initialBytesLoaded,
          idleMs: FILE_READ_IDLE_MS,
          maxAttempts: FILE_MAX_ATTEMPTS,
          retryDelayMs: FILE_RETRY_DELAY_MS,
          maxRetryDelayMs: 5_000,
          abortSignal: this.abortController.signal,
          expectedSha256: expectedSha256,
          onProgress: (loadedBytes) => {
            bestLoadedThisFile = Math.max(bestLoadedThisFile, loadedBytes);
            this.currentFileLoadedBytes = bestLoadedThisFile;
            this.renderDownloading();
          },
        },
      );

      this.currentFileLoadedBytes = bestLoadedThisFile;
      this.renderDownloading();

      return result.totalBytes || transferSize;
    } finally {
      this.abortController = null;
    }
  }

  selfTest() {
    const downloadedPaths = new Set(this.files.map(file => file.path));

    for (const path of ["flutter_bootstrap.js", "main.dart.js"]) {
      if (!downloadedPaths.has(path)) {
        throw new Error(`Downloaded version self-test failed: ${path}`);
      }
    }
  }
}

let activeDownloader = null;

updateButton.addEventListener("click", () => {
  if (!activeDownloader) return;

  if (activeDownloader.done) {
    location.reload();
    return;
  }

  if (activeDownloader.failed) {
    activeDownloader.retryAfterError();
    return;
  }

  if (activeDownloader.paused) {
    activeDownloader.resume();
  } else {
    activeDownloader.pause();
  }
});

updateHideButton.addEventListener("click", () => {
  releaseUpdateBarSpace();
});

async function bootFlutter(manifest) {
  window.__FLUTTER_MANIFEST__ = manifest;
  window.__FLUTTER_BUILD__ = manifest.version;
  const helpers = await ensureBootDownloadHelpers();
  const bootstrapFile = getBootstrapDownloadFile(manifest);

  if (!bootstrapFile || !bootstrapFile.gzPath || !bootstrapFile.gzSize) {
    await loadScript(`${manifest.base}flutter_bootstrap.js`);
    return;
  }

  const download = await helpers.downloadResumableBytes(
    `${manifest.base}${bootstrapFile.gzPath}`,
    {
      cache: "force-cache",
      priority: "high",
    },
    {
      label: "flutter_bootstrap.js",
      collectBytes: true,
      totalBytesHint: bootstrapFile.gzSize,
      idleMs: FILE_READ_IDLE_MS,
      maxAttempts: FILE_MAX_ATTEMPTS,
      retryDelayMs: FILE_RETRY_DELAY_MS,
      maxRetryDelayMs: 5_000,
      expectedSha256: getTransferSha256(bootstrapFile),
      strictRangeResume: false,
    },
  );

  const body = await helpers.gunzipArrayBuffer(download.bytes.buffer);
  const blobUrl = URL.createObjectURL(
    new Blob([body], { type: "application/javascript" }),
  );

  try {
    await loadScript(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function scheduleBackgroundUpdateCheck(runningManifest) {
  if (isVersionPinned()) {
    return;
  }

  await Promise.all([
    waitForFlutterRunning(),
    waitForWindowLoad(),
  ]);

  await delay(5000);

  const latest = await fetchLatestManifest();
  if (latest.version === runningManifest.version) return;

  if (isHardUpdate(latest)) {
    const savedManifest = readLastGoodManifest() || runningManifest;
    const nextManifest = readNextManifest();
    removeLastGoodManifest();
    removeNextManifest();
    console.info("Hard update available; saved manifests cleared before reload.", {
      running: runningManifest.version,
      latest: latest.version,
      lastGood: savedManifest && savedManifest.version,
      next: nextManifest && nextManifest.version,
    });
    const helpers = await ensureBootDownloadHelpers();
    await discardLastGoodVersion(
      helpers,
      savedManifest,
      nextManifest,
    );
    location.reload();
    return;
  }

  activeDownloader = new BackgroundVersionDownloader(latest);
  activeDownloader.start();
}

async function main() {
  const bootManifest = await fetchBootManifest();
  let manifestToRun = bootManifest;

  if (isVersionPinned()) {
    console.info("Version-pinned boot manifest selected:", {
      pinned: bootManifest.version,
      base: bootManifest.base,
    });
  } else {
    let nextManifest = readNextManifest();
    let savedManifest = readLastGoodManifest();
    let latest = bootManifest;

    try {
      latest = await fetchLatestManifest();
    } catch (error) {
      console.warn("Root latest.json is unavailable; booting embedded version manifest.", error);
    }

    if (isHardUpdate(latest)) {
      // index.html may already have cleared localStorage on hardUpdate preflight.
      console.info("Hard update requested; saved manifests cleared before boot.", {
        latest: latest.version,
        lastGood: savedManifest && savedManifest.version,
        next: nextManifest && nextManifest.version,
      });
      const helpers = await ensureBootDownloadHelpers();
      await discardLastGoodVersion(helpers, savedManifest, nextManifest);
      savedManifest = null;
      nextManifest = null;
    } else {
      const helpers = await ensureBootDownloadHelpers();
      manifestToRun = savedManifest || bootManifest;

      if (nextManifest) {
        if (!isSameManifestVersion(nextManifest, latest)) {
          console.warn("Saved next manifest does not match latest.json; dismissing it:", {
            next: nextManifest.version,
            latest: latest.version,
          });
          await dismissStaleNextManifest(helpers, nextManifest);
          nextManifest = null;
        } else if (await isManifestBootReady(helpers, nextManifest)) {
          saveLastGoodManifest(nextManifest);
          removeNextManifest();
          if (!savedManifest) {
            manifestToRun = nextManifest;
          }
          nextManifest = null;
        } else {
          console.warn("Saved next manifest is not boot-ready yet; keeping lastGoodManifest as default.");
        }
      }
    }

    window.addEventListener("flutter-first-frame", () => {
      saveLastGoodManifest(manifestToRun);
      const activeNextManifest = readNextManifest();
      if (activeNextManifest && manifestToRun.version === activeNextManifest.version) {
        removeNextManifest();
      }
    }, { once: true });

    console.info("Boot manifest selected:", {
      latest: latest.version,
      lastGood: savedManifest && savedManifest.version,
      next: nextManifest && nextManifest.version,
      run: manifestToRun && manifestToRun.version,
    });
  }

  await bootFlutter(manifestToRun);

  scheduleBackgroundUpdateCheck(manifestToRun).catch(error => {
    console.error("Background update check failed:", error);
  });
}

main().catch(error => {
  console.error("Application bootstrap failed:", error);

  document.body.innerHTML = `
    <div style="font-family: system-ui, sans-serif; padding: 24px; color: #222;">
      <h2>Cannot load application</h2>
      <p>Please press F5. If the problem continues, contact support.</p>
      <pre>${String(error.message || error)}</pre>
    </div>
  `;
});
