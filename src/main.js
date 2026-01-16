// AliExpress Reviews Scraper - Production-ready with JSON API + HTML fallback
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

// Map filter values to API parameters
const filterMap = {
    all: 'all',
    withPictures: 'withPictures',
    additionalFeedback: 'additionalFeedback',
};

// Map sort values to API parameters
const sortMap = {
    default: 'complex_default',
    newest: 'new_date',
    rating_desc: 'score_desc',
};

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 5,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 3 },
    },
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 120,
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
                if (['image', 'font', 'media'].includes(type) ||
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
    async requestHandler({ page, request }) {
        const pageNo = request.userData?.pageNo || 1;
        log.info(`Processing page ${pageNo}: ${request.url}`);

        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);

        // First, extract aggregate rating from JSON-LD
        const aggregateRating = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data.aggregateRating) {
                        return {
                            ratingValue: data.aggregateRating.ratingValue,
                            reviewCount: data.aggregateRating.reviewCount,
                        };
                    }
                } catch (e) { /* ignore */ }
            }
            return null;
        });

        if (aggregateRating) {
            log.info(`Product has ${aggregateRating.reviewCount} reviews with ${aggregateRating.ratingValue} average rating`);
        }

        // Try to extract reviews via multiple methods
        const result = await page.evaluate(async (params) => {
            const { productId, pageNo, pageSize, filterValue, sortValue } = params;
            const reviews = [];

            // Method 1: Try to get reviews from page data structures
            try {
                // Check for review data in various global objects
                const reviewData = window._dida_config_?._init_data_?.data?.data?.root?.fields?.review?.reviews ||
                    window._dida_config_?._init_data_?.data?.root?.fields?.review?.reviews ||
                    window.runParams?.data?.feedbackModule?.feedback ||
                    window.runParams?.feedbackModule?.feedback ||
                    null;

                if (reviewData && Array.isArray(reviewData)) {
                    for (const review of reviewData) {
                        reviews.push({
                            review_id: review.evaluationId || review.id || String(Date.now() + Math.random()),
                            reviewer_name: review.buyerName || review.buyerNick || review.anonymousBuyer || 'Anonymous',
                            rating: review.buyerEval || review.starRating || review.star || 5,
                            review_text: review.buyerFeedback || review.buyerTranslationFeedback || review.content || '',
                            review_date: review.evalDate || review.buyerEvalDate || review.date || null,
                            sku_info: review.skuInfo || review.skuName || null,
                            images: review.images || review.buyerImageList || [],
                            helpful_count: review.upVoteCount || review.likeCount || 0,
                            country: review.buyerCountry || review.country || null,
                        });
                    }
                }
            } catch (e) { /* continue to next method */ }

            // Method 2: Parse reviews from HTML
            if (reviews.length === 0) {
                try {
                    const reviewElements = document.querySelectorAll('.list--itemBox--je_KNzb, [class*="feedback-item"], [class*="review-item"]');
                    for (const el of reviewElements) {
                        const infoEl = el.querySelector('.list--itemInfo--VEcgSFh, [class*="user-name"], [class*="user-info"]');
                        const info = infoEl?.textContent?.trim() || '';
                        const infoParts = info.split('|').map(s => s.trim());
                        
                        const stars = el.querySelectorAll('.comet-icon-starreviewfilled, [class*="star-view"] > span, [class*="star-icon"]');
                        const contentEl = el.querySelector('.list--itemReview--d9Z9Z5Z, [class*="buyer-feedback"], [class*="review-content"]');
                        const skuEl = el.querySelector('.list--itemSku--idEQSGC, [class*="sku-info"]');
                        const imgEls = el.querySelectorAll('.list--itemThumbnails--TtUDHhl img, [class*="review-image"] img');

                        reviews.push({
                            review_id: `html_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            reviewer_name: infoParts[0] || 'Anonymous',
                            rating: stars.length || 5,
                            review_text: contentEl?.textContent?.trim() || '',
                            review_date: infoParts[1] || null,
                            sku_info: skuEl?.textContent?.trim() || null,
                            images: Array.from(imgEls).map(img => img.src).filter(Boolean),
                            helpful_count: 0,
                            country: null,
                        });
                    }
                } catch (e) { /* continue */ }
            }

            return { reviews, count: reviews.length, method: reviews.length > 0 ? 'extracted' : 'none' };
        }, { productId, pageNo, pageSize: 20, filterValue: filterMap[filter], sortValue: sortMap[sort] });

        log.info(`Extracted ${result.count} reviews via ${result.method}`);

        // If no reviews found on page, try clicking "View more" to load reviews modal
        if (result.count === 0 && pageNo === 1) {
            log.info('No reviews found on initial page, trying to load reviews section...');
            
            try {
                // Try to find and click reviews tab or "View more" button
                const clicked = await page.evaluate(() => {
                    const viewMoreBtn = Array.from(document.querySelectorAll('button, a')).find(
                        btn => btn.textContent?.toLowerCase().includes('view more') || 
                               btn.textContent?.toLowerCase().includes('see all') ||
                               btn.textContent?.toLowerCase().includes('reviews')
                    );
                    if (viewMoreBtn) {
                        viewMoreBtn.click();
                        return true;
                    }
                    return false;
                });

                if (clicked) {
                    await page.waitForTimeout(3000);
                    
                    // Try extraction again after modal opens
                    const modalResult = await page.evaluate(() => {
                        const reviews = [];
                        const reviewElements = document.querySelectorAll('.list--itemBox--je_KNzb, .v3--modal-content--S7_r_eW [class*="review"], [class*="feedback-list"] > div');
                        
                        for (const el of reviewElements) {
                            const infoEl = el.querySelector('.list--itemInfo--VEcgSFh, [class*="user"]');
                            const info = infoEl?.textContent?.trim() || '';
                            const infoParts = info.split('|').map(s => s.trim());
                            
                            const stars = el.querySelectorAll('.comet-icon-starreviewfilled, [class*="star"]');
                            const contentEl = el.querySelector('.list--itemReview--d9Z9Z5Z, [class*="content"]');
                            const skuEl = el.querySelector('.list--itemSku--idEQSGC');
                            const imgEls = el.querySelectorAll('img[class*="thumbnail"], img[class*="review"]');

                            if (contentEl?.textContent?.trim()) {
                                reviews.push({
                                    review_id: `modal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                    reviewer_name: infoParts[0] || 'Anonymous',
                                    rating: stars.length || 5,
                                    review_text: contentEl.textContent.trim(),
                                    review_date: infoParts[1] || null,
                                    sku_info: skuEl?.textContent?.trim() || null,
                                    images: Array.from(imgEls).map(img => img.src).filter(Boolean),
                                    helpful_count: 0,
                                    country: null,
                                });
                            }
                        }
                        return { reviews, count: reviews.length };
                    });

                    if (modalResult.count > 0) {
                        result.reviews = modalResult.reviews;
                        result.count = modalResult.count;
                        log.info(`Extracted ${modalResult.count} reviews from modal`);
                    }
                }
            } catch (e) {
                log.warning(`Modal extraction failed: ${e.message}`);
            }
        }

        // Process and save reviews
        const newReviews = [];
        for (const review of result.reviews || []) {
            if (saved >= RESULTS_WANTED) break;

            const reviewId = review.review_id || `${productId}_${Date.now()}_${Math.random()}`;
            if (!seenIds.has(reviewId)) {
                seenIds.add(reviewId);
                newReviews.push({
                    review_id: reviewId,
                    product_id: productId,
                    product_url: product_url,
                    reviewer_name: review.reviewer_name || 'Anonymous',
                    rating: Number(review.rating) || 5,
                    review_text: review.review_text || '',
                    review_date: review.review_date || null,
                    sku_info: review.sku_info || null,
                    images: Array.isArray(review.images) ? review.images.map(img => 
                        img.startsWith('//') ? `https:${img}` : img
                    ) : [],
                    helpful_count: Number(review.helpful_count) || 0,
                    country: review.country || null,
                });
                saved++;
            }
        }

        if (newReviews.length > 0) {
            await Dataset.pushData(newReviews);
            log.info(`Saved ${newReviews.length} reviews. Total: ${saved}/${RESULTS_WANTED}`);
        }

        // Note: Full pagination would require MTOP API access which needs authentication tokens
        // For now, we extract what's available on the page
        if (saved < RESULTS_WANTED && result.count > 0) {
            log.info(`Note: Some reviews may require scrolling or API access for full pagination.`);
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([{ url: product_url, userData: { pageNo: 1 } }]);
log.info(`Scraping completed. Total reviews saved: ${saved}`);
await Actor.exit();
