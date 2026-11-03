# Codrops feed

A clean RSS feed for Codrops, rebuilt hourly from the site's WordPress API and hosted free on GitHub Pages.

## Setup (about 5 minutes)

1. **Create a repo.** On GitHub, make a new public repository, e.g. `codrops-feed`.
2. **Add the files.** Upload `build-feed.mjs` and `README.md` to the root.
   Create the folder path `.github/workflows/` and put `feed.yml` inside it.
   (In the GitHub web UI: Add file → Create new file, and type `.github/workflows/feed.yml` as the name — the slashes create the folders.)
3. **Turn on Pages.** Settings → Pages → Source: **GitHub Actions**.
4. **Run it once.** Actions tab → "Build Codrops feed" → **Run workflow**.
5. **Subscribe.** Your feed is at:
   `https://<your-username>.github.io/codrops-feed/feed.xml`

After that it rebuilds every hour on its own.

## How it works

- Pulls the 30 latest posts from `tympanus.net/codrops/wp-json/wp/v2/posts`.
  That endpoint only returns published posts, so drafts can't leak in.
- Drops duplicates and any `review-draft` / preview URLs as a safety net.
- Uses Codrops' own post IDs as GUIDs, so your reader won't show repeats.
- If Codrops' API is down, the build fails and Pages keeps serving the last good feed.

## Notes

- GitHub pauses scheduled workflows on repos with no activity for 60 days.
  If the feed stops updating, open the Actions tab and re-enable it.
- To change how many posts are included, edit `per_page=30` in `build-feed.mjs` (max 100).
