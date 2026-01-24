import { Actor, log } from 'apify';
import { Dataset, PlaywrightCrawler } from 'crawlee';

const FEEDBACK_URL = 'https://feedback.aliexpress.com/pc/searchEvaluation.do';
const DEFAULT_PROXY_CONFIG = {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
};
const PAGE_SIZE = 20;
const MAX_ATTEMPTS = 3;

const FILTER_MAP = {
    all: 'all',
    withPictures: 'image',
    additionalFeedback: 'additional',
};

const SORT_MAP = {
    default: 'default',
    newest: 'latest',
    rating_desc: 'topRated',
};

const extractProductId = (url) => {
    const match = url?.match(/item\/(\d+)\.html/i);
    return match ? match[1] : null;
};

const normalizeRating = (buyerEval) => {
    const numeric = Number(buyerEval);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const stars = numeric / 20;
    return Math.max(0, Math.min(5, Math.round(stars * 10) / 10));
};

const sanitizeImages = (images = []) =>
    images.map((url) => url.replace(/_[0-9]+x[0-9]+\.jpg$/i, '').replace(/_\.avif$/i, '').replace(/_\.webp$/i, ''));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    product_url,
    results_wanted: resultsWantedRaw = 20,
    filter = 'all',
    sort = 'default',
    proxyConfiguration: proxyConfig,
} = input;

const RESULTS_WANTED = Number.isFinite(Number(resultsWantedRaw)) ? Math.max(1, Number(resultsWantedRaw)) : 20;
const productId = extractProductId(product_url);

if (!productId) {
    log.error('Invalid product URL. Please provide a valid AliExpress product page.');
    await Actor.exit({ exitCode: 1 });
}

const filterCode = FILTER_MAP[filter] ?? FILTER_MAP.all;
const sortCode = SORT_MAP[sort] ?? SORT_MAP.default;

log.info(
    `Scraping reviews via Playwright for product ${productId}; target ${RESULTS_WANTED} reviews (filter=${filterCode}, sort=${sortCode}).`,
);

let proxyConfiguration = null;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || DEFAULT_PROXY_CONFIG);
} catch (error) {
    log.warning(`Proxy configuration failed (${error.message}). Proceeding without proxy.`);
}

const fetchReviewPage = async (page, pageNumber) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await page.request.get(FEEDBACK_URL, {
                params: {
                    productId,
                    page: pageNumber,
                    pageSize: PAGE_SIZE,
                    sort: sortCode,
                    filter: filterCode,
                    lang: 'en_US',
                },
                headers: {
                    accept: 'application/json,text/plain,*/*',
                    'accept-language': 'en-US,en;q=0.9',
                    'user-agent':
                        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
            });

            if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
            const json = await response.json();
            if (!json?.data) throw new Error('Missing data in response');
            const list = json.data.evaViewList ?? [];
            if (!list.length && attempt < MAX_ATTEMPTS) {
                // API occasionally returns empty payloads; wait and retry to let lazy-loading complete.
                await Actor.sleep(1500);
                continue;
            }
            return json.data;
        } catch (error) {
            const isLastAttempt = attempt === MAX_ATTEMPTS;
            log.warning(`Page fetch ${pageNumber} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error.message}`);
            if (isLastAttempt) throw error;
            await Actor.sleep(attempt * 1000);
        }
    }
};

const mapReview = (review) => ({
    review_id: review.evaluationIdStr || String(review.evaluationId) || `${productId}-${review.evalDate}`,
    product_id: productId,
    product_url,
    reviewer_name: review.buyerName || 'Anonymous',
    rating: normalizeRating(review.buyerEval),
    review_text: (review.buyerTranslationFeedback || review.buyerFeedback || '').trim() || null,
    review_date: review.evalDate || null,
    sku_info: review.skuInfo || null,
    images: sanitizeImages(review.images || review.imageList || []),
    helpful_count: review.upVoteCount ?? 0,
    country: review.buyerCountry || null,
    review_type: review.reviewType || null,
    translated: Boolean(review.buyerTranslationFeedback && review.buyerTranslationFeedback !== review.buyerFeedback),
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    maxConcurrency: 1,
    navigationTimeoutSecs: 60,
    async requestHandler({ page, request }) {
        log.info(`Loaded ${request.url}. Warming up session...`);
        await page.waitForTimeout(2000);
        try {
            await page.waitForLoadState('networkidle', { timeout: 8000 });
        } catch {
            // ignore
        }
        await page.evaluate(() => {
            document.querySelector('#nav-review')?.scrollIntoView();
        });
        await page.waitForTimeout(1000);

        let saved = 0;
        let pageNumber = 1;
        let totalPages = null;
        let totalAvailable = null;
        const seenIds = new Set();

        while (saved < RESULTS_WANTED && (totalPages === null || pageNumber <= totalPages)) {
            const data = await fetchReviewPage(page, pageNumber);
            totalPages = data.totalPage ?? totalPages ?? null;
            totalAvailable = data.totalNum ?? totalAvailable ?? null;

            const reviews = data.evaViewList ?? [];
            if (!reviews.length) {
                log.warning(`No reviews returned on page ${pageNumber}. Waiting for lazy load and retrying next page.`);
                await Actor.sleep(1500);
                pageNumber++;
                continue;
            }

            const batch = [];
            for (const review of reviews) {
                if (saved >= RESULTS_WANTED) break;
                const reviewId = review.evaluationIdStr || String(review.evaluationId);
                if (reviewId && seenIds.has(reviewId)) continue;
                if (reviewId) seenIds.add(reviewId);

                batch.push(mapReview(review));
                saved++;
            }

            if (batch.length) {
                await Dataset.pushData(batch);
                log.info(`Saved ${batch.length} reviews from page ${pageNumber}. Total ${saved}/${RESULTS_WANTED}.`);
            } else {
                log.warning(`Only duplicates found on page ${pageNumber}. Continuing to next page.`);
            }

            if (totalPages && pageNumber >= totalPages) {
                log.info('Reached last available review page reported by API.');
                break;
            }

            pageNumber++;
        }

        log.info(
            `Finished product ${productId}. Saved ${saved} review(s). Requested ${RESULTS_WANTED}. Available: ${
                totalAvailable ?? 'unknown'
            }.`,
        );
    },
    failedRequestHandler({ request }, error) {
        log.error(`Failed to process ${request.url}: ${error.message}`);
    },
});

await crawler.run([{ url: product_url }]);
await Actor.exit();
