import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Requires Node.js 22+ for the built-in fetch and WebSocket APIs.

const phase = process.argv[2] || "check";
const sourcePath = resolve(process.argv[3] || "index.html");
const outputDir = "/private/tmp/ccneed-meeting-ui-tests";
const debugPort = 9400 + (process.pid % 200);
await mkdir(outputDir, { recursive: true });

const browserPaths = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
];
const browserPath = process.env.CCNEED_BROWSER_PATH || browserPaths.find(path => existsSync(path));
if (!browserPath || !existsSync(browserPath)) throw new Error("Set CCNEED_BROWSER_PATH to an existing Chromium-based browser executable");

const sourceHtml = await readFile(sourcePath, "utf8");
let downloadedFixture = "";
const server = createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/index.html" || pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(sourceHtml);
    return;
  }
  if (pathname === "/downloaded.html" && downloadedFixture) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(downloadedFixture);
    return;
  }
  if (pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("Local test server did not start");
const sourceUrl = `http://127.0.0.1:${serverAddress.port}/index.html`;
const downloadedUrl = `http://127.0.0.1:${serverAddress.port}/downloaded.html`;

const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/private/tmp/ccneed-meeting-ui-browser-${process.pid}`,
    "about:blank"
  ],
  { stdio: "ignore" }
);
let browserLaunchError;
browser.once("error", error => { browserLaunchError = error; });

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const results = [];
const browserErrors = [];
let socket;

function check(name, pass, detail = "") {
  const result = { name, pass: Boolean(pass), detail };
  results.push(result);
  console.log(`${result.pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  let targets;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (browserLaunchError) throw browserLaunchError;
    try {
      targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      break;
    } catch {
      await delay(100);
    }
  }
  if (!targets) throw new Error("Headless browser did not start");

  const target = targets.find(item => item.type === "page" && item.url === "about:blank") || targets.find(item => item.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolveOpen => socket.addEventListener("open", resolveOpen, { once: true }));

  let requestId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.reject(message.error) : request.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") browserErrors.push(message.params.entry.text);
  });

  const cdp = (method, params = {}) => new Promise((resolveCdp, rejectCdp) => {
    const id = ++requestId;
    pending.set(id, { resolve: resolveCdp, reject: rejectCdp });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const viewport = width => cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  const navigate = async () => {
    await cdp("Page.navigate", { url: sourceUrl });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await evaluate("document.readyState === 'complete' && Boolean(document.getElementById('quote-form'))")) return;
      await delay(100);
    }
    throw new Error("Page did not finish loading");
  };
  const capture = async width => {
    await viewport(width);
    await navigate();
    await evaluate("document.querySelectorAll('.reveal').forEach(node => node.classList.add('is-visible'))");
    await delay(620);
    const dimensions = await evaluate("({x:0,y:0,width:innerWidth,height:document.documentElement.scrollHeight,scale:1})");
    const screenshot = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: dimensions
    });
    await writeFile(`${outputDir}/${phase}-${width}.png`, Buffer.from(screenshot.data, "base64"));
  };

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await viewport(1440);
  await navigate();
  await delay(620);

  const sectionIds = await evaluate("[...document.querySelectorAll('main > section')].map(section => section.id)");
  check(
    "main keeps exactly the three customer-decision sections",
    JSON.stringify(sectionIds) === JSON.stringify(["top", "deliverables", "pricing"]),
    JSON.stringify(sectionIds)
  );

  const navLinks = await evaluate("[...document.querySelectorAll('.nav-links a')].map(link => [link.textContent.trim(), link.getAttribute('href')])");
  check(
    "navigation keeps the three existing routes",
    JSON.stringify(navLinks) === JSON.stringify([["支持平台", "#platforms"], ["交付内容", "#deliverables"], ["收费方式", "#pricing"]]),
    JSON.stringify(navLinks)
  );

  const colors = await evaluate(`(() => {
    const style = selector => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node) : null;
    };
    return {
      body: getComputedStyle(document.body).backgroundColor,
      sections: [...document.querySelectorAll('main > section')].map(node => getComputedStyle(node).backgroundColor),
      visual: style('.hero-blue-card')?.backgroundColor || '',
      visualImage: style('.hero-blue-card')?.backgroundImage || '',
      primary: style('.hero-actions .button-primary')?.backgroundColor || '',
      platform: style('.platform-showcase')?.backgroundColor || '',
      platformShadow: style('.platform-showcase')?.boxShadow || 'none'
    };
  })()`);
  check("page and every main section use a pure-white canvas", colors.body === "rgb(255, 255, 255)" && colors.sections.every(color => color === "rgb(255, 255, 255)"), JSON.stringify(colors));
  check("hero contains a prominent solid #0066FF visual card", colors.visual === "rgb(0, 102, 255)" && colors.visualImage === "none", JSON.stringify(colors));
  check("primary hero action uses #045AFE", colors.primary === "rgb(4, 90, 254)", colors.primary);
  check("product interface is white with a soft blue shadow", colors.platform === "rgb(255, 255, 255)" && colors.platformShadow !== "none", JSON.stringify(colors));

  const desktopLayout = await evaluate(`(() => {
    const container = document.querySelector('.hero .container').getBoundingClientRect();
    const copy = document.querySelector('.hero-copy').getBoundingClientRect();
    const visual = document.querySelector('.hero-visual').getBoundingClientRect();
    const card = document.querySelector('.hero-blue-card');
    const cardStyle = card ? getComputedStyle(card) : null;
    const heading = getComputedStyle(document.querySelector('.hero h1'));
    const buttons = [...document.querySelectorAll('.hero-actions .button')].map(node => {
      const rect = node.getBoundingClientRect();
      return { height: rect.height, radius: parseFloat(getComputedStyle(node).borderRadius) };
    });
    return {
      containerWidth: container.width,
      copyWidth: copy.width,
      visualWidth: visual.width,
      visualShare: visual.width / (copy.width + visual.width),
      radius: cardStyle ? parseFloat(cardStyle.borderRadius) : 0,
      headingSize: parseFloat(heading.fontSize),
      buttons
    };
  })()`);
  check("desktop content width is 1280px", Math.abs(desktopLayout.containerWidth - 1280) <= 1, JSON.stringify(desktopLayout));
  check("desktop hero follows the 42:58 copy-to-visual proportion", desktopLayout.visualShare >= 0.56 && desktopLayout.visualShare <= 0.60, desktopLayout.visualShare.toFixed(3));
  check("desktop hero heading is 48–64px", desktopLayout.headingSize >= 48 && desktopLayout.headingSize <= 64, String(desktopLayout.headingSize));
  check("desktop visual card uses a 36–48px radius", desktopLayout.radius >= 36 && desktopLayout.radius <= 48, String(desktopLayout.radius));
  check("hero buttons are equal-height pills", desktopLayout.buttons.length === 2 && Math.abs(desktopLayout.buttons[0].height - desktopLayout.buttons[1].height) <= 1 && desktopLayout.buttons.every(button => button.radius >= button.height / 2 - 1), JSON.stringify(desktopLayout.buttons));
  const heroOpeningLines = await evaluate(`(() => {
    const heading = document.querySelector('.hero h1');
    const opening = [...heading.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const range = document.createRange();
    range.selectNodeContents(opening);
    return new Set([...range.getClientRects()].filter(rect => rect.width > 1).map(rect => Math.round(rect.top))).size;
  })()`);
  check("desktop hero opening phrase stays on one decisive line", heroOpeningLines === 1, String(heroOpeningLines));
  const sectionSpacing = await evaluate("[...document.querySelectorAll('.hero,#deliverables,#pricing')].map(node => parseFloat(getComputedStyle(node).paddingTop))");
  check("desktop hero and sections use 96–144px vertical rhythm", sectionSpacing.every(value => value >= 96 && value <= 144), JSON.stringify(sectionSpacing));

  const expectedPlatforms = ["小红书", "抖音", "快手", "微博", "B站", "知乎", "微信公众号", "YouTube", "X／Twitter", "Reddit", "TikTok", "Instagram"];
  const platformData = await evaluate(`(() => {
    const panel = document.getElementById('platforms');
    const cards = panel ? [...panel.querySelectorAll('.platform-card')] : [];
    return {
      inHero: Boolean(panel?.closest('.hero-visual')),
      inBlueCard: Boolean(panel?.closest('.hero-blue-card')),
      names: cards.map(card => card.querySelector('.platform-name')?.textContent.trim()),
      logos: cards.filter(card => card.querySelector('.platform-logo svg path, .platform-logo svg circle, .platform-logo svg polygon')).length,
      visible: cards.every(card => card.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
    };
  })()`);
  check("hero visibly keeps all 12 platform logos and names", platformData.inHero && platformData.inBlueCard && platformData.visible && platformData.logos === 12 && JSON.stringify(platformData.names) === JSON.stringify(expectedPlatforms), JSON.stringify(platformData));

  const floatingData = await evaluate(`(() => {
    const stage = document.querySelector('.hero-visual-stage');
    const blue = stage?.querySelector('.hero-blue-card');
    const floats = stage ? [...stage.querySelectorAll('.floating-layer')] : [];
    return {
      count: floats.length,
      external: Boolean(blue) && floats.every(node => !blue.contains(node)),
      durations: floats.map(node => getComputedStyle(node.querySelector('.floating-card') || node).animationDuration)
    };
  })()`);
  check("hero uses one to three independently layered floating details", floatingData.count >= 1 && floatingData.count <= 3 && floatingData.external, JSON.stringify(floatingData));
  check("decorative floats use the specified 4.5s rhythm", floatingData.durations.every(duration => duration === "4.5s"), JSON.stringify(floatingData.durations));
  const motionTimings = await evaluate(`(() => {
    const probe = document.createElement('div');
    probe.className = 'reveal';
    probe.dataset.revealDelay = '1';
    document.body.appendChild(probe);
    const reveal = getComputedStyle(probe);
    const lift = getComputedStyle(document.querySelector('.lift'));
    const tab = getComputedStyle(document.querySelector('.delivery-tab'));
    const result = {
      revealDuration: reveal.transitionDuration,
      revealDelay: reveal.transitionDelay,
      revealTransform: reveal.transform,
      liftDuration: lift.transitionDuration,
      tabDuration: tab.transitionDuration
    };
    probe.remove();
    return result;
  })()`);
  check("reveal, stagger, hover and tab timings match the motion brief", motionTimings.revealDuration.split(',').every(value => value.trim() === '0.56s') && motionTimings.revealDelay.split(',').every(value => value.trim() === '0.08s') && motionTimings.revealTransform.endsWith(', 20)') && motionTimings.liftDuration.split(',').every(value => value.trim() === '0.2s') && motionTimings.tabDuration.includes('0.2s'), JSON.stringify(motionTimings));

  const tabSemantics = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    return {
      tablist: Boolean(document.querySelector('[role="tablist"]')),
      tabs: tabs.length,
      panels: panels.length,
      controls: tabs.every(tab => document.getElementById(tab.getAttribute('aria-controls'))),
      labels: panels.every(panel => document.getElementById(panel.getAttribute('aria-labelledby'))),
      selected: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length,
      focusable: tabs.filter(tab => tab.tabIndex === 0).length
    };
  })()`);
  check("deliverables expose three accessible manual tabs", tabSemantics.tablist && tabSemantics.tabs === 3 && tabSemantics.panels === 3 && tabSemantics.controls && tabSemantics.labels && tabSemantics.selected === 1 && tabSemantics.focusable === 1, JSON.stringify(tabSemantics));

  const tabBehavior = await evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const stage = document.querySelector('.delivery-panels');
    if (tabs.length !== 3 || !stage) return {ready:false};
    const heights = [stage.getBoundingClientRect().height];
    tabs[1].click();
    await new Promise(resolve => setTimeout(resolve, 320));
    heights.push(stage.getBoundingClientRect().height);
    tabs[1].focus();
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
    const arrow = document.activeElement === tabs[2] && tabs[2].getAttribute('aria-selected') === 'true';
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true}));
    const home = document.activeElement === tabs[0] && tabs[0].getAttribute('aria-selected') === 'true';
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true}));
    const end = document.activeElement === tabs[2] && tabs[2].getAttribute('aria-selected') === 'true';
    const selectedBeforeWait = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
    await new Promise(resolve => setTimeout(resolve, 1100));
    const selectedAfterWait = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
    return {ready:true,heights,arrow,home,end,manual:selectedBeforeWait===selectedAfterWait};
  })()`);
  check("tabs support click, Arrow keys, Home and End", tabBehavior.ready && tabBehavior.arrow && tabBehavior.home && tabBehavior.end, JSON.stringify(tabBehavior));
  check("tab panel height stays stable", tabBehavior.ready && Math.abs(tabBehavior.heights[0] - tabBehavior.heights[1]) <= 1, JSON.stringify(tabBehavior.heights));
  check("tabs do not auto-rotate", tabBehavior.ready && tabBehavior.manual, JSON.stringify(tabBehavior));

  const blueCardContrast = await evaluate(`(() => {
    const parse = color => {
      const values = color.match(/[\\d.]+/g).map(Number);
      return {r:values[0],g:values[1],b:values[2],a:values.length > 3 ? values[3] : 1};
    };
    const blend = (foreground, background) => ({
      r: foreground.r * foreground.a + background.r * (1 - foreground.a),
      g: foreground.g * foreground.a + background.g * (1 - foreground.a),
      b: foreground.b * foreground.a + background.b * (1 - foreground.a)
    });
    const luminance = color => {
      const channel = value => {
        const normalized = value / 255;
        return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      };
      return .2126 * channel(color.r) + .7152 * channel(color.g) + .0722 * channel(color.b);
    };
    const ratio = (foreground, background) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    };
    const blue = parse(getComputedStyle(document.querySelector('.quote-panel')).backgroundColor);
    const selectors = ['.quote-label','.quote-exact','.summary-row dt','.quote-block ul','.quote-note','.visual-caption'];
    return selectors.map(selector => {
      const foreground = parse(getComputedStyle(document.querySelector(selector)).color);
      return [selector, ratio(blend(foreground, blue), blue)];
    });
  })()`);
  check("small text on pure-blue cards meets 4.5:1 contrast", blueCardContrast.every(([, ratio]) => ratio >= 4.5), JSON.stringify(blueCardContrast));

  await cdp("DOM.enable");
  await cdp("CSS.enable");
  const documentNode = await cdp("DOM.getDocument");
  const quoteButtonNode = await cdp("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".quote-panel .copy-plan" });
  await cdp("CSS.forcePseudoState", { nodeId: quoteButtonNode.nodeId, forcedPseudoClasses: ["focus-visible"] });
  const quoteFocus = await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.quote-panel .copy-plan'));
    return { color: style.outlineColor, width: parseFloat(style.outlineWidth) };
  })()`);
  await cdp("CSS.forcePseudoState", { nodeId: quoteButtonNode.nodeId, forcedPseudoClasses: [] });
  check("quote-card controls use a high-contrast white focus ring", quoteFocus.color === "rgb(255, 255, 255)" && quoteFocus.width >= 3, JSON.stringify(quoteFocus));

  const configure = (keywords, months = 3, platforms = ["douyin"]) => evaluate(`(() => {
    document.querySelectorAll('[name="platform"]').forEach(input => input.checked = ${JSON.stringify(platforms)}.includes(input.value));
    document.getElementById('keyword-count').value = ${JSON.stringify(keywords)};
    document.querySelector('[name="duration"][value="${months}"]').checked = true;
    document.getElementById('quote-form').dispatchEvent(new Event('input', {bubbles:true}));
    return document.getElementById('quote-number').textContent;
  })()`);

  for (const [months, expected] of [[3, 5], [6, 10], [12, 20]]) {
    check(`one combination for ${months} months remains ${expected}万元`, await configure("1", months) === String(expected));
  }
  for (const [combinations, expected] of [[1, 20], [3, 36], [5, 52], [6, 58], [10, 82], [11, 87]]) {
    check(`annual ${combinations} combinations remains ${expected}万元`, await configure(String(combinations), 12) === String(expected));
  }
  for (const raw of ["", "0", "-1", "1.5", "abc"]) {
    await configure(raw);
    check(`invalid keyword ${JSON.stringify(raw)} is rejected`, await evaluate("document.getElementById('keyword-count').getAttribute('aria-invalid') === 'true' && document.querySelector('.copy-plan').disabled && document.getElementById('keyword-error').textContent.length > 0"));
  }
  await configure("1", 3, []);
  check("no platform is rejected", await evaluate("document.querySelector('.copy-plan').disabled && document.getElementById('platform-error').textContent.length > 0"));

  await configure("1", 3);
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('denied'))}});document.execCommand=()=>false;document.querySelector('.copy-plan').click()");
  await delay(100);
  check("copy fallback exposes the quarterly plan", await evaluate("(()=>{const field=document.getElementById('manual-copy');return !field.hidden&&field.value.includes('¥50,000')&&field.value.includes('3 个月')&&field.selectionEnd===field.value.length})()"));

  await configure("2", 6, ["douyin", "weibo"]);
  await evaluate(`(() => {
    document.getElementById('o-web').checked = true;
    const NativeBlob = window.Blob;
    window.Blob = class extends NativeBlob {
      constructor(parts, options) {
        window.__downloadSource = String(parts[0]);
        super(parts, options);
      }
    };
    URL.createObjectURL = () => 'blob:ccneed-test';
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {};
    document.querySelector('.download-page').click();
  })()`);
  await delay(50);
  check("downloaded HTML restores the current quote configuration", await evaluate(`(() => {
    const doc = new DOMParser().parseFromString(window.__downloadSource || '', 'text/html');
    const state = JSON.parse(doc.getElementById('initial-quote')?.textContent || '{}');
    return JSON.stringify(state) === JSON.stringify({platforms:['douyin','weibo'],keywords:'2',months:6,options:['web']});
  })()`));

  const downloadedSource = await evaluate("window.__downloadSource || ''");
  downloadedFixture = downloadedSource;
  const downloadedPath = `${outputDir}/${phase}-downloaded.html`;
  await writeFile(downloadedPath, downloadedSource);

  await cdp("Emulation.setScriptExecutionDisabled", { value: true });
  await cdp("Page.navigate", { url: downloadedUrl });
  await delay(100);
  const downloadedNoScript = await evaluate(`(() => {
    const panels = [...document.querySelectorAll('.delivery-panel')];
    return {
      rootEnhanced: document.documentElement.classList.contains('js'),
      tabsHidden: getComputedStyle(document.querySelector('.delivery-tabs')).display === 'none',
      allPanelsVisible: panels.every(node => node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !node.inert && node.getAttribute('aria-hidden') !== 'true')
    };
  })()`);
  check("downloaded HTML remains fully readable without JavaScript", !downloadedNoScript.rootEnhanced && downloadedNoScript.tabsHidden && downloadedNoScript.allPanelsVisible, JSON.stringify(downloadedNoScript));

  await navigate();
  const noScript = await evaluate(`(() => {
    const panels = [...document.querySelectorAll('.delivery-panel')];
    return {
      rootEnhanced: document.documentElement.classList.contains('js'),
      tabsHidden: getComputedStyle(document.querySelector('.delivery-tabs')).display === 'none',
      panels: panels.length,
      allPanelsVisible: panels.every(node => node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})),
      allRevealsVisible: [...document.querySelectorAll('.reveal')].every(node => getComputedStyle(node).opacity === '1'),
      platforms: document.querySelectorAll('.platform-card').length,
      quote: document.getElementById('quote-number').textContent.trim()
    };
  })()`);
  check("without JavaScript all platforms, deliverables and the base quote remain readable", !noScript.rootEnhanced && noScript.tabsHidden && noScript.panels === 3 && noScript.allPanelsVisible && noScript.allRevealsVisible && noScript.platforms === 12 && noScript.quote === "5", JSON.stringify(noScript));
  await cdp("Emulation.setScriptExecutionDisabled", { value: false });

  await cdp("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await navigate();
  const heroButtonPoint = await evaluate(`(() => {
    const rect = document.querySelector('.hero .button-primary').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: heroButtonPoint.x, y: heroButtonPoint.y });
  const reducedMotion = await evaluate(`(() => ({
    reveals: [...document.querySelectorAll('.reveal')].every(node => getComputedStyle(node).opacity === '1' && getComputedStyle(node).transitionDuration === '0s'),
    floats: [...document.querySelectorAll('.floating-card')].every(node => getComputedStyle(node).animationName === 'none'),
    lifts: [...document.querySelectorAll('.lift')].every(node => getComputedStyle(node).transitionDuration === '0s'),
    tabs: [...document.querySelectorAll('.delivery-panel')].every(node => getComputedStyle(node).transitionDuration === '0s'),
    hoveredButtonStatic: getComputedStyle(document.querySelector('.hero .button-primary')).transform === 'none'
  }))()`);
  check("reduced-motion disables reveal, float, hover and tab movement", reducedMotion.reveals && reducedMotion.floats && reducedMotion.lifts && reducedMotion.tabs && reducedMotion.hoveredButtonStatic, JSON.stringify(reducedMotion));

  await cdp("Emulation.setEmulatedMedia", { media: "print" });
  await navigate();
  const printLayout = await evaluate(`(() => ({
    configHidden: getComputedStyle(document.querySelector('.config-panel')).display === 'none',
    quoteStatic: getComputedStyle(document.querySelector('.quote-panel')).position === 'static',
    productVisualsHidden: [...document.querySelectorAll('.delivery-visual')].every(node => getComputedStyle(node).display === 'none'),
    sectionBreaks: [...document.querySelectorAll('#deliverables,#pricing')].every(node => getComputedStyle(node).breakBefore === 'page'),
    panelsCompact: [...document.querySelectorAll('.delivery-panel')].every(node => getComputedStyle(node).display === 'block'),
    panelsVisible: [...document.querySelectorAll('.delivery-panel')].every(node => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1';
    })
  }))()`);
  check("print layout compacts visuals and prints every deliverable on deliberate section pages", printLayout.configHidden && printLayout.quoteStatic && printLayout.productVisualsHidden && printLayout.sectionBreaks && printLayout.panelsCompact && printLayout.panelsVisible, JSON.stringify(printLayout));
  const pdf = await cdp("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
  const pdfBytes = Buffer.from(pdf.data, "base64");
  await writeFile(`${outputDir}/${phase}-print.pdf`, pdfBytes);
  const pageCount = (pdfBytes.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
  check("print output stays within four compact pages", pageCount >= 1 && pageCount <= 4, String(pageCount));
  await cdp("Emulation.setEmulatedMedia", { media: "screen", features: [] });

  for (const width of [1440, 1024, 768, 390]) {
    await viewport(width);
    await navigate();
    const responsive = await evaluate(`(() => {
      const copy = document.querySelector('.hero-copy').getBoundingClientRect();
      const visual = document.querySelector('.hero-visual').getBoundingClientRect();
      const container = document.querySelector('.hero .container').getBoundingClientRect();
      const blue = document.querySelector('.hero-blue-card');
      const visibleFloatNodes = [...document.querySelectorAll('.floating-layer')].filter(node => getComputedStyle(node).display !== 'none');
      const visibleFloats = visibleFloatNodes.length;
      const platformNote = document.querySelector('.platform-note');
      const platformNoteRect = platformNote?.getBoundingClientRect();
      const visualCaption = document.querySelector('.delivery-panel[data-active="true"] .visual-caption') || document.querySelector('.visual-caption');
      const visualCaptionRect = visualCaption?.getBoundingClientRect();
      const productWindow = visualCaption?.parentElement?.querySelector('.product-window');
      const productWindowRect = productWindow?.getBoundingClientRect();
      const deliveryVisualRect = visualCaption?.parentElement?.getBoundingClientRect();
      const intersects = (first, second) => Boolean(first && second && first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top);
      const textLineCount = (container, needle) => {
        if (!container) return 0;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const offset = node.textContent.indexOf(needle);
          if (offset === -1) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + needle.length);
          return new Set([...range.getClientRects()].filter(rect => rect.width > 1).map(rect => Math.round(rect.top))).size;
        }
        return 0;
      };
      return {
        overflow: document.documentElement.scrollWidth <= innerWidth,
        copyBeforeVisual: copy.top < visual.top,
        containerX: container.x,
        radius: blue ? parseFloat(getComputedStyle(blue).borderRadius) : 0,
        visibleFloats,
        floatsWithinViewport: visibleFloatNodes.every(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        }),
        floatOverlapsPlatformNote: visibleFloatNodes.some(node => intersects(node.getBoundingClientRect(), platformNoteRect)),
        platformNoteFont: platformNote ? parseFloat(getComputedStyle(platformNote).fontSize) : 0,
        captionClear: Boolean(visualCaptionRect && deliveryVisualRect && productWindowRect) &&
          visualCaptionRect.left >= deliveryVisualRect.left && visualCaptionRect.right <= deliveryVisualRect.right &&
          visualCaptionRect.top >= deliveryVisualRect.top && visualCaptionRect.bottom <= deliveryVisualRect.bottom &&
          !intersects(visualCaptionRect, productWindowRect),
        pricingTermLines: textLineCount(document.getElementById('pricing-title'), '按平台'),
        deliveryTermLines: textLineCount(document.getElementById('deliverables-title'), '能直接使用'),
        quotePosition: getComputedStyle(document.querySelector('.quote-panel')).position,
        targets: [...document.querySelectorAll('button,a,input')].filter(node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1 && !node.classList.contains('skip-link');
        }).every(node => node.getBoundingClientRect().height >= 44)
      };
    })()`);
    check(`${width}px has no horizontal overflow`, responsive.overflow, JSON.stringify(responsive));
    if (width === 1440) check("desktop hero floats stay clear of platform disclaimer copy", !responsive.floatOverlapsPlatformNote, JSON.stringify(responsive));
    if (width <= 1024) {
      check(`${width}px stacks hero copy before visual`, responsive.copyBeforeVisual, JSON.stringify(responsive));
      check(`${width}px uses a non-sticky quote card`, responsive.quotePosition === "static", responsive.quotePosition);
      check(`${width}px keeps hero floats inside the viewport`, responsive.floatsWithinViewport, JSON.stringify(responsive));
      check(`${width}px gives the product-interface caption its own clear blue gutter`, responsive.captionClear, JSON.stringify(responsive));
    }
    if (width === 1024 || width === 768) check(`${width}px reduces the stacked hero to one float`, responsive.visibleFloats === 1, JSON.stringify(responsive));
    if (width === 390) {
      check("390px uses 24px page gutters", Math.abs(responsive.containerX - 24) <= 1, String(responsive.containerX));
      check("390px uses a 24–32px visual radius", responsive.radius >= 24 && responsive.radius <= 32, String(responsive.radius));
      check("390px reduces floating layers", responsive.visibleFloats <= 2, String(responsive.visibleFloats));
      check("390px keeps the hero float clear of the platform disclaimer", !responsive.floatOverlapsPlatformNote, JSON.stringify(responsive));
      check("390px keeps the platform disclaimer at least 12px", responsive.platformNoteFont >= 12, String(responsive.platformNoteFont));
      check("390px gives the product-interface caption its own clear blue gutter", responsive.captionClear, JSON.stringify(responsive));
      check("390px keeps 按平台 together", responsive.pricingTermLines === 1, String(responsive.pricingTermLines));
      check("390px keeps 能直接使用 together", responsive.deliveryTermLines === 1, String(responsive.deliveryTermLines));
      check("390px keeps visible controls at least 44px tall", responsive.targets, JSON.stringify(responsive));
    }
    await capture(width);
  }

  await viewport(1440);
  await navigate();
  check("runtime remains dependency-free", await evaluate("document.querySelectorAll('script[src],link[rel=\"stylesheet\"],img[src^=\"http\"]').length === 0"));
  check("removed low-information modules remain absent", await evaluate("!document.getElementById('demo')&&!document.getElementById('capabilities')&&!document.getElementById('scenario-title')&&!document.getElementById('custom-title')&&!document.getElementById('pr-title')&&!document.getElementById('cta-title')&&!document.querySelector('.radar-card')"));
  check("entry price remains five万元 per quarter", await evaluate("document.querySelector('.hero').innerText.includes('5 万元／季度起')&&!document.querySelector('.hero').innerText.includes('20 万元／年起')&&document.querySelector('.package-price strong').textContent.trim()==='5 万元起'"));
  check("IDs and label/ARIA references remain valid", await evaluate(`(() => {
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    return new Set(ids).size === ids.length && [...document.querySelectorAll('[for],[aria-labelledby],[aria-describedby],[aria-controls]')].every(node =>
      ['for','aria-labelledby','aria-describedby','aria-controls'].every(attribute =>
        !node.hasAttribute(attribute) || node.getAttribute(attribute).split(/\\s+/).every(value => document.getElementById(value))
      )
    );
  })()`));
  check("browser console remains free of errors", browserErrors.length === 0, browserErrors.join("; "));
} finally {
  if (socket) socket.close();
  browser.kill();
  await new Promise(resolveClose => server.close(resolveClose));
  await writeFile(`${outputDir}/${phase}-results.json`, JSON.stringify(results, null, 2));
}

const failures = results.filter(result => !result.pass);
console.log(`RESULT ${results.length - failures.length}/${results.length} passed; ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
