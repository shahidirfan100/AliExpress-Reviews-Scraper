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
        await page.waitForTimeout(2000);

        // Scroll to reviews section
        log.info('Scrolling to reviews section...');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
        await page.waitForTimeout(1500);

        // Click "View more" button to open reviews modal
        log.info('Looking for reviews modal button...');
        const modalOpened = await page.evaluate(() => {
            const allButtons = document.querySelectorAll('button, a, div[role="button"], span[role="button"]');
            for (const btn of allButtons) {
                const text = btn.textContent?.toLowerCase() || '';
                if ((text.includes('view') && (text.includes('more') || text.includes('all'))) ||
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
            await page.waitForTimeout(2500);
        }

        // Function to extract reviews
        const extractReviews = async () => {
            return await page.evaluate(() => {
                const reviews = [];
                const reviewSelectors = [
                    '.list--itemBox--je_KNzb',
                    '[class*="feedback-item"]',
                    '[class*="review-item"]',
                    '[class*="itemBox"]',
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
                        const infoEl = el.querySelector('.list--itemInfo--VEcgSFh, [class*="user-name"], [class*="user-info"]');
                        const info = infoEl?.textContent?.trim() || '';
                        const infoParts = info.split('|').map(s => s.trim());

                        const starSelectors = ['.comet-icon-starreviewfilled', '[class*="star"][class*="full"]'];
                        let stars = 0;
                        for (const starSel of starSelectors) {
                            const starEls = el.querySelectorAll(starSel);
                            if (starEls.length > 0) { stars = starEls.length; break; }
                        }

                        const contentSelectors = ['.list--itemReview--d9Z9Z5Z', '[class*="buyer-feedback"]', '[class*="review-content"]'];
                        let content = '';
                        for (const contentSel of contentSelectors) {
                            const contentEl = el.querySelector(contentSel);
                            if (contentEl?.textContent?.trim()) { content = contentEl.textContent.trim(); break; }
                        }

                        const skuEl = el.querySelector('.list--itemSku--idEQSGC, [class*="sku-info"]');
                        const imgEls = el.querySelectorAll('.list--itemThumbnails--TtUDHhl img, [class*="review-image"] img, [class*="thumbnail"] img');
                        const images = Array.from(imgEls)
                            .map(img => img.src || img.dataset?.src)
                            .filter(Boolean)
                            .map(url => url.replace(/_\.avif$/i, '').replace(/_\.webp$/i, ''));

                        let country = null;
                        const countryEl = el.querySelector('[class*="country"], [class*="flag"], [class*="location"]');
                        if (countryEl) {
                            country = countryEl.textContent?.trim() || countryEl.getAttribute('title') || null;
                        }

                        if (content) {
                            reviews.push({
                                review_id: `${content.substring(0, 30).replace(/\W/g, '')}_${Math.random().toString(36).substr(2, 6)}`,
                                reviewer_name: infoParts[0] || 'Anonymous',
                                rating: stars || 5,
                                review_text: content,
                                review_date: infoParts[1] || null,
                                sku_info: skuEl?.textContent?.trim() || null,
                                images: images,
                                helpful_count: 0,
                                country: country,
                            });
                        }
                    } catch (e) { /* skip */ }
                }

                return reviews;
            });
        };

        // Function to scroll within modal
        const scrollModal = async () => {
            return await page.evaluate(() => {
                // Try to find and scroll the modal container
                const modalSelectors = [
                    '.v3--modal-content--S7_r_eW',
                    '.comet-v2-modal-body',
                    '.comet-modal-body',
                    '[class*="modal-body"]',
                    '[class*="modal-content"]',
                    '[class*="review-list"]',
                    '[class*="feedback-list"]',
                    '[class*="dialog-body"]',
                ];

                for (const selector of modalSelectors) {
                    const modal = document.querySelector(selector);
                    if (modal) {
                        const prevTop = modal.scrollTop;
                        modal.scrollTop = modal.scrollTop + 800;
                        if (modal.scrollTop > prevTop) {
                            return { scrolled: true, selector };
                        }
                    }
                }

                // Fallback: try scrolling any scrollable element inside a modal
                const modalContainer = document.querySelector('[class*="modal"]');
                if (modalContainer) {
                    const scrollables = modalContainer.querySelectorAll('*');
                    for (const el of scrollables) {
                        if (el.scrollHeight > el.clientHeight + 50) {
                            const prevTop = el.scrollTop;
                            el.scrollTop = el.scrollTop + 800;
                            if (el.scrollTop > prevTop) {
                                return { scrolled: true, selector: 'fallback-scrollable' };
                            }
                        }
                    }
                }

                // Last resort: scroll main page
                const prevScroll = window.scrollY;
                window.scrollBy(0, 600);
                return { scrolled: window.scrollY > prevScroll, selector: 'window' };
            });
        };

        // Collect reviews with pagination
        const allReviews = [];
        let previousCount = 0;
        let noNewCount = 0;
        const maxAttempts = 100;

        for (let attempt = 0; attempt < maxAttempts && saved < RESULTS_WANTED; attempt++) {
            const currentReviews = await extractReviews();

            // Add new unique reviews
            for (const review of currentReviews) {
                const contentKey = review.review_text.substring(0, 60);
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

            // Save in batches of 10
            if (allReviews.length >= BATCH_SIZE) {
                await Dataset.pushData(allReviews.splice(0, BATCH_SIZE));
                log.info(`Batch saved. Total: ${saved}/${RESULTS_WANTED}`);
            }

            // Check progress
            if (saved >= RESULTS_WANTED) {
                log.info('Reached desired number of reviews!');
                break;
            }

            if (saved === previousCount) {
                noNewCount++;
                if (noNewCount >= 8) {
                    log.info('No new reviews after multiple scrolls. All available reviews collected.');
                    break;
                }
            } else {
                noNewCount = 0;
                log.info(`Progress: ${saved}/${RESULTS_WANTED} reviews collected`);
            }
            previousCount = saved;

            // Scroll to load more
            const scrollResult = await scrollModal();
            if (!scrollResult.scrolled) {
                log.info('Cannot scroll further.');
                break;
            }

            await page.waitForTimeout(800); // Fast wait for content load
        }

        // Save remaining reviews
        if (allReviews.length > 0) {
            await Dataset.pushData(allReviews);
            log.info(`Final batch saved. Total: ${saved} reviews.`);
        }

        if (saved === 0) {
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
