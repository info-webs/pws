# scripts

## `migrate-wp-to-notion.mjs`

One-shot migration: pulls every post from the WordPress REST API of
`posicionamiento-web-salamanca.com` and creates a matching page in a Notion
database. Idempotent — re-running skips slugs that already exist.

### Notion database schema

The target database must have these properties. Types matter:

| Property           | Type                                    |
| ------------------ | --------------------------------------- |
| `Name`             | Title                                   |
| `Slug`             | Rich text                               |
| `Excerpt`          | Rich text                               |
| `Published date`   | Date                                    |
| `Updated date`     | Date                                    |
| `Categories`       | Multi-select                            |
| `Tags`             | Multi-select                            |
| `SEO Title`        | Rich text                               |
| `SEO Description`  | Rich text                               |
| `WP Original URL`  | URL                                     |
| `Status`           | Select (must include the option `Published`) |

The post cover image goes on the page's **Cover** (not a property).

### Setup

1. Install dependencies (one-off, from repo root):

   ```bash
   pnpm add -D @notionhq/client node-html-markdown dotenv
   ```

2. Create a Notion integration at <https://www.notion.so/my-integrations>,
   copy the secret, and share the target database with the integration
   (database → `...` → *Add connections*).

3. Copy `.env.example` to `.env` in the repo root and fill in:

   - `WP_BASE_URL`
   - `WP_USER`
   - `WP_APP_PASSWORD` (already populated in `.env.example`; regenerate if compromised)
   - `NOTION_API_KEY`
   - `NOTION_BLOG_DB_ID` (the 32-char UUID from the database URL)

### Usage

Dry run — lists posts and block counts without writing to Notion:

```bash
node scripts/migrate-wp-to-notion.mjs --dry-run
```

Real migration:

```bash
node scripts/migrate-wp-to-notion.mjs --run
```

Limit to first N posts (useful to smoke-test):

```bash
node scripts/migrate-wp-to-notion.mjs --run --limit 3
```

Verbose errors (full stack traces):

```bash
VERBOSE=1 node scripts/migrate-wp-to-notion.mjs --run
```

### What it does

1. Fetches all categories + tags once, caches their `id → name` maps.
2. Paginates `/wp/v2/posts?per_page=100`, reads `X-WP-TotalPages`.
3. For each post:
   - Resolves `featured_media` → image URL via `/wp/v2/media/{id}` (cached).
   - Converts `content.rendered` HTML → Markdown (`node-html-markdown`) →
     Notion blocks (internal `markdownToNotionBlocks()`).
   - Checks the Notion DB for an existing page with the same `Slug`.
   - Creates the Notion page with all properties, cover image, and
     block children (appends overflow if > 100 blocks).
4. Throttles Notion requests to ~2.5 req/s (400 ms delay) to stay under
   the 3 req/s limit.

### Known limitations

- **Inline images** in post content are inserted as Notion external-image
  blocks pointing at the WordPress media URLs. Migrate the assets to your
  own CDN/Notion later if you intend to decommission WordPress.
- **WordPress shortcodes** (`[contact-form-7 …]`, `[gallery]`, etc.) pass
  through as literal text. They render as paragraphs in Notion.
- **Gutenberg blocks**: `content.rendered` already delivers rendered HTML,
  so standard blocks convert fine. Custom blocks with client-side JS won't.
- **Nested lists** become flat lists.
- **Tables** are currently rendered as paragraphs (Notion `table` blocks
  need row-level children, out of scope for the first pass).

### Resetting

To re-import from scratch, delete the Notion pages you don't want and
re-run. The script only skips on exact `Slug` match, so duplicates are
avoided but updates to existing posts are *not* propagated (intentional —
simpler to delete + reimport than to diff).
