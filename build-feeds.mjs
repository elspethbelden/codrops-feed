// Builds RSS feeds for WordPress sites listed in feeds.json, using each site's REST API.
// Node 20+, no dependencies. Writes into public/.
//
// feeds.json: [{ "slug": "codrops", "name": "Codrops", "site": "https://tympanus.net/codrops",
//                "output": "feed.xml", "perPage": 30, "categories": "12,34", "tags": "" }]
// Only slug, name and site are required. output defaults to "<slug>.xml".

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const PAGES_BASE = (process.env.PAGES_BASE || "").replace(/\/$/, "");
const UA = "Mozilla/5.0 (compatible; personal-feed-builder/1.0)";

const decode = (s = "") =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const esc = (s = "") =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cdata = (s = "") => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Not a post list from ${url}`);
  return data;
}

// Pretty-permalink route first, then the query-string route for sites without it.
async function fetchPosts(feed) {
  const site = feed.site.replace(/\/$/, "");
  const q = new URLSearchParams({ per_page: String(feed.perPage || 30), _embed: "author,wp:featuredmedia" });
  if (feed.categories) q.set("categories", feed.categories);
  if (feed.tags) q.set("tags", feed.tags);
  const routes = [`${site}/wp-json/wp/v2/posts?${q}`, `${site}/?rest_route=/wp/v2/posts&${q}`];
  let lastErr;
  for (const url of routes) {
    try {
      return await getJson(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function toXml(feed, posts, selfUrl) {
  const site = feed.site.replace(/\/$/, "");
  const seen = new Set();
  const items = posts
    .filter((p) => {
      const title = decode(p.title?.rendered).trim();
      if (!p.link || !title || p.status && p.status !== "publish") return false;
      if (/review-draft|[?&]preview=/i.test(p.link)) return false;
      if (seen.has(p.link) || seen.has(title)) return false;
      seen.add(p.link).add(title);
      return true;
    })
    .map((p) => {
      const title = decode(p.title.rendered).trim();
      const author = p._embedded?.author?.[0]?.name;
      const image = p._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
      const html = (image ? `<p><img src="${esc(image)}" alt="" /></p>` : "") + (p.excerpt?.rendered || "").trim();
      return [
        "    <item>",
        `      <title>${esc(title)}</title>`,
        `      <link>${esc(p.link)}</link>`,
        `      <guid isPermaLink="false">${esc(feed.slug)}-${p.id}</guid>`,
        `      <pubDate>${new Date(`${p.date_gmt}Z`).toUTCString()}</pubDate>`,
        author ? `      <dc:creator>${esc(decode(author))}</dc:creator>` : "",
        `      <description>${cdata(html)}</description>`,
        image ? `      <media:content medium="image" url="${esc(image)}" />` : "",
        "    </item>",
      ].filter(Boolean).join("\n");
    });

  return {
    count: items.length,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${esc(feed.name)}</title>
    <link>${esc(site)}/</link>
    <description>${esc(feed.name)} posts, rebuilt from the WordPress API.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${selfUrl ? `    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />\n` : ""}${items.join("\n")}
  </channel>
</rss>
`,
  };
}

// If a site is down, republish the copy that is already live so its URL doesn't 404.
async function keepLiveCopy(output) {
  if (!PAGES_BASE) return false;
  const res = await fetch(`${PAGES_BASE}/${output}`, { headers: { "User-Agent": UA } });
  if (!res.ok) return false;
  await writeFile(`public/${output}`, await res.text());
  return true;
}

async function main() {
  const feeds = JSON.parse(await readFile("feeds.json", "utf8"));
  await mkdir("public", { recursive: true });
  const rows = [];
  let broken = 0;

  for (const feed of feeds) {
    const output = feed.output || `${feed.slug}.xml`;
    const selfUrl = PAGES_BASE ? `${PAGES_BASE}/${output}` : "";
    try {
      const { xml, count } = toXml(feed, await fetchPosts(feed), selfUrl);
      if (!count) throw new Error("no usable posts");
      await writeFile(`public/${output}`, xml);
      console.log(`✓ ${feed.slug}: ${count} items -> ${output}`);
      rows.push({ feed, output, ok: true });
    } catch (err) {
      const kept = await keepLiveCopy(output).catch(() => false);
      console.error(`✗ ${feed.slug}: ${err.message}${kept ? " (kept previous copy)" : ""}`);
      if (kept) rows.push({ feed, output, ok: false });
      else broken++;
    }
  }

  // Feed list for the feed-maker page, then the page itself from site/
  const list = rows.map((r) => ({ name: r.feed.name, site: r.feed.site, file: r.output, fresh: r.ok }));
  await writeFile("public/feeds.json", JSON.stringify(list, null, 2));
  if (existsSync("site")) await cp("site", "public", { recursive: true });

  // Stop the deploy rather than publish a site that has lost a feed.
  if (broken) {
    console.error(`${broken} feed(s) failed with no previous copy; not deploying.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
