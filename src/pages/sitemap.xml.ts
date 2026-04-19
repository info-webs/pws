import type { APIContext } from "astro";
import { getAllPosts, getCategories } from "../lib/notion";

const STATIC_ROUTES = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/blog", changefreq: "daily", priority: "0.9" },
];

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET({ site }: APIContext) {
  const origin = (site?.toString() || "https://www.posicionamiento-web-salamanca.com").replace(/\/$/, "");
  const posts = await getAllPosts();
  const categories = await getCategories();

  type Row = { loc: string; lastmod?: string; changefreq?: string; priority?: string };

  const urls: Row[] = [
    ...STATIC_ROUTES.map((r) => ({
      loc: `${origin}${r.path}`,
      changefreq: r.changefreq,
      priority: r.priority,
    })),
    ...categories.map((c) => ({
      loc: `${origin}/blog/categoria/${c.slug}`,
      changefreq: "weekly",
      priority: "0.7",
    })),
    ...posts.map((p) => ({
      loc: `${origin}/blog/${p.slug}`,
      lastmod: p.updatedDate || p.publishedDate || undefined,
      changefreq: "monthly",
      priority: "0.8",
    })),
  ];

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url>\n    <loc>${esc(u.loc)}</loc>\n` +
          (u.lastmod ? `    <lastmod>${esc(u.lastmod)}</lastmod>\n` : "") +
          (u.changefreq ? `    <changefreq>${u.changefreq}</changefreq>\n` : "") +
          (u.priority ? `    <priority>${u.priority}</priority>\n` : "") +
          `  </url>`
      )
      .join("\n") +
    `\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
