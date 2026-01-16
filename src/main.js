// AliExpress Reviews Scraper - Using API interception for reliable extraction
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
const BATCH_SIZE = 10;

const extractProductId = (url) => {
    if (!url) return null;
    const match = url.match(/item\/(\d+)\.html/);
    return match ? match[1] : null;
};

const productId = extractProductId(product_url);
if (!productId) {
    log.error('Invalid product URL.');
    await Actor.exit({ exitCode: 1 });
}

log.info(`Starting scraper for product: ${productId}, reviews wanted: ${RESULTS_WANTED}`);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();
const collectedReviews = [];

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    useSessionPool: true,
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
            // Intercept review API responses
            page.on('response', async (response) => {
                const url = response.url();
                if (url.includes('mtop.aliexpress.review') && response.status() === 200) {
                    try {
                        const text = await response.text();
                        // Parse JSONP response
                        const jsonMatch = text.match(/\((\{.*\})\)/s);
                        if (jsonMatch) {
                            const data = JSON.parse(jsonMatch[1]);
                            const reviews = data?.data?.feedbackList || data?.data?.list || [];
                            for (const r of reviews) {
                                if (saved >= RESULTS_WANTED) break;
                                const reviewId = r.evaluationId || r.id || `api_${Date.now()}_${Math.random()}`;
                                if (!seenIds.has(reviewId)) {
                                    seenIds.add(reviewId);
                                    collectedReviews.push({
                                        review_id: String(reviewId),
                                        product_id: productId,
                                        product_url: product_url,
                                        reviewer_name: r.buyerName || r.anonymousBuyer || 'Anonymous',
                                        rating: r.buyerEval || r.star || 5,
                                        review_text: r.buyerTranslationFeedback || r.buyerFeedback || '',
                                        review_date: r.evalDate || null,
                                        sku_info: r.skuInfo || null,
                                        images: (r.images || r.buyerAllUploadImageList || []).map(img =>
                                            (img.startsWith('//') ? 'https:' + img : img).replace(/_\.avif$/i, '').replace(/_\.webp$/i, '')
                                        ),
                                        helpful_count: r.upVoteCount || 0,
                                        country: r.buyerCountry || null,
                                    });
                                    saved++;
                                }
                            }
                            log.info(`API: Captured ${reviews.length} reviews. Total: ${saved}/${RESULTS_WANTED}`);
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            });

            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();
                if (['font', 'media'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('facebook')) {
                    return route.abort();
                }
                return route.continue();
            });

            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page }) {
        log.info(`Processing: ${product_url}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        // Scroll to trigger reviews section
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
        await page.waitForTimeout(1500);

        // Click "View more" or reviews button to open modal and trigger API
        log.info('Opening reviews modal...');
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, a, span, div');
            for (const btn of buttons) {
                const text = btn.textContent?.toLowerCase() || '';
                if ((text.includes('view') && text.includes('more')) ||
                    (text.includes('see') && text.includes('all')) ||
                    text.match(/view\s+\d+/)) {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return true;
                }
            }
            return false;
        });
        await page.waitForTimeout(2500);

        // Scroll within modal to trigger more API calls
        log.info('Scrolling to load all reviews...');
        for (let i = 0; i < 60 && saved < RESULTS_WANTED; i++) {
            // Scroll modal
            const scrolled = await page.evaluate(() => {
                const modals = document.querySelectorAll('[class*="modal-body"], [class*="modal-content"], .comet-v2-modal-body');
                for (const modal of modals) {
                    if (modal.scrollHeight > modal.clientHeight) {
                        const prev = modal.scrollTop;
                        modal.scrollTop += 500;
                        return modal.scrollTop > prev;
                    }
                }
                // Fallback: scroll any scrollable container
                const containers = document.querySelectorAll('[class*="review"], [class*="feedback"], [class*="list"]');
                for (const c of containers) {
                    if (c.scrollHeight > c.clientHeight + 50) {
                        const prev = c.scrollTop;
                        c.scrollTop += 500;
                        return c.scrollTop > prev;
                    }
                }
                return false;
            });

            if (!scrolled) {
                // Try window scroll
                await page.evaluate(() => window.scrollBy(0, 400));
            }

            await page.waitForTimeout(600);

            // Save batches as we go
            if (collectedReviews.length >= BATCH_SIZE) {
                const batch = collectedReviews.splice(0, BATCH_SIZE);
                await Dataset.pushData(batch);
                log.info(`Batch saved. Total: ${saved}/${RESULTS_WANTED}`);
            }

            if (saved >= RESULTS_WANTED) break;
        }

        // If API didn't capture enough, try HTML extraction as fallback
        if (saved < RESULTS_WANTED) {
            log.info('Trying HTML extraction as fallback...');
            const htmlReviews = await page.evaluate(() => {
                const reviews = [];
                const elements = document.querySelectorAll('.list--itemBox--je_KNzb, [class*="feedback-item"], [class*="review-item"]');
                for (const el of elements) {
                    const textEl = el.querySelector('.list--itemReview--d9Z9Z5Z, [class*="review-content"], [class*="feedback"]');
                    const content = textEl?.textContent?.trim();
                    if (content && content.length > 10) {
                        const infoEl = el.querySelector('.list--itemInfo--VEcgSFh');
                        const info = infoEl?.textContent?.split('|') || [];
                        const stars = el.querySelectorAll('.comet-icon-starreviewfilled').length;
                        const imgEls = el.querySelectorAll('img[class*="thumbnail"]');
                        reviews.push({
                            review_id: `html_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                            reviewer_name: info[0]?.trim() || 'Anonymous',
                            rating: stars || 5,
                            review_text: content,
                            review_date: info[1]?.trim() || null,
                            sku_info: el.querySelector('[class*="sku"]')?.textContent?.trim() || null,
                            images: Array.from(imgEls).map(i => i.src?.replace(/_\.avif$/i, '') || '').filter(Boolean),
                            helpful_count: 0,
                            country: null,
                        });
                    }
                }
                return reviews;
            });

            for (const r of htmlReviews) {
                if (saved >= RESULTS_WANTED) break;
                const key = r.review_text.substring(0, 50);
                if (!seenIds.has(key)) {
                    seenIds.add(key);
                    collectedReviews.push({
                        ...r,
                        product_id: productId,
                        product_url: product_url,
                    });
                    saved++;
                }
            }
        }

        // Save remaining
        if (collectedReviews.length > 0) {
            await Dataset.pushData(collectedReviews);
            log.info(`Final batch: ${collectedReviews.length}. Total saved: ${saved}`);
        }

        if (saved === 0) {
            log.warning('No reviews found.');
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
log.info(`Complete. Total reviews: ${saved}`);
await Actor.exit();
