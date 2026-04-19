#!/usr/bin/env node
/**
 * Import WordPress posts into a Notion database.
 *
 * Tailored to the posicionamiento-web-salamanca.com → Notion migration:
 * - skips the first N posts (default 30, already imported)
 * - idempotent by WP ID (checks the target DB before creating)
 * - 350 ms throttle between creates
 * - resolves WP categories → Notion Category (select) via a fixed map
 * - tolerates both the classic `database_id` and the newer `data_source_id`
 *   Notion parent shapes — probes once at startup and reuses
 *
 * Run locally (the container sandbox blocks api.notion.com and the WP host):
 *
 *   WP_BASE_URL=https://www.posicionamiento-web-salamanca.com \
 *   WP_USER=jesus \
 *   WP_APP_PASSWORD='MjCP M610 gNXr 04Lb S0fH OeAi' \
 *   NOTION_API_KEY=ntn_xxx \
 *   NOTION_DS_ID=91c6ebb6-41c9-4e41-987b-e3a611ed67c3 \
 *   OFFSET=30 \
 *   node scripts/import-wp-blog-to-notion.mjs --run
 *
 * Flags:
 *   --dry-run   (default) list what would be imported; no writes
 *   --run       actually create pages in Notion
 *   --limit N   only process N posts (after offset). Useful for smoke tests
 */

import { NodeHtmlMarkdown } from "node-html-markdown";
import "dotenv/config";

// ---------- Config ----------

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const DRY_RUN = !hasFlag("--run");
const LIMIT = flagValue("--limit") ? Number(flagValue("--limit")) : Infinity;
const OFFSET = Number(process.env.OFFSET ?? 30);
const PER_PAGE = 100;
const NOTION_RATE_MS = 350;
const NOTION_VERSION = "2022-06-28";

const required = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD", "NOTION_API_KEY", "NOTION_DS_ID"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

const WP = process.env.WP_BASE_URL.replace(/\/$/, "");
const WP_AUTH =
  "Basic " +
  Buffer.from(
    `${process.env.WP_USER}:${process.env.WP_APP_PASSWORD.replace(/\s+/g, "")}`
  ).toString("base64");

const NOTION_KEY = process.env.NOTION_API_KEY;
const NOTION_ID = process.env.NOTION_DS_ID;

const nhm = new NodeHtmlMarkdown({
  bulletMarker: "-",
  codeBlockStyle: "fenced",
  keepDataImages: false,
});

const MAX_RICH = 2000;
const MAX_CHILDREN = 100;

// ---------- Category mapping ----------
// WP category slug → Notion Category option name
const CATEGORY_MAP = {
  seo: "SEO",
  "marketing-2-0": "Marketing 2.0",
  "redes-sociales": "Redes Sociales",
  "noticias-corporativas": "Noticias Corporativas",
};
const DEFAULT_CATEGORY = "Sin categoría";

// ---------- Small helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decodeEntities = (s) =>
  !s
    ? ""
    : s
        .replace(/&#8217;/g, "’")
        .replace(/&#8216;/g, "‘")
        .replace(/&#8220;/g, "“")
        .replace(/&#8221;/g, "”")
        .replace(/&#8211;/g, "–")
        .replace(/&#8212;/g, "—")
        .replace(/&#8230;/g, "…")
        .replace(/&#038;/g, "&")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ");

const stripHtml = (html) => decodeEntities(html.replace(/<[^>]+>/g, "")).trim();

const chunkText = (s, size = MAX_RICH) => {
  const out = [];
  while (s && s.length > size) {
    out.push(s.slice(0, size));
    s = s.slice(size);
  }
  if (s) out.push(s);
  return out;
};

// ---------- WordPress fetch ----------

async function wpFetch(path) {
  const url = path.startsWith("http") ? path : `${WP}/wp-json/wp/v2${path}`;
  const res = await fetch(url, {
    headers: { Authorization: WP_AUTH, Accept: "application/json; charset=utf-8" },
  });
  if (!res.ok) throw new Error(`WP ${res.status} ${res.statusText} ← ${url}`);
  return res;
}

async function loadCategories() {
  // id → slug map so we can hit CATEGORY_MAP above
  const map = new Map();
  let page = 1;
  let totalPages = 1;
  do {
    const res = await wpFetch(`/categories?per_page=100&page=${page}`);
    if (page === 1) totalPages = Number(res.headers.get("x-wp-totalpages") || "1");
    const data = await res.json();
    for (const c of data) map.set(c.id, c.slug);
    page += 1;
  } while (page <= totalPages);
  return map;
}

async function fetchPostsWindow(offset, perPage) {
  // WP /posts supports ?offset and ?per_page; return array
  const res = await wpFetch(
    `/posts?per_page=${perPage}&offset=${offset}&orderby=date&order=desc&_embed=0`
  );
  return res.json();
}

// ---------- Notion raw API ----------

async function notion(path, body, method = "POST") {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || `${res.status} ${res.statusText}`;
    const err = new Error(`Notion ${method} ${path} — ${msg}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// Probe once to figure out whether the UUID behaves as a `database_id` or
// as a `data_source_id` on this Notion API version. Returns { parentType,
// queryPath } for subsequent calls.
async function detectParent() {
  try {
    await notion(`/databases/${NOTION_ID}/query`, { page_size: 1 });
    return {
      parentType: "database_id",
      queryPath: `/databases/${NOTION_ID}/query`,
      parentShape: { database_id: NOTION_ID },
    };
  } catch (e) {
    if (e.status === 404 || e.status === 400) {
      // Try newer data-source endpoint
      await notion(`/data_sources/${NOTION_ID}/query`, { page_size: 1 });
      return {
        parentType: "data_source_id",
        queryPath: `/data_sources/${NOTION_ID}/query`,
        parentShape: { data_source_id: NOTION_ID },
      };
    }
    throw e;
  }
}

async function findByWpId(queryPath, wpId) {
  const res = await notion(queryPath, {
    filter: { property: "WP ID", number: { equals: wpId } },
    page_size: 1,
  });
  return res.results?.[0] || null;
}

// ---------- Markdown → Notion blocks ----------

function inlineToRichText(text) {
  if (!text) return [];
  const tokens = [];
  let i = 0;
  const patterns = [
    { re: /!\[([^\]]*)\]\(([^)]+)\)/g, type: "image" },
    { re: /\[([^\]]+)\]\(([^)]+)\)/g, type: "link" },
    { re: /\*\*([^*]+)\*\*/g, type: "bold" },
    { re: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, type: "italic" },
    { re: /`([^`\n]+)`/g, type: "code" },
  ];
  while (i < text.length) {
    let next = null;
    for (const p of patterns) {
      p.re.lastIndex = i;
      const m = p.re.exec(text);
      if (m && (!next || m.index < next.match.index)) next = { pattern: p, match: m };
    }
    if (!next) {
      tokens.push({ type: "text", text: text.slice(i) });
      break;
    }
    if (next.match.index > i) tokens.push({ type: "text", text: text.slice(i, next.match.index) });
    const p = next.pattern;
    const m = next.match;
    if (p.type === "image") {
      /* drop inline images — they get emitted as blocks upstream */
    } else if (p.type === "link") tokens.push({ type: "text", text: m[1], link: m[2] });
    else if (p.type === "bold") tokens.push({ type: "text", text: m[1], bold: true });
    else if (p.type === "italic") tokens.push({ type: "text", text: m[1], italic: true });
    else if (p.type === "code") tokens.push({ type: "text", text: m[1], code: true });
    i = m.index + m[0].length;
  }
  const rich = [];
  for (const t of tokens) {
    if (!t.text) continue;
    for (const chunk of chunkText(t.text)) {
      const annotations = {};
      if (t.bold) annotations.bold = true;
      if (t.italic) annotations.italic = true;
      if (t.code) annotations.code = true;
      rich.push({
        type: "text",
        text: { content: chunk, link: t.link ? { url: t.link } : undefined },
        annotations: Object.keys(annotations).length ? annotations : undefined,
      });
    }
  }
  return rich;
}

const block = {
  p: (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: inlineToRichText(t) } }),
  h: (n, t) => {
    const k = n === 1 ? "heading_1" : n === 2 ? "heading_2" : "heading_3";
    return { object: "block", type: k, [k]: { rich_text: inlineToRichText(t) } };
  },
  li: (kind, t) => {
    const k = kind === "bulleted" ? "bulleted_list_item" : "numbered_list_item";
    return { object: "block", type: k, [k]: { rich_text: inlineToRichText(t) } };
  },
  quote: (t) => ({ object: "block", type: "quote", quote: { rich_text: inlineToRichText(t) } }),
  code: (t, lang = "plain text") => ({
    object: "block",
    type: "code",
    code: {
      rich_text: chunkText(t).map((c) => ({ type: "text", text: { content: c } })),
      language: lang,
    },
  }),
  img: (url, caption = "") => ({
    object: "block",
    type: "image",
    image: {
      type: "external",
      external: { url },
      caption: caption ? [{ type: "text", text: { content: caption } }] : [],
    },
  }),
  divider: () => ({ object: "block", type: "divider", divider: {} }),
};

function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(block.code(buf.join("\n"), normalizeLang(fence[1] || "plain text")));
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(block.divider());
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push(block.h(Math.min(3, h[1].length), h[2].trim()));
      i += 1;
      continue;
    }
    const imgOnly = line.match(/^\s*\[?!\[([^\]]*)\]\(([^)]+)\)\]?/);
    if (imgOnly) {
      blocks.push(block.img(imgOnly[2], imgOnly[1]));
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(block.quote(buf.join("\n")));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        blocks.push(block.li("bulleted", lines[i].replace(/^[-*]\s+/, "")));
        i += 1;
      }
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        blocks.push(block.li("numbered", lines[i].replace(/^\d+\.\s+/, "")));
        i += 1;
      }
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|>\s?|```|[-*]\s+|\d+\.\s+|-{3,}|\*{3,}|_{3,})/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    const joined = para.join(" ").trim();
    if (joined) blocks.push(block.p(joined));
  }
  return blocks;
}

function normalizeLang(lang) {
  const allowed = new Set([
    "bash", "c", "c++", "c#", "css", "dart", "diff", "docker", "elixir", "go",
    "graphql", "html", "java", "javascript", "json", "kotlin", "markdown",
    "mermaid", "perl", "php", "plain text", "powershell", "python", "ruby",
    "rust", "sass", "scala", "scss", "shell", "sql", "swift", "typescript",
    "xml", "yaml",
  ]);
  const l = (lang || "").toLowerCase();
  return allowed.has(l) ? l : "plain text";
}

// ---------- Notion page builder ----------

function mapCategory(slugs) {
  // If a post has multiple categories, pick the first known one; else default.
  for (const slug of slugs) {
    if (CATEGORY_MAP[slug]) return CATEGORY_MAP[slug];
  }
  return DEFAULT_CATEGORY;
}

function buildProperties({ title, slug, excerpt, date, modified, url, seoTitle, seoDesc, wpId, category }) {
  return {
    Title: { title: [{ text: { content: (title || slug).slice(0, 2000) } }] },
    Slug: { rich_text: [{ text: { content: slug } }] },
    Status: { select: { name: "Published" } },
    Category: { select: { name: category } },
    Excerpt: { rich_text: chunkText(excerpt || "", 2000).map((c) => ({ text: { content: c } })) },
    "Published Date": { date: { start: date } },
    "Updated Date": { date: { start: modified } },
    "Original URL": { url },
    "SEO Title": { rich_text: [{ text: { content: (seoTitle || "").slice(0, 2000) } }] },
    "SEO Description": { rich_text: [{ text: { content: (seoDesc || "").slice(0, 2000) } }] },
    "WP ID": { number: wpId },
  };
}

async function createPage(parentShape, props, blocks, coverUrl) {
  const firstChunk = blocks.slice(0, MAX_CHILDREN);
  const rest = blocks.slice(MAX_CHILDREN);

  const payload = {
    parent: parentShape,
    properties: props,
    children: firstChunk,
  };
  if (coverUrl) payload.cover = { type: "external", external: { url: coverUrl } };

  const page = await notion(`/pages`, payload);

  for (let j = 0; j < rest.length; j += MAX_CHILDREN) {
    await sleep(NOTION_RATE_MS);
    await notion(`/blocks/${page.id}/children`, {
      children: rest.slice(j, j + MAX_CHILDREN),
    });
  }
  return page;
}

// ---------- Main ----------

async function main() {
  console.log(`🪄  WP → Notion blog import${DRY_RUN ? " (DRY-RUN)" : ""}`);
  console.log(`    WP:     ${WP}`);
  console.log(`    Notion: ${NOTION_ID.slice(0, 8)}…`);
  console.log(`    Offset: ${OFFSET}   Limit: ${LIMIT === Infinity ? "all" : LIMIT}`);
  console.log("");

  // 1. Probe Notion parent shape
  const target = await detectParent();
  console.log(`✓ Notion parent detected: ${target.parentType}`);

  // 2. Load WP categories (id → slug)
  console.log("↓ Loading WP categories…");
  const catMap = await loadCategories();
  console.log(`  ${catMap.size} categories`);

  // 3. Page through WP posts from OFFSET to end
  console.log(`↓ Fetching WP posts starting at offset ${OFFSET}…`);
  const collected = [];
  let cursor = OFFSET;
  while (collected.length < LIMIT) {
    const batch = await fetchPostsWindow(cursor, PER_PAGE);
    if (!batch.length) break;
    collected.push(...batch);
    cursor += batch.length;
    if (batch.length < PER_PAGE) break;
  }
  const posts = collected.slice(0, LIMIT);
  console.log(`  ${posts.length} posts to process\n`);

  const results = { imported: 0, skipped: 0, errors: [] };

  for (let idx = 0; idx < posts.length; idx += 1) {
    const p = posts[idx];
    const progress = `[${idx + 1}/${posts.length}]`;

    try {
      if (!DRY_RUN) {
        const existing = await findByWpId(target.queryPath, p.id);
        if (existing) {
          console.log(`${progress} · ${p.slug} (wpId ${p.id} exists, skipping)`);
          results.skipped += 1;
          await sleep(NOTION_RATE_MS);
          continue;
        }
      }

      const title = decodeEntities(p.title?.rendered || p.slug);
      const excerpt = stripHtml(p.excerpt?.rendered || "");
      const html = p.content?.rendered || "";
      const md = nhm.translate(html);
      const blocks = markdownToNotionBlocks(md);

      const catSlugs = (p.categories || []).map((id) => catMap.get(id)).filter(Boolean);
      const category = mapCategory(catSlugs);

      const seoTitle = p.yoast_head_json?.title || title;
      const seoDesc = p.yoast_head_json?.description || excerpt;

      const props = buildProperties({
        title,
        slug: p.slug,
        excerpt,
        date: p.date,
        modified: p.modified,
        url: p.link,
        seoTitle,
        seoDesc,
        wpId: p.id,
        category,
      });

      if (DRY_RUN) {
        console.log(
          `${progress} ✓ ${p.slug}  (id=${p.id}, ${blocks.length} blocks, cat=${category}, slugs=[${catSlugs.join(",")}])`
        );
        results.imported += 1;
        continue;
      }

      // Optional cover from WP featured image — skipped here because the spec
      // doesn't require it and avoiding the extra /media round-trip keeps the
      // run snappy. Re-enable by fetching /media/{p.featured_media}.
      await createPage(target.parentShape, props, blocks, null);
      console.log(`${progress} ✓ ${p.slug}`);
      results.imported += 1;
      await sleep(NOTION_RATE_MS);
    } catch (err) {
      console.error(`${progress} ✗ ${p.slug || "?"} — ${err.message}`);
      results.errors.push({ slug: p.slug, wpId: p.id, message: err.message });
    }
  }

  console.log("");
  console.log(
    `Done. imported=${results.imported} skipped=${results.skipped} errors=${results.errors.length}`
  );
  if (results.errors.length) {
    console.log("\nErrors:");
    for (const e of results.errors) console.log(`  · ${e.slug} (wpId ${e.wpId}): ${e.message}`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
