// AliExpress Reviews Scraper - Robust button targeting + dual modal support
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

        // Find and click the CORRECT "View more" button for REVIEWS
        log.info('Finding reviews View more button...');
        const clicked = await page.evaluate(() => {
            // Strategy 1: Find "View more" button near review section (data-anchor="review")
            const reviewSection = document.querySelector('[data-anchor="review"]');
            if (reviewSection) {
                const btns = reviewSection.querySelectorAll('button, span, div, a');
                for (const btn of btns) {
                    const txt = btn.textContent?.trim().toLowerCase();
                    if (txt && txt.length < 30 && txt.includes('view') && txt.includes('more')) {
                        btn.scrollIntoView({ block: 'center' });
                        btn.click();
                        return { method: 'review-section', text: txt };
                    }
                }
            }

            // Strategy 2: Find "View more" button that appears AFTER review content (look for "Helpful" nearby)
            const allButtons = document.querySelectorAll('button, span[role="button"], div[role="button"]');
            for (const btn of allButtons) {
                const txt = btn.textContent?.trim().toLowerCase();
                if (txt === 'view more' || (txt && txt.length < 20 && txt.includes('view') && txt.includes('more'))) {
                    // Check if this button is near review content (parent contains "Helpful" or star ratings)
                    let parent = btn.parentElement;
                    for (let i = 0; i < 5 && parent; i++) {
                        if (parent.textContent?.includes('Helpful') ||
                            parent.querySelector('[class*="star"]') ||
                            parent.querySelector('[class*="rating"]')) {
                            btn.scrollIntoView({ block: 'center' });
                            btn.click();
                            return { method: 'near-helpful', text: txt };
                        }
                        parent = parent.parentElement;
                    }
                }
            }

            // Strategy 3: Find button with specific review-related class
            const reviewBtns = document.querySelectorAll('.v3--btn--KaygomA, [class*="review"] button');
            for (const btn of reviewBtns) {
                const txt = btn.textContent?.trim().toLowerCase();
                if (txt && txt.includes('view') && txt.includes('more')) {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return { method: 'review-class', text: txt };
                }
            }

            // Strategy 4: Last resort - click first short "view more" button after scrolling past half the page
            const buttons = Array.from(document.querySelectorAll('button, span, a')).filter(el => {
                const txt = el.textContent?.trim().toLowerCase() || '';
                const rect = el.getBoundingClientRect();
                return txt === 'view more' && rect.top > 0 && rect.height > 0;
            });

            if (buttons.length > 0) {
                // Prefer button with height < 50px (likely a text button, not a card)
                const smallBtn = buttons.find(b => b.getBoundingClientRect().height < 50);
                if (smallBtn) {
                    smallBtn.scrollIntoView({ block: 'center' });
                    smallBtn.click();
                    return { method: 'last-resort', text: 'view more' };
                }
            }

            return null;
        });

        if (clicked) {
            log.info(`Clicked: "${clicked.text}" via ${clicked.method}. Waiting for modal...`);
            await page.waitForTimeout(3000);
        } else {
            log.warning('Could not find reviews View more button');
        }

        // Check for modal (support both class names)
        const modalInfo = await page.evaluate(() => {
            const modal = document.querySelector('.comet-v2-modal-body') || document.querySelector('.comet-modal-body');
            return modal ? { found: true, className: modal.className } : { found: false };
        });
        log.info(`Modal: ${modalInfo.found ? modalInfo.className : 'not found'}`);

        const reviews = [];
        let lastCount = 0;
        let noNewRounds = 0;

        // Main extraction loop
        for (let i = 0; i < 80 && saved < RESULTS_WANTED; i++) {
            // Extract reviews (try multiple selectors)
            const pageReviews = await page.evaluate(() => {
                const items = [];
                // Try both common selectors
                const boxes = document.querySelectorAll('.list--itemBox--je_KNzb, [class*="review-item"], [class*="feedback-list"] > div');

                for (const box of boxes) {
                    const textEl = box.querySelector('.list--itemReview--d9Z9Z5Z, [class*="review-content"], [class*="feedback"]');
                    const text = textEl?.textContent?.trim();
                    if (!text || text.length < 10) continue;

                    const infoEl = box.querySelector('.list--itemInfo--VEcgSFh, [class*="user-info"]');
                    const infoParts = (infoEl?.textContent || '').split('|').map(s => s.trim());

                    let rating = 5;
                    const starsBox = box.querySelector('[class*="stars--box"], [class*="rating"]');
                    if (starsBox) {
                        const filled = starsBox.querySelectorAll('.comet-icon-starreviewfilled, [class*="star"][class*="full"]');
                        if (filled.length > 0) rating = filled.length;
                    }

                    const skuEl = box.querySelector('.list--itemSku--idEQSGC, [class*="sku"]');
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

            if (i % 5 === 0) {
                log.info(`Round ${i + 1}: ${pageReviews.length} visible, ${saved}/${RESULTS_WANTED} unique`);
            }

            if (saved >= RESULTS_WANTED) break;

            if (saved === lastCount) {
                noNewRounds++;
                if (noNewRounds >= 10) {
                    log.info('No new reviews after 10 scrolls. All collected.');
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

            // Scroll modal (support both class names)
            await page.evaluate(() => {
                const modal = document.querySelector('.comet-v2-modal-body') || document.querySelector('.comet-modal-body');
                if (modal) {
                    modal.scrollBy(0, 1000);
                }
            });
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
