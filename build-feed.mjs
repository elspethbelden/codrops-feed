// Builds an RSS feed for Codrops from the WordPress REST API.
// Runs on Node 20+ (built-in fetch), no dependencies.
// Output: public/feed.xml

import { mkdir, writeFile } from "node:fs/promises";

const SITE = "https://tympanus.net/codrops";
const API = `${SITE}/wp-json/wp/v2/posts?per_page=30&_embed=author,wp:featuredmedia`;
const SELF_URL = process.env.FEED_URL || ""; // set in the workflow, used for atom:link

// Decode the HTML entities WordPress puts in titles (&#8217; &amp; etc.)
function decode(str = "") {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// Escape text for XML elements and attributes
const esc = (s = "") =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Wrap HTML safely in CDATA
const cdata = (s = "") => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

async function main() {
  const res = await fetch(API, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; personal-codrops-feed/1.0)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`API responded ${res.status} ${res.statusText}`);

  const posts = await res.json();
  if (!Array.isArray(posts) || posts.length === 0) throw new Error("API returned no posts");

  // The API only returns published posts, but guard against stray draft URLs
  // and duplicates anyway.
  const seen = new Set();
  const clean = posts.filter((p) => {
    const link = p.link || "";
    const title = decode(p.title?.rendered).trim();
    if (!link || !title) return false;
    if (/review-draft|\/draft\b|[?&]preview=/i.test(link)) return false;
    if (seen.has(link) || seen.has(title)) return false;
    seen.add(link);
    seen.add(title);
    return true;
  });

  const items = clean
    .map((p) => {
      const title = decode(p.title.rendered).trim();
      const author = p._embedded?.author?.[0]?.name;
      const image = p._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
      const excerpt = (p.excerpt?.rendered || "").trim();
      const html = (image ? `<p><img src="${esc(image)}" alt="" /></p>` : "") + excerpt;
      const pubDate = new Date(`${p.date_gmt}Z`).toUTCString();

      return [
        "    <item>",
        `      <title>${esc(title)}</title>`,
        `      <link>${esc(p.link)}</link>`,
        `      <guid isPermaLink="false">codrops-${p.id}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        author ? `      <dc:creator>${esc(decode(author))}</dc:creator>` : "",
        `      <description>${cdata(html)}</description>`,
        image ? `      <media:content medium="image" url="${esc(image)}" />` : "",
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Codrops</title>
    <link>${SITE}/</link>
    <description>All Codrops posts, rebuilt from the WordPress API.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${SELF_URL ? `    <atom:link href="${esc(SELF_URL)}" rel="self" type="application/rss+xml" />\n` : ""}${items}
  </channel>
</rss>
`;

  await mkdir("public", { recursive: true });
  await writeFile("public/feed.xml", xml);
  console.log(`Wrote public/feed.xml with ${clean.length} items (from ${posts.length} posts)`);
}

main().catch((err) => {
  // Fail loudly so GitHub Pages keeps serving the last good feed.
  console.error(err);
  process.exit(1);
});
