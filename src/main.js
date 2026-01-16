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

        // Click View More for reviews - try multiple methods
        log.info('Looking for reviews button...');

        // Method 1: Click "View more" button near reviews section
        let modalOpened = await page.evaluate(() => {
            const btns = document.querySelectorAll('button, span, a');
            for (const btn of btns) {
                const txt = btn.textContent?.trim().toLowerCase() || '';
                if (txt === 'view more' || (txt.length < 20 && txt.includes('view') && txt.includes('more'))) {
                    let p = btn.parentElement;
                    for (let i = 0; i < 5 && p; i++) {
                        if (p.textContent?.includes('Helpful') || p.querySelector('[class*="star"]')) {
                            btn.click();
                            return true;
                        }
                        p = p.parentElement;
                    }
                }
            }
            return false;
        });

        if (modalOpened) {
            log.info('Clicked View More button');
        } else {
            log.info('View More button not found, trying alternative methods...');

            // Method 2: Click any "View more" in the page
            await page.evaluate(() => {
                const btns = document.querySelectorAll('button, span, a, div');
                for (const btn of btns) {
                    const txt = btn.textContent?.trim().toLowerCase() || '';
                    if (txt === 'view more') {
                        btn.click();
                        return;
                    }
                }
            });
        }

        await page.waitForTimeout(3000);

        // Verify modal is open
        const modalExists = await page.evaluate(() => {
            return !!document.querySelector('.comet-v2-modal-body') || !!document.querySelector('.comet-modal-body');
        });

        if (modalExists) {
            log.info('Reviews modal is open');
        } else {
            log.info('Modal not detected, trying to scroll to reviews and click again...');

            // Method 3: Scroll to reviews section and try clicking
            await page.evaluate(() => {
                const reviewSection = document.querySelector('#nav-review') ||
                    document.querySelector('[class*="review"]') ||
                    document.querySelector('[class*="feedback"]');
                if (reviewSection) reviewSection.scrollIntoView();
            });
            await page.waitForTimeout(1000);

            await page.evaluate(() => {
                const btns = document.querySelectorAll('button, span, a, div');
                for (const btn of btns) {
                    const txt = btn.textContent?.trim().toLowerCase() || '';
                    if (txt === 'view more' || txt.includes('more review')) {
                        btn.click();
                        return;
                    }
                }
            });
            await page.waitForTimeout(3000);
        }

        const reviews = [];
        let lastHeight = 0;
        let lastSavedCount = 0;
        let stableRounds = 0;

        // Extract and scroll loop - pure infinite scroll, no pagination buttons needed
        for (let round = 0; round < 150 && saved < RESULTS_WANTED; round++) {
            // Debug: Log number of boxes found on first round
            if (round === 0) {
                const debugInfo = await page.evaluate(() => {
                    const modalBody = document.querySelector('.comet-v2-modal-body');
                    const boxes = document.querySelectorAll('div[class^="list--itemBox"]');
                    const firstBox = boxes[0];
                    return {
                        modalExists: !!modalBody,
                        boxCount: boxes.length,
                        firstBoxClass: firstBox?.className || 'none',
                        firstBoxText: firstBox?.textContent?.substring(0, 100) || 'none',
                        pageReviewCount: document.querySelectorAll('[class*="review"]').length
                    };
                });
                log.info(`Debug: modalExists=${debugInfo.modalExists}, boxCount=${debugInfo.boxCount}, firstBoxClass=${debugInfo.firstBoxClass}, pageReviewElems=${debugInfo.pageReviewCount}`);
            }

            // Extract reviews using resilient selector
            const found = await page.evaluate(() => {
                const items = [];
                // Use partial attribute selector - resilient to class suffix changes
                const boxes = document.querySelectorAll('div[class^="list--itemBox"]');

                boxes.forEach(box => {
                    // Use resilient selectors - partial attribute match for class prefix
                    const textEl = box.querySelector('[class^="list--itemReview"]') ||
                        box.querySelector('[class*="itemReview"]') ||
                        box.querySelector('[class*="review-content"]');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 10) return;

                    const infoEl = box.querySelector('[class^="list--itemInfo"]') ||
                        box.querySelector('[class*="itemInfo"]');
                    const parts = (infoEl?.textContent || '').split('|').map(s => s.trim());

                    const stars = box.querySelectorAll('.comet-icon-starreviewfilled, [class*="star"][class*="filled"], svg[class*="star"]').length;

                    const skuEl = box.querySelector('[class^="list--itemSku"]') ||
                        box.querySelector('[class*="itemSku"]') ||
                        box.querySelector('[class*="sku"]');
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
