// AliExpress Reviews Scraper - Fixed button targeting
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    product_url,
    results_wanted: RESULTS_WANTED_RAW = 20,
    proxyConfiguration: proxyConfig,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;

const extractProductId = (url) => {
    const match = url?.match(/item\/(\d+)\.html/);
    return match ? match[1] : null;
};

const productId = extractProductId(product_url);
if (!productId) {
    log.error('Invalid product URL.');
    await Actor.exit({ exitCode: 1 });
}

log.info(`Scraping reviews for product: ${productId}, wanted: ${RESULTS_WANTED}`);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenTexts = new Set();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 300,
    navigationTimeoutSecs: 60,
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['firefox'],
                operatingSystems: ['windows'],
                devices: ['desktop'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['font', 'media'].includes(type)) return route.abort();
                return route.continue();
            });
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page }) {
        log.info('Loading page...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        // Scroll to reviews section
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
        await page.waitForTimeout(1500);

        // Find and click the ACTUAL "View more" button (small button element, not large text blocks)
        log.info('Finding View more button...');
        const clicked = await page.evaluate(() => {
            // Look specifically for short buttons/links with "view more" text
            const candidates = document.querySelectorAll('button, a, span[role="button"], div[role="button"]');

            for (const btn of candidates) {
                const txt = btn.textContent?.trim().toLowerCase() || '';
                // Must be SHORT text (actual button) and contain "view more"
                if (txt.length < 30 && txt.includes('view') && txt.includes('more')) {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return { found: true, text: txt };
                }
            }

            // Alternative: Try using Playwright's built-in text locator approach via DOM
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
                const txt = el.textContent?.trim().toLowerCase() || '';
                // Only match elements where the DIRECT text is "view more" (not nested text)
                if (el.childNodes.length <= 3) {
                    let directText = '';
                    for (const node of el.childNodes) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            directText += node.textContent;
                        }
                    }
                    directText = directText.trim().toLowerCase();
                    if (directText === 'view more' || directText === 'view all') {
                        el.scrollIntoView({ block: 'center' });
                        el.click();
                        return { found: true, text: directText };
                    }
                }
            }

            return { found: false };
        });

        if (clicked.found) {
            log.info(`Clicked: "${clicked.text}". Waiting for modal...`);
            await page.waitForTimeout(3000);
        } else {
            log.warning('Could not find View more button');
        }

        // Check if modal opened
        const modalExists = await page.evaluate(() => {
            return !!document.querySelector('.comet-v2-modal-body');
        });
        log.info(`Modal opened: ${modalExists}`);

        const reviews = [];
        let lastCount = 0;
        let noNewRounds = 0;

        // Scroll and extract loop
        for (let i = 0; i < 60 && saved < RESULTS_WANTED; i++) {
            // Extract reviews
            const pageReviews = await page.evaluate(() => {
                const items = [];
                const boxes = document.querySelectorAll('.list--itemBox--je_KNzb');

                for (const box of boxes) {
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 5) continue;

                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh');
                    const infoParts = (infoEl?.textContent || '').split('|').map(s => s.trim());

                    const starsBox = box.querySelector('.stars--box--WrrveRu, [class*="stars--box"]');
                    let rating = 5;
                    if (starsBox) {
                        const filled = starsBox.querySelectorAll('.comet-icon-starreviewfilled');
                        if (filled.length > 0) rating = filled.length;
                    }

                    const skuEl = box.querySelector('.list--itemSku--idEQSGC');
                    const imgs = [...box.querySelectorAll('img')].map(i => i.src).filter(s => s?.includes('alicdn'));

                    items.push({
                        text,
                        name: infoParts[0] || 'Anonymous',
                        date: infoParts[1] || null,
                        rating,
                        sku: skuEl?.textContent?.trim() || null,
                        images: imgs.map(u => u.replace(/_\.avif$/i, '').replace(/_\.webp$/i, '')),
                    });
                }
                return items;
            });

            // Add unique reviews
            for (const r of pageReviews) {
                if (saved >= RESULTS_WANTED) break;
                const key = r.text.substring(0, 80);
                if (!seenTexts.has(key)) {
                    seenTexts.add(key);
                    reviews.push({
                        review_id: `${productId}_${saved + 1}`,
                        product_id: productId,
                        product_url,
                        reviewer_name: r.name,
                        rating: r.rating,
                        review_text: r.text,
                        review_date: r.date,
                        sku_info: r.sku,
                        images: r.images,
                        helpful_count: 0,
                        country: null,
                    });
                    saved++;
                }
            }

            log.info(`Round ${i + 1}: ${pageReviews.length} visible, ${saved}/${RESULTS_WANTED} unique`);

            if (saved >= RESULTS_WANTED) break;

            if (saved === lastCount) {
                noNewRounds++;
                if (noNewRounds >= 8) {
                    log.info('No new reviews after 8 scrolls. Done.');
                    break;
                }
            } else {
                noNewRounds = 0;
                lastCount = saved;
            }

            // Save batches
            if (reviews.length >= 10) {
                await Dataset.pushData(reviews.splice(0, 10));
                log.info('Batch saved.');
            }

            // Scroll modal to bottom
            await page.evaluate(() => {
                const modal = document.querySelector('.comet-v2-modal-body');
                if (modal) {
                    modal.scrollTop = modal.scrollHeight;
                }
            });
            await page.waitForTimeout(1200);
        }

        // Save remaining
        if (reviews.length > 0) {
            await Dataset.pushData(reviews);
        }

        log.info(`Complete. Total: ${saved}`);
    },

    failedRequestHandler({ request }, error) {
        log.error(`Failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
log.info(`Done. Reviews: ${saved}`);
await Actor.exit();
