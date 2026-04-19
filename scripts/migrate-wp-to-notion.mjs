#!/usr/bin/env node
/**
 * WordPress → Notion migration script
 *
 * Reads all posts from the WordPress REST API of
 * posicionamiento-web-salamanca.com and creates them as pages inside a
 * Notion database. Idempotent: re-running will skip posts whose slug
 * already exists in the Notion database.
 *
 * Usage:
 *   node scripts/migrate-wp-to-notion.mjs            # dry-run by default if DRY_RUN=1
 *   node scripts/migrate-wp-to-notion.mjs --run      # actually create pages
 *   node scripts/migrate-wp-to-notion.mjs --limit 5  # only process first 5 posts
 *
 * Env (see .env.example):
 *   WP_BASE_URL           e.g. https://www.posicionamiento-web-salamanca.com
 *   WP_USER               WordPress user with REST access
 *   WP_APP_PASSWORD       Application password (spaces OK)
 *   NOTION_API_KEY        Notion integration secret (secret_…)
 *   NOTION_BLOG_DB_ID     Target Notion database UUID
 */

import { Client } from "@notionhq/client";
import { NodeHtmlMarkdown } from "node-html-markdown";
import "dotenv/config";

// ---------- Config ----------

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const DRY_RUN = hasFlag("--dry-run") || (process.env.DRY_RUN === "1" && !hasFlag("--run"));
const LIMIT = flagValue("--limit") ? Number(flagValue("--limit")) : Infinity;
const NOTION_RATE_MS = 400; // ~2.5 req/s — under Notion's 3 req/s limit

const required = ["WP_BASE_URL", "WP_USER", "WP_APP_PASSWORD", "NOTION_API_KEY", "NOTION_BLOG_DB_ID"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing env: ${k}. See .env.example.`);
    process.exit(1);
  }
}

const WP = process.env.WP_BASE_URL.replace(/\/$/, "");
const WP_AUTH =
  "Basic " +
  Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD.replace(/\s+/g, "")}`).toString(
    "base64"
  );

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB_ID = process.env.NOTION_BLOG_DB_ID;

const nhm = new NodeHtmlMarkdown({
  bulletMarker: "-",
  codeBlockStyle: "fenced",
  keepDataImages: false,
});

const MAX_RICH = 2000; // Notion rich-text char limit per item
const MAX_CHILDREN = 100; // Notion create-page children limit

// ---------- Helpers ----------

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

// ---------- WordPress fetch ----------

async function wpFetch(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${WP}/wp-json/wp/v2${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: WP_AUTH,
      Accept: "application/json; charset=utf-8",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`WP ${res.status} ${res.statusText} ← ${url}`);
  }
  return res;
}

async function fetchAllPosts() {
  const perPage = 100;
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await wpFetch(`/posts?per_page=${perPage}&page=${page}&_embed=0&orderby=date&order=asc`);
    const headerTotal = Number(res.headers.get("x-wp-totalpages") || "1");
    if (page === 1) totalPages = headerTotal;
    const data = await res.json();
    all.push(...data);
    page += 1;
  } while (page <= totalPages);
  return all;
}

// resolve featured_media id → URL (with cache)
const mediaCache = new Map();
async function resolveMedia(id) {
  if (!id) return null;
  if (mediaCache.has(id)) return mediaCache.get(id);
  try {
    const res = await wpFetch(`/media/${id}`);
    const m = await res.json();
    const url = m?.source_url || m?.guid?.rendered || null;
    mediaCache.set(id, url);
    return url;
  } catch (e) {
    mediaCache.set(id, null);
    return null;
  }
}

// resolve taxonomy id → name
async function loadTaxonomy(taxonomy) {
  const map = new Map();
  let page = 1;
  let totalPages = 1;
  do {
    const res = await wpFetch(`/${taxonomy}?per_page=100&page=${page}`);
    const headerTotal = Number(res.headers.get("x-wp-totalpages") || "1");
    if (page === 1) totalPages = headerTotal;
    const data = await res.json();
    for (const t of data) map.set(t.id, decodeEntities(t.name));
    page += 1;
  } while (page <= totalPages);
  return map;
}

// ---------- Markdown → Notion blocks ----------

function chunkText(str, size = MAX_RICH) {
  const out = [];
  let s = str;
  while (s.length > size) {
    out.push(s.slice(0, size));
    s = s.slice(size);
  }
  if (s.length) out.push(s);
  return out;
}

/**
 * Parse inline markdown (links, bold, italic, inline code) into Notion rich_text.
 * Keeps it simple: one-pass regex for the four constructs.
 */
function inlineToRichText(text) {
  if (!text) return [];
  const tokens = [];
  let i = 0;
  const patterns = [
    { re: /!\[([^\]]*)\]\(([^)]+)\)/g, type: "image" }, // inline image → skipped (handled at block level)
    { re: /\[([^\]]+)\]\(([^)]+)\)/g, type: "link" },
    { re: /\*\*([^*]+)\*\*/g, type: "bold" },
    { re: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, type: "italic" },
    { re: /`([^`\n]+)`/g, type: "code" },
  ];

  // Naive scan: find next matching token
  while (i < text.length) {
    let next = null;
    for (const p of patterns) {
      p.re.lastIndex = i;
      const m = p.re.exec(text);
      if (m && (!next || m.index < next.match.index)) {
        next = { pattern: p, match: m };
      }
    }
    if (!next) {
      tokens.push({ type: "text", text: text.slice(i) });
      break;
    }
    if (next.match.index > i) {
      tokens.push({ type: "text", text: text.slice(i, next.match.index) });
    }
    const p = next.pattern;
    const m = next.match;
    if (p.type === "image") {
      // drop inline images; they should become separate blocks upstream
    } else if (p.type === "link") {
      tokens.push({ type: "text", text: m[1], link: m[2] });
    } else if (p.type === "bold") {
      tokens.push({ type: "text", text: m[1], bold: true });
    } else if (p.type === "italic") {
      tokens.push({ type: "text", text: m[1], italic: true });
    } else if (p.type === "code") {
      tokens.push({ type: "text", text: m[1], code: true });
    }
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

function makeParagraph(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: inlineToRichText(text) } };
}
function makeHeading(level, text) {
  const key = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
  return { object: "block", type: key, [key]: { rich_text: inlineToRichText(text) } };
}
function makeListItem(type, text) {
  const key = type === "bulleted" ? "bulleted_list_item" : "numbered_list_item";
  return { object: "block", type: key, [key]: { rich_text: inlineToRichText(text) } };
}
function makeQuote(text) {
  return { object: "block", type: "quote", quote: { rich_text: inlineToRichText(text) } };
}
function makeCode(text, lang = "plain text") {
  return {
    object: "block",
    type: "code",
    code: {
      rich_text: chunkText(text).map((c) => ({ type: "text", text: { content: c } })),
      language: lang,
    },
  };
}
function makeImage(url, caption = "") {
  return {
    object: "block",
    type: "image",
    image: {
      type: "external",
      external: { url },
      caption: caption ? [{ type: "text", text: { content: caption } }] : [],
    },
  };
}
function makeDivider() {
  return { object: "block", type: "divider", divider: {} };
}

/**
 * Convert Markdown (as produced by node-html-markdown) into an ordered list
 * of Notion blocks. Handles h1-h3, paragraphs, ul/ol (single-level),
 * fenced code blocks, block quotes, image references and horizontal rules.
 */
function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block
    const codeStart = line.match(/^```(\w+)?\s*$/);
    if (codeStart) {
      const lang = codeStart[1] || "plain text";
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      blocks.push(makeCode(buf.join("\n"), normalizeLang(lang)));
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(makeDivider());
      i += 1;
      continue;
    }

    // Heading (## up to ###### collapses to h3)
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(3, h[1].length);
      blocks.push(makeHeading(level, h[2].trim()));
      i += 1;
      continue;
    }

    // Image (standalone line, possibly wrapped in a link)
    const imgOnly = line.match(/^\s*\[?!\[([^\]]*)\]\(([^)]+)\)\]?/);
    if (imgOnly) {
      blocks.push(makeImage(imgOnly[2], imgOnly[1]));
      i += 1;
      continue;
    }

    // Block quote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(makeQuote(buf.join("\n")));
      continue;
    }

    // Bulleted list
    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        blocks.push(makeListItem("bulleted", lines[i].replace(/^[-*]\s+/, "")));
        i += 1;
      }
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        blocks.push(makeListItem("numbered", lines[i].replace(/^\d+\.\s+/, "")));
        i += 1;
      }
      continue;
    }

    // Paragraph: consume consecutive non-empty lines
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
    if (joined) blocks.push(makeParagraph(joined));
  }

  return blocks;
}

function normalizeLang(lang) {
  const allowed = new Set([
    "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#",
    "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran",
    "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java",
    "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
    "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix", "objective-c",
    "ocaml", "pascal", "perl", "php", "plain text", "powershell", "prolog", "protobuf",
    "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell",
    "solidity", "sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic",
    "webassembly", "xml", "yaml"
  ]);
  const l = (lang || "").toLowerCase();
  return allowed.has(l) ? l : "plain text";
}

// ---------- Notion ----------

async function findExistingBySlug(slug) {
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: { property: "Slug", rich_text: { equals: slug } },
    page_size: 1,
  });
  return res.results[0] || null;
}

async function createPage(post, meta) {
  const { title, slug, excerpt, coverUrl, date, modified, categories, tags, seoTitle, seoDesc, wpUrl, blocks } = meta;

  const properties = {
    Name: { title: [{ text: { content: chunkText(title, 2000)[0] || slug } }] },
    Slug: { rich_text: [{ text: { content: slug } }] },
    Excerpt: { rich_text: chunkText(excerpt, 2000).map((c) => ({ text: { content: c } })) },
    "Published date": { date: { start: date } },
    "Updated date": { date: { start: modified } },
    Categories: { multi_select: categories.map((name) => ({ name: trimSelect(name) })) },
    Tags: { multi_select: tags.map((name) => ({ name: trimSelect(name) })) },
    "SEO Title": { rich_text: [{ text: { content: (seoTitle || "").slice(0, 2000) } }] },
    "SEO Description": { rich_text: [{ text: { content: (seoDesc || "").slice(0, 2000) } }] },
    "WP Original URL": { url: wpUrl },
    Status: { select: { name: "Published" } },
  };

  const firstChunk = blocks.slice(0, MAX_CHILDREN);
  const rest = blocks.slice(MAX_CHILDREN);

  const payload = {
    parent: { database_id: DB_ID },
    properties,
    children: firstChunk,
  };
  if (coverUrl) {
    payload.cover = { type: "external", external: { url: coverUrl } };
  }

  const page = await notion.pages.create(payload);

  // Append any overflow in chunks of 100
  for (let j = 0; j < rest.length; j += MAX_CHILDREN) {
    await sleep(NOTION_RATE_MS);
    await notion.blocks.children.append({
      block_id: page.id,
      children: rest.slice(j, j + MAX_CHILDREN),
    });
  }

  return page;
}

// Notion multi_select options max 100 chars, no commas
function trimSelect(name) {
  return name.replace(/,/g, " ").slice(0, 100).trim();
}

// ---------- Main ----------

async function main() {
  console.log(`🪄  WP → Notion migration${DRY_RUN ? " (DRY-RUN)" : ""}`);
  console.log(`    WP:     ${WP}`);
  console.log(`    Notion: db ${DB_ID.slice(0, 8)}…`);
  console.log(``);

  console.log("↓ Fetching taxonomies…");
  const [catMap, tagMap] = await Promise.all([loadTaxonomy("categories"), loadTaxonomy("tags")]);
  console.log(`  ${catMap.size} categories, ${tagMap.size} tags`);

  console.log("↓ Fetching posts…");
  const posts = await fetchAllPosts();
  console.log(`  ${posts.length} posts found`);

  const toProcess = posts.slice(0, LIMIT);
  const results = { imported: 0, skipped: 0, errors: [] };

  for (let idx = 0; idx < toProcess.length; idx += 1) {
    const post = toProcess[idx];
    const slug = post.slug;
    const progress = `[${idx + 1}/${toProcess.length}]`;

    try {
      // Idempotency check
      if (!DRY_RUN) {
        const existing = await findExistingBySlug(slug);
        if (existing) {
          console.log(`${progress} · ${slug} (exists, skipping)`);
          results.skipped += 1;
          await sleep(NOTION_RATE_MS);
          continue;
        }
      }

      const title = decodeEntities(post.title?.rendered || slug);
      const excerpt = stripHtml(post.excerpt?.rendered || "");
      const html = post.content?.rendered || "";
      const md = nhm.translate(html);
      const blocks = markdownToNotionBlocks(md);

      const coverUrl = await resolveMedia(post.featured_media);
      const categories = (post.categories || []).map((id) => catMap.get(id)).filter(Boolean);
      const tags = (post.tags || []).map((id) => tagMap.get(id)).filter(Boolean);
      const seoTitle = post.yoast_head_json?.title || title;
      const seoDesc = post.yoast_head_json?.description || excerpt;
      const wpUrl = post.link;

      if (DRY_RUN) {
        console.log(
          `${progress} ✓ ${slug} (${blocks.length} blocks, ${categories.length} cats, ${tags.length} tags)`
        );
        results.imported += 1;
        continue;
      }

      await createPage(post, {
        title,
        slug,
        excerpt,
        coverUrl,
        date: post.date,
        modified: post.modified,
        categories,
        tags,
        seoTitle,
        seoDesc,
        wpUrl,
        blocks,
      });
      results.imported += 1;
      console.log(`${progress} ✓ ${slug}`);
      await sleep(NOTION_RATE_MS);
    } catch (err) {
      console.error(`${progress} ✗ ${slug} — ${err.message}`);
      results.errors.push({ slug, message: err.message, stack: err.stack });
    }
  }

  console.log("");
  console.log(`Done. imported=${results.imported} skipped=${results.skipped} errors=${results.errors.length}`);
  if (results.errors.length) {
    console.log("\nErrors:");
    for (const e of results.errors) {
      console.log(`  · ${e.slug}: ${e.message}`);
      if (process.env.VERBOSE === "1") console.log(e.stack);
    }
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
