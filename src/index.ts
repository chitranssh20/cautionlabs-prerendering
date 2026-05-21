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

    // Dev / Lighthouse / Validators
    "chrome-lighthouse",
    "google page speed",
    "w3c_validator",

    // Misc
    "rogerbot",
    "qwantify",
    "showyoubot",
    "outbrain",
    "nuzzel",
    "developers.google.com/+/web/snippet"
];

const CACHE_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const urlStr = request.url;
        const userAgent = request.headers.get("User-Agent")?.toLowerCase() || "";

        const isBot = BOT_USER_AGENTS.some((botToken) => userAgent.includes(botToken));

        // If not a bot, we could either return early (if this worker is only routing),
        // or proxy the request to the original server.
        // Assuming this worker sits in front of the actual application (e.g. as a route):
        if (!isBot) {
            // You should fetch the actual origin or just pass through.
            // If it's the actual cautionlabs.com domain, bypassing will go to the configured origin.
            return fetch(request);
        }

        try {
            // 1. Check in KV Cache
            const cachedHtml = await env.PRERENDER_CACHE.get(urlStr);
            if (cachedHtml) {
                return new Response(cachedHtml, {
                    headers: {
                        "Content-Type": "text/html;charset=UTF-8",
                        "X-Prerendered": "hit"
                    }
                });
            }

            // 2. Not found in KV Cache, launch Puppeteer
            const browser = await puppeteer.launch(env.MYBROWSER);
            const page = await browser.newPage();

            // Navigate to the URL
            // We set waitUntil to 'networkidle0' and add a 15-second timeout per requirements
            await page.goto(urlStr, { waitUntil: 'networkidle0', timeout: 15000 });

            // Extract the rendered HTML
            const renderedHtml = await page.content();

            await page.close();
            await browser.close();

            // 3. Store in KV Cache with 14-day TTL
            ctx.waitUntil(
                env.PRERENDER_CACHE.put(urlStr, renderedHtml, { expirationTtl: CACHE_TTL_SECONDS })
            );

            // 4. Return the prerendered HTML
            return new Response(renderedHtml, {
                headers: {
                    "Content-Type": "text/html;charset=UTF-8",
                    "X-Prerendered": "miss"
                }
            });
        } catch (err: any) {
            // Fallback: If puppeteer fails, return the original un-rendered content
            console.error("Prerendering failed:", err);
            // Wait for the original source and serve it
            return fetch(request);
        }
    }
};
