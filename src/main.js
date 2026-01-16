// AliExpress Reviews Scraper - Production-ready with full pagination
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    product_url,
    results_wanted: RESULTS_WANTED_RAW = 20,
    filter = 'all',
    sort = 'default',
    proxyConfiguration: proxyConfig,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;
const BATCH_SIZE = 10;

// Extract product ID from URL
const extractProductId = (url) => {
    if (!url) return null;
    const match = url.match(/item\/(\d+)\.html/);
    return match ? match[1] : null;
};

const productId = extractProductId(product_url);
if (!productId) {
    log.error('Invalid product URL. Please provide a valid AliExpress product page URL.');
    await Actor.exit({ exitCode: 1 });
}

log.info(`Starting AliExpress Reviews Scraper for product: ${productId}, results wanted: ${RESULTS_WANTED}`);

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 3,
        sessionOptions: { maxUsageCount: 3 },
    },
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 600,
    navigationTimeoutSecs: 90,
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
                const url = route.request().url();
                if (['font', 'media'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
                    url.includes('facebook') ||
                    url.includes('doubleclick')) {
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

        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        // Scroll down to trigger lazy loading
        log.info('Scrolling to load page content...');
        for (let i = 0; i < 3; i++) {
            await page.evaluate((i) => window.scrollTo(0, document.body.scrollHeight * (0.3 * (i + 1))), i);
            await page.waitForTimeout(1000);
        }

        // Try to find and click the reviews/feedback section or button
        log.info('Looking for reviews section...');
        const clickedReviews = await page.evaluate(() => {
            // Try clicking on "Reviews" tab if exists
            const tabSelectors = ['[data-pl="product-reviewer"]', '[class*="tab-item"]', '[class*="product-tab"]'];
            for (const sel of tabSelectors) {
                const tabs = document.querySelectorAll(sel);
                for (const tab of tabs) {
                    if (tab.textContent?.toLowerCase().includes('review')) {
                        tab.click();
                        return 'tab';
                    }
                }
            }

            // Try "View more" or "See all" buttons
            const buttons = document.querySelectorAll('button, a, span, div');
            for (const btn of buttons) {
                const text = btn.textContent?.toLowerCase() || '';
                if ((text.includes('view') && text.includes('more')) ||
                    (text.includes('see') && text.includes('all')) ||
                    (text === 'view more') ||
                    (text.match(/view\s+\d+\s+more/))) {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return 'button';
                }
            }
            return null;
        });

        if (clickedReviews) {
            log.info(`Clicked reviews ${clickedReviews}, waiting for content...`);
            await page.waitForTimeout(3000);
        }

        // Function to extract reviews from page
        const extractReviews = async () => {
            return await page.evaluate(() => {
                const reviews = [];

                // Multiple possible selectors for review containers
                const containerSelectors = [
                    '.list--itemBox--je_KNzb',
                    '[class*="review-item"]',
                    '[class*="feedback-item"]',
                    '[class*="buyer-review"]',
                    '[class*="itemBox"]',
                    '.comet-v2-modal-body [class*="list"]',
                ];

                let reviewElements = [];
                for (const selector of containerSelectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        reviewElements = Array.from(elements);
                        break;
                    }
                }

                // If no specific containers found, look for review-like structures
                if (reviewElements.length === 0) {
                    // Look for elements containing star ratings and text content
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        const hasStars = div.querySelector('[class*="star"]');
                        const hasText = div.textContent?.length > 50;
                        if (hasStars && hasText && div.className.includes('item')) {
                            reviewElements.push(div);
                        }
                    }
                }

                for (const el of reviewElements) {
                    try {
                        // Get review text - try multiple selectors
                        let content = '';
                        const textSelectors = [
                            '.list--itemReview--d9Z9Z5Z',
                            '[class*="review-content"]',
                            '[class*="buyer-feedback"]',
                            '[class*="feedback-text"]',
                            '[class*="content"]',
                        ];
                        for (const sel of textSelectors) {
                            const textEl = el.querySelector(sel);
                            if (textEl?.textContent?.trim().length > 10) {
                                content = textEl.textContent.trim();
                                break;
                            }
                        }

                        if (!content) continue;

                        // Get reviewer info
                        const infoEl = el.querySelector('.list--itemInfo--VEcgSFh, [class*="user-info"], [class*="reviewer"]');
                        const info = infoEl?.textContent?.trim() || '';
                        const infoParts = info.split('|').map(s => s.trim());

                        // Get rating
                        let stars = 0;
                        const starEls = el.querySelectorAll('.comet-icon-starreviewfilled, [class*="star-filled"], [class*="star"][class*="full"]');
                        stars = starEls.length || 5;

                        // Get SKU
                        const skuEl = el.querySelector('.list--itemSku--idEQSGC, [class*="sku-info"]');

                        // Get images
                        const imgEls = el.querySelectorAll('img[class*="thumbnail"], img[class*="review"]');
                        const images = Array.from(imgEls)
                            .map(img => img.src || img.dataset?.src)
                            .filter(Boolean)
                            .map(url => url.replace(/_\.avif$/i, '').replace(/_\.webp$/i, ''));

                        // Get country
                        let country = null;
                        const countryEl = el.querySelector('[class*="country"], [class*="flag"]');
                        if (countryEl) {
                            country = countryEl.textContent?.trim() || countryEl.getAttribute('title');
                        }

                        reviews.push({
                            review_id: `${content.substring(0, 30).replace(/\W/g, '')}_${Math.random().toString(36).substr(2, 6)}`,
                            reviewer_name: infoParts[0] || 'Anonymous',
                            rating: stars,
                            review_text: content,
                            review_date: infoParts[1] || null,
                            sku_info: skuEl?.textContent?.trim() || null,
                            images: images,
                            helpful_count: 0,
                            country: country,
                        });
                    } catch (e) { /* skip */ }
                }

                return reviews;
            });
        };

        // Function to scroll and load more
        const scrollForMore = async () => {
            return await page.evaluate(() => {
                // Try modal first
                const modalSelectors = [
                    '.v3--modal-content--S7_r_eW',
                    '.comet-v2-modal-body',
                    '.comet-modal-body',
                    '[class*="modal-body"]',
                    '[class*="modal-content"]',
                ];

                for (const sel of modalSelectors) {
                    const modal = document.querySelector(sel);
                    if (modal && modal.scrollHeight > modal.clientHeight) {
                        const prev = modal.scrollTop;
                        modal.scrollTop += 600;
                        if (modal.scrollTop > prev) return true;
                    }
                }

                // Try any scrollable container
                const scrollables = document.querySelectorAll('[class*="review"], [class*="feedback"], [class*="list"]');
                for (const el of scrollables) {
                    if (el.scrollHeight > el.clientHeight + 100) {
                        const prev = el.scrollTop;
                        el.scrollTop += 600;
                        if (el.scrollTop > prev) return true;
                    }
                }

                // Fallback to window scroll
                const prev = window.scrollY;
                window.scrollBy(0, 500);
                return window.scrollY > prev;
            });
        };

        // Collect reviews
        const allReviews = [];
        let prevCount = 0;
        let noProgress = 0;
        const maxAttempts = 80;

        // First extraction attempt
        let initialReviews = await extractReviews();
        log.info(`Initial extraction: found ${initialReviews.length} reviews`);

        for (let attempt = 0; attempt < maxAttempts && saved < RESULTS_WANTED; attempt++) {
            const currentReviews = await extractReviews();

            // Add unique reviews
            for (const review of currentReviews) {
                const key = review.review_text.substring(0, 60);
                if (!seenIds.has(key) && saved < RESULTS_WANTED) {
                    seenIds.add(key);
                    allReviews.push({
                        review_id: review.review_id,
                        product_id: productId,
                        product_url: product_url,
                        reviewer_name: review.reviewer_name,
                        rating: review.rating,
                        review_text: review.review_text,
                        review_date: review.review_date,
                        sku_info: review.sku_info,
                        images: review.images.map(img => {
                            let url = img.startsWith('//') ? `https:${img}` : img;
                            return url.replace(/_\.avif$/i, '').replace(/_\.webp$/i, '');
                        }),
                        helpful_count: review.helpful_count,
                        country: review.country,
                    });
                    saved++;
                }
            }

            // Save in batches
            if (allReviews.length >= BATCH_SIZE) {
                await Dataset.pushData(allReviews.splice(0, BATCH_SIZE));
                log.info(`Batch saved. Total: ${saved}/${RESULTS_WANTED}`);
            }

            if (saved >= RESULTS_WANTED) {
                log.info('Target reached!');
                break;
            }

            if (saved === prevCount) {
                noProgress++;
                if (noProgress >= 6) {
                    log.info('No new reviews found. Collection complete.');
                    break;
                }
            } else {
                noProgress = 0;
                log.info(`Progress: ${saved}/${RESULTS_WANTED}`);
            }
            prevCount = saved;

            const scrolled = await scrollForMore();
            if (!scrolled && noProgress >= 2) {
                log.info('Cannot scroll further and no new reviews.');
                break;
            }

            await page.waitForTimeout(700);
        }

        // Save remaining
        if (allReviews.length > 0) {
            await Dataset.pushData(allReviews);
            log.info(`Final batch saved. Total: ${saved}`);
        }

        if (saved === 0) {
            log.warning('No reviews found. The product may have no reviews or selectors may need updating.');
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url, userData: { pageNo: 1 } }]);
log.info(`Scraping completed. Total reviews saved: ${saved}`);
await Actor.exit();
