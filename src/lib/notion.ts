// Notion client for the blog (build-time, SSG).
// Uses the raw REST API to dodge @notionhq/client version skew, and renders
// blocks → HTML in-process so we have no runtime dep on notion-to-md.
//
// Env (set in Vercel / .env):
//   NOTION_API_KEY      integration secret (secret_… or ntn_…)
//   NOTION_DS_ID        the UUID of the blog database / data source
//                       (NOTION_BLOG_DB_ID is also accepted as an alias)

// Use process.env first — import.meta.env only exposes PUBLIC_* vars in Astro SSG build
const NOTION_KEY =
  (typeof process !== "undefined" ? process.env?.NOTION_API_KEY : undefined) ||
  import.meta.env.NOTION_API_KEY ||
  "";

const NOTION_ID =
  (typeof process !== "undefined"
    ? process.env?.NOTION_DS_ID || process.env?.NOTION_BLOG_DB_ID
    : undefined) ||
  import.meta.env.NOTION_DS_ID ||
  import.meta.env.NOTION_BLOG_DB_ID ||
  "";
const NOTION_VERSION = "2022-06-28";

// Soft-fail when env is missing (local dev without secrets, CI, sandbox
// builds): emit a warning and render an empty blog rather than crashing.
// Debug: log what env vars are visible at build time
if (typeof process !== "undefined") {
  const keys = Object.keys(process.env).filter(k => k.startsWith("NOTION") || k.startsWith("PUBLIC_"));
  // eslint-disable-next-line no-console
  console.log(`[notion-debug] process.env NOTION* keys: ${keys.join(", ") || "(none)"}`);
  // eslint-disable-next-line no-console
  console.log(`[notion-debug] NOTION_API_KEY set: ${!!process.env.NOTION_API_KEY}, NOTION_DS_ID set: ${!!process.env.NOTION_DS_ID}`);
}

const NOTION_DISABLED = !NOTION_KEY || !NOTION_ID;
if (NOTION_DISABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    "[notion] NOTION_API_KEY / NOTION_DS_ID missing — blog will render empty."
  );
} else {
  // eslint-disable-next-line no-console
  console.log(`[notion] Connected — DS: ${String(NOTION_ID).slice(0, 8)}...`);
}

// ---------- Types ----------

export type PostMeta = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  categorySlug: string;
  publishedDate: string; // ISO
  updatedDate: string; // ISO
  originalUrl: string | null;
  seoTitle: string;
  seoDescription: string;
  coverUrl: string | null;
  wpId: number | null;
};

export type Post = PostMeta & {
  html: string;
};

export type Category = {
  name: string;
  slug: string;
  count: number;
};

// ---------- Raw API ----------

type NotionParent =
  | { database_id: string }
  | { type: "data_source_id"; data_source_id: string };

let cachedParent: {
  queryPath: string;
  parent: NotionParent;
} | null = null;

async function notion<T = any>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || `${res.status} ${res.statusText}`;
    const err = new Error(`Notion ${method} ${path} — ${msg}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

async function resolveParent() {
  if (cachedParent) return cachedParent;
  try {
    await notion(`/databases/${NOTION_ID}/query`, { page_size: 1 });
    cachedParent = {
      queryPath: `/databases/${NOTION_ID}/query`,
      parent: { database_id: NOTION_ID! },
    };
    return cachedParent;
  } catch (e: any) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  await notion(`/data_sources/${NOTION_ID}/query`, { page_size: 1 });
  cachedParent = {
    queryPath: `/data_sources/${NOTION_ID}/query`,
    parent: { type: "data_source_id", data_source_id: NOTION_ID! },
  };
  return cachedParent;
}

// ---------- Property helpers ----------

const plainText = (rt: any[] | undefined): string =>
  Array.isArray(rt) ? rt.map((r: any) => r?.plain_text || "").join("") : "";

const getTitle = (props: any): string => plainText(props?.Title?.title);
const getRich = (props: any, key: string): string => plainText(props?.[key]?.rich_text);
const getSelect = (props: any, key: string): string => props?.[key]?.select?.name || "";
const getDate = (props: any, key: string): string => props?.[key]?.date?.start || "";
const getUrl = (props: any, key: string): string | null => props?.[key]?.url || null;
const getNumber = (props: any, key: string): number | null =>
  typeof props?.[key]?.number === "number" ? props[key].number : null;

function pageToMeta(page: any): PostMeta {
  const p = page.properties || {};
  const category = getSelect(p, "Category") || "Sin categoría";
  const cover =
    page.cover?.external?.url || page.cover?.file?.url || null;
  return {
    id: page.id,
    slug: getRich(p, "Slug"),
    title: getTitle(p),
    excerpt: getRich(p, "Excerpt"),
    category,
    categorySlug: slugify(category),
    publishedDate: getDate(p, "Published Date"),
    updatedDate: getDate(p, "Updated Date"),
    originalUrl: getUrl(p, "Original URL"),
    seoTitle: getRich(p, "SEO Title") || getTitle(p),
    seoDescription: getRich(p, "SEO Description") || getRich(p, "Excerpt"),
    coverUrl: cover,
    wpId: getNumber(p, "WP ID"),
  };
}

export function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "sin-categoria";
}

// ---------- Queries ----------

async function queryAll(filter: any = undefined, sorts: any = undefined): Promise<any[]> {
  const target = await resolveParent();
  const all: any[] = [];
  let start_cursor: string | undefined = undefined;
  do {
    const res: any = await notion(target.queryPath, {
      filter,
      sorts,
      page_size: 100,
      start_cursor,
    });
    all.push(...(res.results || []));
    start_cursor = res.has_more ? res.next_cursor : undefined;
  } while (start_cursor);
  return all;
}

// Lightweight in-process cache so that getAllPosts() called from multiple
// pages during the same build hits Notion once.
let postsCache: Promise<PostMeta[]> | null = null;
export function resetCache() {
  postsCache = null;
  cachedParent = null;
}

export async function getAllPosts(): Promise<PostMeta[]> {
  if (NOTION_DISABLED) return [];
  if (!postsCache) {
    postsCache = (async () => {
      try {
        const pages = await queryAll(
          { property: "Status", select: { equals: "Published" } },
          [{ property: "Published Date", direction: "descending" }]
        );
        return pages
          .map(pageToMeta)
          .filter((p) => !!p.slug);
      } catch (e: any) {
        console.warn(`[notion] getAllPosts failed: ${e.message} — rendering empty blog.`);
        return [];
      }
    })();
  }
  return postsCache;
}

export async function getCategories(): Promise<Category[]> {
  const posts = await getAllPosts();
  const map = new Map<string, Category>();
  for (const p of posts) {
    const key = p.categorySlug;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { name: p.category, slug: p.categorySlug, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export async function getPostBySlug(slug: string): Promise<Post | null> {
  if (NOTION_DISABLED) return null;
  const posts = await getAllPosts();
  const meta = posts.find((p) => p.slug === slug);
  if (!meta) return null;
  try {
    const blocks = await listAllBlocks(meta.id);
    const html = blocksToHtml(blocks);
    return { ...meta, html };
  } catch (e: any) {
    console.warn(`[notion] getPostBySlug(${slug}) failed: ${e.message}`);
    return { ...meta, html: "" };
  }
}

// ---------- Blocks → HTML ----------

async function listAllBlocks(blockId: string): Promise<any[]> {
  const out: any[] = [];
  let start_cursor: string | undefined = undefined;
  do {
    const qs = start_cursor
      ? `?page_size=100&start_cursor=${start_cursor}`
      : `?page_size=100`;
    const res: any = await notion(`/blocks/${blockId}/children${qs}`, undefined, "GET");
    out.push(...(res.results || []));
    start_cursor = res.has_more ? res.next_cursor : undefined;
  } while (start_cursor);
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function richTextToHtml(rt: any[] | undefined): string {
  if (!Array.isArray(rt)) return "";
  return rt
    .map((r) => {
      if (r.type === "mention" || r.type === "equation") {
        return escapeHtml(r.plain_text || "");
      }
      let text = escapeHtml(r.plain_text || "");
      const a = r.annotations || {};
      if (a.code) text = `<code>${text}</code>`;
      if (a.bold) text = `<strong>${text}</strong>`;
      if (a.italic) text = `<em>${text}</em>`;
      if (a.strikethrough) text = `<s>${text}</s>`;
      if (a.underline) text = `<u>${text}</u>`;
      if (r.href) {
        const href = r.href.startsWith("/") ? r.href : r.href;
        text = `<a href="${escapeHtml(href)}" rel="noopener">${text}</a>`;
      }
      return text;
    })
    .join("");
}

function blocksToHtml(blocks: any[]): string {
  let html = "";
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    switch (b.type) {
      case "paragraph":
        html += `<p>${richTextToHtml(b.paragraph?.rich_text)}</p>`;
        i += 1;
        break;
      case "heading_1":
        html += `<h2>${richTextToHtml(b.heading_1?.rich_text)}</h2>`;
        i += 1;
        break;
      case "heading_2":
        html += `<h3>${richTextToHtml(b.heading_2?.rich_text)}</h3>`;
        i += 1;
        break;
      case "heading_3":
        html += `<h4>${richTextToHtml(b.heading_3?.rich_text)}</h4>`;
        i += 1;
        break;
      case "bulleted_list_item": {
        let items = "";
        while (i < blocks.length && blocks[i].type === "bulleted_list_item") {
          items += `<li>${richTextToHtml(blocks[i].bulleted_list_item?.rich_text)}</li>`;
          i += 1;
        }
        html += `<ul>${items}</ul>`;
        break;
      }
      case "numbered_list_item": {
        let items = "";
        while (i < blocks.length && blocks[i].type === "numbered_list_item") {
          items += `<li>${richTextToHtml(blocks[i].numbered_list_item?.rich_text)}</li>`;
          i += 1;
        }
        html += `<ol>${items}</ol>`;
        break;
      }
      case "quote":
        html += `<blockquote>${richTextToHtml(b.quote?.rich_text)}</blockquote>`;
        i += 1;
        break;
      case "code": {
        const code = escapeHtml(
          (b.code?.rich_text || []).map((r: any) => r.plain_text || "").join("")
        );
        const lang = escapeHtml(b.code?.language || "plain text");
        html += `<pre><code class="language-${lang}">${code}</code></pre>`;
        i += 1;
        break;
      }
      case "image": {
        const url =
          b.image?.external?.url ||
          b.image?.file?.url ||
          "";
        const caption = (b.image?.caption || []).map((r: any) => r.plain_text || "").join("");
        if (url) {
          html += `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(
            caption
          )}" loading="lazy" />${
            caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""
          }</figure>`;
        }
        i += 1;
        break;
      }
      case "divider":
        html += `<hr />`;
        i += 1;
        break;
      case "callout":
        html += `<aside class="callout">${richTextToHtml(b.callout?.rich_text)}</aside>`;
        i += 1;
        break;
      case "bookmark":
      case "embed":
      case "video":
      case "file": {
        const url =
          b.bookmark?.url ||
          b.embed?.url ||
          b.video?.external?.url ||
          b.file?.external?.url ||
          "";
        if (url)
          html += `<p><a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(url)}</a></p>`;
        i += 1;
        break;
      }
      default:
        // Unknown block types are skipped silently.
        i += 1;
    }
  }
  return html;
}
