// Builds RSS feeds for WordPress sites listed in feeds.json, using each site's REST API.
// Node 20+, no dependencies. Writes into public/.
//
// feeds.json: [{ "slug": "codrops", "name": "Codrops", "site": "https://tympanus.net/codrops",
//                "output": "feed.xml", "perPage": 30, "categories": "12,34", "tags": "" }]
// Only slug and site are required. site can be any page on the site; the WordPress base is found
// automatically. name defaults to the site's own name. output defaults to "<slug>.xml".

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

// Find the WordPress install behind any pasted link: try the link itself, then walk up its path.
// Returns { base, route, name } where route is "pretty" (/wp-json/) or "query" (?rest_route=).
async function resolveSite(feed) {
  const u = new URL(feed.site);
  const parts = u.pathname.split("/").filter(Boolean).slice(0, 4);
  const bases = [];
  for (let i = parts.length; i >= 0; i--) bases.push(u.origin + (i ? "/" + parts.slice(0, i).join("/") : ""));
  for (const base of bases) {
    for (const [route, url] of [["pretty", `${base}/wp-json/`], ["query", `${base}/?rest_route=/`]]) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
        if (!res.ok) continue;
        const root = await res.json();
        if (Array.isArray(root?.namespaces) && root.namespaces.includes("wp/v2")) {
          return { base, route, name: decode(root.name || "").trim() || u.hostname.replace(/^www\./, "") };
        }
      } catch {}
    }
  }
  const e = new Error("No WordPress API found at this address");
  e.code = "not_wordpress";
  throw e;
}

async function fetchPosts(feed, site) {
  const q = new URLSearchParams({ per_page: String(feed.perPage || 30), _embed: "author,wp:featuredmedia" });
  if (feed.categories) q.set("categories", feed.categories);
  if (feed.tags) q.set("tags", feed.tags);
  const url = site.route === "pretty" ? `${site.base}/wp-json/wp/v2/posts?${q}` : `${site.base}/?rest_route=/wp/v2/posts&${q}`;
  return getJson(url);
}

function toXml(feed, posts, selfUrl, site) {
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
    <title>${esc(site.name)}</title>
    <link>${esc(site.base)}/</link>
    <description>${esc(site.name)} posts, rebuilt from the WordPress API.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${selfUrl ? `    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml" />\n` : ""}${items.join("\n")}
  </channel>
</rss>
`,
  };
}

// If a site is down, republish the copy that is already live so its URL doesn't 404.
// Returns "kept", "none" (never published, nothing to protect) or "unknown" (couldn't check).
async function keepLiveCopy(output) {
  if (!PAGES_BASE) return "unknown";
  try {
    const res = await fetch(`${PAGES_BASE}/${output}`, { headers: { "User-Agent": UA } });
    if (res.status === 404) return "none";
    if (!res.ok) return "unknown";
    await writeFile(`public/${output}`, await res.text());
    return "kept";
  } catch {
    return "unknown";
  }
}

async function main() {
  const feeds = JSON.parse(await readFile("feeds.json", "utf8"));
  await mkdir("public", { recursive: true });
  const rows = [];
  let broken = 0;

  for (const feed of feeds) {
    const output = feed.output || `${feed.slug}.xml`;
    const selfUrl = PAGES_BASE ? `${PAGES_BASE}/${output}` : "";
    const row = { slug: feed.slug, name: feed.name || feed.slug, site: feed.site, file: output };
    try {
      const site = await resolveSite(feed);
      if (feed.name) site.name = feed.name; // an explicit name in feeds.json wins
      const { xml, count } = toXml(feed, await fetchPosts(feed, site), selfUrl, site);
      if (!count) throw Object.assign(new Error("The site's API returned no posts"), { code: "no_posts" });
      await writeFile(`public/${output}`, xml);
      console.log(`✓ ${feed.slug}: ${count} items from ${site.base} -> ${output}`);
      rows.push({ ...row, name: site.name, site: site.base, status: "ok", items: count });
    } catch (err) {
      const kept = await keepLiveCopy(output);
      console.error(`✗ ${feed.slug}: ${err.message} (${kept})`);
      if (kept === "kept") rows.push({ ...row, status: "stale", error: err.message });
      else if (kept === "none") rows.push({ ...row, status: "failed", code: err.code || "error", error: err.message });
      else broken++;
    }
  }

  // Feed list for the feed-maker page, then the page itself from site/
  await writeFile("public/feeds.json", JSON.stringify(rows, null, 2));
  if (existsSync("site")) await cp("site", "public", { recursive: true });

  // Couldn't tell whether a failing feed was already published: stop rather than risk dropping it.
  if (broken) {
    console.error(`${broken} feed(s) failed and their live copy couldn't be checked; not deploying.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
