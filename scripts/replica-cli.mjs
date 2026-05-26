#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const DEFAULT_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];

const MAX_MIRROR_ASSET_BYTES = 75 * 1024 * 1024;
const MIRROR_ORIGINAL_PATH_PREFIXES = ["/_next/static/", "/assets/", "/vendor/"];
const MIRROR_ROOT_ASSET_PATTERN =
  /^\/(?:favicon(?:-[^/?#]+)?\.(?:ico|png|svg)|apple-touch-icon\.png|site\.webmanifest|web-app-manifest-\d+x\d+\.png|og\.png)$/;
const MIRROR_RUNTIME_ASSET_PREFIXES = [
  "antimetal",
  "cta/",
  "docs-category-icons/",
  "feature-icons/",
  "footer/",
  "header/",
  "home/",
  "integrations/",
];
const MIRROR_TEXT_RESOURCE_TYPES = new Set(["document", "script", "stylesheet"]);

const STYLE_PROPS = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "boxSizing",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "gap",
  "rowGap",
  "columnGap",
  "gridTemplateColumns",
  "gridTemplateRows",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "color",
  "backgroundColor",
  "backgroundImage",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "boxShadow",
  "opacity",
  "overflow",
];

const helpText = `
authorized-ui-replica CLI

Usage:
  replica-cli <url> [--out <dir>]
  replica-cli mirror <url> [--out <dir>] [--timeout <ms>] [--viewport <name>]
  replica-cli verify-mirror <mirror-dir>
  replica-cli capture <url> [--out <dir>] [--save-assets] [--timeout <ms>] [--max-elements <n>]
  replica-cli analyze <capture-dir>
  replica-cli detect-project <target-dir>
  replica-cli generate-brief <capture-dir> <target-dir> [--out <file>]
  replica-cli compare <reference-url-or-image> <local-url> [--out <dir>] [--threshold <n>] [--viewport <name>]

Notes:
  mirror is the default mode and saves a local source-level mirror.
  Commands do not bypass login, paywalls, CAPTCHA, or bot protections.
`;

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  if (error.cause) {
    console.error(error.cause);
  }
  process.exit(1);
});

async function main() {
  const { command, positional, options } = parseCli(process.argv.slice(2));

  if (!command || command === "help" || options.help || options.h) {
    process.stdout.write(helpText.trimStart());
    return;
  }

  if (command === "mirror") {
    await mirrorCommand(positional, options);
    return;
  }

  if (looksLikeSourceInput(command)) {
    await mirrorCommand([command, ...positional], options);
    return;
  }

  if (command === "verify-mirror") {
    await verifyMirrorCommand(positional);
    return;
  }

  if (command === "capture") {
    await captureCommand(positional, options);
    return;
  }

  if (command === "analyze") {
    const captureDir = requireArg(positional[0], "capture-dir");
    const spec = await analyzeCapture(path.resolve(captureDir), { write: true });
    console.log(`Wrote ${spec.files.json}`);
    console.log(`Wrote ${spec.files.markdown}`);
    return;
  }

  if (command === "detect-project") {
    const targetDir = requireArg(positional[0], "target-dir");
    console.log(JSON.stringify(await detectProject(path.resolve(targetDir)), null, 2));
    return;
  }

  if (command === "generate-brief") {
    await generateBriefCommand(positional, options);
    return;
  }

  if (command === "compare") {
    await compareCommand(positional, options);
    return;
  }

  throw new Error(`Unknown command '${command}'. Run with 'help' for usage.`);
}

function parseCli(argv) {
  const positional = [];
  const options = {};
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        options[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
        continue;
      }

      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      options[arg.slice(1)] = true;
      continue;
    }

    positional.push(arg);
  }

  return { command, positional, options };
}

function requireArg(value, label) {
  if (!value) {
    throw new Error(`Missing required argument: ${label}`);
  }
  return value;
}

async function mirrorCommand(positional, options) {
  const input = requireArg(positional[0], "url");
  const sourceUrl = normalizeUrlOrPath(input);
  const timeout = parsePositiveInt(options.timeout, 30000);
  const viewportName = options.viewport || "desktop";
  const viewport = DEFAULT_VIEWPORTS.find((item) => item.name === viewportName);
  if (!viewport) {
    throw new Error(`Unknown viewport '${viewportName}'. Use desktop, tablet, or mobile.`);
  }
  const outDir = path.resolve(
    options.out || path.join("replica-mirrors", `${slugFromUrl(sourceUrl)}-${timestamp()}`),
  );

  await ensureDir(outDir);
  await ensureDir(path.join(outDir, "assets"));

  const browser = await launchChromium();
  const mirrorState = {
    sourceUrl,
    outDir,
    assetDir: path.join(outDir, "assets"),
    entries: new Map(),
    pendingWrites: [],
  };

  let pageHtml = "";
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.on("response", (response) => {
      const task = recordMirrorResponse(response, mirrorState).catch(() => {});
      mirrorState.pendingWrites.push(task);
    });

    const mainResponse = await page.goto(sourceUrl, { waitUntil: "load", timeout });
    pageHtml = (await mainResponse?.text().catch(() => "")) || "";
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(parsePositiveInt(options["settle-ms"], 500));
    const hydratedHtml = await page.content();
    pageHtml ||= hydratedHtml;
    mirrorState.hydratedHtml = hydratedHtml;
    await page.screenshot({ path: path.join(outDir, "screenshot.png"), fullPage: true });
    await context.close();
  } finally {
    await browser.close();
  }

  await Promise.allSettled(mirrorState.pendingWrites);
  await downloadHtmlReferencedMirrorAssets(`${pageHtml}\n${mirrorState.hydratedHtml || ""}`, mirrorState);
  await downloadRuntimeDiscoveredMirrorAssets(`${pageHtml}\n${mirrorState.hydratedHtml || ""}`, mirrorState);
  const entries = [...mirrorState.entries.values()].sort((a, b) => a.url.localeCompare(b.url));
  const urlMap = Object.fromEntries(entries.filter((entry) => entry.localPath).map((entry) => [entry.url, entry.localPath]));
  await rewriteSavedCssAssets(entries, urlMap, sourceUrl, outDir);
  await rewriteSavedScriptReferences(entries, urlMap, sourceUrl, outDir);

  const rewrittenHtml = rewriteHtml(pageHtml, {
    sourceUrl,
    urlMap,
    keepExternalScripts: Boolean(options["keep-external-scripts"]),
  });

  const indexPath = path.join(outDir, "index.html");
  await fsp.writeFile(indexPath, rewrittenHtml, "utf8");

  const manifest = {
    tool: "authorized-ui-replica",
    mode: "mirror",
    version: "0.1.0",
    mirroredAt: new Date().toISOString(),
    sourceUrl,
    viewport,
    index: "index.html",
    screenshot: "screenshot.png",
    notes: [
      "This is a source-level mirror for authorized pages.",
      "Verify rights for images, fonts, logos, scripts, stylesheets, and copy before publication.",
      "Dynamic API calls, authentication, service workers, and SPA runtime behavior may still depend on the original site.",
    ],
    resources: entries,
  };
  await writeJson(path.join(outDir, "mirror-manifest.json"), manifest);
  await fsp.writeFile(path.join(outDir, "license-review.md"), renderLicenseReview(manifest), "utf8");

  console.log(`Mirror written to ${outDir}`);
  console.log(`Open ${indexPath}`);
}

async function verifyMirrorCommand(positional) {
  const mirrorDir = path.resolve(requireArg(positional[0], "mirror-dir"));
  const report = await verifyMirrorDirectory(mirrorDir);
  const reportPath = path.join(mirrorDir, "mirror-verify.json");
  await writeJson(reportPath, report);
  if (!report.ok) {
    console.error(`Mirror verification failed. Wrote ${reportPath}`);
    for (const issue of report.issues.slice(0, 20)) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Mirror verification passed. Wrote ${reportPath}`);
}

async function captureCommand(positional, options) {
  const input = requireArg(positional[0], "url");
  const sourceUrl = normalizeUrlOrPath(input);
  const saveAssets = Boolean(options["save-assets"]);
  const timeout = parsePositiveInt(options.timeout, 30000);
  const maxElements = parsePositiveInt(options["max-elements"], 800);
  const outDir = path.resolve(
    options.out || path.join("replica-captures", `${slugFromUrl(sourceUrl)}-${timestamp()}`),
  );

  await ensureDir(outDir);
  await ensureDir(path.join(outDir, "viewports"));
  if (saveAssets) {
    await ensureDir(path.join(outDir, "assets"));
  }

  const browser = await launchChromium();
  const networkEntries = new Map();
  const pendingWrites = [];
  const viewportResults = [];

  try {
    for (const viewport of DEFAULT_VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      attachNetworkTracking(page, {
        outDir,
        saveAssets,
        networkEntries,
        pendingWrites,
        viewportName: viewport.name,
      });

      await page.goto(sourceUrl, { waitUntil: "load", timeout });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(parsePositiveInt(options["settle-ms"], 500));

      const base = path.join(outDir, "viewports", viewport.name);
      const screenshotPath = `${base}.png`;
      const htmlPath = `${base}.html`;
      const domPath = `${base}.dom.json`;
      const stylesPath = `${base}.styles.json`;
      const cssVarsPath = `${base}.css-vars.json`;
      const cssRulesPath = `${base}.css-rules.json`;
      const domAssetsPath = `${base}.dom-assets.json`;

      await page.screenshot({ path: screenshotPath, fullPage: true });
      await fsp.writeFile(htmlPath, await page.content(), "utf8");

      const pageFacts = await extractPageFacts(page, maxElements);
      await writeJson(domPath, pageFacts.dom);
      await writeJson(stylesPath, pageFacts.styles);
      await writeJson(cssVarsPath, pageFacts.cssVariables);
      await writeJson(cssRulesPath, pageFacts.cssRules);
      await writeJson(domAssetsPath, pageFacts.domAssets);

      viewportResults.push({
        ...viewport,
        files: {
          screenshot: relativePath(outDir, screenshotPath),
          html: relativePath(outDir, htmlPath),
          dom: relativePath(outDir, domPath),
          styles: relativePath(outDir, stylesPath),
          cssVariables: relativePath(outDir, cssVarsPath),
          cssRules: relativePath(outDir, cssRulesPath),
          domAssets: relativePath(outDir, domAssetsPath),
        },
      });

      await context.close();
    }
  } finally {
    await browser.close();
  }

  await Promise.allSettled(pendingWrites);
  const networkManifest = [...networkEntries.values()].sort((a, b) => a.url.localeCompare(b.url));
  const manifestPath = path.join(outDir, "network-manifest.json");
  await writeJson(manifestPath, networkManifest);

  const capture = {
    tool: "authorized-ui-replica",
    version: "0.1.0",
    capturedAt: new Date().toISOString(),
    sourceUrl,
    saveAssets,
    assetPolicy: saveAssets
      ? "Assets were saved for authorized review; verify licenses before reuse."
      : "Third-party assets were inventoried only and should be replaced unless separately authorized.",
    viewports: viewportResults,
    files: {
      networkManifest: relativePath(outDir, manifestPath),
    },
  };

  const capturePath = path.join(outDir, "capture.json");
  await writeJson(capturePath, capture);
  console.log(`Capture written to ${outDir}`);
}

async function extractPageFacts(page, maxElements) {
  return page.evaluate(
    ({ props, max }) => {
      const textOf = (el, limit = 120) => {
        const raw = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return raw.length > limit ? `${raw.slice(0, limit - 1)}...` : raw;
      };

      const selectorFor = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts = [];
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
          let part = current.localName;
          if (current.classList.length) {
            part += `.${[...current.classList].slice(0, 3).map((name) => CSS.escape(name)).join(".")}`;
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter((child) => child.localName === current.localName);
            if (siblings.length > 1) {
              part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
          }
          parts.unshift(part);
          current = current.parentElement;
          if (parts.length >= 5) break;
        }
        return parts.length ? parts.join(" > ") : el.localName;
      };

      const rectFor = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };

      const isVisible = (el, style = getComputedStyle(el)) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
        );
      };

      let domCount = 0;
      const walk = (el, depth = 0) => {
        if (!el || domCount >= max || depth > 7) return null;
        const style = getComputedStyle(el);
        if (depth > 0 && !isVisible(el, style)) return null;
        domCount += 1;

        const children = [];
        for (const child of [...el.children].slice(0, 40)) {
          const item = walk(child, depth + 1);
          if (item) children.push(item);
          if (domCount >= max) break;
        }

        return {
          tag: el.localName,
          id: el.id || null,
          classes: [...el.classList].slice(0, 12),
          role: el.getAttribute("role"),
          ariaLabel: el.getAttribute("aria-label"),
          selector: selectorFor(el),
          text: textOf(el),
          rect: rectFor(el),
          children,
        };
      };

      const styles = [...document.querySelectorAll("body *")]
        .slice(0, max * 2)
        .filter((el) => isVisible(el))
        .slice(0, max)
        .map((el) => {
          const computed = getComputedStyle(el);
          const style = {};
          for (const prop of props) {
            style[prop] = computed[prop];
          }
          return {
            tag: el.localName,
            id: el.id || null,
            classes: [...el.classList].slice(0, 12),
            role: el.getAttribute("role"),
            selector: selectorFor(el),
            text: textOf(el, 100),
            rect: rectFor(el),
            style,
          };
        });

      const rootStyle = getComputedStyle(document.documentElement);
      const cssVariables = {};
      for (let index = 0; index < rootStyle.length; index += 1) {
        const name = rootStyle[index];
        if (name.startsWith("--")) {
          cssVariables[name] = rootStyle.getPropertyValue(name).trim();
        }
      }

      const cssRules = [];
      for (const sheet of [...document.styleSheets]) {
        const item = { href: sheet.href, rules: [], readable: true };
        try {
          const rules = [...sheet.cssRules].slice(0, 250);
          item.rules = rules.map((rule) => rule.cssText).filter(Boolean);
        } catch (error) {
          item.readable = false;
          item.error = error.message;
        }
        cssRules.push(item);
      }

      const domAssets = [...document.querySelectorAll("img, source, link, script, video, audio, use")]
        .map((el) => ({
          tag: el.localName,
          selector: selectorFor(el),
          src: el.getAttribute("src"),
          href: el.getAttribute("href"),
          srcset: el.getAttribute("srcset"),
          rel: el.getAttribute("rel"),
          type: el.getAttribute("type"),
          alt: el.getAttribute("alt"),
        }))
        .filter((item) => item.src || item.href || item.srcset);

      return {
        dom: walk(document.body),
        styles,
        cssVariables,
        cssRules,
        domAssets,
      };
    },
    { props: STYLE_PROPS, max: maxElements },
  );
}

function attachNetworkTracking(page, config) {
  page.on("response", (response) => {
    const task = recordResponse(response, config).catch(() => {});
    config.pendingWrites.push(task);
  });
}

async function recordResponse(response, config) {
  const request = response.request();
  const url = response.url();
  const headers = response.headers();
  const mimeType = headers["content-type"] || "";
  const resourceType = request.resourceType();
  const key = `${url}|${resourceType}`;
  const existing = config.networkEntries.get(key);
  const disposition = classifyDisposition(resourceType, mimeType, config.saveAssets);

  const entry =
    existing ||
    {
      url,
      method: request.method(),
      resourceType,
      status: response.status(),
      mimeType,
      disposition,
      viewports: [],
    };

  if (!entry.viewports.includes(config.viewportName)) {
    entry.viewports.push(config.viewportName);
  }

  if (config.saveAssets && !entry.localPath && isSavableAsset(resourceType, mimeType) && response.status() < 400) {
    const body = await response.body().catch(() => null);
    if (body && body.length <= 20 * 1024 * 1024) {
      const assetDir = path.join(config.outDir, "assets");
      await ensureDir(assetDir);
      const filename = `${resourceType}-${shortHash(url)}${extensionFor(url, mimeType)}`;
      const assetPath = path.join(assetDir, filename);
      await fsp.writeFile(assetPath, body);
      entry.localPath = relativePath(config.outDir, assetPath);
      entry.bytes = body.length;
    }
  }

  config.networkEntries.set(key, entry);
}

function classifyDisposition(resourceType, mimeType, saveAssets) {
  if (resourceType === "image" || mimeType.startsWith("image/")) {
    return saveAssets ? "licensed-review-required" : "replace";
  }
  if (resourceType === "font" || mimeType.includes("font") || mimeType.includes("woff")) {
    return saveAssets ? "licensed-review-required" : "replace";
  }
  if (resourceType === "stylesheet" || resourceType === "script") {
    return saveAssets ? "reference-only-saved" : "reference-only";
  }
  return "manifest-only";
}

function isSavableAsset(resourceType, mimeType) {
  return (
    ["image", "font", "stylesheet", "script"].includes(resourceType) ||
    mimeType.startsWith("image/") ||
    mimeType.includes("font") ||
    mimeType.includes("css") ||
    mimeType.includes("javascript")
  );
}

async function recordMirrorResponse(response, state) {
  const request = response.request();
  const url = response.url();
  const headers = response.headers();
  const mimeType = headers["content-type"] || "";
  const resourceType = request.resourceType();
  const status = response.status();
  const key = `${url}|${resourceType}`;
  const existing = state.entries.get(key);
  const entry =
    existing ||
    {
      url,
      method: request.method(),
      resourceType,
      status,
      mimeType,
      disposition: classifyMirrorDisposition(resourceType, mimeType, url),
      originalPath: pathFromUrl(url),
    };

  if (!existing && status < 400 && isMirrorAsset(resourceType, mimeType, url)) {
    const body =
      status === 206
        ? await fetchMirrorAssetBody(url).catch(() => null)
        : (await response.body().catch(() => null)) || (await fetchMirrorAssetBody(url).catch(() => null));
    await saveMirrorEntryBody(entry, body, state, resourceType, mimeType);
  }

  state.entries.set(key, entry);
}

function classifyMirrorDisposition(resourceType, mimeType, url = "") {
  if (resourceType === "image" || mimeType.startsWith("image/")) return "saved-review-license";
  if (resourceType === "font" || mimeType.includes("font") || mimeType.includes("woff")) return "saved-review-license";
  if (resourceType === "media" || mimeType.startsWith("video/") || mimeType.startsWith("audio/")) return "saved-review-license";
  if (isLottieUrl(url)) return "saved-review-license";
  if (isWasmAsset(url, mimeType)) return "saved-runtime-reference";
  if (resourceType === "stylesheet") return "saved-reference";
  if (resourceType === "script") return "saved-runtime-reference";
  if (resourceType === "document") return "source-document";
  return "manifest-only";
}

function isMirrorAsset(resourceType, mimeType, url = "") {
  return (
    ["image", "font", "stylesheet", "script", "media"].includes(resourceType) ||
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType.includes("font") ||
    mimeType.includes("woff") ||
    mimeType.includes("css") ||
    mimeType.includes("javascript") ||
    isLottieUrl(url) ||
    isWasmAsset(url, mimeType)
  );
}

async function downloadHtmlReferencedMirrorAssets(html, state) {
  const urls = extractMirrorAssetUrls(html, state.sourceUrl);
  for (const url of urls) {
    await downloadMirrorAssetUrl(url, state, "referenced");
  }
}

async function downloadRuntimeDiscoveredMirrorAssets(html, state) {
  const visited = new Set();
  let text = html;

  for (let pass = 0; pass < 4; pass += 1) {
    const urls = extractRuntimeMirrorAssetUrls(text, state.sourceUrl);
    let saved = 0;

    for (const url of urls) {
      if (visited.has(url)) continue;
      visited.add(url);
      const entry = await downloadMirrorAssetUrl(url, state, "runtime-discovered");
      if (entry?.localPath) saved += 1;
    }

    const nextText = await readSavedMirrorText(state);
    if (saved === 0 && nextText === text) break;
    text = nextText;
  }
}

async function downloadMirrorAssetUrl(url, state, reason) {
  if ([...state.entries.values()].some((entry) => entry.url === url && entry.localPath)) return null;

  const bodyResult = await fetchMirrorAsset(url).catch(() => null);
  if (!bodyResult) return null;

  const resourceType = inferResourceType(url, bodyResult.mimeType);
  const entry = {
    url,
    method: "GET",
    resourceType,
    status: bodyResult.status,
    mimeType: bodyResult.mimeType,
    disposition: classifyMirrorDisposition(resourceType, bodyResult.mimeType, url),
    originalPath: pathFromUrl(url),
  };
  await saveMirrorEntryBody(entry, bodyResult.body, state, resourceType, bodyResult.mimeType);
  state.entries.set(`${url}|${reason}`, entry);
  return entry;
}

function extractMirrorAssetUrls(html, sourceUrl) {
  const source = new URL(sourceUrl);
  const urls = new Set();
  const rootPattern = /\/(?:_next\/static|assets|vendor)\/[^\s"'<>),\\]+/g;
  const absolutePattern = new RegExp(`${escapeRegExp(source.origin)}\\/(?:_next\\/static|assets|vendor)\\/[^\\s"'<>),\\\\]+`, "g");
  const rootFilePattern =
    /\/(?:favicon(?:-[^/?#\s"'<>),\\]+)?\.(?:ico|png|svg)|apple-touch-icon\.png|site\.webmanifest|web-app-manifest-\d+x\d+\.png|og\.png)(?:[?#][^\s"'<>),\\]+)?/g;

  for (const match of html.matchAll(rootPattern)) {
    urls.add(new URL(match[0].replace(/&amp;/g, "&"), sourceUrl).href);
  }
  for (const match of html.matchAll(absolutePattern)) {
    urls.add(match[0].replace(/&amp;/g, "&"));
  }
  for (const match of html.matchAll(rootFilePattern)) {
    urls.add(new URL(match[0].replace(/&amp;/g, "&"), sourceUrl).href);
  }
  return [...urls].filter((url) => {
    try {
      const parsed = new URL(url);
      return isMirrorRootPath(parsed.pathname);
    } catch {
      return false;
    }
  });
}

function extractRuntimeMirrorAssetUrls(text, sourceUrl) {
  const urls = new Set(extractMirrorAssetUrls(text, sourceUrl));

  for (const stem of extractRuntimeMirrorAssetStems(text)) {
    for (const pathSuffix of runtimeAssetPathCandidates(stem)) {
      urls.add(new URL(`/assets/${pathSuffix}`, sourceUrl).href);
    }
  }

  return [...urls];
}

function extractRuntimeMirrorAssetStems(text) {
  const stems = new Set();
  const stringPattern = /(?<![A-Za-z0-9_./-])((?:antimetal|cta|docs-category-icons|feature-icons|footer|home|integrations)(?:\/[A-Za-z0-9_.-]+){0,8})(?![A-Za-z0-9_./-])/g;

  for (const match of text.matchAll(stringPattern)) {
    const stem = normalizeRuntimeAssetStem(match[1]);
    if (stem && isRuntimeAssetStem(stem)) stems.add(stem);
  }

  return [...stems];
}

function normalizeRuntimeAssetStem(stem) {
  return String(stem)
    .replace(/^\/+/, "")
    .replace(/^assets\//, "")
    .replace(/^assets-original\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/[?#].*$/, "");
}

function isRuntimeAssetStem(stem) {
  return (
    !stem.includes("..") &&
    MIRROR_RUNTIME_ASSET_PREFIXES.some((prefix) => stem === prefix.replace(/\/$/, "") || stem.startsWith(prefix))
  );
}

function runtimeAssetPathCandidates(stem) {
  const candidates = new Set();
  if (path.posix.extname(stem)) {
    candidates.add(stem);
    return [...candidates];
  }

  if (/(^|\/)video(?:-|$)|video$/i.test(stem)) {
    candidates.add(`${stem}.mp4`);
  }

  if (/lottie/i.test(stem)) {
    candidates.add(`${stem}.lottie`);
  }

  if (/^(?:docs-category-icons|feature-icons)\//.test(stem)) {
    candidates.add(`${stem}.lottie`);
    candidates.add(`${stem}-dark.lottie`);
  }

  candidates.add(`${stem}.avif`);
  candidates.add(`${stem}-dark.avif`);
  return [...candidates];
}

async function readSavedMirrorText(state) {
  const chunks = [state.hydratedHtml || ""];
  for (const entry of state.entries.values()) {
    if (!entry.localPath || !MIRROR_TEXT_RESOURCE_TYPES.has(entry.resourceType)) continue;
    const filePath = path.join(state.outDir, entry.localPath);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || stat.size > 5 * 1024 * 1024) continue;
    const text = await fsp.readFile(filePath, "utf8").catch(() => null);
    if (text !== null) chunks.push(text);
  }
  return chunks.join("\n");
}

async function fetchMirrorAsset(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const mimeType = response.headers.get("content-type") || "";
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_MIRROR_ASSET_BYTES) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_MIRROR_ASSET_BYTES) return null;
  return { body, status: response.status, mimeType };
}

async function fetchMirrorAssetBody(url) {
  return (await fetchMirrorAsset(url))?.body || null;
}

async function saveMirrorEntryBody(entry, body, state, resourceType, mimeType) {
  if (!body || body.length > MAX_MIRROR_ASSET_BYTES) return;

  const localPath = originalRootAssetLocalPath(entry.url, state.sourceUrl) || `assets/${resourceType}-${shortHash(entry.url)}${extensionFor(entry.url, mimeType)}`;
  const assetPath = path.join(state.outDir, localPath);
  await ensureDir(path.dirname(assetPath));
  await fsp.writeFile(assetPath, body);
  entry.localPath = relativePath(state.outDir, assetPath);
  entry.bytes = body.length;
}

function originalRootAssetLocalPath(inputUrl, sourceUrl) {
  try {
    const input = new URL(inputUrl);
    const source = new URL(sourceUrl);
    if (input.origin !== source.origin) return null;
    if (!isMirrorRootPath(input.pathname)) return null;
    return decodeURIComponent(input.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function isMirrorRootPath(pathname) {
  return MIRROR_ORIGINAL_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || MIRROR_ROOT_ASSET_PATTERN.test(pathname);
}

function inferResourceType(url, mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("font/") || mimeType.includes("woff")) return "font";
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) return "media";
  if (mimeType.includes("css")) return "stylesheet";
  if (mimeType.includes("javascript")) return "script";
  if (isWasmAsset(url, mimeType) || isLottieUrl(url)) return "fetch";
  return "fetch";
}

function isLottieUrl(url) {
  return pathFromUrl(url).endsWith(".lottie");
}

function isWasmAsset(url, mimeType) {
  return mimeType.includes("wasm") || pathFromUrl(url).endsWith(".wasm");
}

async function rewriteSavedCssAssets(entries, urlMap, sourceUrl, outDir) {
  const cssEntries = entries.filter((entry) => entry.localPath && entry.resourceType === "stylesheet");
  for (const entry of cssEntries) {
    const cssPath = path.join(outDir, entry.localPath);
    let css = await fsp.readFile(cssPath, "utf8").catch(() => null);
    if (css === null) continue;

    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, rawUrl) => {
      const rewritten = mirrorRelativeUrl(rawUrl, entry.url, urlMap);
      return rewritten ? `url(${quote}${relativeLocalAssetPath(entry.localPath, rewritten)}${quote})` : match;
    });

    css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, rawUrl) => {
      const rewritten = mirrorRelativeUrl(rawUrl, entry.url, urlMap);
      return rewritten ? `@import ${quote}${relativeLocalAssetPath(entry.localPath, rewritten)}${quote}` : match;
    });

    css = css.replace(/@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, rawUrl) => {
      const rewritten = mirrorRelativeUrl(rawUrl, entry.url, urlMap);
      return rewritten ? `@import url(${quote}${relativeLocalAssetPath(entry.localPath, rewritten)}${quote})` : match;
    });

    await fsp.writeFile(cssPath, css, "utf8");
  }
}

async function rewriteSavedScriptReferences(entries, urlMap, sourceUrl, outDir) {
  const scriptEntries = entries.filter((entry) => entry.localPath && entry.resourceType === "script");
  if (!scriptEntries.length) return;

  const sourceOrigin = new URL(sourceUrl).origin;
  const replacements = [...entries]
    .filter((entry) => entry.localPath)
    .flatMap((entry) => {
      const url = new URL(entry.url);
      if (url.origin !== sourceOrigin) return [];
      const localRootPath = `/${entry.localPath}`;
      const localRootUrl = `${localRootPath}${url.search}${url.hash}`;
      return [
        [entry.url, entry.localPath],
        [`${sourceOrigin}${url.pathname}${url.search}${url.hash}`, localRootUrl],
        [`${sourceOrigin}${url.pathname}`, localRootPath],
        [url.pathname, localRootPath],
        [`${url.pathname}${url.search}${url.hash}`, localRootUrl],
      ];
    })
    .sort((a, b) => b[0].length - a[0].length);

  for (const entry of scriptEntries) {
    const scriptPath = path.join(outDir, entry.localPath);
    let js = await fsp.readFile(scriptPath, "utf8").catch(() => null);
    if (js === null) continue;

    for (const [from, to] of replacements) {
      const replacement = to.startsWith("/") ? relativeLocalAssetPath(entry.localPath, to) : relativeLocalAssetPath(entry.localPath, to);
      js = js.replaceAll(from, replacement);
      js = js.replaceAll(escapeJsonString(from), escapeJsonString(replacement));
    }

    await fsp.writeFile(scriptPath, js, "utf8");
  }
}

async function analyzeCapture(captureDir, { write }) {
  const capture = await readJson(path.join(captureDir, "capture.json"));
  const manifestPath = path.join(captureDir, capture.files.networkManifest);
  const networkManifest = fs.existsSync(manifestPath) ? await readJson(manifestPath) : [];
  const counters = {
    colors: new Map(),
    fontFamilies: new Map(),
    fontSizes: new Map(),
    fontWeights: new Map(),
    spacing: new Map(),
    radii: new Map(),
    shadows: new Map(),
  };
  const componentCandidates = [];
  const layoutRegions = [];

  for (const viewport of capture.viewports) {
    const styles = await readJson(path.join(captureDir, viewport.files.styles));
    const dom = await readJson(path.join(captureDir, viewport.files.dom));

    collectLayoutRegions(dom, viewport.name, layoutRegions);

    for (const item of styles) {
      const style = item.style || {};
      for (const key of ["color", "backgroundColor", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"]) {
        addCounter(counters.colors, normalizeColor(style[key]));
      }
      addCounter(counters.fontFamilies, compactFontFamily(style.fontFamily));
      addCounter(counters.fontSizes, style.fontSize);
      addCounter(counters.fontWeights, style.fontWeight);
      for (const key of [
        "marginTop",
        "marginRight",
        "marginBottom",
        "marginLeft",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "gap",
        "rowGap",
        "columnGap",
      ]) {
        addCounter(counters.spacing, normalizePx(style[key]));
      }
      for (const key of [
        "borderTopLeftRadius",
        "borderTopRightRadius",
        "borderBottomRightRadius",
        "borderBottomLeftRadius",
      ]) {
        addCounter(counters.radii, normalizePx(style[key]));
      }
      if (style.boxShadow && style.boxShadow !== "none") {
        addCounter(counters.shadows, style.boxShadow);
      }

      if (isComponentCandidate(item)) {
        componentCandidates.push({
          viewport: viewport.name,
          tag: item.tag,
          role: item.role,
          selector: item.selector,
          text: item.text,
          rect: item.rect,
          display: style.display,
          fontSize: style.fontSize,
          backgroundColor: normalizeColor(style.backgroundColor),
          color: normalizeColor(style.color),
          borderRadius: style.borderTopLeftRadius,
        });
      }
    }
  }

  const replacementAssets = networkManifest
    .filter((item) => ["replace", "licensed-review-required"].includes(item.disposition))
    .map((item) => ({
      url: item.url,
      resourceType: item.resourceType,
      mimeType: item.mimeType,
      disposition: item.disposition,
      localPath: item.localPath || null,
    }));

  const spec = {
    sourceUrl: capture.sourceUrl,
    capturedAt: capture.capturedAt,
    captureDir,
    assetPolicy: capture.assetPolicy,
    viewports: capture.viewports.map(({ name, width, height }) => ({ name, width, height })),
    tokens: {
      colors: topCounters(counters.colors, 24),
      fontFamilies: topCounters(counters.fontFamilies, 12),
      fontSizes: topCounters(counters.fontSizes, 16),
      fontWeights: topCounters(counters.fontWeights, 10),
      spacing: topCounters(counters.spacing, 24),
      radii: topCounters(counters.radii, 16),
      shadows: topCounters(counters.shadows, 12),
    },
    layoutRegions: dedupeBy(layoutRegions, (item) => `${item.viewport}:${item.selector}`).slice(0, 80),
    componentCandidates: dedupeBy(componentCandidates, (item) => `${item.tag}:${item.selector}:${item.text}`).slice(0, 120),
    replacementAssets: replacementAssets.slice(0, 200),
    files: {},
  };

  if (write) {
    const jsonPath = path.join(captureDir, "design-spec.json");
    const mdPath = path.join(captureDir, "design-spec.md");
    await writeJson(jsonPath, spec);
    await fsp.writeFile(mdPath, renderDesignSpecMarkdown(spec), "utf8");
    spec.files = { json: jsonPath, markdown: mdPath };
  }

  return spec;
}

function collectLayoutRegions(node, viewport, output) {
  if (!node) return;
  const classText = (node.classes || []).join(" ");
  const roleText = node.role || "";
  const haystack = `${node.tag} ${roleText} ${classText}`.toLowerCase();
  if (/(header|nav|main|section|article|aside|footer|hero|banner|content|sidebar|grid|list)/.test(haystack)) {
    output.push({
      viewport,
      tag: node.tag,
      role: node.role,
      selector: node.selector,
      text: node.text,
      rect: node.rect,
    });
  }
  for (const child of node.children || []) {
    collectLayoutRegions(child, viewport, output);
  }
}

function isComponentCandidate(item) {
  const classText = (item.classes || []).join(" ").toLowerCase();
  const roleText = (item.role || "").toLowerCase();
  const tag = item.tag;
  return (
    ["button", "a", "input", "select", "textarea", "nav", "header", "footer", "form", "section", "article"].includes(tag) ||
    ["button", "link", "navigation", "banner", "contentinfo", "form", "dialog", "tab", "tabpanel"].includes(roleText) ||
    /(button|btn|card|nav|menu|modal|dialog|tab|hero|banner|input|field|form|cta)/.test(classText)
  );
}

function renderDesignSpecMarkdown(spec) {
  const lines = [];
  lines.push("# Design Spec");
  lines.push("");
  lines.push(`Source: ${spec.sourceUrl}`);
  lines.push(`Captured: ${spec.capturedAt}`);
  lines.push("");
  lines.push("## Top Tokens");
  lines.push("");
  lines.push(`Colors: ${spec.tokens.colors.map((item) => `${item.value} (${item.count})`).join(", ") || "none"}`);
  lines.push(`Fonts: ${spec.tokens.fontFamilies.map((item) => `${item.value} (${item.count})`).join(", ") || "none"}`);
  lines.push(`Font sizes: ${spec.tokens.fontSizes.map((item) => `${item.value} (${item.count})`).join(", ") || "none"}`);
  lines.push(`Spacing: ${spec.tokens.spacing.map((item) => `${item.value} (${item.count})`).join(", ") || "none"}`);
  lines.push(`Radii: ${spec.tokens.radii.map((item) => `${item.value} (${item.count})`).join(", ") || "none"}`);
  lines.push("");
  lines.push("## Component Candidates");
  for (const item of spec.componentCandidates.slice(0, 30)) {
    lines.push(`- ${item.viewport}: ${item.tag} ${item.selector} "${item.text || ""}"`);
  }
  lines.push("");
  lines.push("## Replacement Assets");
  for (const item of spec.replacementAssets.slice(0, 30)) {
    lines.push(`- ${item.disposition}: ${item.resourceType} ${item.url}`);
  }
  lines.push("");
  lines.push(`Asset policy: ${spec.assetPolicy}`);
  lines.push("");
  return lines.join("\n");
}

async function detectProject(targetDir) {
  const packagePath = path.join(targetDir, "package.json");
  const pkg = fs.existsSync(packagePath) ? await readJson(packagePath) : null;
  const deps = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
  };
  const has = (relative) => fs.existsSync(path.join(targetDir, relative));
  const files = listFilesShallow(targetDir, 4, 800);
  const hasAny = (patterns) => files.some((file) => patterns.some((pattern) => pattern.test(file)));

  const framework = deps.next || hasAny([/^next\.config\./]) ? "next" : deps.vite || hasAny([/^vite\.config\./]) ? "vite" : deps.react ? "react" : has("index.html") ? "static-html" : "unknown";
  const appRouter = framework === "next" && hasAny([/^app\/page\.(js|jsx|ts|tsx)$/]);
  const pagesRouter = framework === "next" && hasAny([/^pages\/index\.(js|jsx|ts|tsx)$/]);
  const typeScript = Boolean(deps.typescript || has("tsconfig.json") || hasAny([/\.(ts|tsx)$/]));
  const tailwind = Boolean(
    deps.tailwindcss ||
      hasAny([/^tailwind\.config\./, /^postcss\.config\./]) ||
      fileContainsAny(targetDir, files, ["@tailwind", "@import \"tailwindcss\"", "@import 'tailwindcss'"]),
  );
  const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("package-lock.json") ? "npm" : pkg ? "npm" : "none";

  return {
    targetDir,
    framework,
    router: framework === "next" ? (appRouter ? "app" : pagesRouter ? "pages" : "unknown") : "none",
    typeScript,
    tailwind,
    packageManager,
    styling: tailwind ? "tailwind" : detectStyling(files, deps),
    recommended: recommendationFor({ framework, appRouter, pagesRouter, typeScript, tailwind }),
    evidence: {
      packageJson: fs.existsSync(packagePath),
      matchedFiles: files.slice(0, 80),
    },
  };
}

function recommendationFor({ framework, appRouter, pagesRouter, typeScript, tailwind }) {
  const ext = typeScript ? "tsx" : "jsx";
  if (framework === "next") {
    return {
      pageEntry: appRouter ? `app/page.${ext}` : pagesRouter ? `pages/index.${ext}` : `app/page.${ext}`,
      componentDir: "components/replica",
      assetDir: "public/replica-assets",
      styling: tailwind ? "Use Tailwind utilities and project tokens." : "Use CSS Modules colocated with replica components.",
    };
  }
  if (framework === "vite" || framework === "react") {
    return {
      pageEntry: `src/App.${ext}`,
      componentDir: "src/components/replica",
      assetDir: "src/assets/replica",
      styling: tailwind ? "Use Tailwind utilities and project tokens." : "Use the project's existing CSS or CSS Modules.",
    };
  }
  if (framework === "static-html") {
    return {
      pageEntry: "index.html",
      componentDir: "n/a",
      assetDir: "assets/replica",
      styling: "Use semantic HTML, styles.css, and minimal script.js only where interaction is needed.",
    };
  }
  return {
    pageEntry: `src/App.${ext}`,
    componentDir: "src/components/replica",
    assetDir: "src/assets/replica",
    styling: "Fallback recommendation: React + Tailwind. Do not migrate frameworks without explicit user approval.",
  };
}

function detectStyling(files, deps) {
  if (deps["@emotion/react"] || deps["@emotion/styled"]) return "emotion";
  if (deps["styled-components"]) return "styled-components";
  if (files.some((file) => /\.module\.(css|scss|sass)$/.test(file))) return "css-modules";
  if (files.some((file) => /\.(scss|sass)$/.test(file))) return "sass";
  if (files.some((file) => /\.css$/.test(file))) return "css";
  return "unknown";
}

async function generateBriefCommand(positional, options) {
  const captureDir = path.resolve(requireArg(positional[0], "capture-dir"));
  const targetDir = path.resolve(requireArg(positional[1], "target-dir"));
  const spec = fs.existsSync(path.join(captureDir, "design-spec.json"))
    ? await readJson(path.join(captureDir, "design-spec.json"))
    : await analyzeCapture(captureDir, { write: true });
  const project = await detectProject(targetDir);
  const outPath = path.resolve(options.out || path.join(captureDir, "replica-brief.md"));
  await fsp.writeFile(outPath, renderBrief(spec, project), "utf8");
  console.log(`Wrote ${outPath}`);
}

function renderBrief(spec, project) {
  const lines = [];
  lines.push("# Authorized UI Replica Brief");
  lines.push("");
  lines.push(`Reference: ${spec.sourceUrl}`);
  lines.push(`Capture: ${spec.captureDir}`);
  lines.push(`Target: ${project.targetDir}`);
  lines.push("");
  lines.push("## Authorization Boundary");
  lines.push("");
  lines.push("- Use this brief only for an authorized page migration or licensed/internal recreation.");
  lines.push("- Replace logos, brand imagery, proprietary icons, paid fonts, and commercial photos unless separately authorized.");
  lines.push("- Do not import captured third-party source code into the target app.");
  lines.push("");
  lines.push("## Target Stack");
  lines.push("");
  lines.push(`- Framework: ${project.framework}`);
  lines.push(`- Router: ${project.router}`);
  lines.push(`- TypeScript: ${project.typeScript}`);
  lines.push(`- Tailwind: ${project.tailwind}`);
  lines.push(`- Entry: ${project.recommended.pageEntry}`);
  lines.push(`- Components: ${project.recommended.componentDir}`);
  lines.push(`- Assets: ${project.recommended.assetDir}`);
  lines.push(`- Styling: ${project.recommended.styling}`);
  lines.push("");
  lines.push("## Visual Tokens");
  lines.push("");
  lines.push(`- Colors: ${spec.tokens.colors.slice(0, 12).map((item) => item.value).join(", ")}`);
  lines.push(`- Fonts: ${spec.tokens.fontFamilies.slice(0, 8).map((item) => item.value).join(", ")}`);
  lines.push(`- Font sizes: ${spec.tokens.fontSizes.slice(0, 10).map((item) => item.value).join(", ")}`);
  lines.push(`- Spacing: ${spec.tokens.spacing.slice(0, 14).map((item) => item.value).join(", ")}`);
  lines.push(`- Radii: ${spec.tokens.radii.slice(0, 10).map((item) => item.value).join(", ")}`);
  lines.push("");
  lines.push("## Implementation Tasks");
  lines.push("");
  lines.push("- Build the page using the detected target stack and existing local conventions.");
  lines.push("- Match desktop, tablet, and mobile layouts from the capture artifacts.");
  lines.push("- Recreate component states visible in the DOM and screenshots: navigation, buttons, cards, forms, modals, tabs, and footer if present.");
  lines.push("- Use placeholders for replacement assets until authorized files are provided.");
  lines.push("- Keep dimensions stable across breakpoints; verify text does not overflow or overlap.");
  lines.push("");
  lines.push("## Component Candidates");
  for (const item of spec.componentCandidates.slice(0, 35)) {
    lines.push(`- ${item.viewport}: ${item.tag} ${item.selector} "${item.text || ""}"`);
  }
  lines.push("");
  lines.push("## Asset Replacement Points");
  const assets = spec.replacementAssets.slice(0, 40);
  if (assets.length === 0) {
    lines.push("- None detected.");
  } else {
    for (const item of assets) {
      lines.push(`- ${item.disposition}: ${item.resourceType} ${item.url}`);
    }
  }
  lines.push("");
  lines.push("## Acceptance Criteria");
  lines.push("");
  lines.push("- `npm run replica -- compare <reference> <local>` reports each viewport and writes diff images.");
  lines.push("- Important layout regions align visually across desktop, tablet, and mobile.");
  lines.push("- Differences caused by intentionally replaced assets are documented.");
  lines.push("- No unauthorized third-party assets are committed into the target project.");
  lines.push("");
  return lines.join("\n");
}

async function compareCommand(positional, options) {
  const reference = requireArg(positional[0], "reference-url-or-image");
  const localUrl = normalizeUrlOrPath(requireArg(positional[1], "local-url"));
  const threshold = Number(options.threshold || 0.1);
  const outDir = path.resolve(options.out || path.join("replica-comparisons", timestamp()));
  const requestedViewport = options.viewport;
  const viewports = requestedViewport
    ? DEFAULT_VIEWPORTS.filter((viewport) => viewport.name === requestedViewport)
    : DEFAULT_VIEWPORTS;

  if (viewports.length === 0) {
    throw new Error(`Unknown viewport '${requestedViewport}'. Use desktop, tablet, or mobile.`);
  }

  await ensureDir(outDir);
  await ensureDir(path.join(outDir, "reference"));
  await ensureDir(path.join(outDir, "local"));
  await ensureDir(path.join(outDir, "diffs"));

  const referenceIsImage = fs.existsSync(reference) && /\.(png)$/i.test(reference);
  const browser = await launchChromium();
  const results = [];

  try {
    for (const viewport of referenceIsImage ? viewports.slice(0, 1) : viewports) {
      const referencePath = referenceIsImage
        ? path.resolve(reference)
        : path.join(outDir, "reference", `${viewport.name}.png`);
      const localPath = path.join(outDir, "local", `${viewport.name}.png`);
      const diffPath = path.join(outDir, "diffs", `${viewport.name}.png`);

      if (!referenceIsImage) {
        await screenshotUrl(browser, normalizeUrlOrPath(reference), viewport, referencePath);
      }
      await screenshotUrl(browser, localUrl, viewport, localPath);

      const result = await comparePngFiles(referencePath, localPath, diffPath, threshold);
      results.push({
        viewport: viewport.name,
        reference: referenceIsImage ? referencePath : relativePath(outDir, referencePath),
        local: relativePath(outDir, localPath),
        diff: relativePath(outDir, diffPath),
        ...result,
      });
    }
  } finally {
    await browser.close();
  }

  const report = {
    comparedAt: new Date().toISOString(),
    reference,
    localUrl,
    threshold,
    results,
  };
  const reportJson = path.join(outDir, "comparison-report.json");
  const reportMd = path.join(outDir, "comparison-report.md");
  await writeJson(reportJson, report);
  await fsp.writeFile(reportMd, renderComparisonMarkdown(report), "utf8");
  console.log(`Wrote ${reportJson}`);
  console.log(`Wrote ${reportMd}`);
}

async function screenshotUrl(browser, url, viewport, outPath) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: outPath, fullPage: false });
  await context.close();
}

async function comparePngFiles(referencePath, localPath, diffPath, threshold) {
  const reference = PNG.sync.read(await fsp.readFile(referencePath));
  const local = PNG.sync.read(await fsp.readFile(localPath));
  const width = Math.min(reference.width, local.width);
  const height = Math.min(reference.height, local.height);
  const referenceCrop = cropPng(reference, width, height);
  const localCrop = cropPng(local, width, height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(referenceCrop.data, localCrop.data, diff.data, width, height, {
    threshold,
  });
  await fsp.writeFile(diffPath, PNG.sync.write(diff));
  return {
    width,
    height,
    mismatchedPixels,
    totalPixels: width * height,
    mismatchRatio: Number((mismatchedPixels / (width * height)).toFixed(6)),
    dimensionDelta: {
      width: local.width - reference.width,
      height: local.height - reference.height,
    },
  };
}

function cropPng(source, width, height) {
  if (source.width === width && source.height === height) return source;
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (source.width * y + x) << 2;
      const outputIndex = (width * y + x) << 2;
      output.data[outputIndex] = source.data[sourceIndex];
      output.data[outputIndex + 1] = source.data[sourceIndex + 1];
      output.data[outputIndex + 2] = source.data[sourceIndex + 2];
      output.data[outputIndex + 3] = source.data[sourceIndex + 3];
    }
  }
  return output;
}

function renderComparisonMarkdown(report) {
  const lines = [];
  lines.push("# Comparison Report");
  lines.push("");
  lines.push(`Reference: ${report.reference}`);
  lines.push(`Local: ${report.localUrl}`);
  lines.push(`Compared: ${report.comparedAt}`);
  lines.push("");
  lines.push("| Viewport | Mismatch | Dimension Delta | Diff |");
  lines.push("| --- | ---: | --- | --- |");
  for (const item of report.results) {
    lines.push(
      `| ${item.viewport} | ${(item.mismatchRatio * 100).toFixed(2)}% | ${item.dimensionDelta.width}w, ${item.dimensionDelta.height}h | ${item.diff} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function verifyMirrorDirectory(mirrorDir) {
  const manifestPath = path.join(mirrorDir, "mirror-manifest.json");
  const indexPath = path.join(mirrorDir, "index.html");
  const issues = [];

  if (!fs.existsSync(indexPath)) issues.push("Missing index.html");
  if (!fs.existsSync(manifestPath)) issues.push("Missing mirror-manifest.json");

  const manifest = fs.existsSync(manifestPath) ? await readJson(manifestPath).catch(() => null) : null;
  if (!manifest) issues.push("mirror-manifest.json is not valid JSON");

  const sourceOrigin = manifest?.sourceUrl ? new URL(manifest.sourceUrl).origin : null;
  const files = listFilesShallow(mirrorDir, 6, 5000);
  const textFiles = files.filter(
    (file) =>
      /\.(html|css|js|mjs|json|webmanifest)$/i.test(file) &&
      !["mirror-manifest.json", "license-review.md", "mirror-verify.json"].includes(file),
  );

  for (const file of textFiles) {
    const fullPath = path.join(mirrorDir, file);
    const text = await fsp.readFile(fullPath, "utf8").catch(() => "");
    if (sourceOrigin && text.includes(sourceOrigin)) {
      issues.push(`${file} still references source origin ${sourceOrigin}`);
    }
    for (const rootRef of extractRootMirrorReferences(text)) {
      issues.push(`${file} still references root asset path ${rootRef}`);
    }

    for (const localRef of extractLocalFileReferences(text)) {
      const candidate = path.resolve(path.dirname(fullPath), localRef);
      if (!candidate.startsWith(path.resolve(mirrorDir))) continue;
      if (!fs.existsSync(candidate)) {
        issues.push(`${file} references missing local file ${localRef}`);
      }
    }
  }

  const savedResources = Array.isArray(manifest?.resources)
    ? manifest.resources.filter((resource) => resource.localPath)
    : [];
  for (const resource of savedResources) {
    if (!fs.existsSync(path.join(mirrorDir, resource.localPath))) {
      issues.push(`Manifest resource missing on disk: ${resource.localPath}`);
    }
  }

  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    mirrorDir,
    filesChecked: textFiles.length,
    savedResources: savedResources.length,
    issues,
  };
}

function extractRootMirrorReferences(text) {
  const refs = new Set();
  const patterns = [
    /["'(`](\/(?:_next\/static|assets|vendor)\/[^"'()`\s]+)["'()`]/g,
    /url\(\s*["']?(\/(?:_next\/static|assets|vendor)\/[^"')\s]+)["']?\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      refs.add(match[1].split(/[?#]/)[0]);
    }
  }
  return [...refs];
}

function extractLocalFileReferences(text) {
  const refs = new Set();
  const patterns = [
    /\b(?:src|href|poster)=["']([^"']+)["']/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /@import\s+(?:url\()?["']([^"']+)["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (!value || shouldKeepRawUrl(value) || /^[a-z]+:\/\//i.test(value) || value.startsWith("/")) continue;
      refs.add(value.split(/[?#]/)[0]);
    }
  }

  return [...refs];
}

function rewriteHtml(html, { sourceUrl, urlMap, keepExternalScripts }) {
  let output = html;
  output = output.replace(/<base\b[^>]*>/gi, "");

  output = output.replace(
    /\s(src|href|poster)=("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, attr, _raw, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const rewritten = mirrorRelativeUrl(value, sourceUrl, urlMap);
      if (!rewritten) {
        if (!keepExternalScripts && attr.toLowerCase() === "src" && /^https?:\/\//i.test(value)) {
          return ` data-original-src="${escapeHtmlAttr(value)}"`;
        }
        return match;
      }
      return ` ${attr}="${escapeHtmlAttr(rewritten)}"`;
    },
  );

  output = output.replace(/\s(srcset)=("([^"]*)"|'([^']*)')/gi, (match, attr, _raw, doubleQuoted, singleQuoted) => {
    const value = doubleQuoted ?? singleQuoted ?? "";
    const rewritten = rewriteSrcset(value, sourceUrl, urlMap);
    return rewritten ? ` ${attr}="${escapeHtmlAttr(rewritten)}"` : match;
  });

  output = output.replace(/(<[^>]+\sstyle=)(["'])(.*?)\2/gis, (match, prefix, quote, styleValue) => {
    const rewrittenStyle = styleValue.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (urlMatch, urlQuote, rawUrl) => {
      const rewritten = mirrorRelativeUrl(rawUrl, sourceUrl, urlMap);
      return rewritten ? `url(${urlQuote}${rewritten}${urlQuote})` : urlMatch;
    });
    return `${prefix}${quote}${rewrittenStyle}${quote}`;
  });

  return output;
}

function rewriteSrcset(value, baseUrl, urlMap) {
  const parts = value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      const [rawUrl, ...descriptor] = trimmed.split(/\s+/);
      const rewritten = mirrorRelativeUrl(rawUrl, baseUrl, urlMap);
      return `${rewritten || rawUrl}${descriptor.length ? ` ${descriptor.join(" ")}` : ""}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function mirrorRelativeUrl(rawUrl, baseUrl, urlMap) {
  if (!rawUrl || shouldKeepRawUrl(rawUrl)) return null;
  const absolute = absoluteUrl(rawUrl, baseUrl);
  if (!absolute) return null;
  const localPath = urlMap[absolute];
  if (!localPath) return null;
  return appendOriginalUrlSuffix(localPath, absolute);
}

function relativeLocalAssetPath(fromLocalPath, toLocalPath) {
  const { localPath, suffix } = splitLocalUrlSuffix(toLocalPath);
  const fromDir = path.dirname(fromLocalPath);
  const normalizedLocalPath = localPath.replace(/^\/+/, "");
  const relative = path.relative(fromDir, normalizedLocalPath).split(path.sep).join("/");
  return `${relative.startsWith(".") ? relative : `./${relative}`}${suffix}`;
}

function appendOriginalUrlSuffix(localPath, absolute) {
  try {
    const parsed = new URL(absolute);
    return `${localPath}${parsed.search}${parsed.hash}`;
  } catch {
    return localPath;
  }
}

function splitLocalUrlSuffix(value) {
  const index = String(value).search(/[?#]/);
  if (index === -1) return { localPath: value, suffix: "" };
  return { localPath: value.slice(0, index), suffix: value.slice(index) };
}

function shouldKeepRawUrl(rawUrl) {
  return /^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(rawUrl.trim());
}

function absoluteUrl(rawUrl, baseUrl) {
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch {
    return null;
  }
}

function pathFromUrl(input) {
  try {
    return new URL(input).pathname;
  } catch {
    return "";
  }
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeJsonString(value) {
  return String(value).replace(/\//g, "\\/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeSourceInput(value) {
  return /^https?:\/\//i.test(value) || /^file:\/\//i.test(value) || fs.existsSync(path.resolve(value));
}

function renderLicenseReview(manifest) {
  const lines = [];
  lines.push("# License Review");
  lines.push("");
  lines.push(`Source: ${manifest.sourceUrl}`);
  lines.push(`Mirrored: ${manifest.mirroredAt}`);
  lines.push("");
  lines.push("Review these files before reuse or publication.");
  lines.push("");
  lines.push("| Disposition | Type | Local file | Original URL |");
  lines.push("| --- | --- | --- | --- |");
  for (const item of manifest.resources.filter((resource) => resource.localPath)) {
    lines.push(`| ${item.disposition} | ${item.resourceType} | ${item.localPath} | ${item.url} |`);
  }
  lines.push("");
  lines.push("Notes:");
  lines.push("- Images, logos, icons, fonts, scripts, stylesheets, and copy can require separate rights.");
  lines.push("- Keep this mirror private unless you have permission to publish every retained asset.");
  lines.push("- Dynamic behavior may still call the original site's APIs unless scripts are reviewed or removed.");
  lines.push("");
  return lines.join("\n");
}

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error("Playwright Chromium is not installed. Run: npx playwright install chromium", {
      cause: error.message,
    });
  }
}

function normalizeUrlOrPath(input) {
  if (/^https?:\/\//i.test(input) || /^file:\/\//i.test(input)) {
    return input;
  }
  const absolute = path.resolve(input);
  if (fs.existsSync(absolute)) {
    return pathToFileURL(absolute).href;
  }
  throw new Error(`Expected a URL or existing file path, got '${input}'`);
}

function slugFromUrl(input) {
  try {
    const url = new URL(input);
    return safeName(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`);
  } catch {
    return safeName(path.basename(input, path.extname(input)));
  }
}

function safeName(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "capture";
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shortHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function extensionFor(input, mimeType) {
  try {
    const ext = path.extname(new URL(input).pathname);
    if (ext && ext.length <= 8) return ext;
  } catch {}
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("svg")) return ".svg";
  if (mimeType.includes("woff2")) return ".woff2";
  if (mimeType.includes("woff")) return ".woff";
  if (mimeType.includes("css")) return ".css";
  if (mimeType.includes("javascript")) return ".js";
  return ".bin";
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

function relativePath(fromDir, file) {
  return path.relative(fromDir, file).split(path.sep).join("/");
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function addCounter(map, value) {
  if (!value || value === "none" || value === "normal" || value === "0px" || value === "rgba(0, 0, 0, 0)") {
    return;
  }
  map.set(value, (map.get(value) || 0) + 1);
}

function topCounters(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function normalizeColor(value) {
  if (!value || value === "transparent") return null;
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgba) return value;
  const parts = rgba[1].split(",").map((part) => part.trim());
  const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
  const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
  if (![r, g, b, alpha].every(Number.isFinite) || alpha === 0) return null;
  const hex = [r, g, b]
    .map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, "0"))
    .join("");
  return alpha < 1 ? `#${hex}/${alpha}` : `#${hex}`;
}

function normalizePx(value) {
  if (!value) return null;
  if (value === "0px") return null;
  const match = value.match(/^-?\d+(\.\d+)?px$/);
  if (!match) return value;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return `${Number(parsed.toFixed(2))}px`;
}

function compactFontFamily(value) {
  if (!value) return null;
  return value
    .split(",")
    .slice(0, 2)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .join(", ");
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function listFilesShallow(root, maxDepth, limit) {
  const output = [];
  const ignored = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

  const walk = (dir, depth) => {
    if (output.length >= limit || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (output.length >= limit) break;
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(absolute, depth + 1);
      } else {
        output.push(relative);
      }
    }
  };

  walk(root, 0);
  return output.sort();
}

function fileContainsAny(root, files, needles) {
  for (const file of files) {
    if (!/\.(css|scss|sass|js|jsx|ts|tsx|html)$/.test(file)) continue;
    const absolute = path.join(root, file);
    let content = "";
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > 500_000) continue;
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (needles.some((needle) => content.includes(needle))) return true;
  }
  return false;
}
