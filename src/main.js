// AliExpress Reviews Scraper - Fast HTML extraction with modal scrolling
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
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 45,
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
                if (['font', 'media', 'image'].includes(type)) return route.abort();
                return route.continue();
            });
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page }) {
        log.info('Loading product page...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(1500);

        // Quick scroll to reviews area
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
        await page.waitForTimeout(1000);

        // Click "View more" to open reviews modal
        log.info('Opening reviews...');
        const clicked = await page.evaluate(() => {
            const elements = [...document.querySelectorAll('button, a, span, div')];
            for (const el of elements) {
                const txt = el.textContent?.toLowerCase() || '';
                if (txt.includes('view') && (txt.includes('more') || txt.includes('all'))) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            await page.waitForTimeout(2000);
            log.info('Modal opened');
        }

        const reviews = [];
        let noNewCount = 0;

        // Extract and scroll loop
        for (let i = 0; i < 50 && saved < RESULTS_WANTED; i++) {
            // Extract reviews from page
            const pageReviews = await page.evaluate(() => {
                const items = [];
                const boxes = document.querySelectorAll('.list--itemBox--je_KNzb, [class*="review-item"], [class*="feedback-item"]');

                for (const box of boxes) {
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z, [class*="review-content"], [class*="buyer-feedback"]');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 5) continue;

                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh');
                    const infoParts = (infoEl?.textContent || '').split('|').map(s => s.trim());
                    const stars = box.querySelectorAll('.comet-icon-starreviewfilled').length;
                    const skuEl = box.querySelector('.list--itemSku--idEQSGC, [class*="sku"]');
                    const imgs = [...box.querySelectorAll('img')].map(i => i.src).filter(s => s.includes('alicdn'));

                    items.push({
                        text,
                        name: infoParts[0] || 'Anonymous',
                        date: infoParts[1] || null,
                        rating: stars || 5,
                        sku: skuEl?.textContent?.trim() || null,
                        images: imgs.map(u => u.replace(/_\.avif$/i, '').replace(/_\.webp$/i, '')),
                    });
                }
                return items;
            });

            // Add new unique reviews
            let added = 0;
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
                    added++;
                }
            }

            if (added === 0) {
                noNewCount++;
                if (noNewCount >= 4) break;
            } else {
                noNewCount = 0;
            }

            // Save in batches
            if (reviews.length >= 10) {
                await Dataset.pushData(reviews.splice(0, 10));
                log.info(`Saved batch. Total: ${saved}/${RESULTS_WANTED}`);
            }

            if (saved >= RESULTS_WANTED) break;

            // Scroll modal or page
            await page.evaluate(() => {
                const modal = document.querySelector('.comet-v2-modal-body, [class*="modal-body"], [class*="modal-content"]');
                if (modal) {
                    modal.scrollTop += 400;
                } else {
                    window.scrollBy(0, 400);
                }
            });
            await page.waitForTimeout(500);
        }

        // Save remaining
        if (reviews.length > 0) {
            await Dataset.pushData(reviews);
        }

        log.info(`Done. Total saved: ${saved}`);
    },

    failedRequestHandler({ request }, error) {
        log.error(`Failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
log.info(`Complete. Reviews saved: ${saved}`);
await Actor.exit();
