// AliExpress Reviews Scraper - Proper modal scrolling with wait for content
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
        log.info('Loading product page...');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        // Scroll to reviews section
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
        await page.waitForTimeout(1500);

        // Click "View more" to open reviews modal
        log.info('Looking for View More button...');
        const clicked = await page.evaluate(() => {
            const elements = [...document.querySelectorAll('button, a, span, div')];
            for (const el of elements) {
                const txt = el.textContent?.toLowerCase() || '';
                if ((txt.includes('view') && txt.includes('more')) ||
                    (txt.includes('see') && txt.includes('all')) ||
                    txt.match(/view\s+\d+/)) {
                    el.scrollIntoView({ block: 'center' });
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            log.info('Clicked View More, waiting for modal...');
            await page.waitForTimeout(3000);
        } else {
            log.info('No View More button found, scraping from page');
        }

        const reviews = [];
        let lastCount = 0;
        let stableCount = 0;

        // Main extraction loop with proper scrolling
        for (let iteration = 0; iteration < 100 && saved < RESULTS_WANTED; iteration++) {
            // Extract all visible reviews
            const pageReviews = await page.evaluate(() => {
                const items = [];
                // Try multiple selectors
                const selectors = '.list--itemBox--je_KNzb, [class*="feedback-item"], [class*="review-item"]';
                const boxes = document.querySelectorAll(selectors);

                for (const box of boxes) {
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z, [class*="review-content"], [class*="buyer-feedback"]');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 5) continue;

                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh, [class*="user-info"]');
                    const infoParts = (infoEl?.textContent || '').split('|').map(s => s.trim());
                    const stars = box.querySelectorAll('.comet-icon-starreviewfilled').length;
                    const skuEl = box.querySelector('.list--itemSku--idEQSGC, [class*="sku"]');
                    const imgs = [...box.querySelectorAll('img')].map(i => i.src).filter(s => s && s.includes('alicdn'));

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

            // Log progress every 5 iterations
            if (iteration % 5 === 0) {
                log.info(`Iteration ${iteration}: Found ${pageReviews.length} on page, ${saved}/${RESULTS_WANTED} unique saved`);
            }

            // Check if we're done
            if (saved >= RESULTS_WANTED) {
                log.info('Target reached!');
                break;
            }

            // Check if count is stable (no new reviews loading)
            if (saved === lastCount) {
                stableCount++;
                if (stableCount >= 10) {
                    log.info('No new reviews after 10 scroll attempts. All available reviews collected.');
                    break;
                }
            } else {
                stableCount = 0;
                lastCount = saved;
            }

            // Save in batches
            if (reviews.length >= 10) {
                await Dataset.pushData(reviews.splice(0, 10));
                log.info(`Batch saved. Total: ${saved}/${RESULTS_WANTED}`);
            }

            // SCROLL: Try modal first, then page, with different methods
            const scrollInfo = await page.evaluate(() => {
                // Method 1: Try known modal containers
                const modalContainers = [
                    '.comet-v2-modal-body',
                    '.v3--modal-content--S7_r_eW',
                    '[class*="modal-body"]',
                    '[class*="modal-content"]',
                    '[class*="dialog-body"]',
                ];

                for (const sel of modalContainers) {
                    const modal = document.querySelector(sel);
                    if (modal && modal.scrollHeight > modal.clientHeight + 10) {
                        const prevTop = modal.scrollTop;
                        modal.scrollTop = modal.scrollTop + 300;
                        if (modal.scrollTop > prevTop) {
                            return { method: 'modal', selector: sel, scrolled: true };
                        }
                    }
                }

                // Method 2: Find any deep scrollable element inside modal
                const modalRoot = document.querySelector('[class*="modal"]');
                if (modalRoot) {
                    const allElements = modalRoot.querySelectorAll('*');
                    for (const el of allElements) {
                        if (el.scrollHeight > el.clientHeight + 50 && el.scrollHeight > 200) {
                            const prevTop = el.scrollTop;
                            el.scrollTop = el.scrollTop + 300;
                            if (el.scrollTop > prevTop) {
                                return { method: 'modal-child', className: el.className.substring(0, 50), scrolled: true };
                            }
                        }
                    }
                }

                // Method 3: Scroll the main page
                const prevScroll = window.scrollY;
                window.scrollBy(0, 400);
                return { method: 'window', scrolled: window.scrollY > prevScroll };
            });

            // Wait for new content to load after scroll
            await page.waitForTimeout(800);
        }

        // Save remaining reviews
        if (reviews.length > 0) {
            await Dataset.pushData(reviews);
        }

        log.info(`Completed. Total saved: ${saved}`);
    },

    failedRequestHandler({ request }, error) {
        log.error(`Failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
log.info(`Scraping complete. Reviews saved: ${saved}`);
await Actor.exit();
