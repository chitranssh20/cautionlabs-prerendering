import puppeteer from "@cloudflare/puppeteer";

export interface Env {
    PRERENDER_CACHE: KVNamespace;
    MYBROWSER: puppeteer.BrowserWorker;
}

// List of common bot/crawler User-Agents
const BOT_USER_AGENTS = [
    // Google
    "googlebot",
    "googlebot-image",
    "googlebot-news",
    "googlebot-video",
    "google-inspectiontool",
    "googleother",
    "apis-google",
    "mediapartners-google",
    "adsbot-google",
    "storebot-google",

    // Microsoft
    "bingbot",
    "adidxbot",

    // Yahoo
    "slurp",

    // Yandex / Baidu
    "yandexbot",
    "baiduspider",

    // Apple
    "applebot",

    // DuckDuckGo
    "duckduckbot",

    // AI / LLM Crawlers
    "gptbot",
    "chatgpt-user",
    "oai-searchbot",
    "claudebot",
    "anthropic-ai",
    "ccbot",
    "perplexitybot",
    "amazonbot",
    "bytespider",
    "diffbot",
    "cohere-ai",
    "meta-externalagent",
    "imagesiftbot",

    // SEO / Site Analysis
    "ahrefsbot",
    "semrushbot",
    "mj12bot",
    "dotbot",
    "screaming frog",
    "sitebulb",
    "seznambot",

    // Social / Preview
    "facebookexternalhit",
    "twitterbot",
    "linkedinbot",
    "slackbot",
    "discordbot",
    "telegrambot",
    "whatsapp",
    "skypeuripreview",
    "redditbot",
    "embedly",
    "quora link preview",
    "pinterestbot",
    "flipboard",
    "tumblr",
    "bitlybot",
    "vkshare",
    "xing-contenttabreceiver",

    // Validators. Lighthouse and PageSpeed Insights are left out on purpose: they must measure the
    // real page that people load, not a prerendered copy.
    "w3c_validator",

    // Misc
    "rogerbot",
    "qwantify",
    "showyoubot",
    "outbrain",
    "nuzzel",
    "developers.google.com/+/web/snippet"
];

// Hosts that must never be crawled or indexed. Production stays crawlable: it is not listed here.
const NO_CRAWL_HOSTS = new Set(["dev.cautionlabs.com"]);

const NO_CRAWL_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const NO_CRAWL_HEADER = "noindex, nofollow, noarchive";

// For a no-crawl host: answer /robots.txt ourselves, and mark every other response so a crawler that
// ignores robots.txt still does not index it. Nothing is prerendered, whoever is asking.
async function serveNoCrawlHost(request: Request, pathname: string): Promise<Response> {
    if (pathname === "/robots.txt") {
        return new Response(NO_CRAWL_ROBOTS_TXT, {
            headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Robots-Tag": NO_CRAWL_HEADER }
        });
    }
    const response = await fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Robots-Tag", NO_CRAWL_HEADER);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Kept short because there is no cache-purge hook tied to frontend deploys yet —
// a long TTL here means bots keep seeing stale title/meta/content after a deploy.
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 1 day

// Only page URLs are prerendered. Anything with a file extension (robots.txt, sitemap.xml, llms.txt,
// /.well-known/*, JS, CSS, images) must reach the bot as the file it is: a browser render wraps it in
// an HTML viewer, and then crawlers cannot parse it.
const isPageRequest = (request: Request, pathname: string): boolean =>
    request.method === "GET" && !/\.\w+$/.test(pathname);

// Not needed for the HTML, and analytics must not count a render as a visit.
const SKIPPED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const SKIPPED_HOSTS = ["googletagmanager.com", "google-analytics.com"];

// The page can set the HTTP status of its render, see NotFoundPage in the frontend.
const PAGE_STATUS_PATTERN = /<meta[^>]*name="prerender-status-code"[^>]*content="(\d{3})"/;

interface RenderedPageMeta {
    status: number;
    // Set when the app redirected to another path.
    location?: string;
}

async function renderPage(env: Env, url: string): Promise<{ html: string; meta: RenderedPageMeta }> {
    const browser = await puppeteer.launch(env.MYBROWSER);
    // Always close it: a leaked session counts against the Browser Rendering limits until it times out.
    try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on("request", (pageRequest) => {
            const { hostname } = new URL(pageRequest.url());
            const skip =
                SKIPPED_RESOURCE_TYPES.has(pageRequest.resourceType()) ||
                SKIPPED_HOSTS.some((host) => hostname.endsWith(host));
            void (skip ? pageRequest.abort() : pageRequest.continue());
        });

        await page.goto(url, { waitUntil: "networkidle0", timeout: 15000 });
        const html = await page.content();

        const finalUrl = new URL(page.url());
        if (finalUrl.pathname !== new URL(url).pathname) {
            return { html, meta: { status: 301, location: finalUrl.href } };
        }
        const status = Number(html.match(PAGE_STATUS_PATTERN)?.[1] ?? 200);
        return { html, meta: { status } };
    } finally {
        await browser.close();
    }
}

function pageResponse(html: string, meta: RenderedPageMeta, cacheState: "hit" | "miss"): Response {
    if (meta.location) {
        return new Response(null, {
            status: meta.status,
            headers: { Location: meta.location, "X-Prerendered": cacheState }
        });
    }
    return new Response(html, {
        status: meta.status,
        headers: { "Content-Type": "text/html;charset=UTF-8", "X-Prerendered": cacheState }
    });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const urlStr = request.url;
        const { hostname, pathname } = new URL(urlStr);
        if (NO_CRAWL_HOSTS.has(hostname)) {
            return serveNoCrawlHost(request, pathname);
        }
        const userAgent = request.headers.get("User-Agent")?.toLowerCase() || "";

        console.log(`[Worker Intercept] URL: ${urlStr} | User-Agent: ${userAgent}`);

        const isBot = BOT_USER_AGENTS.some((botToken) => userAgent.includes(botToken));

        // If not a bot, we could either return early (if this worker is only routing),
        // or proxy the request to the original server.
        // Assuming this worker sits in front of the actual application (e.g. as a route):
        if (!isBot || !isPageRequest(request, pathname)) {
            // You should fetch the actual origin or just pass through.
            // If it's the actual cautionlabs.com domain, bypassing will go to the configured origin.
            return fetch(request);
        }

        // Lets you force a fresh render + cache overwrite for a specific URL right after a
        // deploy, instead of waiting out CACHE_TTL_SECONDS, e.g.:
        //   curl -H "User-Agent: Googlebot" -H "X-Prerender-Refresh: 1" https://cautionlabs.com/pricing
        const forceRefresh = request.headers.get("X-Prerender-Refresh") === "1";

        try {
            // 1. Check in KV Cache
            if (!forceRefresh) {
                const cached = await env.PRERENDER_CACHE.getWithMetadata<RenderedPageMeta>(urlStr);
                if (cached.value) {
                    // Entries written before statuses were stored have no metadata.
                    return pageResponse(cached.value, cached.metadata ?? { status: 200 }, "hit");
                }
            }

            // 2. Not found in KV Cache, render it
            const { html, meta } = await renderPage(env, urlStr);

            // 3. Store in KV Cache. A 5xx is a passing failure: the next crawl should try again.
            if (meta.status < 500) {
                ctx.waitUntil(
                    env.PRERENDER_CACHE.put(urlStr, html, { expirationTtl: CACHE_TTL_SECONDS, metadata: meta })
                );
            }

            // 4. Return the prerendered HTML
            return pageResponse(html, meta, "miss");
        } catch (err: any) {
            // Fallback: If puppeteer fails, return the original un-rendered content
            console.error("Prerendering failed:", err);
            // Wait for the original source and serve it
            return fetch(request);
        }
    }
};
