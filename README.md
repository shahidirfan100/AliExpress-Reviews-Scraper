# AliExpress Reviews Scraper

Extract authentic customer reviews from any AliExpress product page. Collect ratings, review text, dates, buyer information, and review images at scale. Perfect for product research, sentiment analysis, competitor monitoring, and market intelligence.

## Features

- **Single Product Focus** — Extract all reviews from any product page
- **Rich Review Data** — Get ratings, text, dates, and reviewer details
- **Image Extraction** — Collect review photos uploaded by buyers
- **Smart Filtering** — Filter by reviews with pictures or additional feedback
- **Flexible Sorting** — Sort by date, rating, or default relevance
- **Country Information** — See where reviewers are located
- **Product Variant Details** — Extract SKU information for each review

## Use Cases

### Product Research
Analyze customer feedback before sourcing products. Understand real user experiences, common complaints, and product quality indicators to make informed purchasing decisions.

### Sentiment Analysis
Build datasets for NLP and machine learning projects. Train sentiment models on authentic customer reviews with structured rating data.

### Competitor Monitoring
Track customer satisfaction across competing products. Compare review sentiment and identify market opportunities.

### Quality Assurance
Monitor product reviews for your own listings. Quickly identify quality issues or shipping problems through customer feedback patterns.

### Market Intelligence
Understand consumer preferences and trends. Analyze what features customers love and what improvements they request.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `product_url` | String | Yes | — | AliExpress product page URL |
| `results_wanted` | Integer | No | `20` | Maximum reviews to collect |
| `filter` | String | No | `"all"` | Filter type: `all`, `withPictures`, `additionalFeedback` |
| `sort` | String | No | `"default"` | Sort order: `default`, `newest`, `rating_desc` |
| `proxyConfiguration` | Object | No | Residential | Proxy settings |

---

## Output Data

Each review in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `review_id` | String | Unique review identifier |
| `product_id` | String | AliExpress product ID |
| `product_url` | String | Source product URL |
| `reviewer_name` | String | Buyer's display name |
| `rating` | Number | Star rating (1-5) |
| `review_text` | String | Full review content |
| `review_date` | String | Date review was posted |
| `sku_info` | String | Product variant purchased |
| `images` | Array | URLs of uploaded review images |
| `helpful_count` | Number | Helpful votes received |
| `country` | String | Reviewer's country |

---

## Usage Examples

### Basic Product Reviews

Extract reviews from a single product:

```json
{
    "product_url": "https://www.aliexpress.com/item/1005006853596517.html",
    "results_wanted": 50
}
```

### Reviews with Photos Only

Get reviews that include customer photos:

```json
{
    "product_url": "https://www.aliexpress.com/item/1005006853596517.html",
    "filter": "withPictures",
    "results_wanted": 30
}
```

### Latest Reviews First

Sort by newest reviews to see recent feedback:

```json
{
    "product_url": "https://www.aliexpress.com/item/1005006853596517.html",
    "sort": "newest",
    "results_wanted": 100
}
```

### High-Rating Reviews

Filter to see highest-rated reviews first:

```json
{
    "product_url": "https://www.aliexpress.com/item/1005006853596517.html",
    "sort": "rating_desc",
    "results_wanted": 25
}
```

---

## Sample Output

```json
{
    "review_id": "1234567890",
    "product_id": "1005006853596517",
    "product_url": "https://www.aliexpress.com/item/1005006853596517.html",
    "reviewer_name": "J***r",
    "rating": 5,
    "review_text": "Excellent quality! The fabric is soft and the print is exactly as shown. Arrived in 2 weeks. Very happy with my purchase.",
    "review_date": "15 Jan 2026",
    "sku_info": "Color: Blue | Size: M",
    "images": [
        "https://ae01.alicdn.com/kf/review-image-1.jpg",
        "https://ae01.alicdn.com/kf/review-image-2.jpg"
    ],
    "helpful_count": 12,
    "country": "United States"
}
```

---

## Tips for Best Results

### Choose Products with Reviews
- Verify the product has customer reviews before running
- Products with higher order counts typically have more reviews
- Check the review count on the product page first

### Optimize Collection Size
- Start with smaller batches (20-50) for testing
- Increase `results_wanted` for comprehensive analysis
- Use filters to focus on relevant review types

### Use Photo Reviews for Quality Assessment
- Set `filter: "withPictures"` to see real product photos
- Customer photos often show true product quality
- Useful for verifying listing accuracy

### Proxy Configuration
For reliable results, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Integrations

Connect your review data with:

- **Google Sheets** — Export reviews for analysis
- **Airtable** — Build searchable review databases
- **Slack** — Get notifications for new reviews
- **Webhooks** — Send data to custom endpoints
- **Make** — Create automated workflows
- **Zapier** — Trigger actions based on reviews

### Export Formats

Download data in multiple formats:

- **JSON** — For developers and APIs
- **CSV** — For spreadsheet analysis
- **Excel** — For business reporting
- **XML** — For system integrations

---

## Frequently Asked Questions

### How many reviews can I collect?
You can collect all available reviews for a product. The practical limit depends on how many reviews the product has.

### Can I scrape multiple products?
This actor processes one product at a time. For multiple products, run separate actor calls or use the Apify scheduler.

### What if reviews are in different languages?
Reviews are extracted as-is. Many include translated versions if the original was auto-translated by AliExpress.

### Are review images included?
Yes, all image URLs uploaded by reviewers are captured in the `images` array.

### How fresh is the data?
Each run fetches real-time data. Schedule regular runs to track review trends over time.

### What about products with no reviews?
The actor will complete successfully but return an empty dataset if no reviews exist.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with AliExpress terms of service and applicable laws. Use data responsibly and respect rate limits.
