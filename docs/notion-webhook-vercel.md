# Auto-rebuild on Notion publish → Vercel Deploy Hook

The blog at `/blog/**` is rendered at **build time** (SSG) from the Notion
database. A new post in Notion only appears on the live site after a new
Vercel deploy — so we wire Notion to trigger one automatically.

## 1. Create the Vercel Deploy Hook

1. Open the project: <https://vercel.com/jesuslopezseos-projects/pws/settings/git>
2. Scroll to **Deploy Hooks**.
3. Click **Create Hook**.
   - **Name**: `Notion publish`
   - **Branch**: `main`
4. Vercel returns a URL like:
   ```
   https://api.vercel.com/v1/integrations/deploy/prj_FVZ2lfA5HTReF2N9JNyi9LxNJmPb/xxxxxxxxxxxx
   ```
   **Copy it** — treat as a secret (anyone with the URL can trigger deploys).

## 2. Subscribe Notion to the hook

Notion's native webhooks (available on Business/Enterprise) can hit a custom
URL. If you're not on those plans, use one of the two free alternatives in
§3.

### Native Notion webhook (Business+)

1. <https://www.notion.so/my-integrations> → open the blog integration → tab
   **Webhooks**.
2. **Add endpoint** → paste the Vercel Deploy Hook URL.
3. Select events:
   - `page.content_updated`
   - `page.properties_updated`
   - `page.created`
4. Filter by database (pick the blog DB, id `91c6ebb6-…`).
5. Save. Notion will send a verification request — the Vercel Deploy Hook
   accepts any POST so it validates immediately.

## 3. Alternatives (free plan)

### a) Zapier / Make

- Trigger: **Notion** → *New database item* (or *Updated database item*)
- Action: **Webhooks** → *POST* to the Vercel Deploy Hook URL with an empty
  JSON body `{}`.

### b) GitHub Action on a cron

If you'd rather skip webhooks entirely, Vercel will redeploy nightly if you
add this workflow:

```yaml
# .github/workflows/nightly-rebuild.yml
name: Nightly rebuild
on:
  schedule:
    - cron: "0 5 * * *"  # 07:00 Europe/Madrid
  workflow_dispatch:
jobs:
  rebuild:
    runs-on: ubuntu-latest
    steps:
      - run: curl -X POST "${{ secrets.VERCEL_DEPLOY_HOOK_URL }}"
```

Store the deploy hook URL in **Settings → Secrets → Actions** as
`VERCEL_DEPLOY_HOOK_URL`.

## 4. Build-time Notion credentials

The SSG build needs the same secrets the import script used:

| Env                  | Value                                               |
| -------------------- | --------------------------------------------------- |
| `NOTION_API_KEY`     | integration secret (`ntn_…`)                        |
| `NOTION_DS_ID`       | blog database / data source UUID                    |

Add them in **Vercel → Settings → Environment Variables** for the
**Production** and **Preview** environments. The first build will query
Notion for all published posts and emit one static HTML file per slug.

## 5. Cost / timing estimate

- Initial build pulls ~277 posts + blocks for each. With 350 ms throttle
  this is ~3-4 min of Notion API time on top of Astro's normal build (~6 s).
- Subsequent rebuilds: same, because we don't currently cache Notion
  responses between deploys. If build time becomes a problem we can cache
  the Notion results in a Vercel Blob / KV store and invalidate on hook.

## 6. Manual trigger

To force a rebuild without touching Notion:

```bash
curl -X POST "https://api.vercel.com/v1/integrations/deploy/prj_FVZ2lfA5HTReF2N9JNyi9LxNJmPb/xxxxxxxxxxxx"
```
