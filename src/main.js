// AliExpress Reviews Scraper - Wait for scrollHeight changes
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
        log.info('Loading...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
        await page.waitForTimeout(1500);

        log.info('Finding reviews button...');
        const clicked = await page.evaluate(() => {
            const reviewSection = document.querySelector('[data-anchor="review"]');
            if (reviewSection) {
                const btns = reviewSection.querySelectorAll('button, span, div, a');
                for (const btn of btns) {
                    const txt = btn.textContent?.trim().toLowerCase();
                    if (txt && txt.length < 30 && txt.includes('view') && txt.includes('more')) {
                        btn.scrollIntoView({ block: 'center' });
                        btn.click();
                        return true;
                    }
                }
            }

            const allButtons = document.querySelectorAll('button, span, a');
            for (const btn of allButtons) {
                const txt = btn.textContent?.trim().toLowerCase();
                if (txt === 'view more' || (txt && txt.length < 20 && txt.includes('view') && txt.includes('more'))) {
                    let parent = btn.parentElement;
                    for (let i = 0; i < 5 && parent; i++) {
                        if (parent.textContent?.includes('Helpful') || parent.querySelector('[class*="star"]')) {
                            btn.scrollIntoView({ block: 'center' });
                            btn.click();
                            return true;
                        }
                        parent = parent.parentElement;
                    }
                }
            }
            return false;
        });

        if (clicked) {
            log.info('Button clicked. Waiting...');
            await page.waitForTimeout(3000);
        }

        const reviews = [];
        let lastHeight = 0;
        let noChangeRounds = 0;

        // Main loop - wait for content to load by monitoring scrollHeight
        for (let i = 0; i < 100 && saved < RESULTS_WANTED; i++) {
            // Extract reviews
            const pageReviews = await page.evaluate(() => {
                const items = [];
                const boxes = document.querySelectorAll('.list--itemBox--je_KNzb, [class*="review-item"]');

                for (const box of boxes) {
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z, [class*="review-content"]');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 10) continue;

                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh');
                    const infoParts = (infoEl?.textContent || '').split('|').map(s => s.trim());

                    let rating = 5;
                    const starsBox = box.querySelector('[class*="stars--box"]');
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

            // Add unique
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

            if (i % 5 === 0) {
                log.info(`Round ${i + 1}: ${pageReviews.length} on page, ${saved}/${RESULTS_WANTED} saved`);
            }

            if (saved >= RESULTS_WANTED) break;

            // Check scrollHeight to see if content is loading
            const scrollInfo = await page.evaluate(() => {
                const modal = document.querySelector('.comet-v2-modal-body') || document.querySelector('.comet-modal-body');
                if (modal) {
                    return { height: modal.scrollHeight, found: true };
                }
                return { height: 0, found: false };
            });

            if (scrollInfo.found) {
                if (scrollInfo.height === lastHeight) {
                    noChangeRounds++;
                } else {
                    noChangeRounds = 0;
                    lastHeight = scrollInfo.height;
                }
            }

            if (noChangeRounds >= 15) {
                log.info('No scrollHeight change for 15 rounds. Done.');
                break;
            }

            // Save batches
            if (reviews.length >= 10) {
                await Dataset.pushData(reviews.splice(0, 10));
                log.info('Batch saved.');
            }

            // Scroll to bottom (like browser research)
            await page.evaluate(() => {
                const modal = document.querySelector('.comet-v2-modal-body') || document.querySelector('.comet-modal-body');
                if (modal) {
                    modal.scrollTop = modal.scrollHeight;
                }
            });

            // Wait 2 seconds for content to load
            await page.waitForTimeout(2000);
        }

        if (reviews.length > 0) {
            await Dataset.pushData(reviews);
        }

        log.info(`Done. Total: ${saved}`);
    },

    failedRequestHandler({ request }, error) {
        log.error(`Failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
log.info(`Complete. Reviews: ${saved}`);
await Actor.exit();
