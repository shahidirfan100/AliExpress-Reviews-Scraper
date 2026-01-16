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
    maxRequestRetries: 5,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 3 },
    },
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 300,
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

        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // First scroll down to reviews section
        log.info('Scrolling to reviews section...');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
        await page.waitForTimeout(2000);

        // Try to click the "View more" / "See all reviews" button to open reviews modal
        log.info('Looking for reviews modal button...');
        const modalOpened = await page.evaluate(() => {
            // Various selectors for the "View more" or "See all" button
            const selectors = [
                'button.v3--btn--KaygomA',
                '[class*="review"] button',
                '[class*="feedback"] button',
                'button:has-text("View more")',
                'button:has-text("See all")',
                'a:has-text("View more")',
                '[class*="more-review"]',
            ];

            for (const selector of selectors) {
                try {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        if (el.textContent?.toLowerCase().includes('view') ||
                            el.textContent?.toLowerCase().includes('see all') ||
                            el.textContent?.toLowerCase().includes('more')) {
                            el.scrollIntoView();
                            el.click();
                            return true;
                        }
                    }
                } catch (e) { /* continue */ }
            }

            // Also try finding by text content directly
            const allButtons = document.querySelectorAll('button, a, div[role="button"]');
            for (const btn of allButtons) {
                const text = btn.textContent?.toLowerCase() || '';
                if ((text.includes('view') && text.includes('more')) ||
                    (text.includes('see') && text.includes('all')) ||
                    (text.includes('all') && text.includes('review'))) {
                    btn.scrollIntoView();
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (modalOpened) {
            log.info('Reviews modal button clicked, waiting for modal...');
            await page.waitForTimeout(3000);
        }

        // Function to extract reviews from page/modal
        const extractReviews = async () => {
            return await page.evaluate(() => {
                const reviews = [];

                // Try multiple selectors for review items
                const reviewSelectors = [
                    '.list--itemBox--je_KNzb',
                    '[class*="feedback-item"]',
                    '[class*="review-item"]',
                    '[class*="itemBox"]',
                    '.buyer-review',
                ];

                let reviewElements = [];
                for (const selector of reviewSelectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        reviewElements = elements;
                        break;
                    }
                }

                for (const el of reviewElements) {
                    try {
                        // Get reviewer info
                        const infoEl = el.querySelector('.list--itemInfo--VEcgSFh, [class*="user-name"], [class*="user-info"], [class*="reviewer"]');
                        const info = infoEl?.textContent?.trim() || '';
                        const infoParts = info.split('|').map(s => s.trim());

                        // Get rating - count filled stars
                        const starSelectors = [
                            '.comet-icon-starreviewfilled',
                            '[class*="star-view"] > span[class*="active"]',
                            '[class*="star-icon"][class*="full"]',
                            'svg[class*="star"][class*="filled"]',
                        ];
                        let stars = 0;
                        for (const starSel of starSelectors) {
                            const starEls = el.querySelectorAll(starSel);
                            if (starEls.length > 0) {
                                stars = starEls.length;
                                break;
                            }
                        }

                        // Get review content
                        const contentSelectors = [
                            '.list--itemReview--d9Z9Z5Z',
                            '[class*="buyer-feedback"]',
                            '[class*="review-content"]',
                            '[class*="feedback-text"]',
                        ];
                        let content = '';
                        for (const contentSel of contentSelectors) {
                            const contentEl = el.querySelector(contentSel);
                            if (contentEl?.textContent?.trim()) {
                                content = contentEl.textContent.trim();
                                break;
                            }
                        }

                        // Get SKU info
                        const skuEl = el.querySelector('.list--itemSku--idEQSGC, [class*="sku-info"], [class*="product-info"]');

                        // Get images
                        const imgEls = el.querySelectorAll('.list--itemThumbnails--TtUDHhl img, [class*="review-image"] img, [class*="thumbnail"] img');
                        const images = Array.from(imgEls).map(img => img.src || img.dataset?.src).filter(Boolean);

                        // Get country if available
                        const countryEl = el.querySelector('[class*="country"], [class*="flag"]');

                        // Generate unique ID from content hash
                        const reviewId = `${content.substring(0, 20).replace(/\W/g, '')}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

                        if (content) {
                            reviews.push({
                                review_id: reviewId,
                                reviewer_name: infoParts[0] || 'Anonymous',
                                rating: stars || 5,
                                review_text: content,
                                review_date: infoParts[1] || null,
                                sku_info: skuEl?.textContent?.trim() || null,
                                images: images,
                                helpful_count: 0,
                                country: countryEl?.textContent?.trim() || null,
                            });
                        }
                    } catch (e) { /* skip failed review */ }
                }

                return reviews;
            });
        };

        // Function to scroll within modal to load more reviews
        const scrollModalForMore = async () => {
            return await page.evaluate(() => {
                // Find the modal/scrollable container
                const modalSelectors = [
                    '.v3--modal-content--S7_r_eW',
                    '.comet-v2-modal-body',
                    '.comet-modal-body',
                    '[class*="modal-content"]',
                    '[class*="review-list"]',
                    '[class*="feedback-list"]',
                ];

                for (const selector of modalSelectors) {
                    const modal = document.querySelector(selector);
                    if (modal && modal.scrollHeight > modal.clientHeight) {
                        const prevScrollTop = modal.scrollTop;
                        modal.scrollTop += 500;
                        return modal.scrollTop > prevScrollTop;
                    }
                }

                // If no modal, try scrolling main page
                const prevScroll = window.scrollY;
                window.scrollBy(0, 500);
                return window.scrollY > prevScroll;
            });
        };

        // Collect reviews with pagination
        const allReviews = [];
        let previousCount = 0;
        let noNewReviewsCount = 0;
        const maxScrollAttempts = 50;

        for (let attempt = 0; attempt < maxScrollAttempts && saved < RESULTS_WANTED; attempt++) {
            // Extract current reviews
            const currentReviews = await extractReviews();

            // Add only new reviews
            for (const review of currentReviews) {
                const contentKey = review.review_text.substring(0, 50);
                if (!seenIds.has(contentKey) && saved < RESULTS_WANTED) {
                    seenIds.add(contentKey);
                    allReviews.push({
                        review_id: review.review_id,
                        product_id: productId,
                        product_url: product_url,
                        reviewer_name: review.reviewer_name,
                        rating: review.rating,
                        review_text: review.review_text,
                        review_date: review.review_date,
                        sku_info: review.sku_info,
                        images: review.images.map(img => img.startsWith('//') ? `https:${img}` : img),
                        helpful_count: review.helpful_count,
                        country: review.country,
                    });
                    saved++;
                }
            }

            log.info(`Attempt ${attempt + 1}: Found ${currentReviews.length} reviews on page. Total unique: ${saved}/${RESULTS_WANTED}`);

            // Check if we've reached our goal
            if (saved >= RESULTS_WANTED) {
                log.info('Reached desired number of reviews!');
                break;
            }

            // Check if we're getting new reviews
            if (saved === previousCount) {
                noNewReviewsCount++;
                if (noNewReviewsCount >= 5) {
                    log.info('No new reviews found after multiple scroll attempts. All reviews collected.');
                    break;
                }
            } else {
                noNewReviewsCount = 0;
            }
            previousCount = saved;

            // Scroll to load more
            const scrolled = await scrollModalForMore();
            if (!scrolled) {
                log.info('Cannot scroll further. Reached end of reviews.');
                break;
            }

            await page.waitForTimeout(1500);
        }

        // Save all collected reviews
        if (allReviews.length > 0) {
            await Dataset.pushData(allReviews);
            log.info(`Saved ${allReviews.length} reviews to dataset.`);
        } else {
            log.warning('No reviews found for this product.');
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url, userData: { pageNo: 1 } }]);
log.info(`Scraping completed. Total reviews saved: ${saved}`);
await Actor.exit();
