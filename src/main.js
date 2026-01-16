// AliExpress Reviews Scraper - Correct modal scroll based on research
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
        await page.waitForTimeout(1000);

        // Click "View more" or "View" button to open reviews modal
        log.info('Opening reviews modal...');
        const clicked = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button, a, span, div')];
            for (const btn of buttons) {
                const txt = btn.textContent?.trim().toLowerCase() || '';
                if ((txt === 'view more') ||
                    (txt.includes('view') && txt.includes('more')) ||
                    (txt.startsWith('view') && txt.length < 20)) {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return txt;
                }
            }
            return null;
        });

        if (clicked) {
            log.info(`Clicked: "${clicked}". Waiting for modal...`);
            await page.waitForTimeout(3000);
        }

        const reviews = [];
        let lastCount = 0;
        let noNewRounds = 0;

        // Scroll and extract loop - scroll to bottom of .comet-v2-modal-body
        for (let i = 0; i < 60 && saved < RESULTS_WANTED; i++) {
            // Extract reviews using confirmed selectors
            const pageReviews = await page.evaluate(() => {
                const items = [];
                // Confirmed selector from research
                const boxes = document.querySelectorAll('.list--itemBox--je_KNzb');

                for (const box of boxes) {
                    // Review text - confirmed selector
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 5) continue;

                    // Reviewer info
                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh');
                    const infoParts = (infoEl?.textContent || '').split('|').map(s => s.trim());

                    // Rating - stars box
                    const starsBox = box.querySelector('.stars--box--WrrveRu, [class*="stars--box"]');
                    let rating = 5;
                    if (starsBox) {
                        const filledStars = starsBox.querySelectorAll('.comet-icon-starreviewfilled, [class*="star"][class*="full"]');
                        if (filledStars.length > 0) rating = filledStars.length;
                    }

                    // SKU info
                    const skuEl = box.querySelector('.list--itemSku--idEQSGC, [class*="sku"]');

                    // Images
                    const imgs = [...box.querySelectorAll('img')].map(i => i.src).filter(s => s && s.includes('alicdn'));

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

            log.info(`Round ${i + 1}: ${pageReviews.length} on page, ${saved}/${RESULTS_WANTED} saved`);

            if (saved >= RESULTS_WANTED) break;

            // Check if we're getting new reviews
            if (saved === lastCount) {
                noNewRounds++;
                if (noNewRounds >= 5) {
                    log.info('No new reviews after 5 scrolls. Done.');
                    break;
                }
            } else {
                noNewRounds = 0;
                lastCount = saved;
            }

            // Save in batches of 10
            if (reviews.length >= 10) {
                await Dataset.pushData(reviews.splice(0, 10));
                log.info(`Batch saved.`);
            }

            // SCROLL: Target .comet-v2-modal-body specifically (confirmed from research)
            await page.evaluate(() => {
                const modal = document.querySelector('.comet-v2-modal-body');
                if (modal) {
                    modal.scrollTop = modal.scrollHeight; // Scroll to absolute bottom
                }
            });

            // Wait for new reviews to load (infinite scroll)
            await page.waitForTimeout(1500);
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
