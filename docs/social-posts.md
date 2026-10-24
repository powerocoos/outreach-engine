# Social posts from the blog

New Squarespace blog posts -> Claude drafts a Facebook post and an Instagram caption -> you review at
`<dashboard>/social` -> publish (or copy into Meta Business Suite).

## How it runs
- GitHub Action `Social drafts` (daily 6:30 AM Eastern, or run it by hand) runs `pipeline/social.py`.
- It reads the blog feed (`/updates?format=rss`), skips posts the dashboard already has, and only looks at posts
  from the last 21 days (`SOCIAL_MAX_AGE_DAYS`). At most 3 per run (`SOCIAL_MAX_PER_RUN`).
- Every draft is checked: no URLs or phone numbers in the text, hashtag count, word counts, and every number
  must appear in the blog post. If Claude fails twice it falls back to a plain template (still reviewed by you).
- Facebook links carry `utm_source=facebook&utm_medium=social&utm_campaign=blog-share`, so the GA4 panel shows
  how much traffic each post sends. Instagram captions say "Link in bio".
- Nothing posts until you approve it on the Social posts page.

## Without Meta connected (works today)
Approve a post, press **Copy Facebook text** / **Copy Instagram caption**, paste into Meta Business Suite,
then press **Mark as posted**.

## Connecting Facebook + Instagram (one-time, optional)
Needs an Instagram professional (business or creator) account linked to the Facebook Page. Meta changes these
screens often, so treat the steps as a guide.
1. developers.facebook.com -> create an app (type Business). Stay in Development mode: it can post to pages
   you own without app review.
2. Recommended (never expires): in Meta Business Settings -> Users -> System users, add a system user (Admin),
   assign it the Page (Content access) and the Instagram account, and assign the app (Develop app). Click
   **Generate token**, pick the app, expiration **Never**, permissions `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Copy the token once (it is shown only once).
   The dashboard swaps it for the Page's own token when posting to Facebook; Instagram uses it directly.
   (Older route: a long-lived user token from Graph API Explorer. User tokens expire after about 60 days and
   `/me/accounts` can come back empty when the Page sits in a business portfolio.)
3. `GET /<page-id>?fields=instagram_business_account` returns the Instagram user id; the Page id is in Page settings.
4. Add Worker secrets yourself in Cloudflare: `META_PAGE_ID`, `META_PAGE_TOKEN` (the token from step 2),
   `META_IG_USER_ID` (IG is optional). Never paste tokens into chat. If Meta retires the API version, set the
   variable `META_GRAPH_VERSION` (default v23.0).
Publish buttons then appear on the Social posts page. Instagram only accepts JPEG images; posts whose header
image is a PNG are Facebook-only.

## Later: Google Business Profile
The same drafts table can feed a third channel once Google approves Business Profile API access.

## Instagram images

Instagram only accepts a public https JPEG. When a blog post's featured image is not a JPEG (or is missing), the
drafting job renders a branded 1080x1080 "NEW ON THE BLOG" card (`pipeline/social_image.py`, Poppins fonts in
`pipeline/fonts/`), uploads it to the dashboard (`PUT /api/social-image/<id>`) and stores its public link
(`/img/social/<id>.jpg`) as the post image. Facebook is unaffected: it posts the blog link and Facebook builds the
preview from the blog page. Posts drafted before this change keep their original image; edit or re-queue them if
Instagram is blocked.

## Scheduling

Approving a post books the next free **9:00 AM Eastern** slot (one post per day). Change the time, or choose
"Do not auto-post", on the approved card. A Worker cron (every 30 minutes) publishes posts whose time has arrived,
to every connected channel that can take the post. Each channel posts at most once; a failing post is retried up to
3 times, then stops and shows its error on the card. "Publish" buttons still post immediately. Times are entered and
shown in Eastern Time; stored as UTC.

## Tips and site-check posts (second stream)

`pipeline/social_stream.py` drafts Facebook + Instagram posts that are not blog posts, in the same `/social` review queue
(the card shows "tip" or "site check" instead of "view blog post"). It runs in the `Social drafts` workflow after the blog step.
- **Tips** come from `config/social_topics.json` (20 topics, each with the facts Claude may use; add your own topics there).
- **Site checks** are anonymous statistics computed from the sites the outreach engine has audited, for example
  "14 of 38 local HVAC websites had no visible call button on the first phone screen". Only used once at least 15 sites back
  the number (and the problem appears on 3+ sites and 15%+ of them). No business is ever named. Each stat is used at most once a month.
- Pace: only Monday, Wednesday and Friday, one new draft per run, and only while fewer than 2 tip/site-check posts are waiting
  (pending or approved, not yet posted). Environment overrides: `SOCIAL_STREAM_DAYS`, `SOCIAL_STREAM_QUEUE`. A manual run of the
  workflow ignores the weekday rule.
- Every draft passes the same checks as blog posts (word counts, no URLs/phones, numbers must come from the item) plus emoji limits;
  site checks must mention the free audit. If Claude cannot produce a passing draft in two tries, nothing is queued.
- Images are always the branded card ("WEBSITE TIP" / "LOCAL SITE CHECK"). Links go to the website with
  `utm_campaign=tips` or `site-checks`.


## Pictures (2026-10-24)
Facebook posts used to go out as link-only, so Facebook showed the page's own social image, the same site image on every post. Now a post with an image is published to Facebook as a photo post (`/photos`, text plus the link) using its own picture: the blog photo, or the branded card for tips, teardowns and posts without a usable JPEG. If Facebook cannot fetch the picture, it falls back to the old link post. Cards use one of four brand-blue colour variants chosen from the title (`social_image.PALETTES`), so they are not all identical. Posts already published are not changed.
