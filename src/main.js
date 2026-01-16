// AliExpress Reviews Scraper - Simplified and robust
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

log.info(`Starting: product ${productId}, wanted ${RESULTS_WANTED}`);

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
    },
    async requestHandler({ page, request }) {
        log.info(`Page loaded: ${request.url}`);
        await page.waitForTimeout(2000);

        // Scroll to reviews
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
        await page.waitForTimeout(1000);

        // Click View More for reviews
        log.info('Looking for reviews button...');
        await page.evaluate(() => {
            const btns = document.querySelectorAll('button, span, a');
            for (const btn of btns) {
                const txt = btn.textContent?.trim().toLowerCase() || '';
                if (txt === 'view more' || (txt.length < 20 && txt.includes('view') && txt.includes('more'))) {
                    let p = btn.parentElement;
                    for (let i = 0; i < 5 && p; i++) {
                        if (p.textContent?.includes('Helpful') || p.querySelector('[class*="star"]')) {
                            btn.click();
                            return;
                        }
                        p = p.parentElement;
                    }
                }
            }
        });
        await page.waitForTimeout(3000);

        const reviews = [];
        let lastHeight = 0;
        let lastSavedCount = 0;
        let stableRounds = 0;

        // Extract and scroll loop - pure infinite scroll, no pagination buttons needed
        for (let round = 0; round < 150 && saved < RESULTS_WANTED; round++) {
            // Extract reviews using resilient selector
            const found = await page.evaluate(() => {
                const items = [];
                // Use partial attribute selector - resilient to class suffix changes
                const boxes = document.querySelectorAll('div[class^="list--itemBox"]');

                boxes.forEach(box => {
                    // Try multiple selectors for review text
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z') ||
                        box.querySelector('[class*="review-content"]') ||
                        box.querySelector('[class*="reviewContent"]') ||
                        box.querySelector('[class*="feedback-content"]');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 10) return;

                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh') ||
                        box.querySelector('[class*="user-info"]') ||
                        box.querySelector('[class*="reviewer"]');
                    const parts = (infoEl?.textContent || '').split('|').map(s => s.trim());
                    const stars = box.querySelectorAll('.comet-icon-starreviewfilled, [class*="star-filled"], [class*="starFilled"]').length;
                    const skuEl = box.querySelector('.list--itemSku--idEQSGC') || box.querySelector('[class*="sku"]');
                    const imgs = [...box.querySelectorAll('img')].map(i => i.src).filter(s => s?.includes('alicdn'));

                    items.push({
                        text,
                        name: parts[0] || 'Anonymous',
                        date: parts[1] || null,
                        rating: stars || 5,
                        sku: skuEl?.textContent?.trim() || null,
                        images: imgs.map(u => u.replace(/_.avif$/i, '').replace(/_.webp$/i, '')),
                    });
                });
                return items;
            });

            // Add unique
            for (const r of found) {
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

            if (round % 5 === 0) log.info(`Round ${round}: ${found.length} visible, ${saved}/${RESULTS_WANTED} saved`);
            if (saved >= RESULTS_WANTED) break;

            // Check if we're making progress (either height changed OR we saved new reviews)
            const height = await page.evaluate(() => {
                const m = document.querySelector('.comet-v2-modal-body') || document.querySelector('.comet-modal-body');
                return m ? m.scrollHeight : 0;
            });

            const madeProgress = (height !== lastHeight) || (saved > lastSavedCount);

            if (!madeProgress) {
                stableRounds++;
                if (stableRounds >= 20) {
                    log.info(`No new content after ${stableRounds} rounds. Done.`);
                    break;
                }
            } else {
                stableRounds = 0;
                lastHeight = height;
                lastSavedCount = saved;
            }

            // Save batch
            if (reviews.length >= 10) {
                await Dataset.pushData(reviews.splice(0, 10));
                log.info('Batch saved.');
            }

            // Scroll to BOTTOM of modal to trigger infinite scroll (loads ~20-23 reviews per scroll)
            await page.evaluate(() => {
                const m = document.querySelector('.comet-v2-modal-body') || document.querySelector('.comet-modal-body');
                if (m) {
                    m.scrollTop = m.scrollHeight;
                }
            });
            // Wait longer for new reviews to load after scrolling to bottom
            await page.waitForTimeout(2000);
        }

        if (reviews.length > 0) await Dataset.pushData(reviews);
        log.info(`Complete: ${saved} reviews saved`);
    },

    failedRequestHandler({ request }, error) {
        log.error(`Failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
log.info(`Done. Total: ${saved}`);
await Actor.exit();
